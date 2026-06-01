#!/usr/bin/env node
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

const ip = getLocalIP();
const PORT_HTTP = process.env.PORT_HTTP || 9000;
const PORT_HTTPS = process.env.PORT_HTTPS || 9443;
const hasSSL = fs.existsSync(path.join(__dirname, 'certs', 'cert.pem'));

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║           🏍️  RIDECOMM HELMET INTERCOM           ║');
console.log('╠══════════════════════════════════════════════════╣');
if (hasSSL) {
  console.log('║                                                  ║');
  console.log('║  ✅ HTTPS MODE (mic works on iPhone!)            ║');
  console.log('║                                                  ║');
  console.log(`║  App URL:  https://${ip}:${PORT_HTTPS}         ║`);
  console.log(`║  Cert URL: https://${ip}:${PORT_HTTPS}/cert    ║`);
  console.log('║                                                  ║');
  console.log('║  ── iOS First Time Setup ──────────────────────  ║');
  console.log('║  1. Open the Cert URL in Safari                 ║');
  console.log('║  2. Tap "Allow" → Install profile               ║');
  console.log('║  3. Settings → General → VPN & Device Mgmt     ║');
  console.log('║  4. Tap RideComm cert → Trust                   ║');
  console.log('║  5. Open the App URL                            ║');
} else {
  console.log(`║  App URL:  http://${ip}:${PORT_HTTP}            ║`);
  console.log('║  ⚠️  No SSL cert found — mic may not work on iOS ║');
}
console.log('║                                                  ║');
console.log('║  Press Ctrl+C to stop.                           ║');
console.log('╚══════════════════════════════════════════════════╝\n');

const child = spawn(process.execPath, ['server.js'], {
  stdio: 'inherit',
  env: { ...process.env, PORT_HTTP, PORT_HTTPS }
});
child.on('exit', (code) => process.exit(code));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
