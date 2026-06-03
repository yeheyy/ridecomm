'use strict';

const express      = require('express');
const http         = require('http');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { Server }   = require('socket.io');
const QRCode       = require('qrcode');
const os           = require('os');

const app  = express();
const PORT = parseInt(process.env.PORT || 9000);
const IS_RAILWAY = !!(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_SERVICE_NAME ||
  process.env.RAILWAY_PROJECT_ID
);

if (IS_RAILWAY) app.set('trust proxy', 1);

// ── SSL (local only) ──────────────────────────────────────────
const keyPath   = path.join(__dirname, 'certs', 'key.pem');
const certPath  = path.join(__dirname, 'certs', 'cert.pem');
const chainPath = path.join(__dirname, 'certs', 'chain.pem');
const caPath    = path.join(__dirname, 'certs', 'ca.pem');
const hasSSL    = !IS_RAILWAY && fs.existsSync(keyPath) && fs.existsSync(certPath);

const httpServer = hasSSL
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

// ── Socket.IO ─────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors:          { origin: '*', methods: ['GET', 'POST'] },
  transports:    ['polling', 'websocket'],
  allowUpgrades: true,
  pingTimeout:   30000,
  pingInterval:  10000,
  allowEIO3:     true,
});

// rooms[roomCode] = Map<socketId, { name, socketId }>
const rooms = {};

io.on('connection', socket => {
  // Per-socket state
  let currentRoom = null;
  let currentName = null;

  console.log(`[CONN] ${socket.id.slice(0,8)}`);

  function leaveCurrentRoom() {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].delete(socket.id);
    // Tell others this rider left
    socket.to(currentRoom).emit('peer-left', {
      socketId: socket.id,
      name:     currentName,
    });
    socket.leave(currentRoom);
    console.log(`[LEAVE] ${currentName} left ${currentRoom} | remaining: ${rooms[currentRoom]?.size || 0}`);
    if (rooms[currentRoom] && rooms[currentRoom].size === 0) {
      delete rooms[currentRoom];
    }
    currentRoom = null;
  }

  // ── Join ────────────────────────────────────────────────────
  socket.on('join', ({ name, roomCode }) => {
    if (!name || !roomCode) return;

    // Leave previous room first
    leaveCurrentRoom();

    currentName = name;
    currentRoom = roomCode;

    // Create room if needed
    if (!rooms[roomCode]) rooms[roomCode] = new Map();

    // Get existing members BEFORE adding self
    const existing = [...rooms[roomCode].values()];

    // Add self to room
    rooms[roomCode].set(socket.id, { name, socketId: socket.id });
    socket.join(roomCode);

    // 1. Send existing members to the new joiner
    socket.emit('room-members', { members: existing });

    // 2. Tell ALL existing members that someone new joined
    socket.to(roomCode).emit('peer-joined', {
      socketId: socket.id,
      name,
    });

    console.log(`[JOIN] ${name}(${socket.id.slice(0,6)}) → ${roomCode} | existing: ${existing.length} | total: ${rooms[roomCode].size}`);
  });

  // ── WebRTC signaling (just relay, no logic) ─────────────────
  socket.on('offer', ({ to, offer }) => {
    console.log(`[OFFER] ${socket.id.slice(0,6)} → ${to.slice(0,6)}`);
    io.to(to).emit('offer', { from: socket.id, name: currentName, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    console.log(`[ANSWER] ${socket.id.slice(0,6)} → ${to.slice(0,6)}`);
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ── Speaking ────────────────────────────────────────────────
  socket.on('speaking', ({ value }) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('speaking', { socketId: socket.id, value });
    }
  });

  // ── Disconnect ──────────────────────────────────────────────
  socket.on('disconnect', reason => {
    console.log(`[DISC] ${currentName || socket.id.slice(0,8)} — ${reason}`);
    leaveCurrentRoom();
  });

  socket.on('error', err => {
    console.log(`[ERR] ${socket.id.slice(0,8)}: ${err.message}`);
  });
});

// ── Static + API ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_, res) => {
  const totalRiders = Object.values(rooms).reduce((a, m) => a + m.size, 0);
  res.json({
    status:   'ok',
    platform: IS_RAILWAY ? 'railway' : 'local',
    uptime:   Math.floor(process.uptime()),
    rooms:    Object.keys(rooms).length,
    riders:   totalRiders,
    sockets:  io.engine.clientsCount,
  });
});

app.get('/qr', async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || (hasSSL ? 'https' : 'http');
  const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  try {
    const qr = await QRCode.toDataURL(`${proto}://${host}`, {
      width: 300, margin: 2,
      color: { dark: '#ff9500', light: '#0e1117' },
    });
    res.json({ qr, url: `${proto}://${host}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/cert', (req, res) => {
  const p = fs.existsSync(caPath) ? caPath : (fs.existsSync(certPath) ? certPath : null);
  if (!p) return res.status(404).send('No cert');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename=ridecomm-ca.crt');
  res.sendFile(p);
});

// ── Start ─────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n🏍️  RideComm on ${IS_RAILWAY ? 'Railway :' + PORT : (hasSSL?'https':'http') + '://' + ip + ':' + PORT}\n`);
});

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const a of iface)
      if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}
