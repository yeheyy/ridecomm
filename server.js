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
// Railway sets PORT automatically — always use it
const PORT       = parseInt(process.env.PORT || 9000);
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_SERVICE_NAME;
const IS_PROD    = process.env.NODE_ENV === 'production' || IS_RAILWAY;

// On Railway/VPS behind proxy — trust forwarded headers
if (IS_PROD) app.set('trust proxy', 1);

// ── SSL — only used for local hotspot mode ──────────────────────────────────
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
  // HTTP redirect
  http.createServer((req, res) => {
    const host = req.headers.host?.split(':')[0] || '127.0.0.1';
    res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
    res.end();
  }).listen(9000, '0.0.0.0');
} else {
  // Railway / plain HTTP (Railway's edge handles SSL for us)
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
const wss    = new WebSocketServer({ server: primaryServer, path: '/ws' });
const rooms  = {};        // roomCode → Set<ws>
const wsInfo = new Map(); // ws → { name, roomCode, peerId }

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

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const { name, roomCode, peerId } = msg;
      if (!name || !roomCode || !peerId) return;

      // Leave old room if any
      const old = wsInfo.get(ws);
      if (old?.roomCode && rooms[old.roomCode]) {
        rooms[old.roomCode].delete(ws);
        broadcast(old.roomCode, { type: 'peer_left', peerId: old.peerId, name: old.name });
      }

      // Join new room
      if (!rooms[roomCode]) rooms[roomCode] = new Set();
      rooms[roomCode].add(ws);
      wsInfo.set(ws, { name, roomCode, peerId });

      // Send existing members to newcomer
      const members = getRoomMembers(roomCode).filter(m => m.peerId !== peerId);
      ws.send(JSON.stringify({ type: 'room_members', members }));

      // Announce to room
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

  ws.on('error', () => {});
});

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    uptime:   Math.floor(process.uptime()),
    platform: IS_RAILWAY ? 'railway' : (hasSSL ? 'local-ssl' : 'local-http'),
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
  if (!p) return res.status(404).send('No local cert — not needed on Railway (uses real HTTPS)');
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
    console.log(`║  Port     : ${PORT}                               ║`);
    console.log(`║  SSL      : Handled by Railway edge              ║`);
    console.log(`║  URL      : Check Railway dashboard              ║`);
  } else {
    const ip = getLocalIP();
    const proto = hasSSL ? 'https' : 'http';
    console.log(`║  Platform : Local                                ║`);
    console.log(`║  URL      : ${proto}://${ip}:${PORT}             ║`);
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
