import { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/errors/domain.exception';
import { blockedIpReason, SsrfService } from './ssrf.service';

describe('blockedIpReason — 차단 대역 경계값', () => {
  // [ip, 차단 여부] — 경계의 안쪽/바깥쪽을 쌍으로 검증한다
  const cases: Array<[string, boolean]> = [
    // 0.0.0.0/8
    ['0.0.0.0', true],
    ['0.255.255.255', true],
    ['1.0.0.0', false],
    // 10.0.0.0/8
    ['9.255.255.255', false],
    ['10.0.0.0', true],
    ['10.255.255.255', true],
    ['11.0.0.0', false],
    // CGNAT 100.64.0.0/10
    ['100.63.255.255', false],
    ['100.64.0.0', true],
    ['100.127.255.255', true],
    ['100.128.0.0', false],
    // 루프백 127.0.0.0/8
    ['126.255.255.255', false],
    ['127.0.0.1', true],
    ['128.0.0.0', false],
    // 링크로컬(메타데이터) 169.254.0.0/16
    ['169.253.255.255', false],
    ['169.254.169.254', true],
    ['169.255.0.0', false],
    // 사설 172.16.0.0/12
    ['172.15.255.255', false],
    ['172.16.0.0', true],
    ['172.31.255.255', true],
    ['172.32.0.0', false],
    // 예약 192.0.0.0/24
    ['192.0.0.255', true],
    ['192.0.1.0', false],
    // 사설 192.168.0.0/16
    ['192.167.255.255', false],
    ['192.168.0.0', true],
    ['192.169.0.0', false],
    // 벤치마크 198.18.0.0/15
    ['198.17.255.255', false],
    ['198.18.0.0', true],
    ['198.19.255.255', true],
    ['198.20.0.0', false],
    // 멀티캐스트·예약 224.0.0.0/3
    ['223.255.255.255', false],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    // 공인 대역
    ['8.8.8.8', false],
    ['93.184.216.34', false],
  ];

  it.each(cases)('%s → 차단=%s', (ip, blocked) => {
    expect(blockedIpReason(ip) !== null).toBe(blocked);
  });

  const v6Cases: Array<[string, boolean]> = [
    ['::1', true],
    ['::', true],
    ['fc00::1', true], // ULA 시작
    ['fdff:ffff::1', true], // ULA 끝
    ['fe80::1', true], // 링크로컬
    ['febf::1', true], // 링크로컬 끝(fe80::/10)
    ['fec0::1', false], // 링크로컬 바깥
    ['ff02::1', true], // 멀티캐스트
    ['2001:4860:4860::8888', false], // 공인 (Google DNS)
    // IPv4-mapped — v6 표기로 v4 차단을 우회하는 고전 수법
    ['::ffff:10.0.0.1', true],
    ['::ffff:8.8.8.8', false],
  ];

  it.each(v6Cases)('%s → 차단=%s', (ip, blocked) => {
    expect(blockedIpReason(ip) !== null).toBe(blocked);
  });
});

describe('SsrfService.assertDeliverableUrl', () => {
  function makeService(env: Record<string, boolean>, resolved?: string[]): SsrfService {
    const config = new ConfigService(env);
    const service = new SsrfService(config);
    if (resolved !== undefined) {
      service.resolve = () => Promise.resolve(resolved);
    }
    return service;
  }

  async function rejectionCode(service: SsrfService, url: string): Promise<string> {
    try {
      await service.assertDeliverableUrl(url);
      return 'ACCEPTED';
    } catch (e) {
      return e instanceof DomainException ? e.code : 'UNKNOWN';
    }
  }

  it('https + 공인 IP로 해석되는 호스트는 허용한다', async () => {
    const service = makeService({}, ['93.184.216.34']);
    await expect(service.assertDeliverableUrl('https://receiver.example.com/hooks')).resolves.toBeUndefined();
  });

  it('기본 설정에서 http는 거부한다', async () => {
    const service = makeService({}, ['93.184.216.34']);
    expect(await rejectionCode(service, 'http://receiver.example.com')).toBe('UNSAFE_ENDPOINT_URL');
  });

  it('HR_ALLOW_INSECURE_HTTP=true면 http를 허용한다 (로컬 데모 전용)', async () => {
    const service = makeService({ HR_ALLOW_INSECURE_HTTP: true }, ['93.184.216.34']);
    await expect(service.assertDeliverableUrl('http://receiver.example.com')).resolves.toBeUndefined();
  });

  it('IP 리터럴 — 링크로컬 메타데이터 주소를 거부한다', async () => {
    const service = makeService({});
    expect(await rejectionCode(service, 'https://169.254.169.254/latest/meta-data')).toBe(
      'UNSAFE_ENDPOINT_URL',
    );
  });

  it('IPv6 리터럴 — 루프백을 거부한다', async () => {
    const service = makeService({});
    expect(await rejectionCode(service, 'https://[::1]:8443/hooks')).toBe('UNSAFE_ENDPOINT_URL');
  });

  it('DNS가 사설 IP로 해석되면 거부한다 (rebinding 1차 방어)', async () => {
    const service = makeService({}, ['10.0.0.5']);
    expect(await rejectionCode(service, 'https://internal.attacker.dev')).toBe('UNSAFE_ENDPOINT_URL');
  });

  it('공인·사설이 섞인 DNS 응답도 거부한다 — 부분 차단은 없다', async () => {
    const service = makeService({}, ['93.184.216.34', '192.168.1.10']);
    expect(await rejectionCode(service, 'https://mixed.attacker.dev')).toBe('UNSAFE_ENDPOINT_URL');
  });

  it('해석 불가 호스트는 거부한다', async () => {
    const service = makeService({});
    service.resolve = () => Promise.reject(new Error('ENOTFOUND'));
    expect(await rejectionCode(service, 'https://no-such-host.invalid')).toBe('UNSAFE_ENDPOINT_URL');
  });

  it('URL 자격증명을 거부한다', async () => {
    const service = makeService({}, ['93.184.216.34']);
    expect(await rejectionCode(service, 'https://user:pass@receiver.example.com')).toBe(
      'UNSAFE_ENDPOINT_URL',
    );
  });

  it('HR_ALLOW_PRIVATE_DESTINATIONS=true면 사설 IP도 허용한다 (E2E·데모 전용)', async () => {
    const service = makeService({ HR_ALLOW_PRIVATE_DESTINATIONS: true, HR_ALLOW_INSECURE_HTTP: true });
    await expect(service.assertDeliverableUrl('http://127.0.0.1:4000/hooks')).resolves.toBeUndefined();
  });
});
