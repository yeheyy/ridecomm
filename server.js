'use strict';

const express = require('express');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { WebSocketServer } = require('ws');
const { ExpressPeerServer } = require('peer');
const QRCode  = require('qrcode');
const os      = require('os');

const app = express();

// ── Config ──────────────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || 9000);
const IS_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME || process.env.RAILWAY_PROJECT_ID);
const IS_PROD    = process.env.NODE_ENV === 'production' || IS_RAILWAY;

if (IS_PROD) app.set('trust proxy', 1);

// ── CORS + headers for Railway WebSocket ─────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── SSL — local hotspot only ─────────────────────────────────────────────────
const certPath  = path.join(__dirname, 'certs', 'cert.pem');
const keyPath   = path.join(__dirname, 'certs', 'key.pem');
const chainPath = path.join(__dirname, 'certs', 'chain.pem');
const caPath    = path.join(__dirname, 'certs', 'ca.pem');
const hasSSL    = !IS_RAILWAY && fs.existsSync(certPath) && fs.existsSync(keyPath);

let primaryServer;
if (hasSSL) {
  const sslOpts = {
    key:  fs.readFileSync(keyPath),
    cert: fs.existsSync(chainPath) ? fs.readFileSync(chainPath) : fs.readFileSync(certPath),
  };
  primaryServer = https.createServer(sslOpts, app);
  http.createServer((req, res) => {
    const host = req.headers.host?.split(':')[0] || '127.0.0.1';
    res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
    res.end();
  }).listen(9000, '0.0.0.0');
} else {
  primaryServer = http.createServer(app);
}

// ── PeerJS signaling ─────────────────────────────────────────────────────────
const peerServer = ExpressPeerServer(primaryServer, {
  debug: false,
  path: '/',
  allow_discovery: true,
});
app.use('/peerjs', peerServer);

// ── WebSocket presence bus ───────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: primaryServer,
  path: '/ws',
  // Required for Railway's proxy
  perMessageDeflate: false,
  clientTracking: true,
});

const rooms  = {};
const wsInfo = new Map();

function broadcast(roomCode, msg, excludeWs = null) {
  const room = rooms[roomCode];
  if (!room) return;
  const payload = JSON.stringify(msg);
  room.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === 1) ws.send(payload);
  });
}

function getRoomMembers(roomCode) {
  const room = rooms[roomCode];
  if (!room) return [];
  return [...room].map(ws => wsInfo.get(ws)).filter(Boolean);
}

wss.on('connection', (ws, req) => {
  console.log(`[WS] New connection from ${req.socket.remoteAddress}`);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const { name, roomCode, peerId } = msg;
      if (!name || !roomCode || !peerId) return;

      const old = wsInfo.get(ws);
      if (old?.roomCode && rooms[old.roomCode]) {
        rooms[old.roomCode].delete(ws);
        broadcast(old.roomCode, { type: 'peer_left', peerId: old.peerId, name: old.name });
      }

      if (!rooms[roomCode]) rooms[roomCode] = new Set();
      rooms[roomCode].add(ws);
      wsInfo.set(ws, { name, roomCode, peerId });

      const members = getRoomMembers(roomCode).filter(m => m.peerId !== peerId);
      ws.send(JSON.stringify({ type: 'room_members', members }));
      broadcast(roomCode, { type: 'peer_joined', name, peerId }, ws);
      console.log(`[JOIN]  ${name} → room ${roomCode} | ${rooms[roomCode].size} riders`);
    }
    else if (msg.type === 'speaking') {
      const info = wsInfo.get(ws);
      if (!info) return;
      broadcast(info.roomCode, { type: 'speaking', peerId: info.peerId, value: msg.value }, ws);
    }
    else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    const info = wsInfo.get(ws);
    if (info) {
      const { roomCode, peerId, name } = info;
      if (rooms[roomCode]) {
        rooms[roomCode].delete(ws);
        if (rooms[roomCode].size === 0) delete rooms[roomCode];
        else broadcast(roomCode, { type: 'peer_left', peerId, name });
      }
      wsInfo.delete(ws);
      console.log(`[LEAVE] ${name} left room ${roomCode}`);
    }
  });

  ws.on('error', (e) => console.log('[WS ERROR]', e.message));
});

// ── Heartbeat — keeps Railway connections alive ──────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000); // every 25s — Railway times out idle at 60s

wss.on('close', () => clearInterval(heartbeat));

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    uptime:   Math.floor(process.uptime()),
    platform: IS_RAILWAY ? 'railway' : (hasSSL ? 'local-ssl' : 'local'),
    rooms:    Object.keys(rooms).length,
    riders:   [...Object.values(rooms)].reduce((a, s) => a + s.size, 0),
  });
});

app.get('/qr', async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || (hasSSL ? 'https' : 'http');
  const host  = req.headers['x-forwarded-host']  || req.headers.host || 'localhost';
  const base  = req.query.url || `${proto}://${host}`;
  try {
    const qr = await QRCode.toDataURL(base, {
      width: 300, margin: 2,
      color: { dark: '#ff9500', light: '#0e1117' }
    });
    res.json({ qr, url: base });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/cert', (req, res) => {
  const p = fs.existsSync(caPath) ? caPath : (fs.existsSync(certPath) ? certPath : null);
  if (!p) return res.status(404).send('No local cert needed on Railway');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename=ridecomm-ca.crt');
  res.sendFile(p);
});

// ── Start ─────────────────────────────────────────────────────────────────────
primaryServer.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         🏍️  RIDECOMM SERVER READY                ║');
  console.log('╠══════════════════════════════════════════════════╣');
  if (IS_RAILWAY) {
    console.log(`║  Platform : Railway ☁️                           ║`);
    console.log(`║  Port     : ${PORT}                             ║`);
    console.log(`║  WS       : wss://your-domain.up.railway.app/ws ║`);
  } else {
    const ip   = getLocalIP();
    const proto = hasSSL ? 'https' : 'http';
    console.log(`║  Platform : Local                                ║`);
    console.log(`║  URL      : ${proto}://${ip}:${PORT}            ║`);
  }
  console.log('╚══════════════════════════════════════════════════╝\n');
});

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}
