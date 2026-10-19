#!/bin/sh
# The host key lives in a volume, so the harness's trust survives re-creating the container. The harness's public key
# is read from /pubkey at each login (sshd_config), so nothing waits for it.
set -eu
chown agent:agent /workspace   # a bind mount Docker may have created as root
[ -f /etc/ssh/host/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/host/ssh_host_ed25519_key
exec /usr/sbin/sshd -D -e
