#!/usr/bin/env bash
# Publish the local build to the deployment host.
#
#   AI_DEPLOY_HOST=root@<host> deploy/deploy.sh   # build → rsync → migrate → restart
#
# The tree is shipped without node_modules (installed on the host) and without
# the local secrets file (the host's copy is never overwritten).
set -euo pipefail

if [ -z "${AI_DEPLOY_HOST:-}" ]; then
  echo "AI_DEPLOY_HOST is not set (e.g. AI_DEPLOY_HOST=root@<host> deploy/deploy.sh)" >&2
  exit 1
fi
HOST="$AI_DEPLOY_HOST"
KEY="${AI_DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR="${AI_DEPLOY_DIR:-/srv/ai-harness}"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")

cd "$LOCAL_DIR"
echo "==> typecheck + unit tests"
npm run typecheck
npm test --silent
echo "==> build"
npm run build

echo "==> rsync → $HOST:$REMOTE_DIR"
rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude artifacts \
  --exclude 'deploy/ai-harness.env' \
  -e "ssh -i $KEY -o BatchMode=yes" \
  ./ "$HOST:$REMOTE_DIR/"

echo "==> install dependencies on the host"
"${SSH[@]}" "cd '$REMOTE_DIR' && npm ci --no-audit --no-fund >/dev/null && echo deps-ok"

echo "==> migrate + restart"
"${SSH[@]}" bash -s <<REMOTE
set -euo pipefail
cd '$REMOTE_DIR'
set -a; . deploy/ai-harness.env; set +a
node scripts/migrate.mjs
if [ -z "\${FEISHU_APP_ID:-}" ]; then
  echo "FEISHU_APP_ID is empty — credentials not configured yet, skipping restart"
# systemctl cat instead of piping list-unit-files into grep: under
# set -o pipefail an early-exiting grep sends SIGPIPE to systemctl, so an
# installed unit was flakily reported as missing and the restart got skipped.
# (No backticks here — this heredoc is unquoted, so they would be command
# substitution on the deploying machine.)
elif systemctl cat ai-harness.service >/dev/null 2>&1; then
  systemctl restart ai-harness
  sleep 2
  systemctl is-active ai-harness
else
  echo "unit not installed yet — run deploy/install.sh on the host"
fi
REMOTE

echo "==> done"
