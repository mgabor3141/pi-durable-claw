# The harness's image: Node, the tools an install needs, `claw-tailnet`, and the launcher. It holds no harness. The
# launcher (launcher/launcher.ts) downloads the harness as a package at the first start, installs it in the `app`
# volume, and runs it from there; `claw update` installs a newer version. So this image changes only when Node, the
# launcher or claw-tailnet do. The harness holds the keys; it never runs agent code.
# Build context: the repo root (compose does this).
ARG NODE_IMAGE=node:24-bookworm-slim
ARG GO_IMAGE=golang:1.27.3-bookworm

# --- claw-tailnet: remote access over your tailnet (tailnet/, Go with embedded Tailscale) ---------------------------
FROM ${GO_IMAGE} AS tailnet
WORKDIR /src
COPY tailnet/go.mod tailnet/go.sum ./
RUN go mod download
COPY tailnet/*.go ./
RUN go vet . && go test . && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /claw-tailnet .

# --- run ------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE}
# openssh-client: the harness reaches the workspace over SSH. ca-certificates: downloads, and claw-tailnet verifying
# Let's Encrypt. git and curl: the T3 bridge builds when it is installed from git (it fetches T3 and its web app).
# pnpm installs a version by its lockfile; corepack keeps it in COREPACK_HOME, which the node user owns so a version
# that names another pnpm can fetch it.
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates git curl \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable && corepack prepare pnpm@10.32.1 --activate \
	&& mkdir -p /data /pubkey /app && chown -R node:node /data /pubkey /app /opt/corepack
COPY launcher/launcher.ts /opt/claw/launcher.ts
COPY images/harness/claw /usr/local/bin/claw
COPY --from=tailnet /claw-tailnet /usr/local/bin/claw-tailnet
WORKDIR /app
# /data holds everything the harness keeps: storage, bridge state, SSH keys. /app holds the installed harness, which
# can be downloaded again. `claw` runs the launcher as node, with the image's paths as flags.
EXPOSE 3775
CMD ["claw"]
