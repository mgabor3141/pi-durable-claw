#!/bin/sh
# The host key lives in a volume, so the harness's trust survives re-creating the container. The harness's public key
# is read from /pubkey at each login (sshd_config), so nothing waits for it.
set -eu
chown agent:agent /home/agent   # a bind mount Docker may have created as root

# A bind-mounted home hides the image's skeleton files. Seed the shell files only when missing, so edits persist.
for file in .profile .bashrc .bash_logout; do
	[ -e "/home/agent/$file" ] || install -m 644 -o agent -g agent "/etc/skel/$file" "/home/agent/$file"
done

[ -f /etc/ssh/host/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/host/ssh_host_ed25519_key

# Node lives in the persistent home; publish its binaries on PATH for every shell.
for bin in node npm npx; do
	[ -x "/home/agent/tools/node/bin/$bin" ] && ln -sf "/home/agent/tools/node/bin/$bin" "/usr/local/bin/$bin"
done

exec /usr/sbin/sshd -D -e
