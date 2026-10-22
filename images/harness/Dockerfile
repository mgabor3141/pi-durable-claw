# The harness: the agent loop, the T3 bridge and its web app. It holds the keys; it never runs agent code.
# Build context: the repo root (compose does this).
ARG NODE_IMAGE=node:24-bookworm-slim

# --- build: pi-durable-t3 (not published) as our sibling, then this repo against it ---------------------------------
FROM ${NODE_IMAGE} AS build
ARG T3_COMMIT=69144cb9f4a21563771dd6f1507dfd8d6849a5d9
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app

# package.json's `link:../pi-durable-t3/...` dependencies expect this sibling layout (one copy of every pi package).
RUN git init -q pi-durable-t3 \
	&& git -C pi-durable-t3 remote add origin https://github.com/mgabor3141/pi-durable-t3.git \
	&& git -C pi-durable-t3 fetch -q --depth 1 origin "$T3_COMMIT" \
	&& git -C pi-durable-t3 checkout -q FETCH_HEAD \
	&& test "$(git -C pi-durable-t3 rev-parse HEAD)" = "$T3_COMMIT"
# `setup:t3` vendors T3's contracts and downloads its prebuilt web app (web-dist/), then installs.
RUN cd pi-durable-t3 && pnpm install --frozen-lockfile && pnpm setup:t3 && rm -rf .t3-cache .git

WORKDIR /app/pi-durable-claw
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src

# --- run ------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /data /pubkey && chown node:node /data /pubkey
COPY --from=build --chown=node:node /app /app
COPY images/harness/claw /usr/local/bin/claw
WORKDIR /app/pi-durable-claw
# /data holds everything the harness keeps: storage, bridge state, SSH keys. `claw` runs the host as node.
ENV CLAW_ROOT=/data CLAW_HOST=0.0.0.0 CLAW_PUBKEY_DIR=/pubkey
EXPOSE 3775
CMD ["claw"]
