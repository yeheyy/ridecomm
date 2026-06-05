'use strict';
// RideComm — WebRTC + Socket.IO + 3-Mode PTT/VOX/OpenMic

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

// ── Globals ───────────────────────────────────────────
let sock         = null;
let myStream     = null;  // raw mic stream
let myName       = '';
let myRoom       = '';
let talking      = false; // PTT active?
let vol          = 1.0;
const PCS        = {};    // PCS[socketId] = RTCPeerConnection

// ── 3 Modes ───────────────────────────────────────────
// 0 = PTT  (hold button)
// 1 = VOX  (auto voice detect)
// 2 = OPEN (always on)
let MODE         = 0;

// VOX state
let voxCtx       = null;
let voxRaf       = null;
let voxActive    = false;
let voxHoldTimer = null;
const VOX_THRESH = 18;   // voice energy threshold (0-255)
const VOX_HOLD   = 1500; // ms to hold open after silence

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
  const ts = new Date().toLocaleTimeString('en', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const p  = document.createElement('p');
  p.className   = cls;
  p.textContent = '[' + ts + '] ' + msg;
  b.appendChild(p);
  b.scrollTop   = 9999;
}

function setSig(n) {
  const b = $('signalBars');
  if (b) b.className = 'signal-bars' + (n > 0 ? ' s' + n : '');
}

function muteMic(yes) {
  if (myStream) myStream.getAudioTracks().forEach(t => { t.enabled = !yes; });
}

function rnd6() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6}, () => c[Math.floor(Math.random()*c.length)]).join('');
}

// ── Audio output ──────────────────────────────────────
function playAudio(sid, stream) {
  let a = document.getElementById('AUD_' + sid);
  if (!a) {
    a             = document.createElement('audio');
    a.id          = 'AUD_' + sid;
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
  if (a) { try { a.srcObject = null; a.pause(); } catch(e) {} a.remove(); }
}

// ── WebRTC ────────────────────────────────────────────
function makePC(sid, rname) {
  if (PCS[sid]) { try { PCS[sid].close(); } catch(e) {} delete PCS[sid]; }
  const pc = new RTCPeerConnection(ICE);
  PCS[sid] = pc;

  if (myStream) myStream.getTracks().forEach(t => pc.addTrack(t, myStream));

  pc.ontrack = ev => {
    const s = ev.streams?.[0] || new MediaStream([ev.track]);
    log('🔊 Audio from ' + rname + ' ✓', 'l-ok');
    toast('🔊 ' + rname + ' connected!');
    playAudio(sid, s);
    setSig(4);
  };

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
  if (sock) { sock.removeAllListeners(); try { sock.disconnect(); } catch(e) {} sock = null; }

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
    log('Existing riders: ' + members.length, 'l-ok');
    members.forEach(m => { addUI(m.socketId, m.name); sendOffer(m.socketId, m.name); });
  });

  sock.on('peer-joined', ({ socketId, name }) => {
    log(name + ' joined!', 'l-ok');
    toast('🏍️ ' + name + ' joined!');
    addUI(socketId, name);
  });

  sock.on('peer-left', ({ socketId, name }) => {
    log((name||'Rider') + ' left', 'l-info');
    toast('👋 ' + (name||'Rider') + ' left');
    removeUI(socketId); killAudio(socketId);
    if (PCS[socketId]) { try { PCS[socketId].close(); } catch(e) {} delete PCS[socketId]; }
  });

  sock.on('offer',         ({ from, name, offer })  => { addUI(from, name||'Rider'); recvOffer(from, name||'Rider', offer); });
  sock.on('answer',        ({ from, answer })        => { recvAnswer(from, answer); });
  sock.on('ice-candidate', ({ from, candidate })     => { addICE(from, candidate); });

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

// ── Rider UI ──────────────────────────────────────────
function addUI(sid, name) {
  if ($('R_' + sid)) return;
  const d = document.createElement('div');
  d.className = 'rider-item';
  d.id        = 'R_' + sid;
  d.innerHTML =
    '<div class="rider-avatar">' + (name||'?')[0].toUpperCase() + '</div>' +
    '<div class="rider-info">' +
      '<div class="rider-name">' + (name||'Rider') + '</div>' +
      '<div class="rider-status">● CONNECTED</div>' +
    '</div>' +
    '<div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>';
  $('ridersList').appendChild(d);
  updCnt();
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

// ═══════════════════════════════════════════════════════
//  3-MODE SYSTEM
// ═══════════════════════════════════════════════════════

const MODES = [
  { label: '🎙️ PUSH TO TALK', color: '#ff9500', hint: 'Hold button · release to stop' },
  { label: '🔊 VOX (AUTO)',   color: '#22c55e', hint: 'Speak to transmit automatically' },
  { label: '🔴 OPEN MIC',    color: '#ff4444', hint: 'Always transmitting' },
];

function toggleMode() {
  // Stop current mode cleanly
  cleanupCurrentMode();

  MODE = (MODE + 1) % 3;
  applyMode();
}

function cleanupCurrentMode() {
  // PTT cleanup
  if (talking) {
    talking = false;
    muteMic(true);
    sock?.emit('speaking', { value: false });
    $('pttBtn')?.classList.remove('active');
    $('pttRing')?.classList.remove('active');
    $('myRider')?.classList.remove('speaking');
  }
  // VOX cleanup
  stopVOX();
}

function applyMode() {
  const m = MODES[MODE];

  // Update button
  const btn = $('modeBtn');
  if (btn) {
    btn.textContent   = m.label;
    btn.style.color   = m.color;
    btn.style.borderColor = m.color + '66';
  }

  // Update hint text
  const hint = qs('.ptt-hint');
  if (hint) hint.textContent = m.hint;

  // Update PTT button appearance
  const pttBtn = $('pttBtn');

  if (MODE === 0) {
    // ── PTT MODE ─────────────────────────────────────
    muteMic(true); // muted until button held
    $('pttLabel').textContent = 'HOLD TO TALK';
    if (pttBtn) { pttBtn.style.opacity = '1'; pttBtn.style.pointerEvents = 'auto'; }
    log('Mode: Push-to-Talk ✓', 'l-info');
    toast('🎙️ PTT — hold button to speak');

  } else if (MODE === 1) {
    // ── VOX MODE ─────────────────────────────────────
    muteMic(false); // unmute so analyser can hear
    $('pttLabel').textContent = 'LISTENING…';
    if (pttBtn) { pttBtn.style.opacity = '0.5'; pttBtn.style.pointerEvents = 'none'; }
    startVOX();
    log('Mode: VOX voice-activated ✓', 'l-info');
    toast('🔊 VOX — speak to transmit!');

  } else if (MODE === 2) {
    // ── OPEN MIC MODE ────────────────────────────────
    muteMic(false); // always unmuted
    talking = true;
    $('pttLabel').textContent = 'OPEN MIC';
    $('pttBtn')?.classList.add('active');
    $('pttRing')?.classList.add('active');
    $('myRider')?.classList.add('speaking');
    if (pttBtn) { pttBtn.style.opacity = '0.5'; pttBtn.style.pointerEvents = 'none'; }
    sock?.emit('speaking', { value: true });
    log('Mode: Open Mic ✓', 'l-info');
    toast('🔴 Open Mic — always transmitting!');
  }
}

// ── VOX Engine ────────────────────────────────────────
function startVOX() {
  stopVOX();
  if (!myStream) { log('VOX: no stream', 'l-err'); return; }

  try {
    voxCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src  = voxCtx.createMediaStreamSource(myStream);
    const anlz = voxCtx.createAnalyser();
    anlz.fftSize                = 512;
    anlz.smoothingTimeConstant  = 0.4;
    src.connect(anlz);

    const buf   = new Uint8Array(anlz.frequencyBinCount);
    const sr    = voxCtx.sampleRate;
    const binsz = sr / anlz.fftSize;
    const lo    = Math.floor(200  / binsz);  // 200 Hz
    const hi    = Math.floor(4000 / binsz);  // 4000 Hz

    function tick() {
      if (MODE !== 1) { stopVOX(); return; }
      anlz.getByteFrequencyData(buf);

      let sum = 0;
      for (let i = lo; i < hi && i < buf.length; i++) sum += buf[i];
      const avg = sum / (hi - lo);

      if (avg >= VOX_THRESH) {
        // ── Voice detected ──────────────────────────
        clearTimeout(voxHoldTimer);
        voxHoldTimer = null;

        if (!voxActive) {
          voxActive = true;
          muteMic(false);
          sock?.emit('speaking', { value: true });
          $('pttBtn')?.classList.add('active');
          $('pttLabel').textContent = 'TRANSMITTING…';
          $('pttRing')?.classList.add('active');
          $('myRider')?.classList.add('speaking');
        }
      } else {
        // ── Silence ─────────────────────────────────
        if (voxActive && !voxHoldTimer) {
          voxHoldTimer = setTimeout(() => {
            voxActive    = false;
            voxHoldTimer = null;
            muteMic(true);
            sock?.emit('speaking', { value: false });
            $('pttBtn')?.classList.remove('active');
            $('pttLabel').textContent = 'LISTENING…';
            $('pttRing')?.classList.remove('active');
            $('myRider')?.classList.remove('speaking');
          }, VOX_HOLD);
        }
      }

      voxRaf = requestAnimationFrame(tick);
    }

    tick();
    log('VOX engine started ✓ (threshold=' + VOX_THRESH + ')', 'l-ok');
  } catch(e) {
    log('VOX start error: ' + e.message, 'l-err');
  }
}

function stopVOX() {
  if (voxRaf)      { cancelAnimationFrame(voxRaf); voxRaf = null; }
  if (voxHoldTimer){ clearTimeout(voxHoldTimer);   voxHoldTimer = null; }
  if (voxCtx)      { try { voxCtx.close(); } catch(e) {} voxCtx = null; }
  voxActive = false;
}

// ── PTT button handlers ───────────────────────────────
function startTalk(e) {
  if (e) e.preventDefault();
  if (MODE !== 0) return;          // only PTT mode
  if (!myStream || talking) return;
  talking = true;
  muteMic(false);
  $('pttBtn').classList.add('active');
  $('pttLabel').textContent = 'TRANSMITTING…';
  $('pttRing').classList.add('active');
  $('myRider')?.classList.add('speaking');
  sock?.emit('speaking', { value: true });
}

function stopTalk(e) {
  if (e) e.preventDefault();
  if (MODE !== 0) return;          // only PTT mode
  if (!talking) return;
  talking = false;
  muteMic(true);
  $('pttBtn').classList.remove('active');
  $('pttLabel').textContent = 'HOLD TO TALK';
  $('pttRing').classList.remove('active');
  $('myRider')?.classList.remove('speaking');
  sock?.emit('speaking', { value: false });
}

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); startTalk(); }
});
document.addEventListener('keyup', e => { if (e.code === 'Space') stopTalk(); });

// ── Join ──────────────────────────────────────────────
async function joinRoom() {
  const name = ($('nameInput').value || '').trim();
  if (!name) { toast('Enter your name first'); return; }

  let code = ($('roomInput').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) code = rnd6();

  myName = name; myRoom = code;
  const btn = $('joinBtn');
  btn.disabled = true; btn.textContent = 'JOINING…';

  try {
    myStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation:         { ideal: true },
        noiseSuppression:         { ideal: true },
        autoGainControl:          { ideal: true },
        googEchoCancellation:     true,
        googEchoCancellation2:    true,
        googNoiseSuppression:     true,
        googNoiseSuppression2:    true,
        googAutoGainControl:      true,
        googHighpassFilter:       true,
        channelCount:             1,
        sampleRate:               48000,
      },
      video: false,
    });
    // Start muted (PTT default)
    muteMic(true);
    log('Mic ready ✓', 'l-ok');
  } catch(e) {
    toast('Mic denied — please allow microphone');
    myName = ''; myRoom = '';
    btn.disabled = false; btn.textContent = 'JOIN';
    return;
  }

  showScreen('screenRoom');
  $('roomCodeDisplay').textContent = code;
  $('headerSub').textContent       = 'Room ' + code + ' · ' + name;

  $('ridersList').innerHTML = '';
  const me = document.createElement('div');
  me.className = 'rider-item'; me.id = 'myRider';
  me.innerHTML =
    '<div class="rider-avatar">' + name[0].toUpperCase() + '</div>' +
    '<div class="rider-info">' +
      '<div class="rider-name">' + name + ' <span style="color:var(--muted);font-size:11px">(You)</span></div>' +
      '<div class="rider-status">● YOU</div>' +
    '</div>' +
    '<div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>';
  $('ridersList').appendChild(me);
  updCnt();

  // Reset to PTT mode and apply
  MODE = 0;
  applyMode();

  initSocket();
  btn.disabled = false; btn.textContent = 'JOIN';
}

// ── Leave ─────────────────────────────────────────────
function leaveRoom() {
  cleanupCurrentMode();
  MODE     = 0;
  myName   = '';
  myRoom   = '';

  Object.keys(PCS).forEach(sid => {
    try { PCS[sid].close(); } catch(e) {}
    killAudio(sid);
    delete PCS[sid];
  });

  if (myStream) { myStream.getTracks().forEach(t => t.stop()); myStream = null; }
  if (sock)     { sock.removeAllListeners(); try { sock.disconnect(); } catch(e) {} sock = null; }

  $('statusDot').className = 'status-dot';
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

// ── Server health ─────────────────────────────────────
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
