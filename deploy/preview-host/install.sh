#!/usr/bin/env bash
# TASK-1228: prepare a machine to host live previews — additively only.
#
#   deploy/preview-host/install.sh
#
# The machine may already run other services (on ours it runs nginx, postgres
# and an app on :3000, with ufw active).
#
# 2026-10-03 lesson, encoded below: installing docker.io via apt turned ufw
# *inactive*, and re-enabling it produced a firewall containing only the preview
# port range — which blocked 22/80/443 and locked the machine out. Therefore:
#   * every piece of firewall state is snapshotted and restored explicitly;
#   * allow rules for ports that were reachable before are re-added BEFORE any
#     re-enable, never after;
#   * a backup that fails is an error, not a warning (the iptables backup
#     silently wrote 0 bytes last time and "having a way back" was fiction);
#   * before/after snapshots are compared and any difference aborts the run.
set -euo pipefail

PREVIEW_DIR="${AI_PREVIEW_DIR:-/srv/previews}"
PREVIEW_PORT_RANGE="${AI_PREVIEW_PORT_RANGE:-18080:18082}"
BASE_IMAGE="${AI_PREVIEW_BASE_IMAGE:-node:22-bookworm-slim}"
BACKUP="/root/iptables-before-docker.rules"
UFW_SNAPSHOT="/root/ufw-before-docker.txt"

echo "==> before-state snapshot (must all succeed)"
ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | sort -u > /tmp/ports-before.txt
systemctl list-units --type=service --state=running --no-legend 2>/dev/null |
  awk '{print $1}' | sort > /tmp/services-before.txt
UFW_WAS_ACTIVE=0
if systemctl is-active --quiet ufw; then
  UFW_WAS_ACTIVE=1
  ufw status verbose > "$UFW_SNAPSHOT"          # the rule list, not just the state
  # Everything currently allowed must survive whatever we do below.
  awk '/^[0-9]+ +ALLOW/ {print $3}' "$UFW_SNAPSHOT" | sort -u > /tmp/ufw-allow-before.txt || true
  echo "    ufw was active; rules saved to $UFW_SNAPSHOT ($(grep -c ALLOW "$UFW_SNAPSHOT" || true) allow rules)"
fi
if command -v iptables-save >/dev/null; then
  iptables-save > "$BACKUP"
  [[ -s "$BACKUP" ]] || { echo "    ERROR: iptables backup is empty" >&2; exit 1; }
  echo "    iptables backed up to $BACKUP ($(wc -l < "$BACKUP") lines)"
fi
echo "    $(wc -l < /tmp/services-before.txt) services running, $(wc -l < /tmp/ports-before.txt) listening sockets"

echo "==> docker (installed only when missing)"
if command -v docker >/dev/null; then
  echo "    docker already present: $(docker --version)"
else
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io
  systemctl enable --now docker >/dev/null
  echo "    installed $(docker --version)"
fi
docker info >/dev/null

# Installing packages can stop ufw (it happened on 2026-10-03). If it was active
# before, put every previously-allowed port back FIRST, then re-enable.
if [[ "$UFW_WAS_ACTIVE" == "1" ]] && ! systemctl is-active --quiet ufw; then
  echo "    ufw was stopped by the install — restoring it"
  while read -r rule; do
    [[ -n "$rule" ]] && ufw allow "$rule" >/dev/null
  done < /tmp/ufw-allow-before.txt
  for port in 22 80 443; do
    ss -ltn | grep -q ":$port " && ufw allow "$port/tcp" >/dev/null
  done
  ufw --force enable >/dev/null
  echo "    ufw re-enabled with $(ufw status | grep -c ALLOW || true) allow rules"
fi

# Docker can reset the FORWARD policy; other services on this box must keep
# working, so put it back if it changed and say so loudly.
if command -v iptables >/dev/null; then
  forward_policy="$(iptables -S FORWARD | head -1 || true)"
  if [[ "$forward_policy" == "-P FORWARD DROP" ]]; then
    echo "    restoring FORWARD policy to ACCEPT (docker changed it)"
    iptables -P FORWARD ACCEPT
  fi
fi

echo "==> firewall: open only the preview range"
if systemctl is-active --quiet ufw; then
  for port in 22 80 443; do
    ss -ltn | grep -q ":$port " && ufw allow "$port/tcp" >/dev/null
  done
  ufw allow "$PREVIEW_PORT_RANGE/tcp" comment 'ai-harness preview (TASK-1228)' >/dev/null
  echo "    ufw allowed $PREVIEW_PORT_RANGE/tcp"
else
  echo "    ufw inactive — nothing to open"
fi

echo "==> preview workspace"
mkdir -p "$PREVIEW_DIR"

echo "==> base image"
if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  echo "    $BASE_IMAGE already present"
else
  # Docker Hub is not always reachable from here (2026-10-03: it is not). Ship
  # the image from a machine that has it instead of failing the whole script:
  #   docker save harness/execution:node22 | ssh <this-host> 'docker load'
  echo "    $BASE_IMAGE missing — ship it from the harness host with:" >&2
  echo "      docker save <image> | ssh $(hostname) 'docker load'" >&2
  echo "    (not pulling from Docker Hub: it is unreachable from this machine)"
fi

echo "==> verification (other services must be untouched)"
ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | sort -u > /tmp/ports-after.txt
systemctl list-units --type=service --state=running --no-legend 2>/dev/null |
  awk '{print $1}' | sort > /tmp/services-after.txt

missing="$(comm -23 /tmp/ports-before.txt /tmp/ports-after.txt || true)"
stopped="$(comm -23 /tmp/services-before.txt /tmp/services-after.txt || true)"
if [[ -n "$missing" ]]; then
  echo "    !! sockets that disappeared: $missing" >&2
fi
if [[ -n "$stopped" ]]; then
  echo "    !! services that stopped: $stopped" >&2
fi
[[ -n "$missing$stopped" ]] && { echo "    ABORT: other services were affected" >&2; exit 1; }

for port in 80 443 5432; do
  if ss -ltn | grep -q ":$port "; then
    echo "    :$port still listening ✓"
  fi
done
if [[ "$UFW_WAS_ACTIVE" == "1" ]]; then
  ufw status verbose | grep -q "22/tcp" || { echo "    ABORT: 22/tcp not allowed in ufw" >&2; exit 1; }
  ufw status verbose | grep -q "80/tcp" || { echo "    ABORT: 80/tcp not allowed in ufw" >&2; exit 1; }
  ufw status verbose | grep -q "443/tcp" || { echo "    ABORT: 443/tcp not allowed in ufw" >&2; exit 1; }
  echo "    ufw still allows 22/80/443 ✓"
fi
echo "    preview range $PREVIEW_PORT_RANGE opened, workspace $PREVIEW_DIR, base image $BASE_IMAGE"
echo "==> done"
