import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUrl, Length, Matches } from 'class-validator';

export class CreateEndpointDto {
  @IsUrl({ require_protocol: true, require_tld: false }, { message: 'url은 프로토콜을 포함한 URL이어야 합니다.' })
  @Length(1, 500)
  url!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  description?: string;
}

export class UpdateEndpointDto {
  @IsOptional()
  @IsUrl({ require_protocol: true, require_tld: false }, { message: 'url은 프로토콜을 포함한 URL이어야 합니다.' })
  @Length(1, 500)
  url?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  description?: string;

  /** 수동 활성/비활성만 허용 — DISABLED_AUTO는 서킷 브레이커의 영역 */
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED_MANUAL'])
  status?: 'ACTIVE' | 'DISABLED_MANUAL';
}

/** 점 표기 소문자 세그먼트 2개 이상 — 'order.created', 'payment.refund.failed' */
export const EVENT_TYPE_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

export class SetSubscriptionsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(EVENT_TYPE_PATTERN, {
    each: true,
    message: '이벤트 타입은 점 표기 소문자여야 합니다 (예: order.created).',
  })
  eventTypes!: string[];
}
