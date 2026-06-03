'use strict';

const express  = require('express');
const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const QRCode   = require('qrcode');
const os       = require('os');

const app    = express();
const PORT   = parseInt(process.env.PORT || 9000);
const IS_RAILWAY = !!(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_SERVICE_NAME ||
  process.env.RAILWAY_PROJECT_ID
);

if (IS_RAILWAY) app.set('trust proxy', 1);

// ── SSL (local only) ──────────────────────────────────────────────────────────
const keyPath   = path.join(__dirname, 'certs', 'key.pem');
const certPath  = path.join(__dirname, 'certs', 'cert.pem');
const chainPath = path.join(__dirname, 'certs', 'chain.pem');
const caPath    = path.join(__dirname, 'certs', 'ca.pem');
const hasSSL    = !IS_RAILWAY && fs.existsSync(keyPath) && fs.existsSync(certPath);

const httpServer = hasSSL
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.existsSync(chainPath) ? fs.readFileSync(chainPath) : fs.readFileSync(certPath) }, app)
  : http.createServer(app);

if (hasSSL) {
  http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host?.split(':')[0]}:${PORT}${req.url}` });
    res.end();
  }).listen(9000, '0.0.0.0');
}

// ── Socket.IO — polling first, upgrade to ws later ───────────────────────────
const io = new Server(httpServer, {
  cors:          { origin: '*', methods: ['GET', 'POST'] },
  transports:    ['polling', 'websocket'],  // polling first = always works
  allowUpgrades: true,
  pingTimeout:   30000,
  pingInterval:  10000,
  connectTimeout: 10000,
  allowEIO3:     true,  // support older clients
});

// ── PeerJS (AFTER Socket.IO to avoid path conflicts) ─────────────────────────
app.use('/peerjs', ExpressPeerServer(httpServer, {
  debug: false,
  path: '/',
  allow_discovery: true,
}));

// ── Room state ────────────────────────────────────────────────────────────────
const rooms = {};  // roomCode → Set<socketId>
const peers = {};  // socketId → { name, roomCode, peerId }

function roomBroadcast(roomCode, event, data, excludeId = null) {
  const room = rooms[roomCode];
  if (!room) return;
  room.forEach(id => {
    if (id !== excludeId) io.to(id).emit(event, data);
  });
}

function roomMembers(roomCode) {
  return [...(rooms[roomCode] || [])].map(id => peers[id]).filter(Boolean);
}

// ── Socket.IO events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const t = socket.conn.transport.name;
  console.log(`[+] ${socket.id.slice(0,8)} connected via ${t}`);

  socket.conn.on('upgrade', () => {
    console.log(`[^] ${socket.id.slice(0,8)} upgraded to ${socket.conn.transport.name}`);
  });

  socket.on('join', ({ name, roomCode, peerId } = {}) => {
    if (!name || !roomCode || !peerId) return;

    // Leave previous room
    const prev = peers[socket.id];
    if (prev?.roomCode && rooms[prev.roomCode]) {
      rooms[prev.roomCode].delete(socket.id);
      roomBroadcast(prev.roomCode, 'peer_left', { peerId: prev.peerId, name: prev.name });
    }

    // Join new room
    if (!rooms[roomCode]) rooms[roomCode] = new Set();
    rooms[roomCode].add(socket.id);
    peers[socket.id] = { name, roomCode, peerId };

    // Send current members to newcomer FIRST (so they can call each one)
    const members = roomMembers(roomCode).filter(m => m.peerId !== peerId);
    socket.emit('room_members', { members });
    console.log(`[JOIN] ${name} → room ${roomCode} | existing: ${members.length} | total: ${rooms[roomCode].size}`);

    // Then announce newcomer to existing riders (so they add UI only, no calling)
    roomBroadcast(roomCode, 'peer_joined', { name, peerId }, socket.id);
  });

  socket.on('speaking', ({ value } = {}) => {
    const p = peers[socket.id];
    if (p) roomBroadcast(p.roomCode, 'speaking', { peerId: p.peerId, value }, socket.id);
  });

  socket.on('disconnect', (reason) => {
    const p = peers[socket.id];
    if (p) {
      if (rooms[p.roomCode]) {
        rooms[p.roomCode].delete(socket.id);
        if (rooms[p.roomCode].size === 0) delete rooms[p.roomCode];
        else roomBroadcast(p.roomCode, 'peer_left', { peerId: p.peerId, name: p.name });
      }
      delete peers[socket.id];
      console.log(`[-] ${p.name} left ${p.roomCode} (${reason})`);
    }
  });
});

// ── Static + API ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({
  status:   'ok',
  platform: IS_RAILWAY ? 'railway' : (hasSSL ? 'local-ssl' : 'local'),
  uptime:   Math.floor(process.uptime()),
  rooms:    Object.keys(rooms).length,
  riders:   Object.values(rooms).reduce((a, s) => a + s.size, 0),
  sockets:  io.engine.clientsCount,
}));

app.get('/qr', async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || (hasSSL ? 'https' : 'http');
  const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  try {
    const qr = await QRCode.toDataURL(`${proto}://${host}`, { width: 300, margin: 2, color: { dark: '#ff9500', light: '#0e1117' } });
    res.json({ qr, url: `${proto}://${host}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/cert', (req, res) => {
  const p = fs.existsSync(caPath) ? caPath : (fs.existsSync(certPath) ? certPath : null);
  if (!p) return res.status(404).send('No cert needed on Railway');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename=ridecomm-ca.crt');
  res.sendFile(p);
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         🏍️  RIDECOMM SERVER READY                ║');
  console.log('╠══════════════════════════════════════════════════╣');
  if (IS_RAILWAY) {
    console.log(`║  Platform : Railway ☁️                           ║`);
    console.log(`║  Port     : ${PORT}                             ║`);
    console.log(`║  Socket.IO: polling → websocket upgrade         ║`);
  } else {
    console.log(`║  URL : ${hasSSL?'https':'http'}://${getLocalIP()}:${PORT}    ║`);
  }
  console.log('╚══════════════════════════════════════════════════╝\n');
});

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const addr of iface)
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
  return '127.0.0.1';
}
