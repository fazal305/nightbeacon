#!/usr/bin/env bash
# Run this ON THE VM, from the repo root (e.g. ~/nightbeacon), after
# 02-setup-vm.sh and after server/.env is filled in. Safe to re-run for
# subsequent deploys (git pull + reinstall + migrate + rebuild + restart).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ ! -f server/.env ]; then
  echo "server/.env is missing. Copy .env.example, fill in real values, and re-run." >&2
  exit 1
fi

echo "== Pulling latest code (if this is a re-deploy) =="
git pull --ff-only || echo "(not a git checkout, or already up to date — continuing)"

echo "== Installing backend dependencies =="
cd "$REPO_DIR/server"
npm ci --omit=dev

echo "== Running database migrations =="
npm run migrate

echo "== Building frontend =="
cd "$REPO_DIR/web"
npm ci
npm run build

echo "== Installing systemd service =="
sudo cp "$REPO_DIR/deploy/nightbeacon.service" /etc/systemd/system/nightbeacon.service
sudo sed -i "s|__REPO_DIR__|$REPO_DIR|g" /etc/systemd/system/nightbeacon.service
sudo chown -R nightbeacon:nightbeacon "$REPO_DIR"
sudo systemctl daemon-reload
sudo systemctl enable nightbeacon
sudo systemctl restart nightbeacon

echo "== Installing nginx site config =="
sudo cp "$REPO_DIR/deploy/nginx-nightbeacon.conf" /etc/nginx/sites-available/nightbeacon
sudo sed -i "s|__REPO_DIR__|$REPO_DIR|g" /etc/nginx/sites-available/nightbeacon
sudo ln -sf /etc/nginx/sites-available/nightbeacon /etc/nginx/sites-enabled/nightbeacon
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

echo
echo "== Deploy complete =="
echo "Backend status: sudo systemctl status nightbeacon"
echo "Logs:           sudo journalctl -u nightbeacon -f"
echo
echo "TLS is not yet configured. Once your domain's DNS points at this VM's IP, run:"
echo "  sudo certbot --nginx -d your-domain.example"
