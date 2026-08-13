import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { setupApp } from '../../src/app.setup';
import { PrismaService } from '../../src/common/prisma/prisma.service';

export const TEST_ADMIN_KEY = 'test-admin-key-0123456789';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  container: StartedPostgreSqlContainer;
  stop: () => Promise<void>;
}

/**
 * E2E 공통 부트스트랩 — 실제 PostgreSQL 16(Testcontainers)에 prisma 스키마를 적용하고
 * 전체 Nest 앱을 띄운다. 스키마·제약까지 포함한 진짜 환경에서 검증한다.
 */
export async function createTestApp(env: Record<string, string> = {}): Promise<TestContext> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const databaseUrl = container.getConnectionUri();

  execSync('npx prisma db push --skip-generate', {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.HR_ADMIN_KEY = TEST_ADMIN_KEY;
  process.env.HR_SECRET_KEY = randomBytes(32).toString('base64');
  process.env.HR_ALLOW_INSECURE_HTTP = 'false';
  process.env.HR_ALLOW_PRIVATE_DESTINATIONS = 'false';
  Object.assign(process.env, env);

  // AppModule은 반드시 env 세팅 "이후"에 로드한다.
  // @prisma/client가 import 시점에 .env를 process.env로 자동 로드하고,
  // ConfigModule.forRoot()는 import 시점에 validate를 실행해 결과를 캐시하므로,
  // 정적 import를 쓰면 테스트 env가 아닌 .env 값이 고정되어 버린다.
  const { AppModule } = await import('../../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = setupApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();

  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    container,
    stop: async () => {
      await app.close();
      await container.stop();
    },
  };
}
