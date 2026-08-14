import { Injectable } from '@nestjs/common';
import { Endpoint } from '@prisma/client';
import { randomUUID } from 'crypto';
import { generateEndpointSecret } from '../api-keys/api-key.util';
import { SecretCipher } from '../common/crypto/secret-cipher';
import { Errors } from '../common/errors/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { SsrfService } from '../security/ssrf.service';
import { CreateEndpointDto, UpdateEndpointDto } from './dto/endpoint.dtos';

/**
 * endpoint 등록·관리.
 *
 * 모든 조회가 tenantId 스코프를 강제한다 — 다른 테넌트의 리소스는 "권한 없음(403)"이
 * 아니라 "존재하지 않음(404)"으로 응답해 리소스 ID의 존재 여부조차 노출하지 않는다
 * (크로스 테넌트 IDOR 차단의 기본기).
 */
@Injectable()
export class EndpointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ssrf: SsrfService,
    private readonly cipher: SecretCipher,
  ) {}

  async create(tenantId: string, dto: CreateEndpointDto) {
    await this.ssrf.assertDeliverableUrl(dto.url);

    const duplicate = await this.prisma.endpoint.findUnique({
      where: { tenantId_url: { tenantId, url: dto.url } },
    });
    if (duplicate !== null) {
      throw Errors.endpointUrlExists();
    }

    // 시크릿 원문은 생성 응답에서만 노출 — 이후엔 회전으로만 교체 가능(Stripe UX)
    const secret = generateEndpointSecret();
    const endpoint = await this.prisma.endpoint.create({
      data: {
        tenantId,
        url: dto.url,
        description: dto.description,
        secretEnc: this.cipher.encrypt(secret),
      },
    });

    return { ...this.toView(endpoint), secret };
  }

  async list(tenantId: string) {
    const endpoints = await this.prisma.endpoint.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: { subscriptions: true },
    });
    return endpoints.map((e) => ({
      ...this.toView(e),
      eventTypes: e.subscriptions.map((s) => s.eventType).sort(),
    }));
  }

  async get(tenantId: string, id: string) {
    const endpoint = await this.findScoped(tenantId, id);
    const subscriptions = await this.prisma.subscription.findMany({ where: { endpointId: id } });
    return { ...this.toView(endpoint), eventTypes: subscriptions.map((s) => s.eventType).sort() };
  }

  async update(tenantId: string, id: string, dto: UpdateEndpointDto) {
    await this.findScoped(tenantId, id);
    if (dto.url !== undefined) {
      await this.ssrf.assertDeliverableUrl(dto.url);
    }

    const updated = await this.prisma.endpoint.update({
      where: { id },
      data: {
        url: dto.url,
        description: dto.description,
        status: dto.status,
        // 수동 재활성화는 서킷 카운터도 초기화한다 — 복구 선언의 의미
        ...(dto.status === 'ACTIVE' ? { consecutiveFailures: 0 } : {}),
      },
    });
    return this.toView(updated);
  }

  /** 구독 일괄 설정 — 부분 수정이 아니라 전체 교체(PUT 의미론). */
  async setSubscriptions(tenantId: string, id: string, eventTypes: string[]) {
    await this.findScoped(tenantId, id);
    const unique = [...new Set(eventTypes)];

    await this.prisma.$transaction([
      this.prisma.subscription.deleteMany({ where: { endpointId: id } }),
      this.prisma.subscription.createMany({
        data: unique.map((eventType) => ({ endpointId: id, eventType })),
      }),
    ]);

    return { endpointId: id, eventTypes: unique.sort() };
  }

  /**
   * 연동 확인용 ping — 구독과 무관하게 이 endpoint 한 곳으로만 테스트 이벤트를 보낸다.
   * 발행 경로와 같이 outbox에만 쓰고 큐는 만지지 않는다.
   */
  async ping(tenantId: string, endpointId: string) {
    const endpoint = await this.findScoped(tenantId, endpointId);
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    await this.prisma.$transaction([
      this.prisma.event.create({
        data: {
          id: eventId,
          tenantId,
          type: 'endpoint.ping',
          payload: { ping: true, endpointId },
          idempotencyKey: `ping:${deliveryId}`,
        },
      }),
      this.prisma.delivery.create({
        data: { id: deliveryId, eventId, endpointId: endpoint.id },
      }),
      this.prisma.outboxMessage.create({
        data: { eventId, deliveryId },
      }),
    ]);
    return { eventId, deliveryId, endpointId: endpoint.id };
  }

  private async findScoped(tenantId: string, id: string): Promise<Endpoint> {
    const endpoint = await this.prisma.endpoint.findFirst({ where: { id, tenantId } });
    if (endpoint === null) {
      throw Errors.endpointNotFound();
    }
    return endpoint;
  }

  private toView(e: Endpoint) {
    return {
      id: e.id,
      url: e.url,
      description: e.description,
      status: e.status,
      consecutiveFailures: e.consecutiveFailures,
      createdAt: e.createdAt,
    };
  }
}
