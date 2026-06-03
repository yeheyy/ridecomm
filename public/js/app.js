'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  RideComm — Client App  (complete rewrite for reliable audio)
// ════════════════════════════════════════════════════════════════════════════

const STATE = {
  myName:    '',
  roomCode:  '',
  myPeerId:  '',
  isTalking: false,
  volume:    1.0,
  peers:     {},   // peerId → { call, audioEl, name }
  peer:      null,
  localStream: null,
  // retry state
  _peerRetries: 0,
  _peerRetryTimer: null,
  _lastPeerErr: null,
};

// ── ICE config with TURN relay ───────────────────────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // TURN servers — relay audio when direct P2P is blocked
    { urls: 'turn:openrelay.metered.ca:80',                 username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',                username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',  username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 10,
};

// ── Utilities ─────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = $(id); if (s) s.classList.add('active');
}

let _toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

function log(msg, cls = 'l-muted') {
  const box = $('logBox'); if (!box) return;
  const ts  = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p   = document.createElement('p');
  p.className   = cls;
  p.textContent = `[${ts}] ${msg}`;
  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
}

function setSignal(n) {
  const b = $('signalBars'); if (!b) return;
  b.className = 'signal-bars' + (n > 0 ? ' s' + n : '');
}

function muteMic(muted) {
  if (!STATE.localStream) return;
  STATE.localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Audio helpers ─────────────────────────────────────────────────────────────
function playAudio(peerId, stream) {
  // Remove any existing audio element
  const old = document.getElementById('audio_' + peerId);
  if (old) { try { old.srcObject = null; } catch(e) {} old.remove(); }

  const audio = document.createElement('audio');
  audio.id          = 'audio_' + peerId;
  audio.autoplay    = true;
  audio.playsInline = true;
  audio.controls    = false;
  audio.muted       = false;
  audio.volume      = Math.min(STATE.volume * 2, 1);
  audio.srcObject   = stream;
  document.body.appendChild(audio);

  audio.play().catch(() => {
    // iOS blocks autoplay — retry on next tap
    const resume = () => audio.play().catch(() => {});
    document.addEventListener('touchend', resume, { once: true });
    document.addEventListener('click',    resume, { once: true });
  });

  return audio;
}

function stopAudio(peerId) {
  const a = document.getElementById('audio_' + peerId);
  if (a) { try { a.srcObject = null; a.pause(); } catch(e) {} a.remove(); }
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
let _socket = null;

function connectSocket(roomCode, name, peerId) {
  if (_socket) {
    _socket.removeAllListeners();
    _socket.disconnect();
    _socket = null;
  }

  log('Connecting to server...', 'l-info');

  const socket = io({
    transports:            ['polling', 'websocket'],
    upgrade:               true,
    reconnection:          true,
    reconnectionAttempts:  Infinity,
    reconnectionDelay:     1500,
    reconnectionDelayMax:  8000,
    timeout:               20000,
    forceNew:              true,
  });
  _socket = socket;

  socket.on('connect', () => {
    const via = socket.io.engine.transport.name;
    log('Server connected ✓ via ' + via, 'l-ok');
    setSignal(4);
    $('statusDot').className = 'status-dot online';
    showConnBanner(null);
    socket.emit('join', { name, roomCode, peerId });
    socket.io.engine.on('upgrade', () => log('Upgraded to WebSocket ✓', 'l-ok'));
  });

  // Existing riders in room → call each one
  socket.on('room_members', ({ members }) => {
    log('Room has ' + members.length + ' existing rider(s)', 'l-info');
    members.forEach(m => {
      if (!m.peerId || m.peerId === STATE.myPeerId) return;
      log('Calling existing rider: ' + m.name, 'l-info');
      addRiderUI(m.peerId, m.name);
      callPeer(m.peerId);
    });
  });

  // New rider joined → they will call us, just add UI
  socket.on('peer_joined', ({ name: n, peerId: pid }) => {
    if (!pid || pid === STATE.myPeerId) return;
    log(n + ' joined the room', 'l-ok');
    toast('🏍️ ' + n + ' joined');
    addRiderUI(pid, n);
    // ALSO call them — handles race condition where both join at same time
    // callPeer() is idempotent (won't double-call)
    setTimeout(() => callPeer(pid), 500);
  });

  socket.on('peer_left', ({ peerId: pid, name: n }) => {
    log((n || 'Rider') + ' left', 'l-info');
    toast('👋 ' + (n || 'Rider') + ' left');
    removeRiderUI(pid);
    cleanupPeer(pid);
  });

  socket.on('speaking', ({ peerId: pid, value }) => {
    setRiderSpeaking(pid, value);
  });

  socket.on('disconnect', reason => {
    STATE.wsConnected = false;
    setSignal(1);
    log('Server disconnected: ' + reason, 'l-err');
  });

  socket.on('connect_error', err => {
    log('Connection error: ' + err.message, 'l-err');
    setSignal(1);
  });
}

function wsSend(msg) {
  if (!_socket?.connected) return;
  if      (msg.type === 'speaking') _socket.emit('speaking', { value: msg.value });
  else if (msg.type === 'leave')    _socket.emit('leave');
  else if (msg.type === 'join')     _socket.emit('join', msg);
}

// ── PeerJS ────────────────────────────────────────────────────────────────────
function initPeer(onReady) {
  if (STATE.peer) { try { STATE.peer.destroy(); } catch(e) {} STATE.peer = null; }

  const isSecure    = location.protocol === 'https:';
  const host        = location.hostname;
  const defaultPort = isSecure ? 443 : 80;
  const port        = location.port ? parseInt(location.port, 10) : defaultPort;

  log('PeerJS connecting → ' + host + ':' + port, 'l-info');

  const peer = new Peer(undefined, {
    host, port, path: '/peerjs',
    secure:       isSecure,
    debug:        0,
    pingInterval: 20000,
    config:       ICE_CONFIG,
  });

  STATE.peer = peer;
  STATE._peerRetries  = 0;
  STATE._lastPeerErr  = null;

  peer.on('open', id => {
    STATE.myPeerId    = id;
    STATE._peerRetries = 0;
    STATE._lastPeerErr = null;
    log('PeerJS ready ✓ ID: ' + id.slice(0, 8) + '…', 'l-ok');
    $('statusDot').className = 'status-dot online';
    setSignal(4);
    if (onReady) onReady(id);
  });

  // Answer incoming calls
  peer.on('call', call => {
    log('Incoming call from ' + call.peer.slice(0, 8) + '…', 'l-info');
    if (!STATE.localStream) { call.close(); return; }
    call.answer(STATE.localStream);
    handleCallStream(call);
  });

  peer.on('disconnected', () => {
    if (!STATE.roomCode) return;
    setSignal(2);
    $('statusDot').className = 'status-dot error';
    STATE._peerRetries++;
    const delay = Math.min(1500 * STATE._peerRetries, 8000);
    log('PeerJS disconnected — retry in ' + (delay / 1000) + 's…', 'l-err');
    clearTimeout(STATE._peerRetryTimer);
    STATE._peerRetryTimer = setTimeout(() => {
      if (!STATE.roomCode) return;
      try { if (peer.disconnected && !peer.destroyed) peer.reconnect(); }
      catch(e) { initPeer(null); }
    }, delay);
  });

  peer.on('error', err => {
    if (!STATE.roomCode) return;
    if (err.type !== STATE._lastPeerErr) {
      log('PeerJS error: ' + err.type, 'l-err');
      STATE._lastPeerErr = err.type;
    }
    const fatal = ['network', 'server-error', 'socket-error', 'socket-closed'];
    if (fatal.includes(err.type)) {
      setSignal(1);
      STATE._peerRetries++;
      const delay = Math.min(2000 * STATE._peerRetries, 12000);
      clearTimeout(STATE._peerRetryTimer);
      STATE._peerRetryTimer = setTimeout(() => {
        if (STATE.roomCode) initPeer(null);
      }, delay);
    }
  });
}

// Call another peer (outgoing)
function callPeer(peerId) {
  if (!STATE.localStream) { log('No mic stream — cannot call', 'l-err'); return; }
  if (!STATE.peer)        { log('PeerJS not ready', 'l-err'); return; }
  if (STATE.peers[peerId]?.call) { log('Already connected to ' + peerId.slice(0,8), 'l-muted'); return; }

  log('Calling ' + (getRiderName(peerId) || peerId.slice(0, 8)) + '…', 'l-info');
  try {
    const call = STATE.peer.call(peerId, STATE.localStream, {
      metadata: { name: STATE.myName },
    });
    if (!call) { log('Call returned null', 'l-err'); return; }
    handleCallStream(call);
  } catch(e) {
    log('Call failed: ' + e.message, 'l-err');
  }
}

// Handle audio stream from a call (works for both incoming & outgoing)
function handleCallStream(call) {
  const peerId = call.peer;

  if (!STATE.peers[peerId]) STATE.peers[peerId] = {};
  STATE.peers[peerId].call = call;

  call.on('stream', remoteStream => {
    const name = getRiderName(peerId) || call.metadata?.name || 'Rider';
    log('🔊 Audio stream from ' + name + ' — playing…', 'l-ok');
    toast('🔊 ' + name + ' audio connected!');

    // Update name in UI if we have it from metadata
    if (call.metadata?.name) updateRiderName(peerId, call.metadata.name);

    const audioEl = playAudio(peerId, remoteStream);
    STATE.peers[peerId].audioEl = audioEl;
    setSignal(4);
  });

  call.on('close', () => {
    const name = getRiderName(peerId) || 'Rider';
    log(name + ' call closed', 'l-muted');
    stopAudio(peerId);
    if (STATE.peers[peerId]) delete STATE.peers[peerId].call;
  });

  call.on('error', e => {
    log('Call error: ' + e.message, 'l-err');
    stopAudio(peerId);
    delete STATE.peers[peerId];
  });
}

function cleanupPeer(peerId) {
  const p = STATE.peers[peerId];
  if (p) {
    try { p.call?.close(); } catch(e) {}
    stopAudio(peerId);
  }
  delete STATE.peers[peerId];
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function getRiderName(peerId) {
  const el = document.getElementById('rname_' + peerId);
  return el ? el.textContent : null;
}

function updateRiderName(peerId, name) {
  const el = document.getElementById('rname_' + peerId);
  if (el) el.textContent = name;
}

function addRiderUI(peerId, name) {
  if ($('rider_' + peerId)) return;
  const list = $('ridersList');
  const div  = document.createElement('div');
  div.className = 'rider-item';
  div.id = 'rider_' + peerId;
  div.innerHTML = `
    <div class="rider-avatar">${(name || '?')[0].toUpperCase()}</div>
    <div class="rider-info">
      <div class="rider-name" id="rname_${peerId}">${name || 'Rider'}</div>
      <div class="rider-status">● CONNECTED</div>
    </div>
    <div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>
  `;
  list.appendChild(div);
  updatePeerCount();
}

function removeRiderUI(peerId) {
  const el = $('rider_' + peerId); if (el) el.remove();
  updatePeerCount();
}

function setRiderSpeaking(peerId, val) {
  const el = $('rider_' + peerId);
  if (el) el.classList.toggle('speaking', !!val);
}

function updatePeerCount() {
  const n = document.querySelectorAll('#ridersList .rider-item').length;
  $('peerCount').textContent = n + ' rider' + (n !== 1 ? 's' : '');
}

// ── Volume ────────────────────────────────────────────────────────────────────
function setVolume(val) {
  const pct = parseInt(val, 10);
  STATE.volume = pct / 100;
  $('volVal').textContent = pct + '%';
  Object.values(STATE.peers).forEach(p => {
    if (p.audioEl) p.audioEl.volume = Math.min(STATE.volume * 2, 1);
  });
}

// ── PTT ───────────────────────────────────────────────────────────────────────
function startTalk(e) {
  if (e) e.preventDefault();
  if (!STATE.localStream || STATE.isTalking) return;
  STATE.isTalking = true;
  muteMic(false);
  $('pttBtn').classList.add('active');
  $('pttLabel').textContent = 'TRANSMITTING…';
  $('pttRing').classList.add('active');
  $('myRider')?.classList.add('speaking');
  wsSend({ type: 'speaking', value: true });
}

function stopTalk(e) {
  if (e) e.preventDefault();
  if (!STATE.isTalking) return;
  STATE.isTalking = false;
  muteMic(true);
  $('pttBtn').classList.remove('active');
  $('pttLabel').textContent = 'HOLD TO TALK';
  $('pttRing').classList.remove('active');
  $('myRider')?.classList.remove('speaking');
  wsSend({ type: 'speaking', value: false });
}

// Spacebar PTT on desktop
document.addEventListener('keydown', e => { if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); startTalk(); }});
document.addEventListener('keyup',   e => { if (e.code === 'Space') stopTalk(); });

// ── Join / Leave ──────────────────────────────────────────────────────────────
async function joinRoom() {
  const name = $('nameInput').value.trim();
  if (!name) { toast('Enter your name first'); return; }

  let roomCode = $('roomInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!roomCode) roomCode = genCode();

  STATE.myName   = name;
  STATE.roomCode = roomCode;

  const btn = $('joinBtn');
  btn.disabled  = true;
  btn.textContent = 'JOINING…';

  // 1. Request mic
  try {
    STATE.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
        sampleRate:       44100,
        channelCount:     1,
      },
      video: false,
    });
    muteMic(true);
    log('Microphone ready ✓', 'l-ok');
  } catch(e) {
    toast('Mic denied — check Settings > Safari/Chrome > Microphone');
    btn.disabled = false; btn.textContent = 'JOIN';
    return;
  }

  // 2. Switch screen
  showScreen('screenRoom');
  $('roomCodeDisplay').textContent  = roomCode;
  $('headerSub').textContent        = 'Room ' + roomCode + ' · ' + name;

  // 3. Add self to riders list
  const list = $('ridersList'); list.innerHTML = '';
  const self  = document.createElement('div');
  self.className = 'rider-item';
  self.id = 'myRider';
  self.innerHTML = `
    <div class="rider-avatar">${name[0].toUpperCase()}</div>
    <div class="rider-info">
      <div class="rider-name">${name} <span style="color:var(--muted);font-size:11px">(You)</span></div>
      <div class="rider-status">● YOU</div>
    </div>
    <div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>
  `;
  list.appendChild(self);
  updatePeerCount();

  // 4. Init PeerJS → on ready, connect Socket.IO
  initPeer(peerId => {
    log('Joining room ' + roomCode + ' as ' + name, 'l-ok');
    connectSocket(roomCode, name, peerId);
  });

  btn.disabled = false; btn.textContent = 'JOIN';
}

function leaveRoom() {
  STATE.roomCode = '';
  STATE.myPeerId = '';
  STATE.isTalking = false;

  clearTimeout(STATE._peerRetryTimer);

  // Disconnect socket
  wsSend({ type: 'leave' });
  if (_socket) { _socket.removeAllListeners(); try { _socket.disconnect(); } catch(e){} _socket = null; }

  // Destroy peer
  if (STATE.peer) { try { STATE.peer.destroy(); } catch(e){} STATE.peer = null; }

  // Stop mic
  if (STATE.localStream) { STATE.localStream.getTracks().forEach(t => t.stop()); STATE.localStream = null; }

  // Cleanup all audio
  Object.keys(STATE.peers).forEach(id => cleanupPeer(id));
  STATE.peers = {};
  STATE._peerRetries = 0;
  STATE._lastPeerErr = null;

  $('statusDot').className = 'status-dot';
  $('headerSub').textContent = 'Helmet Intercom · Local WiFi';
  setSignal(0);
  showScreen('screenJoin');
  $('ridersList').innerHTML = '';
  detectServer();
}

// ── QR Code ───────────────────────────────────────────────────────────────────
async function showQR() {
  const code = STATE.roomCode; if (!code) return;
  const url  = location.protocol + '//' + location.host + '/?room=' + code;
  showScreen('screenQR');
  $('qrRoomCode').textContent = code;
  $('qrUrl').textContent = url;
  try {
    const res  = await fetch('/qr?url=' + encodeURIComponent(url));
    const data = await res.json();
    if (data.qr) $('qrImg').src = data.qr;
  } catch(e) { $('qrUrl').textContent = 'Share manually: ' + url; }
}

function copyCode() {
  const url = location.protocol + '//' + location.host + '/?room=' + STATE.roomCode;
  navigator.clipboard.writeText(url)
    .then(() => toast('Link copied! Share with riders 🏍️'))
    .catch(() => toast('Code: ' + STATE.roomCode));
}

// ── Server detect ─────────────────────────────────────────────────────────────
async function detectServer() {
  const statusEl = $('serverStatusText');
  const dotEl    = document.querySelector('.server-status .dot');
  try {
    const res  = await fetch('/health', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data    = await res.json();
      const isHttps = location.protocol === 'https:';
      const onRail  = data.platform === 'railway';
      statusEl.textContent = onRail
        ? 'Railway server online ✅ · uptime ' + Math.floor(data.uptime) + 's'
        : 'Local server · ' + (isHttps ? 'HTTPS ✅' : 'HTTP ⚠️');
      dotEl.className = 'dot dot-ok';
      const certNotice = $('certNotice');
      if (certNotice) certNotice.style.display = (!onRail && isHttps) ? 'block' : 'none';
      return true;
    }
  } catch(e) {
    statusEl.textContent = 'Server not reachable';
    dotEl.className = 'dot dot-err';
  }
  return false;
}

// ── Connection banner ─────────────────────────────────────────────────────────
function showConnBanner(msg) {
  const b = $('connBanner'); if (!b) return;
  b.style.display = msg ? 'flex' : 'none';
  const t = $('connBannerText'); if (t && msg) t.textContent = msg;
}

function retryConnection() {
  if (!STATE.roomCode) return;
  showConnBanner('Retrying…');
  STATE._peerRetries = 0;
  if (_socket?.connected) {
    _socket.emit('join', { name: STATE.myName, roomCode: STATE.roomCode, peerId: STATE.myPeerId });
  } else {
    connectSocket(STATE.roomCode, STATE.myName, STATE.myPeerId);
  }
}

window.setSignal = function(n) {
  const b = $('signalBars'); if (!b) return;
  b.className = 'signal-bars' + (n > 0 ? ' s' + n : '');
  if (n <= 1 && STATE.roomCode) showConnBanner('Lost connection — retrying…');
  else if (n >= 3) showConnBanner(null);
};

// ── URL param auto-fill ───────────────────────────────────────────────────────
function checkUrlParams() {
  const p = new URLSearchParams(location.search);
  const r = p.get('room');
  if (r) { $('roomInput').value = r.toUpperCase(); toast('Room code pre-filled!'); }
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  detectServer();
  checkUrlParams();

  $('roomInput').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  $('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

  if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(() => {});
});
