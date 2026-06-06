'use strict';
// RideComm — WebRTC + Socket.IO
// Mic: tap to mute/unmute | VOX: voice activated | NC: noise cancel

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
let sock        = null;
let myStream    = null;   // raw mic stream
let cleanStream = null;   // noise-cancelled stream
let noiseCtx    = null;
let myName      = '';
let myRoom      = '';
let isMuted     = true;   // mic starts muted
let vol         = 1.0;
const PCS       = {};     // PCS[socketId] = RTCPeerConnection

// VOX
let voxOn       = false;
let voxCtx      = null;
let voxRaf      = null;
let voxActive   = false;
let voxTimer    = null;
const VOX_DB    = 18;     // sensitivity threshold
const VOX_HOLD  = 1500;   // ms to stay open after silence

// Noise cancel
let ncOn        = true;

// ── DOM helpers ───────────────────────────────────────
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
  const ts = new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
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

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6}, () => c[Math.floor(Math.random()*c.length)]).join('');
}

// ── Mic mute/unmute ───────────────────────────────────
function setMicEnabled(enabled) {
  // Enable/disable tracks on BOTH raw and clean stream
  if (myStream)
    myStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
  if (cleanStream && cleanStream !== myStream)
    cleanStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
}

// ── Noise Cancellation pipeline ───────────────────────
async function buildCleanStream(raw) {
  try {
    if (noiseCtx) { try { noiseCtx.close(); } catch(e){} noiseCtx = null; }

    noiseCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    const src  = noiseCtx.createMediaStreamSource(raw);

    // 1. High-pass — cut low rumble/wind below 80Hz
    const hpf  = noiseCtx.createBiquadFilter();
    hpf.type   = 'highpass';
    hpf.frequency.value = 80;
    hpf.Q.value = 0.7;

    // 2. Low-pass — cut hiss above 8kHz
    const lpf  = noiseCtx.createBiquadFilter();
    lpf.type   = 'lowpass';
    lpf.frequency.value = 8000;
    lpf.Q.value = 0.7;

    // 3. Presence boost — lift voice clarity (2kHz)
    const mid  = noiseCtx.createBiquadFilter();
    mid.type   = 'peaking';
    mid.frequency.value = 2000;
    mid.gain.value = 4;
    mid.Q.value = 0.8;

    // 4. Compressor — reduce loud bursts, lift quiet voice
    const comp = noiseCtx.createDynamicsCompressor();
    comp.threshold.value = -45;
    comp.knee.value      = 10;
    comp.ratio.value     = 12;
    comp.attack.value    = 0.003;
    comp.release.value   = 0.25;

    // 5. Output gain
    const gain = noiseCtx.createGain();
    gain.gain.value = 1.4;

    // Chain: src → hpf → lpf → mid → comp → gain → dest
    const dest = noiseCtx.createMediaStreamDestination();
    src.connect(hpf);
    hpf.connect(lpf);
    lpf.connect(mid);
    mid.connect(comp);
    comp.connect(gain);
    gain.connect(dest);

    log('Noise cancellation pipeline ready ✓', 'l-ok');
    return dest.stream;
  } catch(e) {
    log('NC fallback to raw: ' + e.message, 'l-err');
    return raw;
  }
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
  if (a) { try { a.srcObject = null; a.pause(); } catch(e){} a.remove(); }
}

// ── WebRTC ────────────────────────────────────────────
function makePC(sid, rname) {
  if (PCS[sid]) { try { PCS[sid].close(); } catch(e){} delete PCS[sid]; }

  const pc       = new RTCPeerConnection(ICE);
  PCS[sid]       = pc;

  // Use noise-cancelled stream for sending
  const tx = cleanStream || myStream;
  if (tx) tx.getTracks().forEach(t => pc.addTrack(t, tx));

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
  if (sock) { sock.removeAllListeners(); try { sock.disconnect(); } catch(e){} sock = null; }

  sock = io(window.location.origin, {
    transports: ['polling', 'websocket'], upgrade: true,
    reconnection: true, reconnectionDelay: 1000,
    reconnectionDelayMax: 5000, timeout: 20000, forceNew: true,
  });

  sock.on('connect', () => {
    log('Server connected ✓ (' + sock.io.engine.transport.name + ')', 'l-ok');
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

  sock.on('connect_error', err => { log('Connect error: ' + err.message, 'l-err'); setSig(1); });
}

// ══════════════════════════════════════════════════════
//  MIC CONTROL — tap to mute / unmute
// ══════════════════════════════════════════════════════

function toggleMic() {
  if (voxOn) return; // VOX mode handles mic automatically

  isMuted = !isMuted;
  setMicEnabled(!isMuted);
  updateMicUI();
  sock?.emit('speaking', { value: !isMuted });
  log(isMuted ? '🔇 Muted' : '🎙️ Unmuted — speaking', 'l-info');
}

function updateMicUI() {
  const btn   = $('micBtn');
  const icon  = $('micIcon');
  const label = $('micLabel');
  const ring  = $('pttRing');
  const meEl  = $('myRider');

  if (isMuted) {
    // ── MUTED ────────────────────────────────────────
    if (icon)  icon.textContent  = '🔇';
    if (label) label.textContent = 'TAP TO SPEAK';
    btn?.classList.remove('active');
    ring?.classList.remove('active');
    meEl?.classList.remove('speaking');
    if (btn) {
      btn.style.background  = '';
      btn.style.borderColor = '';
    }
  } else {
    // ── UNMUTED / SPEAKING ───────────────────────────
    if (icon)  icon.textContent  = '🎙️';
    if (label) label.textContent = 'TAP TO MUTE';
    btn?.classList.add('active');
    ring?.classList.add('active');
    meEl?.classList.add('speaking');
    if (btn) {
      btn.style.background  = 'rgba(255,149,0,0.12)';
      btn.style.borderColor = 'var(--orange)';
    }
  }
}

// ══════════════════════════════════════════════════════
//  VOX — voice activated auto mute/unmute
// ══════════════════════════════════════════════════════

function toggleVOX() {
  voxOn = !voxOn;
  const btn = $('voxBtn');

  if (voxOn) {
    // Start VOX
    if (btn) {
      btn.textContent   = '🔊 VOX: ON';
      btn.style.color   = '#22c55e';
      btn.style.borderColor = 'rgba(34,197,94,0.5)';
    }
    // Disable the manual mic button
    const mb = $('micBtn');
    if (mb) { mb.style.opacity = '0.35'; mb.style.pointerEvents = 'none'; }

    // Start mic enabled so analyser can detect voice
    isMuted = false;
    setMicEnabled(true);
    startVOX();
    log('VOX ON — speak to transmit automatically', 'l-ok');
    toast('🔊 VOX ON — just speak naturally!');
  } else {
    // Stop VOX
    if (btn) {
      btn.textContent   = '🔊 VOX: OFF';
      btn.style.color   = 'var(--muted)';
      btn.style.borderColor = 'rgba(255,255,255,0.08)';
    }
    stopVOX();
    // Re-enable manual button, reset to muted
    const mb = $('micBtn');
    if (mb) { mb.style.opacity = '1'; mb.style.pointerEvents = 'auto'; }
    isMuted = true;
    setMicEnabled(false);
    updateMicUI();
    sock?.emit('speaking', { value: false });
    log('VOX OFF — tap button to speak', 'l-info');
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
    anlz.fftSize              = 512;
    anlz.smoothingTimeConstant = 0.4;
    src.connect(anlz);

    const buf   = new Uint8Array(anlz.frequencyBinCount);
    const binsz = voxCtx.sampleRate / anlz.fftSize;
    const lo    = Math.floor(200  / binsz);   // 200 Hz
    const hi    = Math.floor(4000 / binsz);   // 4000 Hz

    function tick() {
      if (!voxOn) { stopVOX(); return; }

      anlz.getByteFrequencyData(buf);
      let sum = 0;
      const len = Math.min(hi, buf.length);
      for (let i = lo; i < len; i++) sum += buf[i];
      const avg = sum / (len - lo);

      if (avg >= VOX_DB) {
        // ── Voice detected ─────────────────────────
        clearTimeout(voxTimer);
        voxTimer = null;

        if (!voxActive) {
          voxActive = true;
          isMuted   = false;
          setMicEnabled(true);
          sock?.emit('speaking', { value: true });

          const icon  = $('micIcon');
          const label = $('micLabel');
          const ring  = $('pttRing');
          $('micBtn')?.classList.add('active');
          $('myRider')?.classList.add('speaking');
          ring?.classList.add('active');
          if (icon)  icon.textContent  = '🎙️';
          if (label) label.textContent = 'SPEAKING…';
        }
      } else {
        // ── Silence ────────────────────────────────
        if (voxActive && !voxTimer) {
          voxTimer = setTimeout(() => {
            voxActive = false;
            voxTimer  = null;
            isMuted   = true;
            setMicEnabled(false);
            sock?.emit('speaking', { value: false });

            const icon  = $('micIcon');
            const label = $('micLabel');
            const ring  = $('pttRing');
            $('micBtn')?.classList.remove('active');
            $('myRider')?.classList.remove('speaking');
            ring?.classList.remove('active');
            if (icon)  icon.textContent  = '🔇';
            if (label) label.textContent = 'LISTENING…';
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

// ══════════════════════════════════════════════════════
//  NC — noise cancellation toggle
// ══════════════════════════════════════════════════════

async function toggleNC() {
  ncOn = !ncOn;
  const btn = $('ncBtn');

  if (ncOn) {
    if (btn) { btn.textContent = '🎚️ NC: ON'; btn.style.color = '#22c55e'; btn.style.borderColor = 'rgba(34,197,94,0.4)'; }
    if (myStream) {
      cleanStream = await buildCleanStream(myStream);
      await replaceTrack();
    }
    toast('🎚️ Noise Cancellation ON');
    log('NC: ON', 'l-ok');
  } else {
    if (btn) { btn.textContent = '🎚️ NC: OFF'; btn.style.color = 'var(--muted)'; btn.style.borderColor = 'rgba(255,255,255,0.08)'; }
    cleanStream = myStream;
    await replaceTrack();
    toast('🎚️ Noise Cancellation OFF');
    log('NC: OFF', 'l-info');
  }
}

async function replaceTrack() {
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
  log(name + ' added to room ✓', 'l-ok');
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

// ── Join room ─────────────────────────────────────────
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

  // Get microphone
  try {
    myStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation:      { ideal: true },
        noiseSuppression:      { ideal: true },
        autoGainControl:       { ideal: true },
        googEchoCancellation:  true,
        googEchoCancellation2: true,
        googNoiseSuppression:  true,
        googNoiseSuppression2: true,
        googAutoGainControl:   true,
        googHighpassFilter:    true,
        channelCount:          1,
        sampleRate:            48000,
      },
      video: false,
    });

    // Build noise-cancelled stream
    cleanStream = ncOn ? await buildCleanStream(myStream) : myStream;

    // Start MUTED — user taps to speak
    isMuted = true;
    setMicEnabled(false);
    log('Mic ready ✓  NC: ' + (ncOn ? 'ON' : 'OFF'), 'l-ok');
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

  // Add self to list
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

  // Reset UI to muted state
  updateMicUI();

  // Connect to server
  initSocket();

  btn.disabled    = false;
  btn.textContent = 'JOIN';
}

// ── Leave room ────────────────────────────────────────
function leaveRoom() {
  // Reset all state
  isMuted = true;
  voxOn   = false;
  myName  = '';
  myRoom  = '';

  // Stop VOX
  stopVOX();

  // Stop mic
  setMicEnabled(false);
  sock?.emit('speaking', { value: false });

  // Close all peer connections
  Object.keys(PCS).forEach(sid => {
    try { PCS[sid].close(); } catch(e) {}
    killAudio(sid);
    delete PCS[sid];
  });

  // Cleanup audio context
  if (noiseCtx) { try { noiseCtx.close(); } catch(e){} noiseCtx = null; }
  cleanStream = null;

  // Stop microphone tracks
  if (myStream) {
    myStream.getTracks().forEach(t => t.stop());
    myStream = null;
  }

  // Disconnect socket
  if (sock) {
    sock.removeAllListeners();
    try { sock.disconnect(); } catch(e){}
    sock = null;
  }

  $('statusDot').className  = 'status-dot';
  $('headerSub').textContent = 'Helmet Intercom';
  setSig(0);
  showScreen('screenJoin');
  $('ridersList').innerHTML = '';
  detectServer();
}

// ── QR Code ───────────────────────────────────────────
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
    el.textContent = (d.platform === 'railway' ? 'Railway ✅' : 'Local ✅') + ' · ' + d.uptime + 's uptime';
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
