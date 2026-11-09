import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('renders counters and cumulative histogram buckets in Prometheus format', () => {
    const metrics = new MetricsService();
    metrics.increment('requests_total', { method: 'GET' });
    metrics.observe('latency_ms', 12, { route: '/health/live' });

    const output = metrics.renderPrometheus();

    expect(output).toContain('requests_total{method="GET"} 1');
    expect(output).toContain('latency_ms_bucket{le="25",route="/health/live"} 1');
    expect(output).toContain('latency_ms_bucket{le="+Inf",route="/health/live"} 1');
    expect(output).toContain('latency_ms_count{route="/health/live"} 1');
  });
});
