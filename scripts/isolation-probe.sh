#!/bin/sh
# Isolation probe, executed INSIDE the execution container (TASK-910).
#
#   docker exec <container> sh /workspace/.isolation-probe.sh
#
# Exits non-zero if any isolation guarantee is violated. Keep this script
# image-agnostic: only POSIX sh plus /proc.

set -u
fail=0

check() {
  name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS ${name}"
  else
    echo "FAIL ${name}"
    fail=1
  fi
}

# --- privilege isolation ---------------------------------------------------
check non_root sh -c '[ "$(id -u)" != "0" ]'
check no_docker_socket test ! -e /var/run/docker.sock
check rootfs_readonly test ! -w /
check etc_not_writable test ! -w /etc
check shadow_not_readable test ! -r /etc/shadow

caps=$(grep -i '^CapEff:' /proc/self/status 2>/dev/null | tr -d ' \t' | cut -d: -f2)
check caps_dropped test "${caps:-unknown}" = "0000000000000000"

# --- filesystem isolation --------------------------------------------------
check workspace_writable sh -c 'touch /workspace/.isolation-probe && rm -f /workspace/.isolation-probe'
check tmp_writable sh -c 'touch /tmp/.isolation-probe && rm -f /tmp/.isolation-probe'
check home_writable sh -c 'touch /home/agent/.isolation-probe && rm -f /home/agent/.isolation-probe'
check host_root_absent test ! -e /srv/harness
check no_host_etc_hosts_write test ! -w /etc/hosts

if [ "$fail" -ne 0 ]; then
  echo "ISOLATION PROBE FAILED"
  exit 1
fi
echo "ISOLATION PROBE PASSED"
