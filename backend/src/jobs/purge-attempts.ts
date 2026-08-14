import { PrismaClient } from '@prisma/client';

/**
 * delivery_attempts 90일 정리.
 *
 * 이력 테이블은 무한히 자란다. 배달의 진실은 deliveries 행에 있고,
 * attempts는 디버깅·통계용이라 90일이면 운영 추적에 충분하다.
 * 파티셔닝은 행이 수억 건이 된 뒤의 다음 단계 — 지금은 DELETE + 부분 인덱스로 충분.
 *
 *   npx ts-node --transpile-only src/jobs/purge-attempts.ts
 */
const DAYS = Number(process.env.HR_ATTEMPTS_RETENTION_DAYS ?? 90);

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.deliveryAttempt.deleteMany({
    where: { attemptedAt: { lt: cutoff } },
  });
  console.log(`purged ${result.count} attempts older than ${DAYS} days (before ${cutoff.toISOString()})`);
  await prisma.$disconnect();
}

void main();
