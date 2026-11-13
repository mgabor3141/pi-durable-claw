#!/usr/bin/env bash
# The stack as you run it: build both images, start them with a placeholder credential, and check from outside that
#   - the harness came up (it only does once it has reached the workspace over SSH),
#   - `claw pair` gives a code that pairs,
#   - a project added at ~/... is a folder in the workspace (the bridge, pi-env and sshd, end to end).
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
compose() { docker compose -p claw-image-smoke "$@"; }

cleanup() {
  status=$?
  if [ "$status" != 0 ]; then
    echo "--- harness log ---"; compose logs --no-color --tail 80 harness || true
    echo "--- workspace log ---"; compose logs --no-color --tail 30 workspace || true
  fi
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

for _ in $(seq 1 120); do
  if curl -fsS "$BASE/.well-known/t3/environment" >/dev/null 2>&1; then up=1; break; fi
  sleep 1
done
[ "${up:-}" = 1 ] || { echo "FAIL: the harness is not listening on $BASE after 120 s"; exit 1; }
echo "the harness is up: $(curl -fsS "$BASE/.well-known/t3/environment")"

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

echo
echo "image-smoke: PASS"
