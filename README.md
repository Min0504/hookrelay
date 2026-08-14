# HookRelay — 웹훅 딜리버리 플랫폼

> 서비스에서 발생한 이벤트를 구독자의 HTTP endpoint로 **at-least-once 보장**으로 배달하는 웹훅 인프라.
> Stripe·GitHub 웹훅의 축소 구현 — 큐, 재시도, 장애 격리, 관측이 주제입니다.

[![CI](https://github.com/Min0504/hookrelay/actions/workflows/ci.yml/badge.svg)](https://github.com/Min0504/hookrelay/actions)

| | |
|---|---|
| 핵심 문제 | DB엔 있는데 큐엔 없는 이벤트 · 재시도 폭풍 · 죽은 endpoint가 다른 테넌트를 지연 · 중복 배달 · SSRF |
| 해결 도구 | Transactional Outbox, BullMQ full jitter, 서킷 브레이커, Redis 테넌트 세마포어, HMAC + DNS rebinding 방어 |
| 스택 | TypeScript 5 · NestJS 11 · Prisma · PostgreSQL 16 · Redis 7 · Prometheus/Grafana · React 콘솔 |
| 테스트 | 단위 84 · E2E 45 — Testcontainers(PostgreSQL+Redis) |

## 한 줄로 읽는 설계

**DB 커밋 = 배달 예약 확정.** API는 Redis를 큐로 쓰지 않습니다. Redis가 5분 죽어도 `POST /events`는 202이고, 복구되면 Relay가 PENDING outbox부터 다시 올립니다.

중복은 버그가 아니라 명세입니다. 수신자는 `X-Delivery-Id`로 멱등 처리합니다 — [demo-receiver](demo-receiver/)가 그 구현입니다.

## 문제 → 해결의 기록

| PR | 문제 | 해결 |
|----|------|------|
| [#1 foundation](https://github.com/Min0504/hookrelay/pull/1) | 임의 URL로 내부망을 찌르는 프록시 | 등록 시 SSRF + 배달 시 DNS rebinding 재검증 |
| [#2 outbox](https://github.com/Min0504/hookrelay/pull/2) | 이중 쓰기 — DB 커밋 후 큐 적재 전 크래시 = 유실 | Transactional Outbox + Relay. 중복은 가능, 유실은 불가능 |
| [#3 worker](https://github.com/Min0504/hookrelay/pull/3) | 실패를 어떻게 기록하고 서명하나 | 시도 전 claim INSERT, HMAC(`timestamp.body`), demo-receiver 멱등 PK |
| [#4 retry](https://github.com/Min0504/hookrelay/pull/4) | 복구 순간 재시도 폭풍 | 지수 백오프 + **full jitter**, 8회 후 DEAD, 수동 재배달은 또 outbox |
| [#5 isolation](https://github.com/Min0504/hookrelay/pull/5) | 느린 endpoint가 워커 슬롯을 점유 | 서킷 OPEN 시 HTTP 생략 + 테넌트 세마포어 (BullMQ Group 대체) |
| [#6 metrics](https://github.com/Min0504/hookrelay/pull/6) | 운영자가 파이프라인을 못 봄 | Prometheus RED, 닫힌 라벨 집합, Grafana JSON 커밋, 발행 429 |
| [#7 console](https://github.com/Min0504/hookrelay/pull/7) | 한 명령으로 못 돌리고 운영 증거가 없음 | 콘솔 SPA · 전체 compose · k6 3종 · Redis 카오스 · 90일 purge |

## 아키텍처

```text
콘솔/호출자 --API Key--> API (outbox만) --> PostgreSQL
                                ^                |
                                |           Outbox Relay
                         attempts 기록            |
                                |                v
                             Worker <---- Redis/BullMQ
                                |
                                v
                         수신자 HTTP + HMAC
```

상세: [아키텍처](docs/architecture.md) · [운영](docs/operations.md) · [카오스](docs/chaos/redis-kill.md) · [k6](docs/perf/k6.md)

## 실행

```bash
docker compose up --build
# 콘솔     http://localhost:8080
# Grafana  http://localhost:3001  (admin/admin)
```

1. 콘솔에서 Admin 키 `dev-admin-key-change-me`로 테넌트를 만듭니다. API 키 원문은 **한 번만** 보입니다.
2. Endpoint URL을 `http://demo-receiver:4100/hooks` 로 등록합니다 (compose 네트워크).
3. 라이브 데모에서 이벤트를 발행하면 오른쪽에 SSE로 수신 로그가 붙습니다.

개발용 인프라만: `docker compose -f docker-compose.dev.yml up -d`

## 부하·카오스

```bash
./bench/seed.sh && ./bench/run.sh
DOWN_SEC=60 ./docs/chaos/redis-kill.sh
```

격리 전 코드는 태그 [`v0-no-isolation`](https://github.com/Min0504/hookrelay/releases/tag/v0-no-isolation)에 있습니다.

## 저장소 구조

```text
hookrelay/
├── backend/         # NestJS api + worker + relay
├── frontend/        # 개발자 콘솔
├── demo-receiver/   # HMAC + 멱등 소비 예제
├── bench/           # k6
├── ops/             # Prometheus/Grafana provisioning
└── docs/
```
