'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  RideComm – Client App
// ═══════════════════════════════════════════════════════════════════════════

const STATE = {
  myName: '',
  roomCode: '',
  myPeerId: '',
  isTalking: false,
  volume: 1.0,
  // peers: { peerId: { call, gainNode, audioCtx, audioEl, name } }
  peers: {},
  // ws + peer
  ws: null,
  peer: null,
  localStream: null,
  reconnectTimer: null,
  pingTimer: null,
  wsConnected: false,
};

// ── Utilities ──────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = $(id);
  if (s) s.classList.add('active');
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function log(msg, type = 'l-muted') {
  const box = $('logBox');
  if (!box) return;
  const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = document.createElement('p');
  p.className = type;
  p.textContent = `[${ts}] ${msg}`;
  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
}

function setSignal(level) { // 0-4
  const bars = $('signalBars');
  if (!bars) return;
  bars.className = 'signal-bars' + (level > 0 ? ` s${level}` : '');
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function muteLocal(muted) {
  if (!STATE.localStream) return;
  STATE.localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
}

// ── Server detection ───────────────────────────────────────────────────────

async function detectServer() {
  const statusEl = $('serverStatusText');
  const dotEl = document.querySelector('.server-status .dot');
  try {
    const res = await fetch('/health', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const isHttps = location.protocol === 'https:';
      const isRailway = data.platform === 'railway';

      if (isRailway) {
        statusEl.textContent = 'Railway server online ✅ · uptime ' + Math.floor(data.uptime) + 's';
        dotEl.className = 'dot dot-ok';
        // No cert needed on Railway — hide cert notice
        const certNotice = $('certNotice');
        if (certNotice) certNotice.style.display = 'none';
      } else if (isHttps) {
        statusEl.textContent = 'Local server online · HTTPS ✅';
        dotEl.className = 'dot dot-ok';
        // Show cert notice for local HTTPS (iOS needs to trust it once)
        const certNotice = $('certNotice');
        if (certNotice) certNotice.style.display = 'block';
      } else {
        statusEl.textContent = 'Server online (HTTP — mic may not work on iPhone)';
        dotEl.className = 'dot dot-warn';
      }
      return true;
    }
  } catch (e) {
    statusEl.textContent = 'Server not reachable — check connection';
    dotEl.className = 'dot dot-err';
  }
  return false;
}

// ── Socket.IO presence bus ───────────────────────────────────────────────────
// Socket.IO works on ALL platforms including Railway, Heroku, etc.
// Falls back to HTTP long-polling if WebSocket is blocked

let _socket = null;

function connectWS(roomCode, name, peerId) {
  if (_socket) {
    _socket.removeAllListeners();
    _socket.disconnect();
    _socket = null;
  }

  log('Connecting via Socket.IO...', 'l-info');

  // io() is globally available from socket.io.min.js
  const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    timeout: 10000,
  });
  _socket = socket;
  STATE._wsRetries = 0;

  socket.on('connect', () => {
    STATE.wsConnected = true;
    STATE._wsRetries = 0;
    const transport = socket.io.engine.transport.name;
    log('Socket.IO connected ✓ via ' + transport, 'l-ok');
    setSignal(4);
    $('statusDot').className = 'status-dot online';
    // Join room immediately on connect
    socket.emit('join', { name, roomCode, peerId });

    // Log transport upgrades (polling → websocket)
    socket.io.engine.on('upgrade', () => {
      log('Transport upgraded to WebSocket ✓', 'l-ok');
    });
  });

  socket.on('msg', (data) => handleWSMsg(data));

  socket.on('disconnect', (reason) => {
    STATE.wsConnected = false;
    setSignal(1);
    log('Socket.IO disconnected: ' + reason, 'l-err');
  });

  socket.on('connect_error', (err) => {
    STATE._wsRetries = (STATE._wsRetries || 0) + 1;
    if (STATE._wsRetries <= 3) {
      log('Socket.IO error: ' + err.message, 'l-err');
    }
    setSignal(1);
  });
}

function wsSend(msg) {
  if (!_socket || !_socket.connected) return;
  if (msg.type === 'speaking') {
    _socket.emit('speaking', { value: msg.value });
  } else if (msg.type === 'leave') {
    _socket.emit('leave');
  } else if (msg.type === 'join') {
    _socket.emit('join', msg);
  }
}

// ── PeerJS ─────────────────────────────────────────────────────────────────

function initPeer(onReady) {
  if (STATE.peer) { try { STATE.peer.destroy(); } catch(e){} STATE.peer = null; }

  // Auto-detect from current page URL — works for Railway and local
  const isSecure = location.protocol === 'https:';
  const host = location.hostname;
  // Railway uses standard ports (443 for https, 80 for http) — no custom port
  // Local uses whatever port is in the URL
  const defaultPort = isSecure ? 443 : 80;
  const port = location.port ? parseInt(location.port, 10) : defaultPort;

  log('Connecting PeerJS → ' + host + ':' + port + ' (' + (isSecure ? 'wss' : 'ws') + ')...', 'l-info');

  const peer = new Peer(undefined, {
    host,
    port,
    path: '/peerjs',
    secure: isSecure,
    debug: 0,
    pingInterval: 20000,
    config: {
      iceServers: [
        // Public STUN servers for WebRTC hole-punching
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ]
    }
  });

  STATE.peer = peer;
  STATE._peerRetries = 0;

  peer.on('open', (id) => {
    STATE.myPeerId = id;
    STATE._peerRetries = 0;
    STATE._lastPeerErr = null;
    log('PeerJS ready ✓  ID: ' + id.slice(0, 8) + '…', 'l-ok');
    $('statusDot').className = 'status-dot online';
    setSignal(4);
    if (onReady) onReady(id);
  });

  peer.on('call', (call) => {
    call.answer(STATE.localStream);
    attachCallHandlers(call);
    log('Incoming call — answered', 'l-info');
  });

  peer.on('disconnected', () => {
    if (!STATE.roomCode) return;
    setSignal(2);
    $('statusDot').className = 'status-dot error';
    STATE._peerRetries = (STATE._peerRetries || 0) + 1;
    const delay = Math.min(1500 * STATE._peerRetries, 8000);
    log('PeerJS disconnected — retry in ' + (delay/1000) + 's...', 'l-err');
    clearTimeout(STATE._peerRetryTimer);
    STATE._peerRetryTimer = setTimeout(() => {
      if (!STATE.roomCode) return;
      try { if (peer.disconnected && !peer.destroyed) peer.reconnect(); }
      catch(e) { initPeer(null); }
    }, delay);
  });

  peer.on('error', (err) => {
    if (!STATE.roomCode) return;
    if (err.type !== STATE._lastPeerErr) {
      log('PeerJS error: ' + err.type, 'l-err');
      STATE._lastPeerErr = err.type;
    }
    if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
      setSignal(1);
      $('statusDot').className = 'status-dot error';
      STATE._peerRetries = (STATE._peerRetries || 0) + 1;
      const delay = Math.min(2000 * STATE._peerRetries, 12000);
      clearTimeout(STATE._peerRetryTimer);
      STATE._peerRetryTimer = setTimeout(() => {
        if (STATE.roomCode) initPeer(null);
      }, delay);
    }
  });
}

function callPeer(peerId) {
  if (!STATE.localStream || !STATE.peer) return;
  if (STATE.peers[peerId]) return; // already connected
  try {
    const call = STATE.peer.call(peerId, STATE.localStream);
    if (!call) return;
    attachCallHandlers(call);
    log('Calling ' + (getRiderName(peerId) || peerId.slice(0, 8)), 'l-info');
  } catch(e) {
    log('Call failed: ' + e.message, 'l-err');
  }
}

function attachCallHandlers(call) {
  const peerId = call.peer;

  call.on('stream', (remoteStream) => {
    log('Audio stream from ' + (getRiderName(peerId) || peerId.slice(0, 8)), 'l-ok');
    const entry = STATE.peers[peerId] || {};
    entry.call = call;

    // Web Audio for volume control
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(remoteStream);
      const gain = audioCtx.createGain();
      gain.gain.value = STATE.volume * 2;
      source.connect(gain);
      gain.connect(audioCtx.destination);
      entry.audioCtx = audioCtx;
      entry.gainNode = gain;
    } catch(e) {
      // Fallback: plain audio element
      const audio = getOrCreateAudio(peerId);
      audio.srcObject = remoteStream;
      audio.volume = Math.min(STATE.volume * 2, 1);
      entry.audioEl = audio;
    }

    STATE.peers[peerId] = entry;
    addRiderUI(peerId, getRiderName(peerId));
    setSignal(4);
  });

  call.on('close', () => {
    log('Call closed with ' + (getRiderName(peerId) || peerId.slice(0, 8)), 'l-muted');
    cleanupPeer(peerId);
  });

  call.on('error', (e) => {
    log('Call error: ' + e.message, 'l-err');
    cleanupPeer(peerId);
  });

  if (!STATE.peers[peerId]) STATE.peers[peerId] = {};
  STATE.peers[peerId].call = call;
}

function getOrCreateAudio(peerId) {
  let el = document.getElementById('audio_' + peerId);
  if (!el) {
    el = document.createElement('audio');
    el.id = 'audio_' + peerId;
    el.autoplay = true;
    el.playsInline = true;
    el.style.display = 'none';
    document.body.appendChild(el);
  }
  return el;
}

function cleanupPeer(peerId) {
  const p = STATE.peers[peerId];
  if (p) {
    try { if (p.call) p.call.close(); } catch(e){}
    try { if (p.audioCtx) p.audioCtx.close(); } catch(e){}
    try { if (p.audioEl) p.audioEl.remove(); } catch(e){}
  }
  delete STATE.peers[peerId];
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function getRiderName(peerId) {
  const el = $('name_' + peerId);
  return el ? el.textContent.replace(' (You)', '') : null;
}

function addRiderUI(peerId, name) {
  if ($('rider_' + peerId)) return;
  const list = $('ridersList');
  const div = document.createElement('div');
  div.className = 'rider-item';
  div.id = 'rider_' + peerId;
  const initial = (name || '?')[0].toUpperCase();
  div.innerHTML = `
    <div class="rider-avatar">${initial}</div>
    <div class="rider-info">
      <div class="rider-name" id="name_${peerId}">${name || 'Rider'}</div>
      <div class="rider-status">● CONNECTED</div>
    </div>
    <div class="wave-bars">
      <span></span><span></span><span></span><span></span><span></span>
    </div>
  `;
  list.appendChild(div);
  updatePeerCount();
}

function removeRiderUI(peerId) {
  const el = $('rider_' + peerId);
  if (el) el.remove();
  cleanupPeer(peerId);
  const audio = $('audio_' + peerId);
  if (audio) audio.remove();
  updatePeerCount();
}

function setRiderSpeaking(peerId, val) {
  const el = $('rider_' + peerId);
  if (el) {
    if (val) el.classList.add('speaking');
    else el.classList.remove('speaking');
  }
}

function updatePeerCount() {
  const items = document.querySelectorAll('#ridersList .rider-item');
  const n = items.length;
  $('peerCount').textContent = n + ' rider' + (n !== 1 ? 's' : '');
}

// ── Volume ─────────────────────────────────────────────────────────────────

function setVolume(val) {
  const pct = parseInt(val, 10);
  STATE.volume = pct / 100;
  $('volVal').textContent = pct + '%';
  Object.values(STATE.peers).forEach(p => {
    if (p.gainNode) p.gainNode.gain.value = STATE.volume * 2;
    if (p.audioEl) p.audioEl.volume = Math.min(STATE.volume * 2, 1);
  });
}

// ── PTT ────────────────────────────────────────────────────────────────────

function startTalk(e) {
  if (e) e.preventDefault();
  if (!STATE.localStream || STATE.isTalking) return;
  STATE.isTalking = true;
  muteLocal(false);
  $('pttBtn').classList.add('active');
  $('pttLabel').textContent = 'TRANSMITTING…';
  $('pttRing').classList.add('active');
  // Show my own speaking indicator
  const myRider = $('myRider');
  if (myRider) myRider.classList.add('speaking');
  wsSend({ type: 'speaking', value: true });
}

function stopTalk(e) {
  if (e) e.preventDefault();
  if (!STATE.isTalking) return;
  STATE.isTalking = false;
  muteLocal(true);
  $('pttBtn').classList.remove('active');
  $('pttLabel').textContent = 'HOLD TO TALK';
  $('pttRing').classList.remove('active');
  const myRider = $('myRider');
  if (myRider) myRider.classList.remove('speaking');
  wsSend({ type: 'speaking', value: false });
}

// Space bar PTT
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    startTalk();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') stopTalk();
});

// ── Join / Leave ───────────────────────────────────────────────────────────

async function joinRoom() {
  const name = $('nameInput').value.trim();
  if (!name) { toast('Enter your name first'); return; }

  let roomCode = $('roomInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!roomCode) roomCode = genCode();

  STATE.myName = name;
  STATE.roomCode = roomCode;

  const btn = $('joinBtn');
  btn.disabled = true;
  btn.textContent = 'JOINING…';

  // Request mic
  try {
    STATE.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 44100,
      },
      video: false
    });
    muteLocal(true); // start muted until PTT
  } catch (err) {
    toast('Mic access denied — check permissions');
    btn.disabled = false;
    btn.textContent = 'JOIN';
    return;
  }

  // Switch to room screen
  showScreen('screenRoom');
  $('roomCodeDisplay').textContent = roomCode;
  $('headerSub').textContent = `Room ${roomCode} · ${name}`;

  // Add self to riders list
  const list = $('ridersList');
  list.innerHTML = '';
  const selfDiv = document.createElement('div');
  selfDiv.className = 'rider-item';
  selfDiv.id = 'myRider';
  selfDiv.innerHTML = `
    <div class="rider-avatar">${name[0].toUpperCase()}</div>
    <div class="rider-info">
      <div class="rider-name">${name} <span style="color:var(--muted);font-size:11px">(You)</span></div>
      <div class="rider-status">● YOU</div>
    </div>
    <div class="wave-bars">
      <span></span><span></span><span></span><span></span><span></span>
    </div>
  `;
  list.appendChild(selfDiv);
  updatePeerCount();

  // Connect Socket.IO first (presence), then PeerJS (audio signaling)
  connectWS(roomCode, name, 'pending');
  initPeer((peerId) => {
    // Re-join with real peerId once PeerJS is ready
    if (_socket && _socket.connected) {
      _socket.emit('join', { name, roomCode, peerId });
    } else {
      // Socket not ready yet — reconnect with real peerId
      connectWS(roomCode, name, peerId);
    }
  });

  log(`Joined room ${roomCode} as ${name}`, 'l-ok');
  btn.disabled = false;
  btn.textContent = 'JOIN';
}

function leaveRoom() {
  // Stop all retry timers FIRST so nothing reconnects after we clear roomCode
  clearTimeout(STATE.reconnectTimer);
  clearTimeout(STATE._peerRetryTimer);
  clearInterval(STATE.pingTimer);

  // Clear roomCode early — stops all reconnect guards
  STATE.roomCode = '';
  STATE.myPeerId = '';

  // Notify others then close WS
  wsSend({ type: 'leave' });
  if (_socket) {
    _socket.removeAllListeners();
    try { _socket.disconnect(); } catch(e){}
    _socket = null;
  }

  // Destroy peer
  if (STATE.peer) {
    STATE.peer.removeAllListeners && STATE.peer.removeAllListeners();
    try { STATE.peer.destroy(); } catch(e){}
    STATE.peer = null;
  }

  // Stop mic
  if (STATE.localStream) {
    STATE.localStream.getTracks().forEach(t => t.stop());
    STATE.localStream = null;
  }

  // Cleanup all peer connections
  Object.keys(STATE.peers).forEach(id => cleanupPeer(id));
  STATE.peers = {};

  // Reset state
  STATE.isTalking = false;
  STATE.wsConnected = false;
  STATE._wsRetries = 0;
  STATE._peerRetries = 0;
  STATE._lastPeerErr = null;
  STATE.wsConnected = false;

  $('statusDot').className = 'status-dot';
  $('headerSub').textContent = 'Helmet Intercom · Local WiFi';
  setSignal(0);

  showScreen('screenJoin');
  $('ridersList').innerHTML = '';
  log('Left room', 'l-muted');
  detectServer();
}

// ── QR Code ────────────────────────────────────────────────────────────────

async function showQR() {
  const code = STATE.roomCode;
  if (!code) return;

  const baseUrl = `${location.protocol}//${location.host}`;
  const url = `${baseUrl}/?room=${code}`;

  showScreen('screenQR');
  $('qrRoomCode').textContent = code;
  $('qrUrl').textContent = url;

  try {
    const res = await fetch('/qr?url=' + encodeURIComponent(url));
    const data = await res.json();
    if (data.qr) $('qrImg').src = data.qr;
  } catch(e) {
    $('qrUrl').textContent = 'QR generation failed — share URL manually:\n' + url;
  }
}

// ── Copy code ──────────────────────────────────────────────────────────────

function copyCode() {
  const code = STATE.roomCode;
  if (!code) return;
  const url = `${location.protocol}//${location.host}/?room=${code}`;
  navigator.clipboard.writeText(url).then(() => {
    toast('Link copied! Share with riders 🏍️');
  }).catch(() => {
    toast('Code: ' + code);
  });
}

// ── Auto-fill room from URL param ──────────────────────────────────────────

function checkUrlParams() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) {
    $('roomInput').value = room.toUpperCase();
    toast('Room code pre-filled from link!');
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  detectServer();
  checkUrlParams();

  // Sanitize room code input
  $('roomInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });
  $('roomInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });

  // Wake lock to keep screen on (mobile)
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').catch(() => {});
  }
});

// ── Connection banner ──────────────────────────────────────────────────────
function showConnBanner(msg) {
  const b = document.getElementById('connBanner');
  const t = document.getElementById('connBannerText');
  if (!b) return;
  if (msg) {
    b.style.display = 'flex';
    if (t) t.textContent = msg;
  } else {
    b.style.display = 'none';
  }
}

function retryConnection() {
  if (!STATE.roomCode) return;
  showConnBanner('Retrying...');
  STATE._wsRetries = 0;
  STATE._peerRetries = 0;
  STATE._lastPeerErr = null;
  clearTimeout(STATE.reconnectTimer);
  clearTimeout(STATE._peerRetryTimer);
  connectWS(STATE.roomCode, STATE.myName, STATE.myPeerId || 'reconnecting');
  if (!STATE.peer || STATE.peer.destroyed) {
    initPeer(null);
  } else if (STATE.peer.disconnected) {
    try { STATE.peer.reconnect(); } catch(e) { initPeer(null); }
  }
}

// Patch log to also update banner
const _origLog = log;
// Override setSignal to manage banner
const _origSetSignal = setSignal;
window.setSignal = function(level) {
  _origSetSignal(level);
  if (level <= 1 && STATE.roomCode) {
    showConnBanner('Lost connection — retrying automatically...');
  } else if (level >= 3) {
    showConnBanner(null); // hide banner when reconnected
  }
};
