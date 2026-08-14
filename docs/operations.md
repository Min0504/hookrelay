# 운영

## 로컬 전체 스택

```bash
docker compose up --build
# 콘솔  http://localhost:8080
# Grafana http://localhost:3001  (admin/admin)
# Prometheus http://localhost:9090
```

개발만 인프라:

```bash
docker compose -f docker-compose.dev.yml up -d   # pg :55434, redis :63790, prom :9090, grafana :3001
cd backend && npm install && npx prisma migrate dev && npm run start:dev
# 다른 터미널
npm run start:relay:dev
npm run start:worker:dev
cd ../demo-receiver && npm start   # :4100
cd ../frontend && npm install && npm run dev  # :5173
```

워커 메트릭 포트: `HR_METRICS_PORT=9091 npm run start:worker`. Relay는 9092.

## 환경 변수

| 변수 | 기본 | 의미 |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL |
| `REDIS_URL` | — | BullMQ + 서킷 + 세마포어 + 발행 한도 |
| `HR_ADMIN_KEY` | — | `POST /tenants` |
| `HR_SECRET_KEY` | — | endpoint secret AES-GCM (base64 32바이트) |
| `HR_ALLOW_INSECURE_HTTP` | false | 로컬 http endpoint 허용 |
| `HR_ALLOW_PRIVATE_DESTINATIONS` | false | 사설 IP 배달 허용 (compose 데모) |
| `HR_TENANT_CONCURRENCY` | 3 | 테넌트당 동시 배달. 0=무제한 |
| `HR_CIRCUIT_OPEN_AFTER` | 10 | OPEN 임계 |
| `HR_RATE_LIMIT_FREE_PER_MIN` | 60 | 발행 한도. 0=끄기. Redis 다운 시 fail-open |
| `HR_METRICS_PORT` | 0 | worker/relay /metrics. 0이면 안 염 |
| `HR_MAX_ATTEMPTS` | 8 | 이후 DEAD |

## 알람 후보 (Grafana)

- `hookrelay_outbox_pending` 5분 이상 > 0 — Relay 또는 Redis 장애
- `sum(hookrelay_queue_jobs{state="delayed"})` 급증 — 수신자 집단 장애 또는 서킷 OPEN
- `rate(hookrelay_deliveries_total{result="SUCCEEDED"}[5m])` 급락 — 대시보드 실패 분류 패널부터
- `process_resident_memory_bytes` 워커 누수

조사 순서: 큐 적체인가 → 특정 error_class인가 → 서킷 OPEN인가 → 특정 테넌트(로그 delivery_id)인가.

## 이력 정리

```bash
cd backend && npm run purge:attempts   # 90일 지난 delivery_attempts 삭제
```

배달 상태의 진실은 `deliveries` 행에 있습니다. attempts는 디버깅용입니다.

## 장애 런북

| 증상 | 원인 | 조치 |
|---|---|---|
| 발행 5xx | DB | RDS/디스크. 호출자는 멱등 키로 재시도 |
| 발행 202인데 배달 없음 | Redis 다운 또는 Relay 정지 | `outbox_pending` 확인. Redis **컨테이너 stop**은 DNS가 바뀌어 ioredis가 `ENOTFOUND`를 내므로 relay/worker를 재기동한다. 데이터는 outbox에 있다 |
| 한 endpoint만 실패 | 수신자 또는 서킷 | `DISABLED_AUTO`면 수신자 복구 후 수동 ACTIVE + 재배달 |
| 다른 테넌트까지 느림 | noisy neighbor | 테넌트 세마포어·서킷 메트릭. `v0-no-isolation` 대비 수치는 docs/perf |
| 429 RATE_LIMITED | 발행 한도 | `Retry-After`. PRO 플랜 또는 한도 상향 |

카오스 재현: [docs/chaos/redis-kill.md](chaos/redis-kill.md)
