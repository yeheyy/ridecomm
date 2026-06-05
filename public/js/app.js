'use strict';
// RideComm v5 — Pure WebRTC signaling via Socket.IO

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',                username:'openrelayproject',credential:'openrelayproject'},
    { urls: 'turn:openrelay.metered.ca:443',               username:'openrelayproject',credential:'openrelayproject'},
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username:'openrelayproject',credential:'openrelayproject'},
  ],
};

// ── globals ───────────────────────────────────────────
let sock        = null;
let myStream    = null;
let myName      = '';
let myRoom      = '';
let talking     = false;
let vol         = 1.0;
let otherstalking = 0; // count of how many remote riders are speaking
const PCS       = {};   // PCS[remoteSocketId] = RTCPeerConnection

// ── tiny DOM helpers ──────────────────────────────────
const $  = id => document.getElementById(id);
const qs = s  => document.querySelector(s);

function screen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id) && $(id).classList.add('active');
}

let _tt;
function toast(m) {
  const t=$('toast'); t.textContent=m; t.classList.add('show');
  clearTimeout(_tt); _tt=setTimeout(()=>t.classList.remove('show'),2500);
}

function log(msg, c='l-muted') {
  const b=$('logBox'); if(!b) return;
  const ts=new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const p=document.createElement('p'); p.className=c;
  p.textContent='['+ts+'] '+msg; b.appendChild(p); b.scrollTop=9999;
}

function sig(n) {
  const b=$('signalBars');
  if(b) b.className='signal-bars'+(n>0?' s'+n:'');
}

function mute(yes) {
  if(myStream) myStream.getAudioTracks().forEach(t=>{t.enabled=!yes;});
}

function rnd6() {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6},()=>c[Math.floor(Math.random()*c.length)]).join('');
}

// ── audio ─────────────────────────────────────────────
function playAudio(sid, stream) {
  let a=document.getElementById('A_'+sid);
  if(!a){ a=document.createElement('audio'); a.id='A_'+sid; document.body.appendChild(a); }
  a.autoplay=true; a.playsInline=true; a.muted=false;
  // Keep volume at 100% max to reduce echo feedback loop
  a.volume=Math.min(vol, 1.0);
  a.srcObject=stream;
  a.play().catch(()=>{
    const fn=()=>a.play().catch(()=>{});
    document.addEventListener('click',fn,{once:true});
    document.addEventListener('touchend',fn,{once:true});
  });
}

function killAudio(sid) {
  const a=document.getElementById('A_'+sid);
  if(a){try{a.srcObject=null;a.pause();}catch(e){}a.remove();}
}

// ── RTCPeerConnection ─────────────────────────────────
function makePC(sid, rname) {
  if(PCS[sid]){ try{PCS[sid].close();}catch(e){} delete PCS[sid]; }
  log('PC create → '+rname,'l-info');
  const pc=new RTCPeerConnection(ICE);
  PCS[sid]=pc;

  // add my tracks
  if(myStream) myStream.getTracks().forEach(t=>pc.addTrack(t,myStream));

  // receive remote audio
  pc.ontrack=ev=>{
    const s=ev.streams&&ev.streams[0]?ev.streams[0]:new MediaStream([ev.track]);
    log('🔊 audio from '+rname+' ✓','l-ok');
    toast('🔊 '+rname+' audio connected!');
    playAudio(sid,s); sig(4);
  };

  // send ICE
  pc.onicecandidate=ev=>{
    if(ev.candidate && sock)
      sock.emit('ice-candidate',{to:sid,candidate:ev.candidate.toJSON()});
  };

  pc.oniceconnectionstatechange=()=>{
    log('ICE('+rname+'):'+pc.iceConnectionState,'l-muted');
    if(pc.iceConnectionState==='failed') try{pc.restartIce();}catch(e){}
  };

  pc.onconnectionstatechange=()=>{
    log('PC('+rname+'):'+pc.connectionState,'l-muted');
    if(pc.connectionState==='failed'||pc.connectionState==='closed'){
      killAudio(sid); delete PCS[sid]; removeUI(sid);
    }
  };
  return pc;
}

async function sendOffer(sid,rname){
  const pc=makePC(sid,rname);
  try{
    const o=await pc.createOffer({offerToReceiveAudio:true,offerToReceiveVideo:false});
    await pc.setLocalDescription(o);
    sock.emit('offer',{to:sid,offer:pc.localDescription});
    log('offer → '+rname,'l-info');
  }catch(e){log('sendOffer err:'+e.message,'l-err');}
}

async function recvOffer(sid,rname,offer){
  const pc=makePC(sid,rname);
  try{
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const a=await pc.createAnswer();
    await pc.setLocalDescription(a);
    sock.emit('answer',{to:sid,answer:pc.localDescription});
    log('answer → '+rname,'l-info');
  }catch(e){log('recvOffer err:'+e.message,'l-err');}
}

async function recvAnswer(sid,answer){
  const pc=PCS[sid]; if(!pc) return;
  try{
    if(pc.signalingState==='have-local-offer'){
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      log('answer ✓','l-ok');
    }
  }catch(e){log('recvAnswer err:'+e.message,'l-err');}
}

async function addICE(sid,cand){
  const pc=PCS[sid]; if(!pc||!cand) return;
  try{await pc.addIceCandidate(new RTCIceCandidate(cand));}catch(e){}
}

// ── Socket.IO — set up ONCE ───────────────────────────
function initSocket(){
  // Destroy old socket completely
  if(sock){
    sock.removeAllListeners();
    try{sock.disconnect();}catch(e){}
    sock=null;
  }

  log('Connecting to server...','l-info');

  // IMPORTANT: pass explicit URL so it works on Railway
  sock=io(window.location.origin, {
    transports:          ['polling','websocket'],
    upgrade:             true,
    reconnection:        true,
    reconnectionDelay:   1000,
    reconnectionDelayMax:5000,
    timeout:             20000,
    forceNew:            true,
  });

  sock.on('connect',()=>{
    log('Socket connected ✓ id='+sock.id.slice(0,8)+' via '+sock.io.engine.transport.name,'l-ok');
    sig(4);
    $('statusDot').className='status-dot online';
    showBanner(null);
    // Always rejoin room on connect/reconnect
    sock.emit('join',{name:myName,roomCode:myRoom});
    log('Emitted join → room:'+myRoom+' name:'+myName,'l-info');
  });

  // ── room-members: existing riders → I call them ──────
  sock.on('room-members',({members})=>{
    log('room-members: '+members.length+' existing rider(s)','l-ok');
    if(members.length===0){
      log('You are first in this room — waiting for others...','l-info');
      return;
    }
    members.forEach(m=>{
      log('Existing: '+m.name+' sid='+m.socketId.slice(0,8),'l-info');
      addUI(m.socketId, m.name);
      sendOffer(m.socketId, m.name);
    });
  });

  // ── peer-joined: new rider joined → they call me ─────
  sock.on('peer-joined',({socketId,name})=>{
    log(name+' joined! sid='+socketId.slice(0,8),'l-ok');
    toast('🏍️ '+name+' joined!');
    addUI(socketId, name);
    // they will send us an offer via their room-members handler
  });

  // ── peer-left ─────────────────────────────────────────
  sock.on('peer-left',({socketId,name})=>{
    log((name||'Rider')+' left','l-info');
    toast('👋 '+(name||'Rider')+' left');
    removeUI(socketId);
    killAudio(socketId);
    if(PCS[socketId]){try{PCS[socketId].close();}catch(e){}delete PCS[socketId];}
  });

  // ── WebRTC signaling ──────────────────────────────────
  sock.on('offer',({from,name,offer})=>{
    log('offer from '+(name||from.slice(0,8)),'l-info');
    addUI(from, name||'Rider');
    recvOffer(from, name||'Rider', offer);
  });

  sock.on('answer',({from,answer})=>{
    log('answer from '+from.slice(0,8),'l-info');
    recvAnswer(from,answer);
  });

  sock.on('ice-candidate',({from,candidate})=>{
    addICE(from,candidate);
  });

  // ── speaking ──────────────────────────────────────────
  sock.on('speaking',({socketId,value})=>{
    const el=$('R_'+socketId);
    if(el) el.classList.toggle('speaking',!!value);
    // Echo suppression: when remote rider speaks, track count
    // This helps the browser AEC know when to suppress feedback
    if(value) otherstalking++;
    else otherstalking = Math.max(0, otherstalking - 1);
  });

  sock.on('disconnect',reason=>{
    log('Disconnected: '+reason,'l-err');
    sig(1);
    $('statusDot').className='status-dot error';
    if(myRoom) showBanner('Reconnecting...');
  });

  sock.on('connect_error',err=>{
    log('Connect error: '+err.message,'l-err');
    sig(1);
  });
}

// ── Rider UI ──────────────────────────────────────────
function addUI(sid,name){
  if($('R_'+sid)) return;
  const d=document.createElement('div');
  d.className='rider-item'; d.id='R_'+sid;
  d.innerHTML=
    '<div class="rider-avatar">'+(name||'?')[0].toUpperCase()+'</div>'+
    '<div class="rider-info">'+
      '<div class="rider-name">'+(name||'Rider')+'</div>'+
      '<div class="rider-status">● CONNECTED</div>'+
    '</div>'+
    '<div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>';
  $('ridersList').appendChild(d);
  cnt();
  log(name+' added to list ✓','l-ok');
}

function removeUI(sid){ $('R_'+sid)?.remove(); cnt(); }

function cnt(){
  const n=$('ridersList').querySelectorAll('.rider-item').length;
  $('peerCount').textContent=n+' rider'+(n!==1?'s':'');
}

// ── Volume ────────────────────────────────────────────
function setVolume(v){
  const p=parseInt(v); vol=p/100;
  $('volVal').textContent=p+'%';
  document.querySelectorAll('audio[id^="A_"]').forEach(a=>{a.volume=Math.min(vol*2,1);});
}

// ── PTT ───────────────────────────────────────────────
function startTalk(e){
  if(e) e.preventDefault();
  if(!myStream||talking) return;
  if(talkMode !== 0) return; // only PTT mode uses hold button
  talking=true; mute(false);
  $('pttBtn').classList.add('active');
  $('pttLabel').textContent='TRANSMITTING…';
  $('pttRing').classList.add('active');
  $('myRider')?.classList.add('speaking');
  sock?.emit('speaking',{value:true});
}

function stopTalk(e){
  if(e) e.preventDefault();
  if(!talking) return;
  if(talkMode !== 0) return; // only PTT mode uses hold button
  talking=false; mute(true);
  $('pttBtn').classList.remove('active');
  $('pttLabel').textContent='HOLD TO TALK';
  $('pttRing').classList.remove('active');
  $('myRider')?.classList.remove('speaking');
  sock?.emit('speaking',{value:false});
}

document.addEventListener('keydown',e=>{if(e.code==='Space'&&e.target.tagName!=='INPUT'){e.preventDefault();startTalk();}});
document.addEventListener('keyup',  e=>{if(e.code==='Space') stopTalk();});

// ── Mode: PTT / VOX / OPEN MIC ───────────────────────
// 0 = PTT (hold to talk)
// 1 = VOX (voice activated — auto opens mic when speaking)
// 2 = OPEN (always on)
let talkMode = 0;
let voxAnalyser  = null;
let voxProcessor = null;
let voxAudioCtx  = null;
let voxActive    = false;  // is VOX currently transmitting?
let voxSilTimer  = null;   // silence timer

const MODES = [
  { label: '🎙️ PUSH TO TALK', color: 'var(--orange)', hint: 'Hold button to transmit' },
  { label: '🔊 VOX (AUTO)',    color: '#22c55e',        hint: 'Speak to transmit automatically' },
  { label: '🔴 OPEN MIC',     color: '#ff4444',        hint: 'Always transmitting' },
];

function toggleMode(){
  talkMode = (talkMode + 1) % 3;
  applyMode();
}

function applyMode(){
  const m   = MODES[talkMode];
  const btn = $('modeBtn');
  if(btn){ btn.textContent = m.label; btn.style.color = m.color; }
  const hint = document.querySelector('.ptt-hint');
  if(hint) hint.textContent = m.hint;

  // Stop VOX if switching away
  stopVOX();

  if(talkMode === 0){
    // PTT — mute mic, user holds button
    if(!talking) mute(true);
    $('pttBtn') && ($('pttBtn').style.opacity = '1');
    $('pttBtn') && ($('pttBtn').style.pointerEvents = 'auto');
    log('Mode: Push-to-Talk', 'l-info');
    toast('PTT — hold button to speak');
  }
  else if(talkMode === 1){
    // VOX — mic always listening, auto-transmit on voice
    mute(false); // need to hear audio level
    $('pttBtn') && ($('pttBtn').style.opacity = '0.4');
    $('pttBtn') && ($('pttBtn').style.pointerEvents = 'none');
    startVOX();
    log('Mode: VOX (voice activated)', 'l-info');
    toast('VOX — speak to transmit automatically!');
  }
  else if(talkMode === 2){
    // Open mic — always transmitting
    mute(false);
    $('pttBtn') && ($('pttBtn').style.opacity = '0.4');
    $('pttBtn') && ($('pttBtn').style.pointerEvents = 'none');
    if(!talking){
      talking = true;
      $('pttBtn')?.classList.add('active');
      $('pttLabel').textContent = 'OPEN MIC';
      $('pttRing')?.classList.add('active');
      $('myRider')?.classList.add('speaking');
      sock?.emit('speaking', { value: true });
    }
    log('Mode: Open Mic (always on)', 'l-info');
    toast('Open Mic — always transmitting!');
  }
}

// ── VOX engine ────────────────────────────────────────
const VOX_THRESHOLD = 20;   // 0-128 — sensitivity (lower = more sensitive)
const VOX_HOLD_MS   = 1200; // ms to keep mic open after silence

function startVOX(){
  if(!myStream) return;
  stopVOX(); // cleanup old

  try{
    voxAudioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    const src    = voxAudioCtx.createMediaStreamSource(myStream);
    voxAnalyser  = voxAudioCtx.createAnalyser();
    voxAnalyser.fftSize = 512;
    voxAnalyser.smoothingTimeConstant = 0.3;
    src.connect(voxAnalyser);

    const buf = new Uint8Array(voxAnalyser.frequencyBinCount);
    let animId = null;

    function checkVoice(){
      if(talkMode !== 1){ stopVOX(); return; }
      voxAnalyser.getByteFrequencyData(buf);

      // Average energy in voice frequency range (300Hz-3000Hz)
      let sum = 0;
      const start = Math.floor(300  / (voxAudioCtx.sampleRate / voxAnalyser.fftSize));
      const end   = Math.floor(3000 / (voxAudioCtx.sampleRate / voxAnalyser.fftSize));
      for(let i = start; i < end && i < buf.length; i++) sum += buf[i];
      const avg = sum / (end - start);

      if(avg > VOX_THRESHOLD){
        // VOICE DETECTED
        clearTimeout(voxSilTimer);
        if(!voxActive){
          voxActive = true;
          mute(false);
          sock?.emit('speaking', { value: true });
          $('pttBtn')?.classList.add('active');
          $('pttLabel').textContent = 'SPEAKING…';
          $('pttRing')?.classList.add('active');
          $('myRider')?.classList.add('speaking');
          log('VOX: voice detected — transmitting', 'l-muted');
        }
      } else {
        // SILENCE — hold for VOX_HOLD_MS then close
        if(voxActive && !voxSilTimer){
          voxSilTimer = setTimeout(()=>{
            voxActive = false;
            voxSilTimer = null;
            mute(true);
            sock?.emit('speaking', { value: false });
            $('pttBtn')?.classList.remove('active');
            $('pttLabel').textContent = 'LISTENING…';
            $('pttRing')?.classList.remove('active');
            $('myRider')?.classList.remove('speaking');
          }, VOX_HOLD_MS);
        }
      }
      animId = requestAnimationFrame(checkVoice);
    }
    checkVoice();
    voxProcessor = { stop: ()=>{ if(animId) cancelAnimationFrame(animId); } };
    log('VOX engine started ✓', 'l-ok');
  } catch(e){
    log('VOX error: '+e.message, 'l-err');
  }
}

function stopVOX(){
  clearTimeout(voxSilTimer);
  voxSilTimer = null;
  voxActive   = false;
  if(voxProcessor){ try{ voxProcessor.stop(); }catch(e){} voxProcessor = null; }
  if(voxAudioCtx){  try{ voxAudioCtx.close();  }catch(e){} voxAudioCtx  = null; }
  voxAnalyser = null;
}

// ── Join ──────────────────────────────────────────────
async function joinRoom(){
  const name=($('nameInput').value||'').trim();
  if(!name){toast('Enter your name first');return;}
  let code=($('roomInput').value||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(!code) code=rnd6();

  myName=name; myRoom=code;

  const btn=$('joinBtn');
  btn.disabled=true; btn.textContent='JOINING…';

  try{
    myStream=await navigator.mediaDevices.getUserMedia({
      audio:{
        // Strong echo cancellation — reduces echo without earphones
        echoCancellation:        {ideal:true},
        noiseSuppression:        {ideal:true},
        autoGainControl:         {ideal:true},
        // Chrome-specific enhanced processing
        googEchoCancellation:    true,
        googEchoCancellation2:   true,
        googNoiseSuppression:    true,
        googNoiseSuppression2:   true,
        googAutoGainControl:     true,
        googAutoGainControl2:    true,
        googHighpassFilter:      true,
        googTypingNoiseDetection:true,
        channelCount:            1,
        sampleRate:              48000,
      },
      video:false,
    });
    mute(true);
    log('Mic ready ✓','l-ok');
  }catch(e){
    toast('Mic denied — please allow microphone');
    myName=''; myRoom='';
    btn.disabled=false; btn.textContent='JOIN';
    return;
  }

  screen('screenRoom');
  $('roomCodeDisplay').textContent=code;
  $('headerSub').textContent='Room '+code+' · '+name;

  $('ridersList').innerHTML='';
  const me=document.createElement('div');
  me.className='rider-item'; me.id='myRider';
  me.innerHTML=
    '<div class="rider-avatar">'+name[0].toUpperCase()+'</div>'+
    '<div class="rider-info">'+
      '<div class="rider-name">'+name+' <span style="color:var(--muted);font-size:11px">(You)</span></div>'+
      '<div class="rider-status">● YOU</div>'+
    '</div>'+
    '<div class="wave-bars"><span></span><span></span><span></span><span></span><span></span></div>';
  $('ridersList').appendChild(me);
  cnt();

  initSocket();

  // Apply current mode (default PTT)
  applyMode();

  btn.disabled=false; btn.textContent='JOIN';
}

// ── Leave ─────────────────────────────────────────────
function leaveRoom(){
  talking=false; myName=''; myRoom='';
  talkMode=0; // reset to PTT on leave
  stopVOX();
  mute(true);
  Object.keys(PCS).forEach(sid=>{try{PCS[sid].close();}catch(e){}killAudio(sid);delete PCS[sid];});
  if(myStream){myStream.getTracks().forEach(t=>t.stop());myStream=null;}
  if(sock){sock.removeAllListeners();try{sock.disconnect();}catch(e){}sock=null;}
  $('statusDot').className='status-dot';
  $('headerSub').textContent='Helmet Intercom';
  sig(0); screen('screenJoin');
  $('ridersList').innerHTML='';
  detectServer();
}

// ── QR ────────────────────────────────────────────────
async function showQR(){
  if(!myRoom) return;
  const url=location.origin+'/?room='+myRoom;
  screen('screenQR');
  $('qrRoomCode').textContent=myRoom;
  $('qrUrl').textContent=url;
  try{const d=await(await fetch('/qr?url='+encodeURIComponent(url))).json(); if(d.qr)$('qrImg').src=d.qr;}catch(e){}
}

function copyCode(){
  const url=location.origin+'/?room='+myRoom;
  navigator.clipboard.writeText(url).then(()=>toast('Link copied! 🏍️')).catch(()=>toast('Code: '+myRoom));
}

// ── Health ────────────────────────────────────────────
async function detectServer(){
  const el=$('serverStatusText'), dot=qs('.server-status .dot');
  try{
    const d=await(await fetch('/health',{signal:AbortSignal.timeout(5000)})).json();
    el.textContent=(d.platform==='railway'?'Railway ✅':'Local ✅')+' · '+d.uptime+'s uptime';
    dot.className='dot dot-ok';
    const cn=$('certNotice');
    if(cn) cn.style.display=(d.platform!=='railway'&&location.protocol==='https:')?'block':'none';
  }catch(e){el.textContent='Server not reachable'; dot.className='dot dot-err';}
}

function showBanner(msg){
  const b=$('connBanner'); if(!b) return;
  b.style.display=msg?'flex':'none';
  const t=$('connBannerText'); if(t&&msg) t.textContent=msg;
}

function retryConnection(){
  if(sock&&sock.connected) sock.emit('join',{name:myName,roomCode:myRoom});
  else if(sock) sock.connect();
}

window.setSignal=function(n){
  const b=$('signalBars'); if(!b) return;
  b.className='signal-bars'+(n>0?' s'+n:'');
  if(n<=1&&myRoom) showBanner('Lost connection — reconnecting...');
  else if(n>=3) showBanner(null);
};

// ── Init ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  detectServer();
  const p=new URLSearchParams(location.search).get('room');
  if(p){$('roomInput').value=p.toUpperCase(); toast('Room pre-filled!');}
  $('roomInput').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');});
  $('nameInput').addEventListener('keydown',e=>{if(e.key==='Enter') joinRoom();});
  $('roomInput').addEventListener('keydown',e=>{if(e.key==='Enter') joinRoom();});
  if('wakeLock'in navigator) navigator.wakeLock.request('screen').catch(()=>{});
});
