'use strict';

const express  = require('express');
const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { Server: SocketIO } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const QRCode   = require('qrcode');
const os       = require('os');

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

// ── PeerJS signaling ──────────────────────────────────────────────────────────
const peerServer = ExpressPeerServer(primaryServer, {
  debug: false,
  path: '/',
  allow_discovery: true,
});
app.use('/peerjs', peerServer);

// ── Socket.IO — replaces raw WebSocket ───────────────────────────────────────
// Socket.IO uses long-polling as fallback when WebSocket is blocked
// This ALWAYS works on Railway, Heroku, etc.
const io = new SocketIO(primaryServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Try WebSocket first, fall back to long-polling if blocked
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  pingTimeout:  20000,
  pingInterval: 10000,
});

const rooms  = {};  // roomCode → Set<socketId>
const info   = {};  // socketId → { name, roomCode, peerId }

function broadcast(roomCode, msg, excludeId = null) {
  const room = rooms[roomCode];
  if (!room) return;
  room.forEach(id => {
    if (id !== excludeId) {
      io.to(id).emit('msg', msg);
    }
  });
}

function getRoomMembers(roomCode) {
  const room = rooms[roomCode];
  if (!room) return [];
  return [...room].map(id => info[id]).filter(Boolean);
}

io.on('connection', (socket) => {
  console.log(`[CONNECT] socket ${socket.id} via ${socket.conn.transport.name}`);

  socket.on('join', ({ name, roomCode, peerId }) => {
    if (!name || !roomCode || !peerId) return;

    // Leave old room
    const old = info[socket.id];
    if (old?.roomCode && rooms[old.roomCode]) {
      rooms[old.roomCode].delete(socket.id);
      broadcast(old.roomCode, { type: 'peer_left', peerId: old.peerId, name: old.name });
    }

    // Join new room
    if (!rooms[roomCode]) rooms[roomCode] = new Set();
    rooms[roomCode].add(socket.id);
    info[socket.id] = { name, roomCode, peerId, socketId: socket.id };

    // Send existing members to newcomer
    const members = getRoomMembers(roomCode).filter(m => m.peerId !== peerId);
    socket.emit('msg', { type: 'room_members', members });

    // Announce to room
    broadcast(roomCode, { type: 'peer_joined', name, peerId }, socket.id);
    console.log(`[JOIN]  ${name} → room ${roomCode} | ${rooms[roomCode].size} riders`);
  });

  socket.on('speaking', ({ value }) => {
    const i = info[socket.id];
    if (!i) return;
    broadcast(i.roomCode, { type: 'speaking', peerId: i.peerId, value }, socket.id);
  });

  socket.on('leave', () => cleanup(socket.id));

  socket.on('disconnect', (reason) => {
    console.log(`[DISCONNECT] ${socket.id} — ${reason}`);
    cleanup(socket.id);
  });

  socket.on('error', (e) => console.log('[SOCKET ERR]', e.message));
});

function cleanup(socketId) {
  const i = info[socketId];
  if (i) {
    const { roomCode, peerId, name } = i;
    if (rooms[roomCode]) {
      rooms[roomCode].delete(socketId);
      if (rooms[roomCode].size === 0) delete rooms[roomCode];
      else broadcast(roomCode, { type: 'peer_left', peerId, name });
    }
    delete info[socketId];
    console.log(`[LEAVE] ${name} left room ${roomCode}`);
  }
}

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const totalRiders = Object.values(rooms).reduce((a, s) => a + s.size, 0);
  res.json({
    status:      'ok',
    uptime:      Math.floor(process.uptime()),
    platform:    IS_RAILWAY ? 'railway' : (hasSSL ? 'local-ssl' : 'local'),
    rooms:       Object.keys(rooms).length,
    riders:      totalRiders,
    connections: io.engine.clientsCount,
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
    console.log(`║  Transport: Socket.IO (ws + polling fallback)   ║`);
  } else {
    console.log(`║  URL      : ${hasSSL ? 'https' : 'http'}://${ip}:${PORT}              ║`);
    console.log(`║  Transport: Socket.IO (ws + polling fallback)   ║`);
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
