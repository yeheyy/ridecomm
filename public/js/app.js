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
  a.autoplay=true; a.playsInline=true; a.muted=false; a.volume=Math.min(vol*2,1);
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
  talking=false; mute(true);
  $('pttBtn').classList.remove('active');
  $('pttLabel').textContent='HOLD TO TALK';
  $('pttRing').classList.remove('active');
  $('myRider')?.classList.remove('speaking');
  sock?.emit('speaking',{value:false});
}

document.addEventListener('keydown',e=>{if(e.code==='Space'&&e.target.tagName!=='INPUT'){e.preventDefault();startTalk();}});
document.addEventListener('keyup',  e=>{if(e.code==='Space') stopTalk();});

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
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},
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

  btn.disabled=false; btn.textContent='JOIN';
}

// ── Leave ─────────────────────────────────────────────
function leaveRoom(){
  talking=false; myName=''; myRoom='';
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
