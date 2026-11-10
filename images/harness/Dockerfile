# The harness: the agent loop and the T3 bridge, which serves T3's web app. It holds the keys; it never runs agent code.
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

# --- build ---------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
# The bridge (@mgabor3141/pi-durable-t3) installs from git and builds on install: it fetches T3 (git) and its web app.
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
# The bridge's build on install needs its devDependencies, which `--prod` skips: install fully, typecheck, then prune
# (a second `pnpm install --prod` keeps the dev tools; `prune --prod` removes them).
RUN pnpm install --frozen-lockfile && pnpm typecheck && pnpm prune --prod

# --- run ------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /data /pubkey && chown node:node /data /pubkey
COPY --from=build --chown=node:node /app /app
COPY images/harness/claw /usr/local/bin/claw
COPY --from=tailnet /claw-tailnet /usr/local/bin/claw-tailnet
WORKDIR /app
# /data holds everything the harness keeps: storage, bridge state, SSH keys. `claw` runs the host as node.
ENV CLAW_ROOT=/data CLAW_HOST=0.0.0.0 CLAW_PUBKEY_DIR=/pubkey
EXPOSE 3775
CMD ["claw"]
