import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { Errors } from '../common/errors/errors';

/**
 * 관리자 전용 API 가드 — X-Admin-Key 헤더.
 * 데모 편의를 위한 단일 키. 운영이라면 별도 IdP·RBAC로 대체될 자리임을 명시한다.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly adminKey: string;

  constructor(config: ConfigService) {
    this.adminKey = config.getOrThrow<string>('HR_ADMIN_KEY');
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.header('x-admin-key') ?? '';
    // 길이가 다르면 timingSafeEqual이 던지므로 먼저 거른다 — 비교 자체는 상수 시간
    const a = Buffer.from(provided);
    const b = Buffer.from(this.adminKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw Errors.adminKeyRequired();
    }
    return true;
  }
}
