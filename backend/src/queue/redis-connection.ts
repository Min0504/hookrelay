import { ConnectionOptions } from 'bullmq';

/**
 * REDIS_URL → BullMQ 연결 옵션.
 * ioredis 인스턴스를 직접 넘기면 BullMQ가 소유하지 않아 종료 시 연결이 남는다.
 * 옵션 객체로 넘겨 Queue/Worker가 연결의 생성과 종료를 책임지게 한다.
 */
export function redisConnectionFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {}),
    ...(url.pathname && url.pathname !== '/' ? { db: Number(url.pathname.slice(1)) } : {}),
    // BullMQ 권장 — 블로킹 명령이 재시도 한도로 끊기지 않게
    maxRetriesPerRequest: null,
  };
}
