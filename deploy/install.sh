#!/usr/bin/env bash
# One-time host setup (run as root on the deployment machine):
#
#   deploy/install.sh
#
# Idempotent: creates the dedicated PostgreSQL, applies migrations, installs
# and (re)starts the systemd unit. It never touches other stacks on the box.
set -euo pipefail

REMOTE_DIR="${AI_DEPLOY_DIR:-/srv/ai-harness}"
ENV_FILE="$REMOTE_DIR/deploy/ai-harness.env"

cd "$REMOTE_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE — copy deploy/ai-harness.env.example and fill it in" >&2
  exit 1
fi
chmod 600 "$ENV_FILE"

echo "==> PostgreSQL (dedicated container, localhost only)"
docker compose -f deploy/docker-compose.harness.yml up -d
for _ in $(seq 1 30); do
  if docker exec ai-harness-db pg_isready -U ai -d ai_harness >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec ai-harness-db pg_isready -U ai -d ai_harness

echo "==> migrations"
set -a; . "$ENV_FILE"; set +a
node scripts/migrate.mjs

echo "==> systemd unit"
install -m 644 deploy/ai-harness.service /etc/systemd/system/ai-harness.service
systemctl daemon-reload
systemctl enable ai-harness >/dev/null
systemctl restart ai-harness
sleep 3
systemctl --no-pager --lines=25 status ai-harness || true
