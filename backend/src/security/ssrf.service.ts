import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Errors } from '../common/errors/errors';

/**
 * SSRF 방어 1단계 — endpoint 등록 시 URL 검증.
 *
 * 웹훅 서비스는 "서버가 사용자가 준 URL로 요청을 보내주는 서비스"다. 검증 없이 받으면
 * 워커가 EC2 메타데이터(169.254.169.254)나 내부 Redis(10.x:6379)를 대신 찔러주는
 * 프록시가 된다. 등록 시 DNS를 해석해 모든 결과 IP가 공인 대역인지 확인한다.
 *
 * 등록 시 1회 검증만으로는 부족하다 — 등록 땐 공인 IP를 주고 배달 땐 내부 IP로 바꾸는
 * DNS rebinding이 남는다. 배달 시마다의 connect 단계 재검증은 워커(Phase 3)가 담당하고,
 * 이 서비스의 isBlockedIp를 공유한다.
 */
@Injectable()
export class SsrfService {
  private readonly allowInsecureHttp: boolean;
  private readonly allowPrivateDestinations: boolean;

  /** 테스트에서 DNS 응답을 주입하기 위한 접점 — 기본은 시스템 리졸버 */
  resolve: (hostname: string) => Promise<string[]> = defaultResolver;

  constructor(config: ConfigService) {
    this.allowInsecureHttp = config.get<boolean>('HR_ALLOW_INSECURE_HTTP', false);
    this.allowPrivateDestinations = config.get<boolean>('HR_ALLOW_PRIVATE_DESTINATIONS', false);
  }

  /** 등록 불가 사유가 있으면 UNSAFE_ENDPOINT_URL로 거부한다. */
  async assertDeliverableUrl(rawUrl: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw Errors.unsafeEndpointUrl('URL 형식이 아닙니다');
    }

    if (url.protocol !== 'https:' && !(this.allowInsecureHttp && url.protocol === 'http:')) {
      throw Errors.unsafeEndpointUrl('https만 허용됩니다');
    }
    // 자격증명이 든 URL(https://user:pass@host)은 수신자 오설정이거나 공격 시도다
    if (url.username !== '' || url.password !== '') {
      throw Errors.unsafeEndpointUrl('URL에 자격증명을 포함할 수 없습니다');
    }

    if (this.allowPrivateDestinations) {
      return; // 로컬 데모·E2E 전용 완화 — 운영 기본값은 false
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, ''); // IPv6 리터럴의 대괄호 제거
    const ips = isIP(hostname) !== 0 ? [hostname] : await this.resolveOrReject(hostname);

    // 해석된 "모든" IP를 검사한다 — 공인·사설이 섞인 응답은 rebinding 시도로 간주
    for (const ip of ips) {
      const reason = blockedIpReason(ip);
      if (reason !== null) {
        throw Errors.unsafeEndpointUrl(`${reason} (${ip})`);
      }
    }
  }

  private async resolveOrReject(hostname: string): Promise<string[]> {
    try {
      const ips = await this.resolve(hostname);
      if (ips.length === 0) throw new Error('empty');
      return ips;
    } catch {
      throw Errors.unsafeEndpointUrl('호스트명을 해석할 수 없습니다');
    }
  }
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

/**
 * 차단 대역 판정 — 순수 함수로 분리해 단위 테스트와 워커의 connect 훅이 공유한다.
 * 반환값: 차단 사유(한국어) 또는 null(허용).
 */
export function blockedIpReason(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) return blockedV4Reason(ip);
  if (family === 6) return blockedV6Reason(ip);
  return 'IP 형식이 아닙니다';
}

function blockedV4Reason(ip: string): string | null {
  const octets = ip.split('.').map(Number);
  const [a, b] = octets as [number, number, number, number];
  const value = octets.reduce((acc, o) => acc * 256 + o, 0);
  const inRange = (cidr: string): boolean => {
    const [base, bits] = cidr.split('/') as [string, string];
    const baseValue = base.split('.').map(Number).reduce((acc, o) => acc * 256 + o, 0);
    const mask = -1 << (32 - Number(bits));
    return (value & mask) === (baseValue & mask);
  };

  if (inRange('0.0.0.0/8')) return '예약 대역(0.0.0.0/8)입니다';
  if (a === 10) return '사설 대역(10.0.0.0/8)입니다';
  if (inRange('100.64.0.0/10')) return 'CGNAT 대역(100.64.0.0/10)입니다';
  if (a === 127) return '루프백(127.0.0.0/8)입니다';
  if (inRange('169.254.0.0/16')) return '링크로컬(169.254.0.0/16) — 클라우드 메타데이터 대역입니다';
  if (a === 172 && b >= 16 && b <= 31) return '사설 대역(172.16.0.0/12)입니다';
  if (inRange('192.0.0.0/24')) return '예약 대역(192.0.0.0/24)입니다';
  if (a === 192 && b === 168) return '사설 대역(192.168.0.0/16)입니다';
  if (inRange('198.18.0.0/15')) return '벤치마크 예약 대역(198.18.0.0/15)입니다';
  if (a >= 224) return '멀티캐스트/예약 대역(224.0.0.0/3)입니다';
  return null;
}

function blockedV6Reason(ip: string): string | null {
  const lower = ip.toLowerCase();
  // IPv4-mapped(::ffff:10.0.0.1)는 v4 규칙으로 위임 — v6 표기로 v4 차단을 우회하는 고전 수법
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped !== null) return blockedV4Reason(mapped[1]);

  if (lower === '::' || lower === '::1') return '루프백/미지정(::1, ::)입니다';
  const firstGroup = parseInt(lower.split(':')[0] || '0', 16);
  if ((firstGroup & 0xfe00) === 0xfc00) return 'ULA 사설 대역(fc00::/7)입니다';
  if ((firstGroup & 0xffc0) === 0xfe80) return '링크로컬(fe80::/10)입니다';
  if ((firstGroup & 0xff00) === 0xff00) return '멀티캐스트(ff00::/8)입니다';
  return null;
}
