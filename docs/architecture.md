# 아키텍처

HookRelay는 **발행(API)과 배달(Worker)을 프로세스와 저장소 책임으로 나눈** 웹훅 인프라입니다.
진실의 원천은 PostgreSQL입니다. Redis/BullMQ는 배달 일정의 파생물입니다.

```
[테넌트 / 웹 콘솔]                         [수신자 Endpoint]
     │ POST /events 202                          ▲
     ▼                                           │ HMAC POST (10s timeout)
[API]  events + deliveries + outbox              │
     │ 같은 DB 트랜잭션                           │
     ▼                                           │
[PostgreSQL] ──Relay(500ms)──► [Redis/BullMQ] ──Worker × N
     ▲                              │              │
     └── attempts / 상태 기록        delayed set    서킷·테넌트 세마포어
```

## 왜 이 분해인가

| 컴포넌트 | 책임 | 죽으면 |
|---|---|---|
| API | 검증·영속화. **큐를 만지지 않는다** | 발행 5xx. 이미 커밋된 이벤트는 outbox에 남음 |
| Relay | PENDING outbox → 큐 적재 후 PUBLISHED | 적재가 밀릴 뿐 유실 없음. 재기동하면 PENDING부터 |
| Worker | HTTP 배달, 실패 분류, 백오프, 서킷 | 큐 적체. stalled 잡 재할당 |
| Redis | 잡 일정·서킷·세마포어·rate limit | **발행은 계속 202**. 배달만 멈춤 → 복구 시 Relay가 재개 |
| PostgreSQL | 유일한 전면 장애점 | 발행 불가. RDS 다중 AZ가 운영 정답 |

이중 쓰기 문제(DB 커밋과 큐 적재를 한 트랜잭션으로 묶을 수 없음)의 선택이 **Transactional Outbox** 입니다.
유실 vs 중복 중 웹훅은 중복을 감수합니다. 수신자는 `X-Delivery-Id`로 멱등 처리합니다. demo-receiver가 그 모범 구현입니다.

## 배달 계약

```
POST {endpoint.url}
X-HookRelay-Event: order.created
X-Delivery-Id: {uuid}
X-HookRelay-Timestamp: unix-seconds
X-HookRelay-Signature: v1=hex(HMAC-SHA256(secret, timestamp + "." + rawBody))
```

2xx = 성공. 그 외·10초 타임아웃 = 실패. 재시도는 같은 Delivery-Id.

## 격리

1. **테넌트 세마포어** (`HR_TENANT_CONCURRENCY`, 기본 3) — BullMQ Group은 Pro 전용이라 Redis INCR으로 대체. 슬롯 부족은 `DelayedError`(시도 횟수 미소모).
2. **endpoint 서킷** — 연속 실패 10 → OPEN(HTTP 생략) → 5분 후 HALF_OPEN 프로브 1건 → 50회 `DISABLED_AUTO`.
3. Redis 다운 시 서킷·세마포어·rate limit 모두 **fail-open**. 배달을 멈추는 쪽이 더 나쁘다는 판단입니다.

격리 전 코드는 태그 `v0-no-isolation`에 남아 있습니다. 같은 바이너리로 비교할 때는 `HR_TENANT_CONCURRENCY=0`으로 워커만 재기동하면 됩니다.

## 관측

라벨은 닫힌 집합만 사용합니다. `tenant_id`/`endpoint_id`를 붙이면 시계열이 폭증합니다.
스크레이프: API `:3000/metrics`, Worker `HR_METRICS_PORT`, Relay 동일. Grafana 대시보드는 `ops/grafana/dashboards/hookrelay.json`에 커밋되어 클론 후 compose로 재현됩니다.

## Kafka를 쓰지 않은 이유

웹훅 배달은 **잡 단위 재시도·지연·DLQ**가 핵심입니다. Kafka는 파티션 순서·리플레이·다중 컨슈머 그룹에 강합니다.
요구가 "이벤트 버스 + 감사 파이프라인"으로 바뀌면 Kafka를 **추가**합니다. 지금 바꾸면 운영만 커집니다.

## 확장

워커만 수평 확장합니다 (`docker compose up --scale worker=3`). API는 상태 없는 발행기, Relay는 조건부 UPDATE로 이중 실행에 안전합니다.
attempts는 90일 삭제(`npm run purge:attempts`). 수억 행이 되면 월별 파티셔닝이 다음 단계입니다.
