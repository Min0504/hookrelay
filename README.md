# HookRelay — 웹훅 딜리버리 플랫폼

> 서비스에서 발생한 이벤트를 구독자의 HTTP endpoint로 **at-least-once 보장**으로 배달하는 웹훅 인프라.
> Stripe·GitHub가 운영하는 "웹훅 배달"의 축소 구현 — 큐, 재시도, 배달 보장, 장애 격리, 관측이 주제입니다.

구현 진행 중입니다. 상세 계획은 [docs/기획서.md](docs/기획서.md)를 참고하세요.

## 저장소 구조

```text
hookrelay/
├── backend/         # NestJS api + worker + outbox relay — 학습의 본체
├── frontend/        # 웹 콘솔 — 시연용
├── demo-receiver/   # 수신 검증·시연용 경량 서버
└── docs/            # 기획서 · 아키텍처 · 카오스 리포트 · 부하 결과
```

## 개발

```bash
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL(:55434) + Redis(:63790)
cd backend && npm install
npm run prisma:migrate                            # 스키마 적용
npm run start:dev                                 # API (:3000)
npm test && npm run test:e2e                      # 단위 + E2E (Testcontainers)
```
