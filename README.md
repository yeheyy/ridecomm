# 🏍️ RideComm – Helmet Intercom App

A fully local, WiFi-based push-to-talk intercom for motorcycle riders.  
No internet required. No accounts. No cloud. Just hotspot + Node.js.

---

## ✅ Features

- 🎙️ **Push-to-Talk** (hold button or spacebar)
- 👥 **Multi-rider** group rooms (4–8 riders tested)
- 📡 **Local WiFi only** — works on hotspot, no internet needed
- 📱 **iOS + Android Safari** compatible (no app install)
- 🔗 **QR code sharing** — scan to join a room instantly
- 🔊 **Volume control** up to 200%
- 🔒 **Peer-to-peer audio** — no recording, no servers in the middle
- ♻️ **Auto-reconnect** if connection drops
- 📵 **Screen wake lock** — screen stays on while riding

---

## 📦 Requirements

- **Node.js** v16 or higher
- One device to act as the **hotspot host** (phone, laptop, or router)
- All riders on the **same WiFi network**

---

## 🚀 Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
node start.js
# or
npm start
```

You'll see:
```
╔══════════════════════════════════════════════════╗
║           🏍️  RIDECOMM HELMET INTERCOM           ║
╠══════════════════════════════════════════════════╣
║  👉  http://192.168.1.x:9000                     ║
╚══════════════════════════════════════════════════╝
```

### 3. Share the URL
- Copy the `http://192.168.x.x:9000` URL
- All riders open this in **Safari** (iOS) or **Chrome** (Android)
- Or scan the QR code shown inside the app

### 4. Ride & Talk
- First rider enters name → taps **JOIN** (leaves room code blank → creates room)
- Room code appears → share with other riders
- Others enter the same code → **JOIN**
- Hold 🎙️ button to talk

---

## 📱 iOS Safari Tips

- When asked, **allow microphone access**
- Tap **"Add to Home Screen"** for a native app feel:  
  Safari → Share icon → Add to Home Screen
- Keep Safari open while riding (wake lock is enabled)

---

## 🔧 Configuration

| Env Variable | Default | Description |
|---|---|---|
| `PORT` | `9000` | Server port |

```bash
PORT=8080 node start.js
```

---

## 🗂️ File Structure

```
ridecomm/
├── server.js          ← Express + PeerJS + WebSocket server
├── start.js           ← Launcher with setup instructions
├── package.json
├── README.md
└── public/
    ├── index.html     ← Main app UI
    ├── css/
    │   └── style.css  ← Dark theme styles
    └── js/
        ├── app.js     ← Client logic (WebRTC, PTT, WS)
        └── peerjs.min.js ← PeerJS bundled (no CDN)
```

---

## 🏗️ Architecture

```
[iPhone 1] ──WebSocket──▶ [Node Server]
[iPhone 1] ◀──WebRTC P2P──▶ [iPhone 2]
[iPhone 2] ──WebSocket──▶ [Node Server]
```

- **WebSocket** `/ws` — presence bus: join/leave/speaking events
- **PeerJS** `/peerjs` — WebRTC signaling (SDP + ICE exchange)
- **WebRTC** — actual audio, peer-to-peer after handshake
- **Express** `/` — serves static files

---

## 🔒 Security

- All audio is WebRTC P2P — the server never sees audio
- Room codes are 6-character alphanumeric
- Works offline once all devices are on the same hotspot
- No user data stored anywhere

---

## 🐛 Troubleshooting

| Problem | Solution |
|---|---|
| "Mic access denied" | Go to Settings → Safari → Microphone → Allow |
| Can't connect to server | Make sure you're on the same WiFi/hotspot |
| No audio | Check volume slider; try toggling PTT |
| Riders not showing | Refresh and rejoin with same room code |
| iOS audio muffled | Remove from ear while connecting, then put back |

---

## 📡 Range

Depends on your hotspot device:
- Phone hotspot: ~30–50 meters
- WiFi router: ~50–100 meters  
- High-power router: up to 300 meters

---

Made with ❤️ for riders. Stay safe on the road! 🏍️
