import * as http from 'http';
import { Logger } from '@nestjs/common';
import { ensureDefaultMetrics, registry } from './registry';

/**
 * Worker/Relay는 HTTP API가 없다. 스크레이프만 위해 최소 서버를 연다.
 * HR_METRICS_PORT=0 이면 시작하지 않는다(테스트 기본값).
 */
export function startMetricsServer(port: number, component: string): http.Server {
  ensureDefaultMetrics();
  const logger = new Logger('MetricsServer');
  const server = http.createServer((req, res) => {
    if (req.url !== '/metrics' && req.url !== '/metrics/') {
      res.writeHead(404);
      res.end();
      return;
    }
    void registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(body);
      })
      .catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  server.listen(port, '0.0.0.0', () => {
    logger.log(`${component} /metrics :${port}`);
  });
  return server;
}
