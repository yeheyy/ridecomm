'use strict';

const express = require('express');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const WebSocket = require('ws');
const { ExpressPeerServer } = require('peer');
const QRCode  = require('qrcode');
const os      = require('os');

const app = express();

// ── Config ───────────────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || 9000);
const IS_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME || process.env.RAILWAY_PROJECT_ID);
const IS_PROD    = process.env.NODE_ENV === 'production' || IS_RAILWAY;

if (IS_PROD) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── SSL (local hotspot only) ──────────────────────────────────────────────────
const certPath  = path.join(__dirname, 'certs', 'cert.pem');
const keyPath   = path.join(__dirname, 'certs', 'key.pem');
const chainPath = path.join(__dirname, 'certs', 'chain.pem');
const caPath    = path.join(__dirname, 'certs', 'ca.pem');
const hasSSL    = !IS_RAILWAY && fs.existsSync(certPath) && fs.existsSync(keyPath);

const primaryServer = hasSSL
  ? https.createServer({
      key:  fs.readFileSync(keyPath),
      cert: fs.existsSync(chainPath) ? fs.readFileSync(chainPath) : fs.readFileSync(certPath),
    }, app)
  : http.createServer(app);

if (hasSSL) {
  http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host?.split(':')[0]}:${PORT}${req.url}` });
    res.end();
  }).listen(9000, '0.0.0.0');
}

// ── PeerJS ────────────────────────────────────────────────────────────────────
const peerServer = ExpressPeerServer(primaryServer, {
  debug: false,
  path: '/',
  allow_discovery: true,
});
app.use('/peerjs', peerServer);

// ── WebSocket — NO path filter, handle upgrade manually ──────────────────────
// Railway's proxy strips paths during upgrade — this is why /ws path fails
const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

const rooms  = {};
const wsInfo = new Map();

function broadcast(roomCode, msg, excludeWs = null) {
  const room = rooms[roomCode];
  if (!room) return;
  const payload = JSON.stringify(msg);
  room.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
}

function getRoomMembers(roomCode) {
  const room = rooms[roomCode];
  if (!room) return [];
  return [...room].map(ws => wsInfo.get(ws)).filter(Boolean);
}

// Handle upgrade manually — intercept /ws and let PeerJS handle the rest
primaryServer.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  console.log(`[UPGRADE] ${url}`);

  if (url.startsWith('/ws') || url === '/') {
    // Our presence WebSocket
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
  // PeerJS handles its own upgrades via /peerjs/*
});

wss.on('connection', (ws, req) => {
  console.log(`[WS] Connected — ${req.socket?.remoteAddress || 'unknown'}`);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

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

  ws.on('close', (code) => {
    const info = wsInfo.get(ws);
    if (info) {
      const { roomCode, peerId, name } = info;
      if (rooms[roomCode]) {
        rooms[roomCode].delete(ws);
        if (rooms[roomCode].size === 0) delete rooms[roomCode];
        else broadcast(roomCode, { type: 'peer_left', peerId, name });
      }
      wsInfo.delete(ws);
      console.log(`[LEAVE] ${name} left (code ${code})`);
    }
  });

  ws.on('error', (e) => console.log('[WS ERR]', e.message));
});

// ── Heartbeat — prevent Railway 60s idle timeout ─────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);
wss.on('close', () => clearInterval(heartbeat));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    uptime:   Math.floor(process.uptime()),
    platform: IS_RAILWAY ? 'railway' : (hasSSL ? 'local-ssl' : 'local'),
    rooms:    Object.keys(rooms).length,
    riders:   [...Object.values(rooms)].reduce((a, s) => a + s.size, 0),
    ws_clients: wss.clients.size,
  });
});

app.get('/qr', async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || (hasSSL ? 'https' : 'http');
  const host  = req.headers['x-forwarded-host']  || req.headers.host || 'localhost';
  const base  = req.query.url || `${proto}://${host}`;
  try {
    const qr = await QRCode.toDataURL(base, { width: 300, margin: 2, color: { dark: '#ff9500', light: '#0e1117' } });
    res.json({ qr, url: base });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/cert', (req, res) => {
  const p = fs.existsSync(caPath) ? caPath : (fs.existsSync(certPath) ? certPath : null);
  if (!p) return res.status(404).send('No local cert — not needed on Railway');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename=ridecomm-ca.crt');
  res.sendFile(p);
});

// ── Start ─────────────────────────────────────────────────────────────────────
primaryServer.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         🏍️  RIDECOMM SERVER READY                ║');
  console.log('╠══════════════════════════════════════════════════╣');
  if (IS_RAILWAY) {
    console.log(`║  Platform : Railway ☁️                           ║`);
    console.log(`║  Port     : ${PORT}                             ║`);
    console.log(`║  WebSocket: handled via server upgrade           ║`);
  } else {
    console.log(`║  URL      : ${hasSSL ? 'https' : 'http'}://${ip}:${PORT}  ║`);
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
