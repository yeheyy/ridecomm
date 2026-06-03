'use strict';
// ═══════════════════════════════════════════════════════
//  RideComm — Pure WebRTC + Socket.IO
//  Flow:
//  1. Rider2 joins → gets room-members [Rider1]
//  2. Rider2 creates offer → sends to Rider1
//  3. Rider1 receives offer → creates answer → sends back
//  4. Both exchange ICE candidates
//  5. Audio flows both ways ✅
// ═══════════════════════════════════════════════════════

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',                  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',                 username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',   username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

// ── App state ─────────────────────────────────────────
let socket      = null;
let localStream = null;
let myName      = '';
let myRoom      = '';
let isTalking   = false;
let vol         = 1.0;

// peerConns[socketId] = RTCPeerConnection
const peerConns = {};

// ── DOM helpers ───────────────────────────────────────
const $ = id => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id)?.classList.add('active');
}

let _tt;
function toast(m) {
  const t=$('toast'); t.textContent=m; t.classList.add('show');
  clearTimeout(_tt); _tt=setTimeout(()=>t.classList.remove('show'),2500);
}

function log(msg, cls='l-muted') {
  const b=$('logBox'); if(!b) return;
  const ts=new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const p=document.createElement('p');
  p.className=cls; p.textContent=`[${ts}] ${msg}`;
  b.appendChild(p); b.scrollTop=b.scrollHeight;
}

function setSignal(n) {
  const b=$('signalBars'); if(!b) return;
  b.className='signal-bars'+(n>0?' s'+n:'');
}

function muteMic(muted) {
  localStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
}

function genCode() {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6},()=>c[Math.random()*c.length|0]).join('');
}

// ── Audio element ─────────────────────────────────────
function playRemoteAudio(socketId, stream) {
  // Always remove old first
  const old = document.getElementById('audio_'+socketId);
  if (old) { try{old.srcObject=null; old.pause();}catch(e){} old.remove(); }

  const a         = document.createElement('audio');
  a.id            = 'audio_'+socketId;
  a.autoplay      = true;
  a.playsInline   = true;
  a.muted         = false;
  a.volume        = Math.min(vol*2, 1);
  a.srcObject     = stream;
  document.body.appendChild(a);

  const tryPlay = () => {
    a.play().catch(e => {
      log('Tap screen to enable audio', 'l-err');
      document.addEventListener('touchend', ()=>a.play().catch(()=>{}), {once:true});
      document.addEventListener('click',    ()=>a.play().catch(()=>{}), {once:true});
    });
  };
  tryPlay();
  return a;
}

function stopRemoteAudio(socketId) {
  const a=document.getElementById('audio_'+socketId);
  if(a){try{a.srcObject=null;a.pause();}catch(e){}a.remove();}
}

// ── RTCPeerConnection ─────────────────────────────────
function createPeerConn(remoteSocketId, remoteName) {
  // Close existing if any
  if (peerConns[remoteSocketId]) {
    try { peerConns[remoteSocketId].close(); } catch(e) {}
    delete peerConns[remoteSocketId];
  }

  log('Creating peer connection with '+remoteName, 'l-info');
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConns[remoteSocketId] = pc;

  // Add all local tracks so remote can hear us
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
      log('Added local track: '+track.kind, 'l-muted');
    });
  } else {
    log('WARNING: no localStream when creating PC!', 'l-err');
  }

  // When remote audio arrives — play it
  pc.ontrack = event => {
    log('🔊 Got remote audio from '+remoteName+' ✓', 'l-ok');
    toast('🔊 '+remoteName+' audio connected!');
    const stream  = event.streams[0] || new MediaStream([event.track]);
    const audioEl = playRemoteAudio(remoteSocketId, stream);
    setSignal(4);
    // Store audio el reference
    pc._audioEl = audioEl;
  };

  // Send ICE candidates to remote via server
  pc.onicecandidate = event => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: remoteSocketId, candidate: event.candidate });
    }
  };

  // Log ICE state
  pc.oniceconnectionstatechange = () => {
    log('ICE ['+remoteName+']: '+pc.iceConnectionState, 'l-muted');
    if (pc.iceConnectionState === 'failed') {
      log('ICE failed — restarting ICE...', 'l-err');
      try { pc.restartIce(); } catch(e) {}
    }
    if (pc.iceConnectionState === 'disconnected') {
      log(remoteName+' connection lost', 'l-err');
    }
  };

  pc.onconnectionstatechange = () => {
    log('PC state ['+remoteName+']: '+pc.connectionState, 'l-muted');
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removeRiderUI(remoteSocketId);
      stopRemoteAudio(remoteSocketId);
      delete peerConns[remoteSocketId];
    }
  };

  return pc;
}

// ── Caller: create and send offer ─────────────────────
async function sendOffer(remoteSocketId, remoteName) {
  log('Sending offer to '+remoteName+'...', 'l-info');
  const pc = createPeerConn(remoteSocketId, remoteName);

  try {
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: remoteSocketId, offer: pc.localDescription });
    log('Offer sent to '+remoteName, 'l-ok');
  } catch(e) {
    log('sendOffer error: '+e.message, 'l-err');
  }
}

// ── Callee: receive offer, send answer ────────────────
async function receiveOffer(remoteSocketId, remoteName, offer) {
  log('Received offer from '+remoteName+' — answering...', 'l-info');
  const pc = createPeerConn(remoteSocketId, remoteName);

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: remoteSocketId, answer: pc.localDescription });
    log('Answer sent to '+remoteName, 'l-ok');
  } catch(e) {
    log('receiveOffer error: '+e.message, 'l-err');
  }
}

// ── Caller: receive answer ────────────────────────────
async function receiveAnswer(remoteSocketId, answer) {
  const pc = peerConns[remoteSocketId];
  if (!pc) { log('No PC for answer from '+remoteSocketId.slice(0,8), 'l-err'); return; }
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    log('Answer received — WebRTC connecting...', 'l-ok');
  } catch(e) {
    log('receiveAnswer error: '+e.message, 'l-err');
  }
}

// ── ICE candidate ─────────────────────────────────────
async function addIceCandidate(remoteSocketId, candidate) {
  const pc = peerConns[remoteSocketId];
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch(e) {
    // Silently ignore — can happen if PC closed
  }
}

// ── Socket.IO connection ──────────────────────────────
function connectSocket() {
  if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }

  socket = io({
    transports:           ['polling', 'websocket'],
    upgrade:              true,
    reconnection:         true,
    reconnectionDelay:    1500,
    reconnectionDelayMax: 8000,
    timeout:              20000,
  });

  // ── Connected to server ───────────────────────────────
  socket.on('connect', () => {
    const via = socket.io.engine.transport.name;
    log('Server connected ✓ via '+via, 'l-ok');
    setSignal(4);
    $('statusDot').className = 'status-dot online';
    showConnBanner(null);

    // Re-join room (handles reconnects too)
    socket.emit('join', { name: myName, roomCode: myRoom });
    log('Joined room '+myRoom+' as '+myName, 'l-ok');

    socket.io.engine.on('upgrade', () => log('Upgraded to WebSocket ✓', 'l-ok'));
  });

  // ── room-members: list of riders already in room ──────
  // I just joined → I call each of them
  socket.on('room-members', ({ members }) => {
    log('Existing riders: '+members.length, 'l-info');
    members.forEach(m => {
      log('Found: '+m.name+' ('+m.socketId.slice(0,6)+')', 'l-info');
      addRiderUI(m.socketId, m.name);
      // I am the NEW rider — I send offers to all existing riders
      sendOffer(m.socketId, m.name);
    });
  });

  // ── peer-joined: a NEW rider joined after me ──────────
  // They will send ME an offer — I just add their UI
  socket.on('peer-joined', ({ socketId, name }) => {
    log(name+' joined ('+socketId.slice(0,6)+') — waiting for their offer...', 'l-ok');
    toast('🏍️ '+name+' joined');
    addRiderUI(socketId, name);
    // Do NOT call them — they will call us via room-members
  });

  // ── peer-left ─────────────────────────────────────────
  socket.on('peer-left', ({ socketId, name }) => {
    log((name||'Rider')+' left', 'l-info');
    toast('👋 '+(name||'Rider')+' left');
    removeRiderUI(socketId);
    stopRemoteAudio(socketId);
    if (peerConns[socketId]) {
      try { peerConns[socketId].close(); } catch(e) {}
      delete peerConns[socketId];
    }
  });

  // ── WebRTC signaling ──────────────────────────────────
  socket.on('offer', ({ from, name, offer }) => {
    log('Offer from '+(name||from.slice(0,6)), 'l-info');
    // Make sure they're in the UI
    if (!$('rider_'+from)) addRiderUI(from, name||'Rider');
    receiveOffer(from, name||'Rider', offer);
  });

  socket.on('answer', ({ from, answer }) => {
    log('Answer from '+from.slice(0,6), 'l-info');
    receiveAnswer(from, answer);
  });

  socket.on('ice-candidate', ({ from, candidate }) => {
    addIceCandidate(from, candidate);
  });

  // ── Speaking indicator ────────────────────────────────
  socket.on('speaking', ({ socketId, value }) => {
    setRiderSpeaking(socketId, value);
  });

  // ── Disconnected ──────────────────────────────────────
  socket.on('disconnect', reason => {
    log('Server disconnected: '+reason, 'l-err');
    setSignal(1);
    $('statusDot').className = 'status-dot error';
    if (myRoom) showConnBanner('Lost connection — reconnecting...');
  });

  socket.on('connect_error', err => {
    log('Connect error: '+err.message, 'l-err');
    setSignal(1);
  });
}

// ── Rider UI ──────────────────────────────────────────
function addRiderUI(socketId, name) {
  if ($('rider_'+socketId)) return; // already exists
  const list = $('ridersList');
  const div  = document.createElement('div');
  div.className = 'rider-item';
  div.id        = 'rider_'+socketId;
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
  log('Added '+name+' to riders list', 'l-muted');
}

function removeRiderUI(socketId) {
  $('rider_'+socketId)?.remove();
  updateCount();
}

function setRiderSpeaking(socketId, val) {
  $('rider_'+socketId)?.classList.toggle('speaking', !!val);
}

function updateCount() {
  const n = $('ridersList').querySelectorAll('.rider-item').length;
  $('peerCount').textContent = n+' rider'+(n!==1?'s':'');
}

// ── Volume ────────────────────────────────────────────
function setVolume(v) {
  const pct = parseInt(v);
  vol = pct / 100;
  $('volVal').textContent = pct+'%';
  document.querySelectorAll('audio[id^="audio_"]').forEach(a => {
    a.volume = Math.min(vol*2, 1);
  });
}

// ── PTT ───────────────────────────────────────────────
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

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); startTalk(); }
});
document.addEventListener('keyup', e => { if (e.code === 'Space') stopTalk(); });

// ── Join ──────────────────────────────────────────────
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
        channelCount:     1,
      },
      video: false,
    });
    muteMic(true);
    log('Mic ready ✓ tracks: '+localStream.getAudioTracks().length, 'l-ok');
  } catch(e) {
    toast('Mic denied — please allow microphone access');
    btn.disabled = false; btn.textContent = 'JOIN';
    return;
  }

  // Show room screen
  showScreen('screenRoom');
  $('roomCodeDisplay').textContent = roomCode;
  $('headerSub').textContent       = 'Room '+roomCode+' · '+name;

  // Add self
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

  // Connect to server
  connectSocket();
  btn.disabled = false; btn.textContent = 'JOIN';
}

// ── Leave ─────────────────────────────────────────────
function leaveRoom() {
  myRoom = ''; isTalking = false;
  muteMic(true);

  // Close all peer connections
  Object.keys(peerConns).forEach(id => {
    try { peerConns[id].close(); } catch(e) {}
    stopRemoteAudio(id);
    delete peerConns[id];
  });

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

// ── QR ────────────────────────────────────────────────
async function showQR() {
  if (!myRoom) return;
  const url = location.origin + '/?room=' + myRoom;
  showScreen('screenQR');
  $('qrRoomCode').textContent = myRoom;
  $('qrUrl').textContent = url;
  try {
    const d = await (await fetch('/qr?url='+encodeURIComponent(url))).json();
    if (d.qr) $('qrImg').src = d.qr;
  } catch(e) {}
}

function copyCode() {
  const url = location.origin+'/?room='+myRoom;
  navigator.clipboard.writeText(url)
    .then(()=>toast('Link copied! 🏍️'))
    .catch(()=>toast('Code: '+myRoom));
}

// ── Server detect ─────────────────────────────────────
async function detectServer() {
  const el  = $('serverStatusText');
  const dot = document.querySelector('.server-status .dot');
  try {
    const d = await (await fetch('/health',{signal:AbortSignal.timeout(5000)})).json();
    el.textContent = (d.platform==='railway'?'Railway ✅':'Local ✅')+' · uptime '+d.uptime+'s';
    dot.className  = 'dot dot-ok';
    const cn=$('certNotice');
    if(cn) cn.style.display=(d.platform!=='railway'&&location.protocol==='https:')?'block':'none';
  } catch(e) {
    el.textContent = 'Server not reachable';
    dot.className  = 'dot dot-err';
  }
}

function showConnBanner(msg) {
  const b=$('connBanner'); if(!b) return;
  b.style.display = msg ? 'flex' : 'none';
  const t=$('connBannerText'); if(t&&msg) t.textContent=msg;
}

function retryConnection() {
  if (socket?.connected) socket.emit('join',{name:myName,roomCode:myRoom});
  else connectSocket();
}

window.setSignal = function(n) {
  const b=$('signalBars'); if(!b) return;
  b.className='signal-bars'+(n>0?' s'+n:'');
  if(n<=1&&myRoom) showConnBanner('Lost connection — reconnecting...');
  else if(n>=3) showConnBanner(null);
};

// ── Init ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  detectServer();
  const p = new URLSearchParams(location.search).get('room');
  if (p) { $('roomInput').value = p.toUpperCase(); toast('Room pre-filled!'); }
  $('roomInput').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
  });
  $('nameInput').addEventListener('keydown', e => { if(e.key==='Enter') joinRoom(); });
  $('roomInput').addEventListener('keydown', e => { if(e.key==='Enter') joinRoom(); });
  if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(()=>{});
});
