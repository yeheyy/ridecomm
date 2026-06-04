'use strict';
// RideComm — WebRTC + Socket.IO (clean, minimal, reliable)

// ─── ICE/TURN config ──────────────────────────────────────────────────────────
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',               username:'openrelayproject', credential:'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',              username:'openrelayproject', credential:'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',username:'openrelayproject', credential:'openrelayproject' },
  ],
};

// ─── State ────────────────────────────────────────────────────────────────────
let socket      = null;   // Socket.IO connection
let localStream = null;   // My microphone
let myName      = '';
let myRoom      = '';
let isTalking   = false;
let vol         = 1.0;
const pcs       = {};     // pcs[remoteSocketId] = RTCPeerConnection

// ─── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id)?.classList.add('active');
}

let _tt;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => t.classList.remove('show'), 2500);
}

function log(msg, cls = 'l-muted') {
  const b = $('logBox');
  if (!b) return;
  const ts = new Date().toLocaleTimeString('en', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const p  = document.createElement('p');
  p.className   = cls;
  p.textContent = '[' + ts + '] ' + msg;
  b.appendChild(p);
  b.scrollTop = b.scrollHeight;
}

function setSignal(n) {
  const b = $('signalBars');
  if (b) b.className = 'signal-bars' + (n > 0 ? ' s' + n : '');
}

function muteMic(muted) {
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
}

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ─── Audio playback ───────────────────────────────────────────────────────────
function playAudio(sid, stream) {
  let a = document.getElementById('aud_' + sid);
  if (!a) {
    a = document.createElement('audio');
    a.id = 'aud_' + sid;
    a.autoplay   = true;
    a.playsInline = true;
    document.body.appendChild(a);
  }
  a.muted    = false;
  a.volume   = Math.min(vol * 2, 1);
  a.srcObject = stream;
  a.play().catch(() => {
    const fn = () => a.play().catch(() => {});
    document.addEventListener('click',    fn, { once: true });
    document.addEventListener('touchend', fn, { once: true });
  });
}

function stopAudio(sid) {
  const a = document.getElementById('aud_' + sid);
  if (a) { try { a.srcObject = null; a.pause(); } catch(e){} a.remove(); }
}

// ─── RTCPeerConnection ────────────────────────────────────────────────────────
function getOrCreatePC(sid, remoteName) {
  if (pcs[sid]) return pcs[sid];

  log('Creating WebRTC connection with ' + remoteName, 'l-info');
  const pc = new RTCPeerConnection(ICE);
  pcs[sid] = pc;

  // Add my mic tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // Play remote audio when it arrives
  pc.ontrack = ev => {
    log('🔊 Audio from ' + remoteName + ' ✓', 'l-ok');
    toast('🎙️ ' + remoteName + ' connected!');
    const stream = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([ev.track]);
    playAudio(sid, stream);
  };

  // Send ICE candidates
  pc.onicecandidate = ev => {
    if (ev.candidate && socket) {
      socket.emit('ice-candidate', { to: sid, candidate: ev.candidate.toJSON() });
    }
  };

  pc.oniceconnectionstatechange = () => {
    log('ICE(' + remoteName + '): ' + pc.iceConnectionState, 'l-muted');
    if (pc.iceConnectionState === 'failed') {
      try { pc.restartIce(); } catch(e) {}
    }
  };

  pc.onconnectionstatechange = () => {
    log('PC(' + remoteName + '): ' + pc.connectionState, 'l-muted');
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closePC(sid);
      removeRiderUI(sid);
    }
  };

  return pc;
}

function closePC(sid) {
  if (pcs[sid]) {
    try { pcs[sid].close(); } catch(e) {}
    delete pcs[sid];
  }
  stopAudio(sid);
}

// ─── WebRTC signaling ─────────────────────────────────────────────────────────
async function makeOffer(sid, remoteName) {
  const pc = getOrCreatePC(sid, remoteName);
  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: sid, offer: pc.localDescription });
    log('Offer → ' + remoteName, 'l-info');
  } catch(e) {
    log('makeOffer error: ' + e.message, 'l-err');
  }
}

async function handleOffer(sid, remoteName, offer) {
  const pc = getOrCreatePC(sid, remoteName);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: sid, answer: pc.localDescription });
    log('Answer → ' + remoteName, 'l-info');
  } catch(e) {
    log('handleOffer error: ' + e.message, 'l-err');
  }
}

async function handleAnswer(sid, answer) {
  const pc = pcs[sid];
  if (!pc) { log('No PC for answer sid=' + sid.slice(0,8), 'l-err'); return; }
  try {
    if (pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      log('Answer received ✓', 'l-ok');
    }
  } catch(e) {
    log('handleAnswer error: ' + e.message, 'l-err');
  }
}

async function handleIce(sid, candidate) {
  const pc = pcs[sid];
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch(e) { /* ignore stale candidates */ }
}

// ─── Socket setup (called ONCE) ───────────────────────────────────────────────
function setupSocket() {
  socket = io({
    transports:           ['polling', 'websocket'],
    upgrade:              true,
    reconnection:         true,
    reconnectionDelay:    1000,
    reconnectionDelayMax: 5000,
    timeout:              20000,
  });

  // ── connect / reconnect ────────────────────────────────────────────────────
  socket.on('connect', () => {
    log('Connected to server ✓ (' + socket.io.engine.transport.name + ')', 'l-ok');
    setSignal(4);
    $('statusDot').className = 'status-dot online';
    showConnBanner(null);

    // Always re-emit join on connect (handles initial + reconnects)
    if (myName && myRoom) {
      socket.emit('join', { name: myName, roomCode: myRoom });
    }
  });

  // ── Server tells me who is already in the room ─────────────────────────────
  // I am the JOINER → I call everyone in the list
  socket.on('room-members', ({ members }) => {
    log('room-members received: ' + members.length + ' rider(s)', 'l-ok');
    if (members.length === 0) {
      log('You are the first rider in this room', 'l-info');
      return;
    }
    members.forEach(m => {
      log('Calling ' + m.name + ' (' + m.socketId.slice(0,8) + ')...', 'l-info');
      addRiderUI(m.socketId, m.name);
      makeOffer(m.socketId, m.name);
    });
  });

  // ── Someone new joined AFTER me ────────────────────────────────────────────
  // They will call me — I just show them in the list
  socket.on('peer-joined', ({ socketId, name }) => {
    log(name + ' joined the room (' + socketId.slice(0,8) + ')', 'l-ok');
    toast('🏍️ ' + name + ' joined!');
    addRiderUI(socketId, name);
    // NOTE: do NOT call them — they received room-members and will call us
  });

  // ── Someone left ───────────────────────────────────────────────────────────
  socket.on('peer-left', ({ socketId, name }) => {
    log((name || 'Rider') + ' left the room', 'l-info');
    toast('👋 ' + (name || 'Rider') + ' left');
    removeRiderUI(socketId);
    closePC(socketId);
  });

  // ── WebRTC signaling relay ─────────────────────────────────────────────────
  socket.on('offer', ({ from, name, offer }) => {
    log('Offer received from ' + (name || from.slice(0,8)), 'l-info');
    addRiderUI(from, name || 'Rider');
    handleOffer(from, name || 'Rider', offer);
  });

  socket.on('answer', ({ from, answer }) => {
    log('Answer received from ' + from.slice(0,8), 'l-info');
    handleAnswer(from, answer);
  });

  socket.on('ice-candidate', ({ from, candidate }) => {
    handleIce(from, candidate);
  });

  // ── Speaking indicator ─────────────────────────────────────────────────────
  socket.on('speaking', ({ socketId, value }) => {
    $('rider_' + socketId)?.classList.toggle('speaking', !!value);
  });

  // ── Disconnect / error ─────────────────────────────────────────────────────
  socket.on('disconnect', reason => {
    log('Disconnected: ' + reason, 'l-err');
    setSignal(1);
    $('statusDot').className = 'status-dot error';
    if (myRoom) showConnBanner('Reconnecting...');
  });

  socket.on('connect_error', err => {
    log('Connect error: ' + err.message, 'l-err');
    setSignal(1);
  });
}

// ─── Rider list UI ────────────────────────────────────────────────────────────
function addRiderUI(sid, name) {
  if ($('rider_' + sid)) return;
  const div = document.createElement('div');
  div.className = 'rider-item';
  div.id        = 'rider_' + sid;
  div.innerHTML =
    '<div class="rider-avatar">' + (name || '?')[0].toUpperCase() + '</div>' +
    '<div class="rider-info">' +
      '<div class="rider-name">' + (name || 'Rider') + '</div>' +
      '<div class="rider-status">● CONNECTED</div>' +
    '</div>' +
    '<div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>';
  $('ridersList').appendChild(div);
  updateCount();
  log(name + ' added to riders list ✓', 'l-ok');
}

function removeRiderUI(sid) {
  $('rider_' + sid)?.remove();
  updateCount();
}

function setRiderSpeaking(sid, val) {
  $('rider_' + sid)?.classList.toggle('speaking', !!val);
}

function updateCount() {
  const n = $('ridersList').querySelectorAll('.rider-item').length;
  $('peerCount').textContent = n + ' rider' + (n !== 1 ? 's' : '');
}

// ─── Volume ───────────────────────────────────────────────────────────────────
function setVolume(v) {
  const pct = parseInt(v);
  vol = pct / 100;
  $('volVal').textContent = pct + '%';
  document.querySelectorAll('audio[id^="aud_"]').forEach(a => {
    a.volume = Math.min(vol * 2, 1);
  });
}

// ─── PTT ──────────────────────────────────────────────────────────────────────
function startTalk(e) {
  if (e) e.preventDefault();
  if (!localStream || isTalking) return;
  isTalking = true;
  muteMic(false);
  $('pttBtn').classList.add('active');
  $('pttLabel').textContent = 'TRANSMITTING…';
  $('pttRing').classList.add('active');
  $('myRider')?.classList.add('speaking');
  if (socket) socket.emit('speaking', { value: true });
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
  if (socket) socket.emit('speaking', { value: false });
}

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); startTalk(); }
});
document.addEventListener('keyup', e => { if (e.code === 'Space') stopTalk(); });

// ─── Join room ────────────────────────────────────────────────────────────────
async function joinRoom() {
  const name = $('nameInput').value.trim();
  if (!name) { toast('Enter your name first'); return; }

  let roomCode = $('roomInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!roomCode) roomCode = genCode();

  // Save to module-level vars BEFORE async work
  myName = name;
  myRoom = roomCode;

  const btn = $('joinBtn');
  btn.disabled    = true;
  btn.textContent = 'JOINING…';

  // 1. Get microphone
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    muteMic(true); // muted until PTT pressed
    log('Microphone ready ✓ (' + localStream.getAudioTracks().length + ' track)', 'l-ok');
  } catch(e) {
    toast('Microphone denied — please allow access');
    myName = ''; myRoom = '';
    btn.disabled = false; btn.textContent = 'JOIN';
    return;
  }

  // 2. Switch to room screen
  showScreen('screenRoom');
  $('roomCodeDisplay').textContent = roomCode;
  $('headerSub').textContent       = 'Room ' + roomCode + ' · ' + name;

  // 3. Show self in rider list
  $('ridersList').innerHTML = '';
  const selfDiv = document.createElement('div');
  selfDiv.className = 'rider-item';
  selfDiv.id        = 'myRider';
  selfDiv.innerHTML =
    '<div class="rider-avatar">' + name[0].toUpperCase() + '</div>' +
    '<div class="rider-info">' +
      '<div class="rider-name">' + name + ' <span style="color:var(--muted);font-size:11px">(You)</span></div>' +
      '<div class="rider-status">● YOU</div>' +
    '</div>' +
    '<div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>';
  $('ridersList').appendChild(selfDiv);
  updateCount();

  // 4. Connect to server (socket setup done ONCE — handles reconnects internally)
  setupSocket();

  btn.disabled    = false;
  btn.textContent = 'JOIN';
}

// ─── Leave room ───────────────────────────────────────────────────────────────
function leaveRoom() {
  isTalking = false;
  myName    = '';
  myRoom    = '';

  muteMic(true);

  // Close all peer connections
  Object.keys(pcs).forEach(sid => closePC(sid));

  // Stop microphone
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }

  // Disconnect socket
  if (socket) {
    socket.removeAllListeners();
    try { socket.disconnect(); } catch(e) {}
    socket = null;
  }

  $('statusDot').className = 'status-dot';
  $('headerSub').textContent = 'Helmet Intercom';
  setSignal(0);
  showScreen('screenJoin');
  $('ridersList').innerHTML = '';
  detectServer();
}

// ─── QR code ──────────────────────────────────────────────────────────────────
async function showQR() {
  if (!myRoom) return;
  const url = location.origin + '/?room=' + myRoom;
  showScreen('screenQR');
  $('qrRoomCode').textContent = myRoom;
  $('qrUrl').textContent      = url;
  try {
    const d = await (await fetch('/qr?url=' + encodeURIComponent(url))).json();
    if (d.qr) $('qrImg').src = d.qr;
  } catch(e) {}
}

function copyCode() {
  const url = location.origin + '/?room=' + myRoom;
  navigator.clipboard.writeText(url)
    .then(() => toast('Link copied! 🏍️'))
    .catch(() => toast('Code: ' + myRoom));
}

// ─── Server health ────────────────────────────────────────────────────────────
async function detectServer() {
  const el  = $('serverStatusText');
  const dot = document.querySelector('.server-status .dot');
  try {
    const d = await (await fetch('/health', { signal: AbortSignal.timeout(5000) })).json();
    el.textContent = (d.platform === 'railway' ? 'Railway ✅' : 'Local ✅') + ' · uptime ' + d.uptime + 's';
    dot.className  = 'dot dot-ok';
    const cn = $('certNotice');
    if (cn) cn.style.display = (d.platform !== 'railway' && location.protocol === 'https:') ? 'block' : 'none';
  } catch(e) {
    el.textContent = 'Server not reachable';
    dot.className  = 'dot dot-err';
  }
}

function showConnBanner(msg) {
  const b = $('connBanner'); if (!b) return;
  b.style.display = msg ? 'flex' : 'none';
  const t = $('connBannerText'); if (t && msg) t.textContent = msg;
}

function retryConnection() {
  if (socket && socket.connected) {
    socket.emit('join', { name: myName, roomCode: myRoom });
  } else if (socket) {
    socket.connect();
  }
}

window.setSignal = function(n) {
  const b = $('signalBars'); if (!b) return;
  b.className = 'signal-bars' + (n > 0 ? ' s' + n : '');
  if (n <= 1 && myRoom) showConnBanner('Lost connection — reconnecting...');
  else if (n >= 3)      showConnBanner(null);
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  detectServer();

  // Pre-fill room code from URL
  const p = new URLSearchParams(location.search).get('room');
  if (p) { $('roomInput').value = p.toUpperCase(); toast('Room pre-filled!'); }

  $('roomInput').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  $('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

  if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(() => {});
});
