#!/usr/bin/env bash
# Run this ON THE VM (as a sudo-capable user), once, after the VM is created
# and you've gotten the Nightbeacon repo onto it (see 01-gcloud-provision.sh's
# printed next-steps). Installs Node.js, PostgreSQL, nginx, certbot, and
# creates a dedicated non-root system user to run the app.
set -euo pipefail

echo "== Updating system packages =="
sudo apt-get update
sudo apt-get upgrade -y

echo "== Installing Node.js 20 (NodeSource) =="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "== Installing PostgreSQL =="
sudo apt-get install -y postgresql postgresql-contrib

echo "== Installing nginx and certbot =="
sudo apt-get install -y nginx certbot python3-certbot-nginx

echo "== Creating dedicated system user for the app =="
if ! id -u nightbeacon >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /usr/sbin/nologin nightbeacon
fi

echo "== Creating application database and role =="
DB_PASSWORD="$(openssl rand -hex 24)"
sudo -u postgres psql -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nightbeacon') THEN
    CREATE ROLE nightbeacon LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END \$\$;"
sudo -u postgres psql -c "SELECT 1 FROM pg_database WHERE datname = 'nightbeacon'" | grep -q 1 || \
  sudo -u postgres createdb -O nightbeacon nightbeacon

echo
echo "== Setup complete =="
echo "Generated Postgres password for the 'nightbeacon' role (save this — it will not be shown again):"
echo "  $DB_PASSWORD"
echo
echo "Next: fill in nightbeacon/server/.env (use .env.example as a template) with:"
echo "  DATABASE_URL=postgres://nightbeacon:${DB_PASSWORD}@localhost:5432/nightbeacon"
echo "  ...plus TELEGRAM_*, OPENROUTER_*, SESSION_SECRET, OPERATOR_* — never commit this file."
echo "Then run: bash nightbeacon/deploy/03-deploy.sh"
