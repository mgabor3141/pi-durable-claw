#!/usr/bin/env bash
# The stack as you run it: build both images, start them with a placeholder credential, and check from outside that
#   - the launcher installed the harness (this checkout, dev/compose.source.yaml) and it came up (it only does once it
#     has reached the workspace over SSH),
#   - `claw pair` gives a code that pairs,
#   - a project added at ~/... is a folder in the workspace (the bridge, pi-env and sshd, end to end),
#   - with SMOKE_VERSION=<a commit on GitHub>: the stack restarted with CLAW_VERSION set to it downloads that
#     version, switches to it, and serves again; `claw rollback` is refused under a pin.
# No model is called. It starts from an empty ./data and removes it after, so it refuses to run where one exists.
#
#   dev/image-smoke.sh            (CI runs this; KEEP=1 leaves the stack up)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -e data ] || [ -e .env ]; then
  echo "data/ or .env exists: this check is for a fresh checkout, not a server in use"
  exit 2
fi
PORT=3775
BASE="http://127.0.0.1:$PORT"
# The harness is this checkout until the second part pins a downloaded version.
FILES="-f compose.yaml -f dev/compose.source.yaml"
# shellcheck disable=SC2086
compose() { docker compose -p claw-image-smoke $FILES "$@"; }
pin="$(mktemp)"

cleanup() {
  status=$?
  if [ "$status" != 0 ]; then
    echo "--- harness log ---"; compose logs --no-color --tail 80 harness || true
    echo "--- workspace log ---"; compose logs --no-color --tail 30 workspace || true
  fi
  rm -f "$pin"
  if [ "${KEEP:-}" != 1 ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    # The containers own ./data as uid 1000 (or root, before their first start).
    rm -rf data 2>/dev/null || sudo rm -rf data
  fi
  exit "$status"
}
trap cleanup EXIT

echo "== build"
compose build

echo "== start"
mkdir -p data/harness/pi
# A provider with a key is all the harness asks for at start; nothing here calls a model.
echo '{"anthropic":{"type":"api_key","key":"sk-image-smoke-not-a-key"}}' > data/harness/pi/auth.json
compose up -d

# The first start installs the harness: its dependencies, and the bridge's build. Minutes, not seconds.
wait_up() {
  up=
  for _ in $(seq 1 "$1"); do
    if curl -fsS "$BASE/.well-known/t3/environment" >/dev/null 2>&1; then up=1; break; fi
    sleep 1
  done
  [ "$up" = 1 ] || { echo "FAIL: the harness is not listening on $BASE after $1 s"; exit 1; }
}
wait_up 900
echo "the harness is up: $(curl -fsS "$BASE/.well-known/t3/environment")"
installed="$(compose exec -T harness claw version)"
echo "$installed"
grep -q '^running: local-.* (file:/src)' <<<"$installed" || { echo "FAIL: the harness that runs is not this checkout"; exit 1; }
# What the harness asks the launcher for T3's Update button: a checkout has no newer version.
checked="$(compose exec -T harness claw check)"
grep -q '"current":"local-[0-9]*","latest":null' <<<"$checked" || { echo "FAIL: claw check answered $checked"; exit 1; }

echo "== pair"
CODE="$(compose exec -T harness claw pair | sed -n 's/^Pairing code (single use): //p' | head -1)"
[ -n "$CODE" ] || { echo "FAIL: claw pair printed no code"; exit 1; }
TOKEN="$(curl -fsS -X POST "$BASE/oauth/token" \
  --data-urlencode grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  --data-urlencode "subject_token=$CODE" \
  --data-urlencode subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap \
  --data-urlencode requested_token_type=urn:ietf:params:oauth:token-type:access_token \
  | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] || { echo "FAIL: the pairing code bought no token"; exit 1; }
echo "paired"

echo "== a project at ~/image-smoke is a folder in the workspace"
curl -fsS -X POST "$BASE/api/projects/mutate" \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"type":"project.create","commandId":"image-smoke","projectId":"image-smoke","title":"image-smoke","workspaceRoot":"~/image-smoke","createWorkspaceRootIfMissing":true}'
echo
compose exec -T workspace test -d /home/agent/image-smoke || { echo "FAIL: /home/agent/image-smoke is not in the workspace"; exit 1; }
[ "$(compose exec -T workspace stat -c %U /home/agent/image-smoke)" = agent ] || { echo "FAIL: the folder is not the agent's"; exit 1; }

if [ -n "${SMOKE_VERSION:-}" ]; then
  echo "== CLAW_VERSION=$SMOKE_VERSION: downloaded, switched to, serving"
  printf 'services:\n  harness:\n    environment:\n      CLAW_VERSION: "%s"\n' "$SMOKE_VERSION" > "$pin"
  FILES="-f compose.yaml -f $pin"
  compose up -d
  # The container was replaced: wait for the old one's port to close, then for the new version.
  sleep 5
  wait_up 900
  short="$(printf %s "$SMOKE_VERSION" | cut -c1-12)"
  # The launcher says a version serves within a second of its first answer.
  for _ in $(seq 1 30); do
    installed="$(compose exec -T harness claw version)"
    logged="$(compose logs --no-color harness)"
    if grep -q "^running: $short " <<<"$installed" && grep -q "claw: version $short serves" <<<"$logged"; then switched=1; break; fi
    sleep 2
  done
  echo "$installed"
  [ "${switched:-}" = 1 ] || { echo "FAIL: version $short does not run, or the launcher did not see it serve"; exit 1; }
  grep -q '^before it: local-' <<<"$installed" || { echo "FAIL: the version before was not kept"; exit 1; }
  if compose exec -T harness claw rollback 2>/dev/null; then echo "FAIL: claw rollback went against CLAW_VERSION"; exit 1; fi
  paired="$(compose exec -T harness claw pair)"
  grep -q '^Pairing code' <<<"$paired" || { echo "FAIL: claw pair does not work in the downloaded version"; exit 1; }
  checked="$(compose exec -T harness claw check)"
  grep -q "\"current\":\"$short\",\"latest\":\"$short\"" <<<"$checked" || { echo "FAIL: claw check answered $checked"; exit 1; }

  echo "== claw restart: the launcher restarts the harness in place"
  restarted="$(compose exec -T harness claw restart)"
  [ "$restarted" = '{"restarting":true}' ] || { echo "FAIL: claw restart answered $restarted"; exit 1; }
  sleep 3
  wait_up 120
  starts="$(compose logs --no-color harness | grep -c "claw: starting the harness, version $short")"
  [ "$starts" -ge 2 ] || { echo "FAIL: the harness was started $starts time(s), not again"; exit 1; }
fi

echo
echo "image-smoke: PASS"
