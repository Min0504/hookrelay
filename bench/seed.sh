#!/usr/bin/env bash
# 테넌트·endpoint 시드. compose 스택(:8080) 또는 로컬 API(:3000)에 붙는다.
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
ADMIN="${ADMIN_KEY:-dev-admin-key-change-me}"
RECEIVER_HOOK="${RECEIVER_HOOK:-http://demo-receiver:4100/hooks}"
RECEIVER_ADMIN="${RECEIVER_ADMIN:-http://localhost:8080/receiver}"

create_tenant() {
  local name="$1"
  curl -sf -X POST "$BASE/tenants" \
    -H "X-Admin-Key: $ADMIN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$name\",\"plan\":\"PRO\"}"
}

register() {
  local key="$1" url="$2"
  local ep
  ep="$(curl -sf -X POST "$BASE/endpoints" \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"$url\",\"description\":\"seed\"}")"
  local id secret
  id="$(echo "$ep" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  secret="$(echo "$ep" | python3 -c 'import json,sys; print(json.load(sys.stdin)["secret"])')"
  curl -sf -X PUT "$BASE/endpoints/$id/subscriptions" \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d '{"eventTypes":["order.created"]}' >/dev/null
  curl -sf -X POST "$RECEIVER_ADMIN/config" \
    -H "Content-Type: application/json" \
    -d "{\"secret\":\"$secret\"}" >/dev/null
  echo "$ep"
}

echo "seeding against $BASE"
healthy="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/metrics" || true)"
if [[ "$healthy" != "200" ]]; then
  echo "API not ready (GET /metrics → $healthy)" >&2
  exit 1
fi

FAST_NAME="bench-fast-$(date +%s)"
SLOW_NAME="bench-slow-$(date +%s)"
FAST_JSON="$(create_tenant "$FAST_NAME")"
SLOW_JSON="$(create_tenant "$SLOW_NAME")"
FAST_KEY="$(echo "$FAST_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["apiKey"])')"
SLOW_KEY="$(echo "$SLOW_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["apiKey"])')"

register "$FAST_KEY" "$RECEIVER_HOOK" >/dev/null
register "$SLOW_KEY" "${RECEIVER_HOOK}/slow" >/dev/null

mkdir -p bench/out
cat > bench/out/seed.env <<EOF
KEY_B=$FAST_KEY
KEY_A=$SLOW_KEY
KEY=$FAST_KEY
BASE=$BASE
EOF
echo "wrote bench/out/seed.env"
echo "KEY_B(fast)=$FAST_KEY"
echo "KEY_A(slow)=$SLOW_KEY"
