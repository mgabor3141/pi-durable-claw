#!/bin/sh
# The host key lives in a volume, so the harness's trust survives re-creating the container. The harness's public key
# is read from /pubkey at each login (sshd_config), so nothing waits for it.
set -eu
chown agent:agent /workspace   # a bind mount Docker may have created as root

# Fetched pages live on the workspace volume, not in /tmp: /tmp is a tmpfs.
# They are evidence the agent can grep, and they expire after a day.
TMP_DIR=/workspace/tmp
mkdir -p "$TMP_DIR/pages"
chown -R agent:agent "$TMP_DIR"
(
  while true; do
    find "$TMP_DIR" -type f -mmin +1440 -delete 2>/dev/null || true
    find "$TMP_DIR" -mindepth 1 -type d -empty -delete 2>/dev/null || true
    sleep 3600
  done
) &
[ -f /etc/ssh/host/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/host/ssh_host_ed25519_key
exec /usr/sbin/sshd -D -e
