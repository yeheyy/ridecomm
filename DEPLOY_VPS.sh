#!/bin/bash
# ══════════════════════════════════════════════════════════════════
#  RideComm VPS Deploy Script
#  Run this on your VPS: bash DEPLOY_VPS.sh
#  Tested on: Ubuntu 20.04 / 22.04 / 24.04
# ══════════════════════════════════════════════════════════════════

set -e  # stop on any error
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     🏍️  RideComm VPS Deployment Script           ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ── Ask for domain ─────────────────────────────────────────────────────────
read -p "  Enter your domain name (e.g. ridecomm.yourdomain.com): " DOMAIN
if [ -z "$DOMAIN" ]; then
    echo -e "${RED}  [ERROR] Domain is required!${NC}"
    exit 1
fi

read -p "  Enter your email (for SSL certificate): " EMAIL
if [ -z "$EMAIL" ]; then
    echo -e "${RED}  [ERROR] Email is required for SSL!${NC}"
    exit 1
fi

echo ""
echo -e "  ${GREEN}Domain: $DOMAIN${NC}"
echo -e "  ${GREEN}Email:  $EMAIL${NC}"
echo ""
read -p "  Continue? (y/n): " CONFIRM
if [ "$CONFIRM" != "y" ]; then exit 0; fi

# ── Install Node.js ────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[1/6] Installing Node.js 20...${NC}"
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo -e "${GREEN}  Node.js $(node --version) ready${NC}"

# ── Install PM2 ────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[2/6] Installing PM2 process manager...${NC}"
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
fi
echo -e "${GREEN}  PM2 $(pm2 --version) ready${NC}"

# ── Install Nginx ──────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[3/6] Installing Nginx...${NC}"
sudo apt-get update -qq
sudo apt-get install -y nginx certbot python3-certbot-nginx
echo -e "${GREEN}  Nginx ready${NC}"

# ── Install npm packages ────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[4/6] Installing app dependencies...${NC}"
npm install --production
echo -e "${GREEN}  Dependencies installed${NC}"

# ── Setup Nginx config ─────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[5/6] Configuring Nginx for $DOMAIN...${NC}"

sudo tee /etc/nginx/sites-available/ridecomm > /dev/null << NGINXEOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl;
    server_name $DOMAIN;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location /ws {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
    }
    location /peerjs/ {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
    }
}
NGINXEOF

sudo ln -sf /etc/nginx/sites-available/ridecomm /etc/nginx/sites-enabled/ridecomm
sudo rm -f /etc/nginx/sites-enabled/default

# Temp HTTP-only config for certbot
sudo tee /etc/nginx/sites-available/ridecomm-temp > /dev/null << TMPEOF
server {
    listen 80;
    server_name $DOMAIN;
    root /var/www/html;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 200 'RideComm setup in progress'; add_header Content-Type text/plain; }
}
TMPEOF
sudo ln -sf /etc/nginx/sites-available/ridecomm-temp /etc/nginx/sites-enabled/ridecomm
sudo nginx -t && sudo systemctl reload nginx

# Get SSL cert
echo -e "${YELLOW}  Getting Let's Encrypt SSL certificate...${NC}"
sudo certbot certonly --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive

# Switch to full config
sudo ln -sf /etc/nginx/sites-available/ridecomm /etc/nginx/sites-enabled/ridecomm
sudo nginx -t && sudo systemctl reload nginx
echo -e "${GREEN}  Nginx + SSL configured!${NC}"

# ── Start app with PM2 ─────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[6/6] Starting RideComm with PM2...${NC}"
mkdir -p logs
pm2 stop ridecomm 2>/dev/null || true
pm2 delete ridecomm 2>/dev/null || true

NODE_ENV=production PORT_HTTP=9000 TRUST_PROXY=true NO_BUILTIN_SSL=true \
    pm2 start server.js --name ridecomm \
    --max-memory-restart 256M \
    --log ./logs/ridecomm.log \
    --time

pm2 save
sudo pm2 startup systemd -u $USER --hp $HOME | tail -1 | bash || true

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     ✅  RIDECOMM DEPLOYED SUCCESSFULLY!          ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  URL:    https://$DOMAIN              ║${NC}"
echo -e "${GREEN}║  Status: pm2 status                              ║${NC}"
echo -e "${GREEN}║  Logs:   pm2 logs ridecomm                       ║${NC}"
echo -e "${GREEN}║  Stop:   pm2 stop ridecomm                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Riders just open ${CYAN}https://$DOMAIN${NC} in Safari — no cert install needed!"
echo ""
