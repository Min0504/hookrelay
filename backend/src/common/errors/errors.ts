import { DomainException } from './domain.exception';

/**
 * 에러 코드 레지스트리 — 코드 문자열을 한 곳에서 관리해
 * API 문서·콘솔 분기·테스트가 같은 계약을 바라보게 한다.
 */
export const Errors = {
  // auth
  adminKeyRequired: (): DomainException =>
    new DomainException(401, 'ADMIN_KEY_REQUIRED', '유효한 관리자 키가 필요합니다.'),
  invalidApiKey: (): DomainException =>
    new DomainException(401, 'INVALID_API_KEY', '유효한 API 키가 필요합니다.'),
  tenantSuspended: (): DomainException =>
    new DomainException(403, 'TENANT_SUSPENDED', '정지된 테넌트입니다.'),

  // tenants
  tenantNameExists: (): DomainException =>
    new DomainException(409, 'TENANT_NAME_EXISTS', '이미 존재하는 테넌트 이름입니다.'),

  // endpoints
  endpointNotFound: (): DomainException =>
    new DomainException(404, 'ENDPOINT_NOT_FOUND', 'endpoint를 찾을 수 없습니다.'),
  endpointUrlExists: (): DomainException =>
    new DomainException(409, 'ENDPOINT_URL_EXISTS', '이미 등록된 URL입니다.'),
  unsafeEndpointUrl: (reason: string): DomainException =>
    new DomainException(400, 'UNSAFE_ENDPOINT_URL', `등록할 수 없는 URL입니다: ${reason}`, { reason }),
  invalidEventType: (value: string): DomainException =>
    new DomainException(400, 'INVALID_EVENT_TYPE', `이벤트 타입 형식이 올바르지 않습니다: ${value}`, {
      value,
    }),

  // events
  idempotencyKeyRequired: (): DomainException =>
    new DomainException(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 헤더가 필요합니다.'),
  duplicateEvent: (eventId: string): DomainException =>
    new DomainException(409, 'DUPLICATE_EVENT', '같은 멱등성 키로 이미 발행된 이벤트가 있습니다.', {
      eventId,
    }),
  payloadTooLarge: (sizeBytes: number, limitBytes: number): DomainException =>
    new DomainException(413, 'PAYLOAD_TOO_LARGE', 'payload가 허용 크기를 초과했습니다.', {
      sizeBytes,
      limitBytes,
    }),
  eventNotFound: (): DomainException =>
    new DomainException(404, 'EVENT_NOT_FOUND', '이벤트를 찾을 수 없습니다.'),
  deliveryNotFound: (): DomainException =>
    new DomainException(404, 'DELIVERY_NOT_FOUND', '배달을 찾을 수 없습니다.'),
  invalidCursor: (): DomainException =>
    new DomainException(400, 'INVALID_CURSOR', '커서 형식이 올바르지 않습니다.'),
} as const;
