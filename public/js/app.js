'use strict';
// ═══════════════════════════════════════════════════════════════
//  RideComm — Pure WebRTC + Socket.IO (no PeerJS)
// ═══════════════════════════════════════════════════════════════

// ── ICE / TURN config ─────────────────────────────────────────
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',               username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',              username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

// ── State ─────────────────────────────────────────────────────
let socket      = null;
let localStream = null;
let myName      = '';
let myRoom      = '';
let isTalking   = false;
let volume      = 1.0;

// peers[socketId] = { pc: RTCPeerConnection, audioEl: HTMLAudioElement, name }
const peers = {};

// ── Helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $(id); if (el) el.classList.add('active');
}

let _tt;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(_tt); _tt = setTimeout(() => t.classList.remove('show'), 2500);
}

function log(msg, cls = 'l-muted') {
  const b = $('logBox'); if (!b) return;
  const ts = new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const p  = document.createElement('p');
  p.className = cls; p.textContent = `[${ts}] ${msg}`;
  b.appendChild(p); b.scrollTop = b.scrollHeight;
}

function setSignal(n) {
  const b = $('signalBars'); if (!b) return;
  b.className = 'signal-bars' + (n > 0 ? ' s' + n : '');
}

function muteMic(muted) {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
}

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6}, () => c[Math.random()*c.length|0]).join('');
}

// ── Audio output ──────────────────────────────────────────────
function createAudio(socketId, stream) {
  // Remove old
  const old = document.getElementById('audio_' + socketId);
  if (old) { old.srcObject = null; old.remove(); }

  const a = document.createElement('audio');
  a.id          = 'audio_' + socketId;
  a.autoplay    = true;
  a.playsInline = true;
  a.muted       = false;
  a.volume      = Math.min(volume * 2, 1);
  a.srcObject   = stream;
  document.body.appendChild(a);

  // iOS Safari needs explicit play() call after user gesture
  a.play().catch(() => {
    const fn = () => { a.play().catch(()=>{}); };
    document.addEventListener('touchend', fn, {once:true});
    document.addEventListener('click',    fn, {once:true});
  });
  return a;
}

function removeAudio(socketId) {
  const a = document.getElementById('audio_' + socketId);
  if (a) { try { a.srcObject = null; a.pause(); } catch(e){} a.remove(); }
}

// ── WebRTC peer connection ────────────────────────────────────
function createPC(socketId, remoteName) {
  // Close existing
  if (peers[socketId]) closePeer(socketId);

  const pc = new RTCPeerConnection(ICE);
  peers[socketId] = { pc, name: remoteName };

  // Add our mic tracks to the connection
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // When we get remote audio — play it
  pc.ontrack = e => {
    log('🔊 Audio from ' + remoteName + ' ✓', 'l-ok');
    toast('🔊 ' + remoteName + ' connected!');
    const audioEl = createAudio(socketId, e.streams[0]);
    peers[socketId].audioEl = audioEl;
    setSignal(4);
  };

  // Send ICE candidates to the other peer via server
  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('ice-candidate', { to: socketId, candidate: e.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    log('ICE [' + remoteName + ']: ' + s, 'l-muted');
    if (s === 'failed') {
      log('ICE failed — restarting...', 'l-err');
      pc.restartIce();
    }
    if (s === 'disconnected' || s === 'closed') {
      removeRiderUI(socketId);
      closePeer(socketId);
    }
  };

  pc.onconnectionstatechange = () => {
    log('PC [' + remoteName + ']: ' + pc.connectionState, 'l-muted');
  };

  return pc;
}

function closePeer(socketId) {
  const p = peers[socketId];
  if (!p) return;
  try { p.pc.close(); } catch(e) {}
  removeAudio(socketId);
  delete peers[socketId];
}

// ── Caller side: create offer ─────────────────────────────────
async function callPeer(socketId, remoteName) {
  log('Calling ' + remoteName + '...', 'l-info');
  const pc = createPC(socketId, remoteName);

  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: socketId, offer: pc.localDescription });
    log('Offer sent to ' + remoteName, 'l-info');
  } catch(e) {
    log('Offer failed: ' + e.message, 'l-err');
    closePeer(socketId);
  }
}

// ── Callee side: handle offer, send answer ────────────────────
async function handleOffer(socketId, remoteName, offer) {
  log('Offer from ' + remoteName + ' — answering...', 'l-info');
  const pc = createPC(socketId, remoteName);

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: socketId, answer: pc.localDescription });
    log('Answer sent to ' + remoteName, 'l-info');
  } catch(e) {
    log('Answer failed: ' + e.message, 'l-err');
    closePeer(socketId);
  }
}

// ── Handle answer ─────────────────────────────────────────────
async function handleAnswer(socketId, answer) {
  const p = peers[socketId];
  if (!p) return;
  try {
    await p.pc.setRemoteDescription(new RTCSessionDescription(answer));
    log('Answer received — connecting...', 'l-info');
  } catch(e) {
    log('Set answer failed: ' + e.message, 'l-err');
  }
}

// ── Handle ICE candidate ──────────────────────────────────────
async function handleIce(socketId, candidate) {
  const p = peers[socketId];
  if (!p || !candidate) return;
  try {
    await p.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch(e) {
    // Ignore — can happen if PC is already closed
  }
}

// ── Socket.IO ─────────────────────────────────────────────────
function connectSocket(roomCode, name) {
  if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }

  socket = io({
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    reconnectionDelay: 1500,
    reconnectionDelayMax: 8000,
    timeout: 20000,
  });

  socket.on('connect', () => {
    log('Server connected ✓ via ' + socket.io.engine.transport.name, 'l-ok');
    setSignal(4);
    $('statusDot').className = 'status-dot online';
    showConnBanner(null);
    // Join room
    socket.emit('join', { name, roomCode });
    socket.io.engine.on('upgrade', () => log('Upgraded to WebSocket ✓', 'l-ok'));
  });

  // ── Room events ───────────────────────────────────────────────
  // I just joined — call every existing rider
  socket.on('room-members', ({ members }) => {
    log('Room members: ' + members.length, 'l-info');
    members.forEach(m => {
      addRiderUI(m.socketId, m.name);
      callPeer(m.socketId, m.name);
    });
  });

  // New rider joined the room — add UI only, they will call me
  socket.on('peer-joined', ({ socketId: sid, name: n }) => {
    log(n + ' joined', 'l-ok');
    toast('🏍️ ' + n + ' joined');
    addRiderUI(sid, n);
    // Do NOT call them — they got room-members and will call us
  });

  // Rider left
  socket.on('peer-left', ({ socketId: sid, name: n }) => {
    log((n || 'Rider') + ' left', 'l-info');
    toast('👋 ' + (n || 'Rider') + ' left');
    removeRiderUI(sid);
    closePeer(sid);
  });

  // ── WebRTC signaling ──────────────────────────────────────────
  socket.on('offer', ({ from, name: n, offer }) => {
    if (!peers[from]) addRiderUI(from, n);
    handleOffer(from, n || peers[from]?.name || 'Rider', offer);
  });

  socket.on('answer', ({ from, answer }) => {
    handleAnswer(from, answer);
  });

  socket.on('ice-candidate', ({ from, candidate }) => {
    handleIce(from, candidate);
  });

  // Speaking indicator
  socket.on('speaking', ({ socketId: sid, value }) => {
    setRiderSpeaking(sid, value);
  });

  socket.on('disconnect', reason => {
    setSignal(1);
    log('Disconnected: ' + reason, 'l-err');
    $('statusDot').className = 'status-dot error';
  });

  socket.on('connect_error', err => {
    log('Connect error: ' + err.message, 'l-err');
    setSignal(1);
  });
}

// ── Rider UI ──────────────────────────────────────────────────
function addRiderUI(socketId, name) {
  if ($('rider_' + socketId)) return;
  const list = $('ridersList');
  const div  = document.createElement('div');
  div.className = 'rider-item';
  div.id = 'rider_' + socketId;
  div.innerHTML = `
    <div class="rider-avatar">${(name||'?')[0].toUpperCase()}</div>
    <div class="rider-info">
      <div class="rider-name" id="rname_${socketId}">${name||'Rider'}</div>
      <div class="rider-status">● CONNECTED</div>
    </div>
    <div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>
  `;
  list.appendChild(div);
  updateCount();
}

function removeRiderUI(socketId) {
  $('rider_' + socketId)?.remove();
  updateCount();
}

function setRiderSpeaking(socketId, val) {
  $('rider_' + socketId)?.classList.toggle('speaking', !!val);
}

function updateCount() {
  const n = $('ridersList').querySelectorAll('.rider-item').length;
  $('peerCount').textContent = n + ' rider' + (n !== 1 ? 's' : '');
}

// ── Volume ────────────────────────────────────────────────────
function setVolume(val) {
  const pct = parseInt(val);
  volume = pct / 100;
  $('volVal').textContent = pct + '%';
  Object.values(peers).forEach(p => {
    if (p.audioEl) p.audioEl.volume = Math.min(volume * 2, 1);
  });
}

// ── PTT ───────────────────────────────────────────────────────
function startTalk(e) {
  if (e) e.preventDefault();
  if (!localStream || isTalking) return;
  isTalking = true;
  muteMic(false);
  $('pttBtn').classList.add('active');
  $('pttLabel').textContent = 'TRANSMITTING…';
  $('pttRing').classList.add('active');
  $('myRider')?.classList.add('speaking');
  socket?.emit('speaking', { value: true });
}

function stopTalk(e) {
  if (e) e.preventDefault();
  if (!isTalking) return;
  isTalking = false;
  muteMic(true);
  $('pttBtn').classList.remove('active');
  $('pttLabel').textContent = 'HOLD TO TALK';
  $('pttRing').classList.remove('active');
  $('myRider')?.classList.remove('speaking');
  socket?.emit('speaking', { value: false });
}

document.addEventListener('keydown', e => { if (e.code==='Space' && e.target.tagName!=='INPUT') { e.preventDefault(); startTalk(); }});
document.addEventListener('keyup',   e => { if (e.code==='Space') stopTalk(); });

// ── Join / Leave ──────────────────────────────────────────────
async function joinRoom() {
  const name = $('nameInput').value.trim();
  if (!name) { toast('Enter your name first'); return; }

  let roomCode = $('roomInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  if (!roomCode) roomCode = genCode();

  myName = name;
  myRoom = roomCode;

  const btn = $('joinBtn');
  btn.disabled = true; btn.textContent = 'JOINING…';

  // Get mic
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
        channelCount: 1,
      },
      video: false,
    });
    muteMic(true);
    log('Mic ready ✓', 'l-ok');
  } catch(e) {
    toast('Mic denied — allow microphone access');
    btn.disabled = false; btn.textContent = 'JOIN';
    return;
  }

  // Show room screen
  showScreen('screenRoom');
  $('roomCodeDisplay').textContent = roomCode;
  $('headerSub').textContent = 'Room ' + roomCode + ' · ' + name;

  // Add self to list
  $('ridersList').innerHTML = '';
  const self = document.createElement('div');
  self.className = 'rider-item'; self.id = 'myRider';
  self.innerHTML = `
    <div class="rider-avatar">${name[0].toUpperCase()}</div>
    <div class="rider-info">
      <div class="rider-name">${name} <span style="color:var(--muted);font-size:11px">(You)</span></div>
      <div class="rider-status">● YOU</div>
    </div>
    <div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>
  `;
  $('ridersList').appendChild(self);
  updateCount();

  // Connect
  connectSocket(roomCode, name);
  btn.disabled = false; btn.textContent = 'JOIN';
}

function leaveRoom() {
  myRoom = ''; isTalking = false;
  muteMic(true);

  // Close all peer connections
  Object.keys(peers).forEach(id => closePeer(id));

  // Stop mic
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }

  // Disconnect socket
  if (socket) { socket.removeAllListeners(); try { socket.disconnect(); } catch(e){} socket = null; }

  $('statusDot').className = 'status-dot';
  $('headerSub').textContent = 'Helmet Intercom';
  setSignal(0);
  showScreen('screenJoin');
  $('ridersList').innerHTML = '';
  detectServer();
}

// ── QR ────────────────────────────────────────────────────────
async function showQR() {
  if (!myRoom) return;
  const url = location.origin + '/?room=' + myRoom;
  showScreen('screenQR');
  $('qrRoomCode').textContent = myRoom;
  $('qrUrl').textContent = url;
  try {
    const d = await (await fetch('/qr?url=' + encodeURIComponent(url))).json();
    if (d.qr) $('qrImg').src = d.qr;
  } catch(e) {}
}

function copyCode() {
  const url = location.origin + '/?room=' + myRoom;
  navigator.clipboard.writeText(url).then(() => toast('Link copied! 🏍️')).catch(() => toast('Code: ' + myRoom));
}

// ── Server detect ─────────────────────────────────────────────
async function detectServer() {
  const el  = $('serverStatusText');
  const dot = document.querySelector('.server-status .dot');
  try {
    const d = await (await fetch('/health', { signal: AbortSignal.timeout(5000) })).json();
    el.textContent  = (d.platform === 'railway' ? 'Railway ✅' : 'Local ✅') + ' · uptime ' + d.uptime + 's';
    dot.className   = 'dot dot-ok';
    const cn = $('certNotice');
    if (cn) cn.style.display = (d.platform !== 'railway' && location.protocol === 'https:') ? 'block' : 'none';
  } catch(e) {
    el.textContent  = 'Server not reachable';
    dot.className   = 'dot dot-err';
  }
}

function showConnBanner(msg) {
  const b = $('connBanner'); if (!b) return;
  b.style.display = msg ? 'flex' : 'none';
  const t = $('connBannerText'); if (t && msg) t.textContent = msg;
}

function retryConnection() {
  if (socket?.connected) socket.emit('join', { name: myName, roomCode: myRoom });
  else connectSocket(myRoom, myName);
}

window.setSignal = function(n) {
  const b = $('signalBars'); if (!b) return;
  b.className = 'signal-bars' + (n > 0 ? ' s' + n : '');
  if (n <= 1 && myRoom) showConnBanner('Lost connection — retrying…');
  else if (n >= 3) showConnBanner(null);
};

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  detectServer();
  const p = new URLSearchParams(location.search).get('room');
  if (p) { $('roomInput').value = p.toUpperCase(); toast('Room pre-filled!'); }
  $('roomInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); });
  $('nameInput').addEventListener('keydown', e => { if (e.key==='Enter') joinRoom(); });
  $('roomInput').addEventListener('keydown', e => { if (e.key==='Enter') joinRoom(); });
  if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(()=>{});
});
