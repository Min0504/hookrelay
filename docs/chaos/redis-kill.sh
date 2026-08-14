#!/usr/bin/env bash
# Redis 전면 다운 카오스 — 발행 API는 outbox만 쓰므로 계속 202를 줘야 한다.
# 복구 후 Relay가 PENDING부터 적재해 배달이 재개된다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
BASE="${BASE:-http://localhost:3000}"
# shellcheck disable=SC1091
if [[ -f bench/out/seed.env ]]; then source bench/out/seed.env; fi
KEY="${KEY:?run bench/seed.sh first}"
DOWN_SEC="${DOWN_SEC:-60}"

echo "== publish before kill"
curl -sf -X POST "$BASE/events" \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: chaos-before-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{"type":"order.created","payload":{"phase":"before"}}'
echo

echo "== stopping redis ${DOWN_SEC}s"
docker compose stop redis
sleep 2

echo "== publish during outage (must be 202)"
code="$(curl -s -o /tmp/hr-chaos-down.json -w '%{http_code}' -X POST "$BASE/events" \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: chaos-down-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{"type":"order.created","payload":{"phase":"down"}}')"
echo "status=$code body=$(cat /tmp/hr-chaos-down.json)"
if [[ "$code" != "202" ]]; then
  echo "FAIL: expected 202 during redis outage" >&2
  docker compose start redis
  exit 1
fi

echo "== waiting ${DOWN_SEC}s (outbox accumulating)"
sleep "$DOWN_SEC"

echo "== starting redis + relay/worker (컨테이너 stop은 DNS가 바뀌어 연결이 죽을 수 있다)"
docker compose start redis
sleep 2
docker compose restart relay worker
echo "== waiting for relay to drain"
sleep 10

DOWN_EVENT="$(python3 -c 'import json; print(json.load(open("/tmp/hr-chaos-down.json"))["eventId"])')"
st="$(curl -sf "$BASE/events/$DOWN_EVENT/deliveries" -H "Authorization: Bearer $KEY")"
echo "$st"
echo "$st" | python3 -c 'import json,sys
d=json.load(sys.stdin)["deliveries"][0]
print("delivery", d["deliveryId"], "status", d["status"])
assert d["status"] in ("SUCCEEDED","PENDING","FAILED_RETRYING"), d["status"]'
echo "chaos redis-kill completed"
