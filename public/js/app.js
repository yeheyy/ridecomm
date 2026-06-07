'use strict';
// RideComm — WebRTC + Socket.IO
// Clean audio — browser native processing only, no Web Audio pipeline

// ── ICE/TURN ──────────────────────────────────────────
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',                username:'openrelayproject',credential:'openrelayproject'},
    { urls: 'turn:openrelay.metered.ca:443',               username:'openrelayproject',credential:'openrelayproject'},
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username:'openrelayproject',credential:'openrelayproject'},
  ],
};

// ── State ─────────────────────────────────────────────
let sock     = null;
let myStream = null;   // mic stream
let myName   = '';
let myRoom   = '';
let isMuted  = true;   // starts muted
let vol      = 1.0;
const PCS    = {};     // PCS[socketId] = RTCPeerConnection

// VOX
let voxOn     = false;
let voxCtx    = null;
let voxRaf    = null;
let voxActive = false;
let voxTimer  = null;
const VOX_DB  = 15;    // voice detection threshold (0-255)
const VOX_HOLD = 1500; // ms to stay open after silence

// ── DOM ───────────────────────────────────────────────
const $  = id => document.getElementById(id);
const qs = s  => document.querySelector(s);

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
  const ts = new Date().toLocaleTimeString('en', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = document.createElement('p');
  p.className   = cls;
  p.textContent = '[' + ts + '] ' + msg;
  b.appendChild(p);
  b.scrollTop   = 9999;
}

function setSig(n) {
  const b = $('signalBars');
  if (b) b.className = 'signal-bars' + (n > 0 ? ' s' + n : '');
}

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length: 6}, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ── Mic enable/disable ────────────────────────────────
function setMic(enabled) {
  if (myStream)
    myStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
}

// ── Audio output ──────────────────────────────────────
function playAudio(sid, stream) {
  let a = document.getElementById('AUD_' + sid);
  if (!a) {
    a = document.createElement('audio');
    a.id = 'AUD_' + sid;
    document.body.appendChild(a);
  }
  a.autoplay    = true;
  a.playsInline = true;
  a.muted       = false;
  a.volume      = Math.min(vol, 1.0);
  a.srcObject   = stream;
  a.play().catch(() => {
    const fn = () => a.play().catch(() => {});
    document.addEventListener('click',    fn, { once: true });
    document.addEventListener('touchend', fn, { once: true });
  });
}

function killAudio(sid) {
  const a = document.getElementById('AUD_' + sid);
  if (a) { try { a.srcObject = null; a.pause(); } catch(e){} a.remove(); }
}

// ── WebRTC ────────────────────────────────────────────
function makePC(sid, rname) {
  if (PCS[sid]) { try { PCS[sid].close(); } catch(e){} delete PCS[sid]; }

  const pc = new RTCPeerConnection(ICE);
  PCS[sid] = pc;

  // Add mic tracks to this connection
  if (myStream) myStream.getTracks().forEach(t => pc.addTrack(t, myStream));

  // Receive remote audio
  pc.ontrack = ev => {
    const s = ev.streams?.[0] || new MediaStream([ev.track]);
    log('🔊 Audio from ' + rname + ' ✓', 'l-ok');
    toast('🔊 ' + rname + ' connected!');
    playAudio(sid, s);
    setSig(4);
  };

  // Send ICE candidates
  pc.onicecandidate = ev => {
    if (ev.candidate && sock)
      sock.emit('ice-candidate', { to: sid, candidate: ev.candidate.toJSON() });
  };

  pc.oniceconnectionstatechange = () => {
    log('ICE(' + rname + '): ' + pc.iceConnectionState, 'l-muted');
    if (pc.iceConnectionState === 'failed') try { pc.restartIce(); } catch(e) {}
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      killAudio(sid); delete PCS[sid]; removeUI(sid);
    }
  };

  return pc;
}

async function sendOffer(sid, rname) {
  const pc = makePC(sid, rname);
  try {
    const o = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
    await pc.setLocalDescription(o);
    sock.emit('offer', { to: sid, offer: pc.localDescription });
    log('Offer → ' + rname, 'l-info');
  } catch(e) { log('Offer err: ' + e.message, 'l-err'); }
}

async function recvOffer(sid, rname, offer) {
  const pc = makePC(sid, rname);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const a = await pc.createAnswer();
    await pc.setLocalDescription(a);
    sock.emit('answer', { to: sid, answer: pc.localDescription });
    log('Answer → ' + rname, 'l-info');
  } catch(e) { log('Answer err: ' + e.message, 'l-err'); }
}

async function recvAnswer(sid, answer) {
  const pc = PCS[sid]; if (!pc) return;
  try {
    if (pc.signalingState === 'have-local-offer')
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch(e) { log('recvAnswer err: ' + e.message, 'l-err'); }
}

async function addICE(sid, cand) {
  const pc = PCS[sid]; if (!pc || !cand) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch(e) {}
}

// ── Socket.IO ─────────────────────────────────────────
function initSocket() {
  if (sock) { sock.removeAllListeners(); try { sock.disconnect(); } catch(e){} sock = null; }

  sock = io(window.location.origin, {
    transports:           ['polling', 'websocket'],
    upgrade:              true,
    reconnection:         true,
    reconnectionDelay:    1000,
    reconnectionDelayMax: 5000,
    timeout:              20000,
    forceNew:             true,
  });

  sock.on('connect', () => {
    log('Connected ✓ (' + sock.io.engine.transport.name + ')', 'l-ok');
    setSig(4);
    $('statusDot').className = 'status-dot online';
    showBanner(null);
    sock.emit('join', { name: myName, roomCode: myRoom });
    sock.io.engine.on('upgrade', () => log('Upgraded to WebSocket ✓', 'l-ok'));
  });

  sock.on('room-members', ({ members }) => {
    log('Room members: ' + members.length, 'l-ok');
    members.forEach(m => { addUI(m.socketId, m.name); sendOffer(m.socketId, m.name); });
  });

  sock.on('peer-joined', ({ socketId, name }) => {
    log(name + ' joined!', 'l-ok');
    toast('🏍️ ' + name + ' joined!');
    addUI(socketId, name);
  });

  sock.on('peer-left', ({ socketId, name }) => {
    log((name || 'Rider') + ' left', 'l-info');
    toast('👋 ' + (name || 'Rider') + ' left');
    removeUI(socketId); killAudio(socketId);
    if (PCS[socketId]) { try { PCS[socketId].close(); } catch(e){} delete PCS[socketId]; }
  });

  sock.on('offer',         ({ from, name, offer }) => { addUI(from, name || 'Rider'); recvOffer(from, name || 'Rider', offer); });
  sock.on('answer',        ({ from, answer })       => { recvAnswer(from, answer); });
  sock.on('ice-candidate', ({ from, candidate })    => { addICE(from, candidate); });

  sock.on('speaking', ({ socketId, value }) => {
    $('R_' + socketId)?.classList.toggle('speaking', !!value);
  });

  sock.on('disconnect', reason => {
    log('Disconnected: ' + reason, 'l-err');
    setSig(1);
    $('statusDot').className = 'status-dot error';
    if (myRoom) showBanner('Reconnecting...');
  });

  sock.on('connect_error', err => { log('Error: ' + err.message, 'l-err'); setSig(1); });
}

// ══════════════════════════════════════════════════════
//  MIC — tap to mute / unmute
// ══════════════════════════════════════════════════════

function toggleMic() {
  if (voxOn) return; // VOX handles mic
  isMuted = !isMuted;
  setMic(!isMuted);
  updateMicUI();
  sock?.emit('speaking', { value: !isMuted });
  log(isMuted ? '🔇 Muted' : '🎙️ Speaking', 'l-info');
}

function updateMicUI() {
  const btn   = $('micBtn');
  const icon  = $('micIcon');
  const label = $('micLabel');
  const ring  = $('pttRing');
  const me    = $('myRider');

  if (isMuted) {
    if (icon)  icon.textContent  = '🔇';
    if (label) label.textContent = 'TAP TO SPEAK';
    btn?.classList.remove('active');
    ring?.classList.remove('active');
    me?.classList.remove('speaking');
    if (btn) { btn.style.background = ''; btn.style.borderColor = ''; }
  } else {
    if (icon)  icon.textContent  = '🎙️';
    if (label) label.textContent = 'TAP TO MUTE';
    btn?.classList.add('active');
    ring?.classList.add('active');
    me?.classList.add('speaking');
    if (btn) {
      btn.style.background  = 'rgba(255,149,0,0.12)';
      btn.style.borderColor = 'var(--orange)';
    }
  }
}

// ══════════════════════════════════════════════════════
//  VOX — voice activated auto speak
// ══════════════════════════════════════════════════════

function toggleVOX() {
  voxOn = !voxOn;
  const btn = $('voxBtn');

  if (voxOn) {
    if (btn) { btn.textContent = '🔊 VOX: ON'; btn.style.color = '#22c55e'; btn.style.borderColor = 'rgba(34,197,94,0.5)'; }
    const mb = $('micBtn');
    if (mb) { mb.style.opacity = '0.35'; mb.style.pointerEvents = 'none'; }
    // Unmute so analyser can hear
    isMuted = true;
    setMic(true); // keep enabled so VOX analyser works
    startVOX();
    log('VOX ON — speak to transmit', 'l-ok');
    toast('🔊 VOX ON — just speak!');
  } else {
    if (btn) { btn.textContent = '🔊 VOX: OFF'; btn.style.color = 'var(--muted)'; btn.style.borderColor = 'rgba(255,255,255,0.08)'; }
    stopVOX();
    const mb = $('micBtn');
    if (mb) { mb.style.opacity = '1'; mb.style.pointerEvents = 'auto'; }
    isMuted = true;
    setMic(false);
    updateMicUI();
    sock?.emit('speaking', { value: false });
    log('VOX OFF', 'l-info');
    toast('VOX OFF');
  }
}

function startVOX() {
  stopVOX();
  if (!myStream) { log('VOX: no mic stream', 'l-err'); return; }

  try {
    voxCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src  = voxCtx.createMediaStreamSource(myStream);
    const anlz = voxCtx.createAnalyser();
    anlz.fftSize               = 512;
    anlz.smoothingTimeConstant = 0.3;
    src.connect(anlz);

    const buf   = new Uint8Array(anlz.frequencyBinCount);
    const binsz = voxCtx.sampleRate / anlz.fftSize;
    const lo    = Math.floor(200  / binsz);
    const hi    = Math.floor(4000 / binsz);

    function tick() {
      if (!voxOn) { stopVOX(); return; }

      anlz.getByteFrequencyData(buf);
      let sum = 0;
      const end = Math.min(hi, buf.length);
      for (let i = lo; i < end; i++) sum += buf[i];
      const avg = sum / (end - lo);

      if (avg >= VOX_DB) {
        clearTimeout(voxTimer); voxTimer = null;
        if (!voxActive) {
          voxActive = true;
          setMic(true);
          sock?.emit('speaking', { value: true });
          $('micBtn')?.classList.add('active');
          $('pttRing')?.classList.add('active');
          $('myRider')?.classList.add('speaking');
          const icon  = $('micIcon');  if (icon)  icon.textContent  = '🎙️';
          const label = $('micLabel'); if (label) label.textContent = 'SPEAKING…';
        }
      } else {
        if (voxActive && !voxTimer) {
          voxTimer = setTimeout(() => {
            voxActive = false; voxTimer = null;
            setMic(false);
            sock?.emit('speaking', { value: false });
            $('micBtn')?.classList.remove('active');
            $('pttRing')?.classList.remove('active');
            $('myRider')?.classList.remove('speaking');
            const icon  = $('micIcon');  if (icon)  icon.textContent  = '🔇';
            const label = $('micLabel'); if (label) label.textContent = 'LISTENING…';
          }, VOX_HOLD);
        }
      }
      voxRaf = requestAnimationFrame(tick);
    }
    tick();
    log('VOX engine running ✓', 'l-ok');
  } catch(e) {
    log('VOX error: ' + e.message, 'l-err');
    voxOn = false;
  }
}

function stopVOX() {
  if (voxRaf)   { cancelAnimationFrame(voxRaf); voxRaf = null; }
  if (voxTimer) { clearTimeout(voxTimer);       voxTimer = null; }
  if (voxCtx)   { try { voxCtx.close(); } catch(e){} voxCtx = null; }
  voxActive = false;
}

// ── Rider UI ──────────────────────────────────────────
function addUI(sid, name) {
  if ($('R_' + sid)) return;
  const d = document.createElement('div');
  d.className = 'rider-item';
  d.id        = 'R_' + sid;
  d.innerHTML =
    '<div class="rider-avatar">' + (name || '?')[0].toUpperCase() + '</div>' +
    '<div class="rider-info">' +
      '<div class="rider-name">' + (name || 'Rider') + '</div>' +
      '<div class="rider-status">● CONNECTED</div>' +
    '</div>' +
    '<div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>';
  $('ridersList').appendChild(d);
  updCnt();
  log(name + ' added ✓', 'l-ok');
}

function removeUI(sid) { $('R_' + sid)?.remove(); updCnt(); }

function updCnt() {
  const n = $('ridersList').querySelectorAll('.rider-item').length;
  $('peerCount').textContent = n + ' rider' + (n !== 1 ? 's' : '');
}

// ── Volume ────────────────────────────────────────────
function setVolume(v) {
  const p = parseInt(v);
  vol = p / 100;
  $('volVal').textContent = p + '%';
  document.querySelectorAll('audio[id^="AUD_"]').forEach(a => { a.volume = Math.min(vol, 1); });
}

// ── Join ──────────────────────────────────────────────
async function joinRoom() {
  const name = ($('nameInput').value || '').trim();
  if (!name) { toast('Enter your name first'); return; }

  let code = ($('roomInput').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) code = genCode();

  myName = name;
  myRoom = code;

  const btn = $('joinBtn');
  btn.disabled    = true;
  btn.textContent = 'JOINING…';

  // Get mic — let the browser handle all processing natively
  // Browser echo cancellation + noise suppression is the best available
  try {
    myStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // ── Browser native processing — handles everything cleanly ──────
        echoCancellation: true,   // removes speaker echo
        noiseSuppression: true,   // removes background noise
        autoGainControl:  true,   // keeps volume consistent
        // ── Best quality settings ───────────────────────────────────────
        channelCount:     1,      // mono — less bleed
        sampleRate:       48000,  // 48kHz — best voice quality
      },
      video: false,
    });

    // Start MUTED — user taps to speak
    isMuted = true;
    setMic(false);
    log('Mic ready ✓ (browser native processing)', 'l-ok');
  } catch(e) {
    toast('Mic access denied — please allow microphone');
    myName = ''; myRoom = '';
    btn.disabled    = false;
    btn.textContent = 'JOIN';
    return;
  }

  // Show room screen
  showScreen('screenRoom');
  $('roomCodeDisplay').textContent = code;
  $('headerSub').textContent       = 'Room ' + code + ' · ' + name;

  // Add self to riders list
  $('ridersList').innerHTML = '';
  const me = document.createElement('div');
  me.className = 'rider-item';
  me.id        = 'myRider';
  me.innerHTML =
    '<div class="rider-avatar">' + name[0].toUpperCase() + '</div>' +
    '<div class="rider-info">' +
      '<div class="rider-name">' + name + ' <span style="color:var(--muted);font-size:11px">(You)</span></div>' +
      '<div class="rider-status">● YOU</div>' +
    '</div>' +
    '<div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>';
  $('ridersList').appendChild(me);
  updCnt();

  // Set UI to muted state
  updateMicUI();

  // Connect to server
  initSocket();

  btn.disabled    = false;
  btn.textContent = 'JOIN';
}

// ── Leave ─────────────────────────────────────────────
function leaveRoom() {
  isMuted = true;
  voxOn   = false;
  myName  = '';
  myRoom  = '';

  stopVOX();
  setMic(false);
  sock?.emit('speaking', { value: false });

  Object.keys(PCS).forEach(sid => {
    try { PCS[sid].close(); } catch(e){}
    killAudio(sid);
    delete PCS[sid];
  });

  if (myStream) { myStream.getTracks().forEach(t => t.stop()); myStream = null; }

  if (sock) { sock.removeAllListeners(); try { sock.disconnect(); } catch(e){} sock = null; }

  $('statusDot').className   = 'status-dot';
  $('headerSub').textContent = 'Helmet Intercom';
  setSig(0);
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
  $('qrUrl').textContent      = url;
  try {
    const d = await (await fetch('/qr?url=' + encodeURIComponent(url))).json();
    if (d.qr) $('qrImg').src = d.qr;
  } catch(e) {}
}

function copyCode() {
  navigator.clipboard.writeText(location.origin + '/?room=' + myRoom)
    .then(() => toast('Link copied! 🏍️'))
    .catch(() => toast('Code: ' + myRoom));
}

// ── Health ────────────────────────────────────────────
async function detectServer() {
  const el  = $('serverStatusText');
  const dot = qs('.server-status .dot');
  try {
    const d = await (await fetch('/health', { signal: AbortSignal.timeout(5000) })).json();
    el.textContent = (d.platform === 'railway' ? 'Railway ✅' : 'Local ✅') + ' · ' + d.uptime + 's';
    dot.className  = 'dot dot-ok';
    const cn = $('certNotice');
    if (cn) cn.style.display = (d.platform !== 'railway' && location.protocol === 'https:') ? 'block' : 'none';
  } catch(e) {
    el.textContent = 'Server not reachable';
    dot.className  = 'dot dot-err';
  }
}

function showBanner(msg) {
  const b = $('connBanner'); if (!b) return;
  b.style.display = msg ? 'flex' : 'none';
  const t = $('connBannerText'); if (t && msg) t.textContent = msg;
}

function retryConnection() {
  if (sock?.connected) sock.emit('join', { name: myName, roomCode: myRoom });
  else if (sock) sock.connect();
}

window.setSignal = function(n) {
  const b = $('signalBars'); if (!b) return;
  b.className = 'signal-bars' + (n > 0 ? ' s' + n : '');
  if (n <= 1 && myRoom) showBanner('Lost connection — reconnecting...');
  else if (n >= 3)      showBanner(null);
};

// ── Init ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  detectServer();
  const p = new URLSearchParams(location.search).get('room');
  if (p) { $('roomInput').value = p.toUpperCase(); toast('Room pre-filled!'); }
  $('roomInput').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  $('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(() => {});
});
