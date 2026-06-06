'use strict';
// RideComm — WebRTC + Socket.IO
// Mic control: tap button to mute/unmute

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
let sock         = null;
let myStream     = null;
let cleanStream  = null;
let noiseCtx     = null;
let myName       = '';
let myRoom       = '';
let isMuted      = true;   // start muted
let vol          = 1.0;
const PCS        = {};

// VOX state
let voxMode      = false;
let voxCtx       = null;
let voxRaf       = null;
let voxActive    = false;
let voxHoldTimer = null;
const VOX_THRESH = 18;
const VOX_HOLD   = 1500;

// NC state
let ncEnabled    = true;

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
  if (myStream)    myStream.getAudioTracks().forEach(t => { t.enabled = !yes; });
  if (cleanStream && cleanStream !== myStream)
    cleanStream.getAudioTracks().forEach(t => { t.enabled = !yes; });
}

function rnd6() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6}, () => c[Math.floor(Math.random()*c.length)]).join('');
}

// ── Noise Cancellation ────────────────────────────────
async function buildCleanStream(rawStream) {
  try {
    if (noiseCtx) { try { noiseCtx.close(); } catch(e){} noiseCtx = null; }
    noiseCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    const src  = noiseCtx.createMediaStreamSource(rawStream);

    // High-pass: remove low rumble/wind (< 80Hz)
    const hpf = noiseCtx.createBiquadFilter();
    hpf.type = 'highpass'; hpf.frequency.value = 80; hpf.Q.value = 0.7;

    // Low-pass: remove hiss (> 8kHz)
    const lpf = noiseCtx.createBiquadFilter();
    lpf.type = 'lowpass'; lpf.frequency.value = 8000; lpf.Q.value = 0.7;

    // Boost voice frequencies (1–3kHz)
    const mid = noiseCtx.createBiquadFilter();
    mid.type = 'peaking'; mid.frequency.value = 2000; mid.gain.value = 3; mid.Q.value = 0.8;

    // Compressor: reduce loud peaks, lift quiet voice
    const comp = noiseCtx.createDynamicsCompressor();
    comp.threshold.value = -45; comp.knee.value = 10;
    comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.25;

    // Gain boost after compression
    const gain = noiseCtx.createGain();
    gain.gain.value = 1.5;

    const dest = noiseCtx.createMediaStreamDestination();
    src.connect(hpf); hpf.connect(lpf); lpf.connect(mid);
    mid.connect(comp); comp.connect(gain); gain.connect(dest);

    log('Noise cancellation ✓', 'l-ok');
    return dest.stream;
  } catch(e) {
    log('NC fallback: ' + e.message, 'l-err');
    return rawStream;
  }
}

// ── Audio output ──────────────────────────────────────
function playAudio(sid, stream) {
  let a = document.getElementById('AUD_' + sid);
  if (!a) { a = document.createElement('audio'); a.id = 'AUD_' + sid; document.body.appendChild(a); }
  a.autoplay = true; a.playsInline = true; a.muted = false;
  a.volume   = Math.min(vol, 1.0);
  a.srcObject = stream;
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

  const streamToUse = cleanStream || myStream;
  if (streamToUse) streamToUse.getTracks().forEach(t => pc.addTrack(t, streamToUse));

  pc.ontrack = ev => {
    const s = ev.streams?.[0] || new MediaStream([ev.track]);
    log('🔊 Audio from ' + rname + ' ✓', 'l-ok');
    toast('🔊 ' + rname + ' connected!');
    playAudio(sid, s); setSig(4);
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
    const o = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:false });
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
    transports: ['polling','websocket'], upgrade: true,
    reconnection: true, reconnectionDelay: 1000,
    reconnectionDelayMax: 5000, timeout: 20000, forceNew: true,
  });

  sock.on('connect', () => {
    log('Connected ✓ (' + sock.io.engine.transport.name + ')', 'l-ok');
    setSig(4); $('statusDot').className = 'status-dot online';
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
    if (PCS[socketId]) { try { PCS[socketId].close(); } catch(e){} delete PCS[socketId]; }
  });

  sock.on('offer',         ({ from, name, offer }) => { addUI(from, name||'Rider'); recvOffer(from, name||'Rider', offer); });
  sock.on('answer',        ({ from, answer })       => { recvAnswer(from, answer); });
  sock.on('ice-candidate', ({ from, candidate })    => { addICE(from, candidate); });

  sock.on('speaking', ({ socketId, value }) => {
    $('R_' + socketId)?.classList.toggle('speaking', !!value);
  });

  sock.on('disconnect', reason => {
    log('Disconnected: ' + reason, 'l-err');
    setSig(1); $('statusDot').className = 'status-dot error';
    if (myRoom) showBanner('Reconnecting...');
  });

  sock.on('connect_error', err => { log('Error: ' + err.message, 'l-err'); setSig(1); });
}

// ── Mic toggle (TAP to mute/unmute) ──────────────────
function toggleMic() {
  if (voxMode) return; // VOX controls mic automatically

  isMuted = !isMuted;
  muteMic(isMuted);
  updateMicUI();
  sock?.emit('speaking', { value: !isMuted });
  log(isMuted ? 'Muted 🔇' : 'Unmuted 🎙️', 'l-info');
}

function updateMicUI() {
  const btn   = $('micBtn');
  const label = $('micLabel');
  const ring  = $('pttRing');
  const myR   = $('myRider');

  if (isMuted) {
    // MUTED state
    btn?.classList.remove('active');
    ring?.classList.remove('active');
    myR?.classList.remove('speaking');
    if (label) label.textContent = 'TAP TO SPEAK';
    if (btn) {
      btn.style.background   = 'var(--surface2)';
      btn.style.borderColor  = 'var(--border)';
    }
    // Update mic icon
    const icon = $('micIcon');
    if (icon) icon.textContent = '🔇';
  } else {
    // UNMUTED / SPEAKING state
    btn?.classList.add('active');
    ring?.classList.add('active');
    myR?.classList.add('speaking');
    if (label) label.textContent = 'TAP TO MUTE';
    if (btn) {
      btn.style.background  = 'rgba(255,149,0,0.12)';
      btn.style.borderColor = 'var(--orange)';
    }
    const icon = $('micIcon');
    if (icon) icon.textContent = '🎙️';
  }
}

// ── VOX Engine ────────────────────────────────────────
function toggleVOX() {
  voxMode = !voxMode;
  const btn = $('voxBtn');

  if (voxMode) {
    if (btn) { btn.textContent = '🔊 VOX: ON'; btn.style.color = '#22c55e'; btn.style.borderColor = '#22c55e66'; }
    // Unmute so analyser can work
    muteMic(false); isMuted = false;
    startVOX();
    // Disable tap-to-speak button
    const mb = $('micBtn');
    if (mb) { mb.style.opacity = '0.4'; mb.style.pointerEvents = 'none'; }
    log('VOX mode ON — speak to transmit', 'l-ok');
    toast('🔊 VOX ON — speak to transmit!');
  } else {
    if (btn) { btn.textContent = '🔊 VOX: OFF'; btn.style.color = 'var(--muted)'; btn.style.borderColor = 'rgba(255,255,255,0.08)'; }
    stopVOX();
    // Re-enable tap button, reset to muted
    isMuted = true; muteMic(true);
    updateMicUI();
    const mb = $('micBtn');
    if (mb) { mb.style.opacity = '1'; mb.style.pointerEvents = 'auto'; }
    sock?.emit('speaking', { value: false });
    log('VOX mode OFF', 'l-info');
    toast('VOX OFF — tap button to speak');
  }
}

function startVOX() {
  stopVOX();
  if (!myStream) return;
  try {
    voxCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src  = voxCtx.createMediaStreamSource(myStream);
    const anlz = voxCtx.createAnalyser();
    anlz.fftSize = 512; anlz.smoothingTimeConstant = 0.4;
    src.connect(anlz);
    const buf   = new Uint8Array(anlz.frequencyBinCount);
    const binsz = voxCtx.sampleRate / anlz.fftSize;
    const lo    = Math.floor(200  / binsz);
    const hi    = Math.floor(4000 / binsz);

    function tick() {
      if (!voxMode) { stopVOX(); return; }
      anlz.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = lo; i < hi && i < buf.length; i++) sum += buf[i];
      const avg = sum / (hi - lo);

      if (avg >= VOX_THRESH) {
        clearTimeout(voxHoldTimer); voxHoldTimer = null;
        if (!voxActive) {
          voxActive = true;
          muteMic(false);
          sock?.emit('speaking', { value: true });
          $('micBtn')?.classList.add('active');
          $('micLabel') && ($('micLabel').textContent = 'SPEAKING…');
          $('micIcon')  && ($('micIcon').textContent  = '🎙️');
          $('pttRing')?.classList.add('active');
          $('myRider')?.classList.add('speaking');
        }
      } else {
        if (voxActive && !voxHoldTimer) {
          voxHoldTimer = setTimeout(() => {
            voxActive = false; voxHoldTimer = null;
            muteMic(true);
            sock?.emit('speaking', { value: false });
            $('micBtn')?.classList.remove('active');
            $('micLabel') && ($('micLabel').textContent = 'LISTENING…');
            $('micIcon')  && ($('micIcon').textContent  = '🔊');
            $('pttRing')?.classList.remove('active');
            $('myRider')?.classList.remove('speaking');
          }, VOX_HOLD);
        }
      }
      voxRaf = requestAnimationFrame(tick);
    }
    tick();
    log('VOX engine started ✓', 'l-ok');
  } catch(e) { log('VOX error: ' + e.message, 'l-err'); }
}

function stopVOX() {
  if (voxRaf)      { cancelAnimationFrame(voxRaf); voxRaf = null; }
  if (voxHoldTimer){ clearTimeout(voxHoldTimer);   voxHoldTimer = null; }
  if (voxCtx)      { try { voxCtx.close(); } catch(e){} voxCtx = null; }
  voxActive = false;
}

// ── Noise Cancellation toggle ─────────────────────────
async function toggleNC() {
  ncEnabled = !ncEnabled;
  const btn = $('ncBtn');
  if (ncEnabled) {
    if (btn) { btn.textContent = '🎚️ NC: ON'; btn.style.color = '#22c55e'; btn.style.borderColor = '#22c55e66'; }
    if (myStream) { cleanStream = await buildCleanStream(myStream); await rebuildTracks(); }
    toast('🎚️ Noise Cancellation ON');
  } else {
    if (btn) { btn.textContent = '🎚️ NC: OFF'; btn.style.color = 'var(--muted)'; btn.style.borderColor = 'rgba(255,255,255,0.08)'; }
    cleanStream = myStream;
    await rebuildTracks();
    toast('🎚️ Noise Cancellation OFF');
  }
  log('NC: ' + (ncEnabled ? 'ON' : 'OFF'), 'l-info');
}

async function rebuildTracks() {
  const s     = cleanStream || myStream;
  const track = s?.getAudioTracks()[0];
  if (!track) return;
  for (const pc of Object.values(PCS)) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (sender) await sender.replaceTrack(track).catch(() => {});
  }
}

// ── Rider UI ──────────────────────────────────────────
function addUI(sid, name) {
  if ($('R_' + sid)) return;
  const d = document.createElement('div');
  d.className = 'rider-item'; d.id = 'R_' + sid;
  d.innerHTML =
    '<div class="rider-avatar">' + (name||'?')[0].toUpperCase() + '</div>' +
    '<div class="rider-info">' +
      '<div class="rider-name">' + (name||'Rider') + '</div>' +
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
  const p = parseInt(v); vol = p / 100;
  $('volVal').textContent = p + '%';
  document.querySelectorAll('audio[id^="AUD_"]').forEach(a => { a.volume = Math.min(vol, 1); });
}

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
        echoCancellation:     { ideal: true },
        noiseSuppression:     { ideal: true },
        autoGainControl:      { ideal: true },
        googEchoCancellation: true,
        googEchoCancellation2:true,
        googNoiseSuppression: true,
        googNoiseSuppression2:true,
        googAutoGainControl:  true,
        googHighpassFilter:   true,
        channelCount: 1, sampleRate: 48000,
      },
      video: false,
    });

    // Build noise-cancelled stream
    cleanStream = ncEnabled ? await buildCleanStream(myStream) : myStream;

    // Start MUTED
    isMuted = true; muteMic(true);
    log('Mic ready ✓ (NC: ' + (ncEnabled ? 'ON' : 'OFF') + ')', 'l-ok');
  } catch(e) {
    toast('Mic denied — please allow microphone access');
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

  // Set initial button states
  updateMicUI();

  initSocket();
  btn.disabled = false; btn.textContent = 'JOIN';
}

// ── Leave ─────────────────────────────────────────────
function leaveRoom() {
  isMuted = true; myName = ''; myRoom = '';
  voxMode = false; stopVOX();
  muteMic(true);
  sock?.emit('speaking', { value: false });

  Object.keys(PCS).forEach(sid => {
    try { PCS[sid].close(); } catch(e) {}
    killAudio(sid); delete PCS[sid];
  });

  if (noiseCtx) { try { noiseCtx.close(); } catch(e){} noiseCtx = null; }
  cleanStream = null;
  if (myStream) { myStream.getTracks().forEach(t => t.stop()); myStream = null; }
  if (sock) { sock.removeAllListeners(); try { sock.disconnect(); } catch(e){} sock = null; }

  $('statusDot').className = 'status-dot';
  $('headerSub').textContent = 'Helmet Intercom';
  setSig(0); showScreen('screenJoin');
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
    el.textContent = 'Server not reachable'; dot.className = 'dot dot-err';
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
