#!/usr/bin/env bash
# k6 3종 실행. compose up 이후:
#   ./bench/seed.sh && ./bench/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source bench/out/seed.env
mkdir -p bench/out
RPS="${RPS:-80}"
DURATION="${DURATION:-20s}"

echo "== ① publish ${RPS} rps ${DURATION}"
k6 run --summary-export=bench/out/publish-summary.json \
  -e BASE="$BASE" -e KEY="$KEY" -e RPS="$RPS" -e DURATION="$DURATION" \
  bench/k6/publish.js | tee bench/out/publish.txt

echo "== ② noisy neighbor (isolation ON, tenant limit 3)"
k6 run --summary-export=bench/out/noisy-on-summary.json \
  -e BASE="$BASE" -e KEY_A="$KEY_A" -e KEY_B="$KEY_B" -e RPS=15 -e DURATION=20s \
  bench/k6/noisy-neighbor.js | tee bench/out/noisy-on.txt

echo "== ③ DLQ redeliver"
k6 run --summary-export=bench/out/dlq-summary.json \
  -e BASE="$BASE" -e KEY="$KEY" -e DURATION=10s \
  bench/k6/dlq-redeliver.js | tee bench/out/dlq.txt

echo "summaries in bench/out/"
