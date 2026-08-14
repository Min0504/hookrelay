# HookRelay 웹 콘솔

테넌트 셀프서비스 화면입니다. 운영 관측은 Grafana(:3001)를 씁니다.

```bash
npm install
npm run dev   # Vite :5173, /api → :3000, /receiver → :4100
```

화면: API 키 1회 노출 · endpoint 등록(SSRF 에러) · 배달 이력 · DLQ 재배달 · 라이브 데모(SSE).
