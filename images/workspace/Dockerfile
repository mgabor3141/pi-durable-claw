# The workspace: a container the harness reaches over SSH with pi-env (it needs only sshd). It holds no keys of the
# harness's: only the harness's PUBLIC key, and whatever the agent's own scripts write under /workspace.
FROM debian:bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssh-server python3 git curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /run/sshd /workspace /etc/ssh/host \
	&& useradd -m -u 1000 -s /bin/bash -p '*' agent \
	&& chown agent:agent /workspace

COPY sshd_config /etc/ssh/sshd_config.d/claw.conf
COPY entrypoint.sh /entrypoint.sh

VOLUME /workspace
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
