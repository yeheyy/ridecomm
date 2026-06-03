'use strict';

const express  = require('express');
const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { Server } = require('socket.io');
const QRCode   = require('qrcode');
const os       = require('os');

const app  = express();
const PORT = parseInt(process.env.PORT || 9000);
const IS_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME || process.env.RAILWAY_PROJECT_ID);

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

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
  pingTimeout: 30000,
  pingInterval: 10000,
  allowEIO3: true,
});

// rooms[roomCode] = Map<socketId, { name, socketId }>
const rooms = {};

function getRoomMembers(roomCode, excludeId = null) {
  if (!rooms[roomCode]) return [];
  return [...rooms[roomCode].values()].filter(m => m.socketId !== excludeId);
}

io.on('connection', socket => {
  let myRoom = null;
  let myName = null;

  console.log(`[+] ${socket.id.slice(0,8)} connected`);

  // ── Join room ───────────────────────────────────────────────────────────────
  socket.on('join', ({ name, roomCode }) => {
    if (!name || !roomCode) return;
    myName = name;
    myRoom = roomCode;

    // Leave old room
    if (myRoom && rooms[myRoom]) {
      rooms[myRoom].delete(socket.id);
      socket.to(myRoom).emit('peer-left', { socketId: socket.id, name });
      socket.leave(myRoom);
    }

    // Join new room
    socket.join(roomCode);
    if (!rooms[roomCode]) rooms[roomCode] = new Map();
    rooms[roomCode].set(socket.id, { name, socketId: socket.id });

    // Send existing members to the newcomer
    const members = getRoomMembers(roomCode, socket.id);
    socket.emit('room-members', { members });

    // Tell existing members someone joined
    socket.to(roomCode).emit('peer-joined', { socketId: socket.id, name });

    console.log(`[JOIN] ${name} → ${roomCode} | ${rooms[roomCode].size} riders`);
  });

  // ── WebRTC signaling relay ──────────────────────────────────────────────────
  // Offer: caller → server → callee
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, name: myName, offer });
  });

  // Answer: callee → server → caller
  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  // ICE candidate: either side → server → other side
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ── Speaking indicator ──────────────────────────────────────────────────────
  socket.on('speaking', ({ value }) => {
    if (myRoom) socket.to(myRoom).emit('speaking', { socketId: socket.id, value });
  });

  // ── Disconnect ──────────────────────────────────────────────────────────────
  socket.on('disconnect', reason => {
    if (myRoom && rooms[myRoom]) {
      rooms[myRoom].delete(socket.id);
      if (rooms[myRoom].size === 0) delete rooms[myRoom];
      else io.to(myRoom).emit('peer-left', { socketId: socket.id, name: myName });
    }
    console.log(`[-] ${myName || socket.id.slice(0,8)} left (${reason})`);
  });
});

// ── Static + API ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_, res) => res.json({
  status: 'ok', platform: IS_RAILWAY ? 'railway' : 'local',
  uptime: Math.floor(process.uptime()),
  rooms:  Object.keys(rooms).length,
  riders: Object.values(rooms).reduce((a, m) => a + m.size, 0),
}));

app.get('/qr', async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || (hasSSL ? 'https' : 'http');
  const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  try {
    const qr = await QRCode.toDataURL(`${proto}://${host}`, { width: 300, margin: 2, color: { dark: '#ff9500', light: '#0e1117' } });
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

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n🏍️  RideComm ready on ${IS_RAILWAY ? 'Railway' : (hasSSL ? 'https' : 'http') + '://' + ip + ':' + PORT}\n`);
});

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const a of iface)
      if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}
