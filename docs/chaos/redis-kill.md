# Chaos: Redis 전면 다운

**날짜:** 2026-08-14  
**환경:** docker compose (api + relay + worker + redis + postgres)  
**가설:** API는 outbox만 쓰므로 Redis가 죽어도 발행은 202이어야 하고, 그 사이 이벤트는 복구 후 배달된다.

## 재현

```bash
docker compose up --build -d
./bench/seed.sh
DOWN_SEC=60 ./docs/chaos/redis-kill.sh
```

스크립트는 다음을 순서대로 합니다.

1. 정상 발행 1건 (대조군)
2. `docker compose stop redis`
3. 다시 발행 — **202가 아니면 실패**
4. N초 대기 (outbox 적재)
5. Redis 기동 후 relay/worker 재기동 (컨테이너 stop은 DNS가 바뀌어 ioredis가 `ENOTFOUND`를 낸다)
6. 다운 중 발행한 eventId의 배달 상태가 SUCCEEDED 또는 재시도 중인지 확인

## 기대 타임라인

| t | 사건 |
|---|---|
| 0 | Redis 정상. 발행 → Relay 적재 → 워커 배달 |
| T | Redis SIGSTOP/stop. Relay tick은 적재 실패를 로그하고 PENDING을 남김 |
| T+ | `POST /events` 여전히 202. deliveries 행이 DB에 생김 |
| T+N | Redis 복구. 다음 Relay 틱이 PENDING을 addBulk |
| T+N+ε | 워커 배달. 수신자는 같은 X-Delivery-Id |

## 관찰 포인트 (Grafana)

장애 주입 구간에서:

- `hookrelay_http_requests_total{route="/events",status="202"}` 계속 증가
- `hookrelay_outbox_pending` 상승 후 복구 시 하강
- `hookrelay_queue_jobs` 는 Redis 다운 동안 스크레이프 공백 → 복구 후 다시 채워짐

## 결과

2026-08-14 로컬 compose:

1. Redis `stop` 중 `POST /events` → **202**. body에 `eventId`와 `deliveryId`가 있다.
2. 30초 동안 outbox에 PENDING이 쌓인다. Grafana의 `hookrelay_outbox_pending`이 이 구간의 관측 포인트다.
3. Redis `start` 후 relay/worker를 재기동한다. `docker compose stop redis`는 컨테이너가 내려가 DNS 이름이 잠시 사라지므로 ioredis가 `ENOTFOUND`를 낸다. **데이터는 outbox에 있으므로 프로세스만 다시 붙이면 된다.**
4. 다운 중 발행한 이벤트는 재기동 후 **SUCCEEDED**.

5분(`DOWN_SEC=300`)도 같은 불변식이다. 스크립트 기본은 60초.

## 한계

- 이 카오스는 **큐 유실**을 다룹니다. DB 다운은 전면 장애이며 호출자 재시도+멱등 키로만 안전합니다.
- `DOWN_SEC=300`(5분)도 같은 불변식입니다. CI/로컬 기본은 60초로 짧게 잡았습니다.
