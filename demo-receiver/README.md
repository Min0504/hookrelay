# demo-receiver

HookRelay가 배달하는 웹훅을 받아 **서명 검증**과 **멱등 소비**를 시연하는 경량 수신 서버.
수신자 구현 가이드의 살아있는 예제로, 실제 연동 시 이 파일 하나를 참고하면 된다.

## 실행

```bash
npm install
WEBHOOK_SECRET=whsec_... npm start   # 기본 포트 4100
```

> `node:sqlite` 내장 모듈을 사용한다 — Node 24+ 권장 (Node 22는 `--experimental-sqlite` 플래그 필요).

## 이 예제가 보여주는 것

| 포인트 | 코드 위치 | 왜 중요한가 |
|---|---|---|
| 원시 바이트로 서명 검증 | `express.raw()` | JSON 파싱 후 재직렬화하면 바이트가 달라져 서명이 깨진다 |
| 타임스탬프 허용 오차 | ±300초 | 서명된 요청의 리플레이 공격 방어 |
| 상수 시간 비교 | `timingSafeEqual` | 서명 비교의 타이밍 부채널 차단 |
| **멱등 소비** | `processed_delivery_ids` PK | HookRelay는 at-least-once — 같은 `X-Delivery-Id` 재도착 시 부수효과 없이 200 |

## 엔드포인트

- `POST /hooks` — 웹훅 수신 (검증 실패 시 400/401)
- `GET /received` — 지금까지 받은 배달 목록 (데모 확인용)
