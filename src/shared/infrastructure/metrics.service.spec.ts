import { MetricsService, instanceIdOf } from './metrics.service';

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

  it('renderInstance() pone la etiqueta instance en todas las series y añade las del proceso', () => {
    const metrics = new MetricsService();
    metrics.increment('sitpverse_http_requests_total', { method: 'GET', route: '/fleet/buses/:id', status: '200' });
    metrics.observe('sitpverse_http_request_duration_ms', 42, { method: 'GET', route: '/fleet/buses/:id' });
    metrics.setGauge('sitpverse_websocket_connections', 7);

    const output = metrics.renderInstance();
    const id = metrics.instanceId;

    expect(output).toContain(`sitpverse_http_requests_total{instance="${id}",method="GET",route="/fleet/buses/:id",status="200"} 1`);
    expect(output).toContain(`sitpverse_http_request_duration_ms_bucket{instance="${id}",le="50",method="GET",route="/fleet/buses/:id"} 1`);
    expect(output).toContain(`sitpverse_websocket_connections{instance="${id}"} 7`);
    expect(output).toContain(`sitpverse_instance_up{instance="${id}"} 1`);
    expect(output).toMatch(new RegExp(`process_resident_memory_bytes\\{instance="${id}"\\} \\d+`));
    expect(output).toMatch(new RegExp(`process_cpu_seconds_total\\{instance="${id}"\\} [\\d.]+`));
    // Ninguna serie queda sin instancia: si no, dos instancias publicarían la misma serie.
    expect(output.trim().split('\n').every((line) => line.includes(`instance="${id}"`))).toBe(true);
  });

  it('una etiqueta con comas o comillas no rompe el formato', () => {
    const metrics = new MetricsService();
    metrics.increment('x_total', { route: '/a,b', note: 'di "hola"' });
    expect(metrics.renderInstance()).toContain(`x_total{instance="${metrics.instanceId}",note="di \\"hola\\"",route="/a,b"} 1`);
  });
});

describe('instanceIdOf', () => {
  it('usa el id de Azure App Service, recortado, o uno explícito', () => {
    expect(instanceIdOf({ WEBSITE_INSTANCE_ID: 'a1b2c3d4e5f6a7b8c9d0' })).toBe('a1b2c3d4e5f6');
    expect(instanceIdOf({ INSTANCE_ID: 'api-2', WEBSITE_INSTANCE_ID: 'zzz' })).toBe('api-2');
  });

  it('sin variables usa el nombre de la máquina (nunca queda vacío)', () => {
    expect(instanceIdOf({}).length).toBeGreaterThan(0);
  });
});
