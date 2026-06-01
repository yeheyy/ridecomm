/**
 * RideComm - Proper SSL Certificate Generator
 * Generates a CA + server cert that iOS Safari will trust
 * No OpenSSL needed - uses node-forge
 */
const forge = require('node-forge');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

async function generateCerts(ip) {
  console.log('[RideComm] Generating CA + server certificate for IP:', ip);
  console.log('[RideComm] This takes a few seconds...');

  // ── 1. Generate CA key + cert ──────────────────────────────────────────
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter  = new Date();
  caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);

  const caAttrs = [
    { name: 'commonName',         value: 'RideComm Local CA' },
    { name: 'organizationName',   value: 'RideComm' },
    { name: 'countryName',        value: 'PH' },
  ];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  // ── 2. Generate server key + cert signed by CA ─────────────────────────
  const srvKeys = forge.pki.rsa.generateKeyPair(2048);
  const srvCert = forge.pki.createCertificate();
  srvCert.publicKey = srvKeys.publicKey;
  srvCert.serialNumber = '02';
  srvCert.validity.notBefore = new Date();
  srvCert.validity.notAfter  = new Date();
  srvCert.validity.notAfter.setFullYear(srvCert.validity.notBefore.getFullYear() + 10);

  const srvAttrs = [
    { name: 'commonName',       value: ip },
    { name: 'organizationName', value: 'RideComm' },
  ];
  srvCert.setSubject(srvAttrs);
  srvCert.setIssuer(caAttrs); // signed by CA

  // SAN — critical for modern iOS Safari
  srvCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [
      { type: 7, ip: ip },          // IP SAN
      { type: 7, ip: '127.0.0.1' }, // localhost IP
      { type: 2, value: 'localhost' },
    ]},
    { name: 'subjectKeyIdentifier' },
  ]);
  srvCert.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    caKey:  forge.pki.privateKeyToPem(caKeys.privateKey),
    caCert: forge.pki.certificateToPem(caCert),
    srvKey:  forge.pki.privateKeyToPem(srvKeys.privateKey),
    srvCert: forge.pki.certificateToPem(srvCert),
  };
}

async function main() {
  const ip = process.argv[2] || getLocalIP();
  console.log('\n════════════════════════════════════════');
  console.log('  RideComm SSL Certificate Generator');
  console.log('════════════════════════════════════════');

  const certsDir = path.join(__dirname, 'certs');
  if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir);

  const certs = await generateCerts(ip);

  // Server uses these
  fs.writeFileSync(path.join(certsDir, 'key.pem'),  certs.srvKey);
  fs.writeFileSync(path.join(certsDir, 'cert.pem'), certs.srvCert);
  // CA cert — iPhone must install and trust this
  fs.writeFileSync(path.join(certsDir, 'ca.pem'),   certs.caCert);
  // Combined chain for server
  fs.writeFileSync(path.join(certsDir, 'chain.pem'), certs.srvCert + '\n' + certs.caCert);

  console.log('\n✅ Certificates generated!');
  console.log('────────────────────────────────────────');
  console.log('  Your IP  : ' + ip);
  console.log('  App URL  : https://' + ip + ':9443');
  console.log('  Trust URL: https://' + ip + ':9443/trust.html');
  console.log('────────────────────────────────────────');
  console.log('\n📱 iPhone setup (one time):');
  console.log('  1. Open trust URL in Safari');
  console.log('  2. Download + install CA certificate');
  console.log('  3. Settings > General > VPN & Device Mgmt > Trust');
  console.log('  4. Open app URL\n');
}

main().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
