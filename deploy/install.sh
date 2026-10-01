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

echo "==> execution images"
# TASK-1217: a Run starts one container from the repository's execution image.
# Building that image belongs here (it needs network + apt + codex), not in the
# Run path, where a missing image used to burn an attempt and block the task.
EXEC_RUNTIME="${AI_EXECUTION_RUNTIME:-node22}"
EXEC_IMAGE="harness/execution:${EXEC_RUNTIME}"
EXEC_BASE_IMAGE="${AI_EXECUTION_BASE_IMAGE:-node:22-bookworm-slim}"
if docker image inspect "$EXEC_IMAGE" >/dev/null 2>&1; then
  echo "    $EXEC_IMAGE already present"
else
  echo "    building $EXEC_IMAGE (pulls $EXEC_BASE_IMAGE; installs git + codex)"
  docker build -f docker/execution/Dockerfile \
    --build-arg "BASE_IMAGE=$EXEC_BASE_IMAGE" \
    --build-arg "RUNTIME=$EXEC_RUNTIME" \
    -t "$EXEC_IMAGE" .
fi
# Repositories registered without --exec-image fall back to
# harness/execution:base in the core. Give that name a real image instead of
# leaving a dangling tag that only fails once a Run tries to start.
if [ "$EXEC_IMAGE" != "harness/execution:base" ] &&
  ! docker image inspect harness/execution:base >/dev/null 2>&1; then
  docker tag "$EXEC_IMAGE" harness/execution:base
  echo "    tagged $EXEC_IMAGE as harness/execution:base (default profile fallback)"
fi
if docker image inspect harness/execution-proxy:latest >/dev/null 2>&1; then
  echo "    harness/execution-proxy:latest already present"
else
  echo "    building harness/execution-proxy:latest"
  docker build -f docker/proxy/Dockerfile -t harness/execution-proxy:latest .
fi

echo "==> systemd unit"
install -m 644 deploy/ai-harness.service /etc/systemd/system/ai-harness.service
systemctl daemon-reload
systemctl enable ai-harness >/dev/null
systemctl restart ai-harness
sleep 3
systemctl --no-pager --lines=25 status ai-harness || true
