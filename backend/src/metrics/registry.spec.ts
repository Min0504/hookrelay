import { deliveriesTotal, httpRequestsTotal, registry } from './registry';

describe('metrics registry', () => {
  it('배달 결과·HTTP 상태만 라벨로 받고 tenant/endpoint id는 받지 않는다', () => {
    deliveriesTotal.inc({ result: 'SUCCEEDED' });
    httpRequestsTotal.inc({ method: 'POST', route: '/events', status: '202' });
    return registry.metrics().then((body) => {
      expect(body).toContain('hookrelay_deliveries_total');
      expect(body).toContain('hookrelay_http_requests_total');
      expect(body).not.toMatch(/tenant_id=/);
      expect(body).not.toMatch(/endpoint_id=/);
    });
  });
});
