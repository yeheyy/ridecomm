# 🏍️ RideComm — VPS Deployment Guide

## ✅ Why VPS is Better Than Hotspot

| | Hotspot | VPS |
|---|---|---|
| Range | ~50m | Worldwide |
| SSL cert | Manual (self-signed) | Automatic (Let's Encrypt) |
| Always online | No (need laptop) | Yes (24/7) |
| iPhone mic | Cert tricks needed | Works instantly |
| Cost | Free | ~$5/month |

---

## 🛒 Recommended VPS Providers (cheap)

| Provider | Price | Link |
|---|---|---|
| **Contabo** | $5/mo | contabo.com |
| **Hetzner** | $4/mo | hetzner.com |
| **DigitalOcean** | $6/mo | digitalocean.com |
| **Vultr** | $6/mo | vultr.com |
| **Hostinger VPS** | $5/mo | hostinger.com |

Get the cheapest plan — **1 CPU, 1GB RAM, Ubuntu 22.04**

---

## 🌐 Domain Name (Required for SSL)

You need a domain pointed to your VPS IP.

**Free options:**
- `freedns.afraid.org` — free subdomain
- `duckdns.org` — free subdomain (e.g. ridecomm.duckdns.org)

**Cheap options:**
- Namecheap: ~$1/year for `.xyz`

**DNS setup:**
Add an `A record` pointing your domain to your VPS IP address.
Wait 5-30 minutes for DNS to propagate.

---

## 🚀 Quick Deploy (Automated)

### 1. Upload project to VPS
```bash
# From your Windows PC (using Git Bash or PowerShell)
scp -r ridecomm/ root@YOUR_VPS_IP:/root/ridecomm
```

Or use **FileZilla** (free FTP client) to upload the folder via SFTP.

### 2. SSH into your VPS
```bash
ssh root@YOUR_VPS_IP
cd /root/ridecomm
```

### 3. Run the deploy script
```bash
bash DEPLOY_VPS.sh
```

It will ask for your domain and email, then do everything automatically:
- Install Node.js, Nginx, PM2
- Get free SSL certificate (Let's Encrypt)
- Configure nginx as reverse proxy
- Start the app with PM2 (auto-restart on crash/reboot)

---

## 🔧 Manual Deploy (Step by Step)

### Step 1 — Install Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Step 2 — Install PM2
```bash
sudo npm install -g pm2
```

### Step 3 — Install app
```bash
cd /root/ridecomm
npm install --production
```

### Step 4 — Start app
```bash
PORT_HTTP=9000 TRUST_PROXY=true NO_BUILTIN_SSL=true pm2 start server.js --name ridecomm
pm2 save
pm2 startup
```

### Step 5 — Install Nginx
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

### Step 6 — Configure Nginx
```bash
sudo nano /etc/nginx/sites-available/ridecomm
# Paste contents of nginx.conf, replace YOUR_DOMAIN
sudo ln -s /etc/nginx/sites-available/ridecomm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Step 7 — Get free SSL
```bash
sudo certbot --nginx -d YOUR_DOMAIN --email YOUR_EMAIL --agree-tos
```

### Step 8 — Done!
Open `https://YOUR_DOMAIN` — no cert install, mic works instantly on iPhone! ✅

---

## 📋 Useful Commands

```bash
pm2 status              # Check if app is running
pm2 logs ridecomm       # View live logs
pm2 restart ridecomm    # Restart app
pm2 stop ridecomm       # Stop app
pm2 monit               # Live dashboard

sudo nginx -t           # Test nginx config
sudo systemctl reload nginx  # Reload nginx
sudo certbot renew      # Renew SSL (auto runs via cron)
```

---

## 🔥 Firewall Setup

Make sure these ports are open on your VPS:

```bash
sudo ufw allow 22    # SSH
sudo ufw allow 80    # HTTP (certbot + redirect)
sudo ufw allow 443   # HTTPS (app)
sudo ufw enable
```

---

## 💡 How It Works on VPS

```
iPhone  ──HTTPS──▶  Nginx (:443)
                        │
                    proxy_pass
                        │
                    Node.js (:9000)
                    ├── PeerJS signaling
                    ├── WebSocket presence
                    └── Static files

iPhone A ◀──WebRTC P2P──▶ iPhone B
(audio goes direct between phones, not through server)
```

The server only handles **signaling** (connecting peers).
Audio is always **peer-to-peer** — server never hears your voice.

---

Made with ❤️ for riders. Stay safe! 🏍️
