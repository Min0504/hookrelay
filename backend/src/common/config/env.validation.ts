import { plainToInstance, Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsString, MinLength, validateSync } from 'class-validator';

/** 부팅 시 환경변수를 검증한다 — 잘못된 설정은 요청을 받기 전에 죽는 것이 낫다. */
class EnvSchema {
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @MinLength(12)
  HR_ADMIN_KEY!: string;

  /** base64 인코딩된 32바이트 — endpoint 시크릿 AES-GCM 마스터 키 */
  @IsString()
  @IsNotEmpty()
  HR_SECRET_KEY!: string;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  HR_ALLOW_INSECURE_HTTP: boolean = false;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  HR_ALLOW_PRIVATE_DESTINATIONS: boolean = false;

  @Transform(({ value }) => parseInt(String(value), 10))
  @IsInt()
  PORT: number = 3000;

  /** BullMQ가 사용하는 Redis — API 서버는 큐를 만지지 않으므로 Relay/Worker만 연결한다 */
  @IsString()
  @IsNotEmpty()
  REDIS_URL!: string;

  /** outbox 폴링 주기(ms) — 배달 지연의 상한을 결정한다 */
  @Transform(({ value }) => parseInt(String(value), 10))
  @IsInt()
  HR_OUTBOX_POLL_MS: number = 500;

  /** 배달 HTTP 타임아웃(ms) — 초과 시 실패(TIMEOUT)로 분류 */
  @Transform(({ value }) => parseInt(String(value), 10))
  @IsInt()
  HR_DELIVERY_TIMEOUT_MS: number = 10_000;

  /** 워커 프로세스당 동시 배달 수 — I/O 바운드라 수십까지 상향 가능 */
  @Transform(({ value }) => parseInt(String(value), 10))
  @IsInt()
  HR_WORKER_CONCURRENCY: number = 10;
}

export function validateEnv(config: Record<string, unknown>): EnvSchema {
  const validated = plainToInstance(EnvSchema, config, { enableImplicitConversion: false });
  const errors = validateSync(validated, { skipMissingProperties: false, whitelist: true });
  if (errors.length > 0) {
    throw new Error(`환경변수 검증 실패:\n${errors.map((e) => `  - ${e.toString()}`).join('\n')}`);
  }
  if (Buffer.from(validated.HR_SECRET_KEY, 'base64').length !== 32) {
    throw new Error('환경변수 검증 실패: HR_SECRET_KEY는 base64 인코딩된 32바이트여야 합니다.');
  }
  return validated;
}
