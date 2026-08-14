/**
 * 큐 계약 — Relay(생산)와 Worker(소비)가 공유하는 상수.
 * API 서버는 이 파일을 import하지 않는다: API는 outbox까지만 쓰고 큐를 모른다.
 */
export const DELIVERY_QUEUE = 'delivery';

/** BullMQ 잡 페이로드 — 배달에 필요한 나머지는 워커가 DB에서 읽는다(진실의 원천은 DB). */
export interface DeliveryJobData {
  deliveryId: string;
}

/**
 * jobId를 deliveryId로 고정해 outbox 재적재(크래시·릴레이 이중 실행)로 인한
 * 중복 잡을 큐 레벨에서 흡수한다. 잡이 이미 소비·제거된 뒤의 재적재는 막지 못하므로
 * best-effort — 최종 방어는 수신자의 X-Delivery-Id 멱등 처리다.
 */
export function deliveryJobId(deliveryId: string, suffix?: string): string {
  // BullMQ는 커스텀 jobId에 ':'를 허용하지 않는다(내부 키 구분자와 충돌)
  return suffix ? `dlv-${deliveryId}-${suffix}` : `dlv-${deliveryId}`;
}
