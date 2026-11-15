import { Injectable } from '@nestjs/common';
import { hostname } from 'os';
import { monitorEventLoopDelay } from 'perf_hooks';

const HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const MAX_INSTANCE_ID = 12;

interface Histogram {
  count: number;
  sum: number;
  buckets: number[];
}

/**
 * Identificador corto de ESTA instancia del backend: el de Azure App Service (`WEBSITE_INSTANCE_ID`), uno explícito
 * (`INSTANCE_ID`) o el nombre del contenedor/máquina. Es la etiqueta `instance` de todas las métricas.
 */
export function instanceIdOf(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.INSTANCE_ID || env.WEBSITE_INSTANCE_ID || hostname() || 'local';
  return raw.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, MAX_INSTANCE_ID) || 'local';
}

/**
 * Métricas en memoria de ESTA instancia, en formato Prometheus (ESC-OBS-01): contadores, medidores e histogramas.
 * `renderInstance()` les pone la etiqueta `instance` y añade las del proceso (CPU, memoria, retraso del event loop).
 */
@Injectable()
export class MetricsService {
  readonly instanceId = instanceIdOf();
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, number>();
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.eventLoop.enable();
  }

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(this.metricKey(name, labels), value);
  }

  observe(name: string, valueMs: number, labels: Record<string, string> = {}): void {
    const key = this.metricKey(name, labels);
    const histogram = this.histograms.get(key) ?? {
      count: 0,
      sum: 0,
      buckets: HISTOGRAM_BUCKETS.map(() => 0),
    };
    histogram.count += 1;
    histogram.sum += valueMs;
    HISTOGRAM_BUCKETS.forEach((bucket, index) => {
      if (valueMs <= bucket) histogram.buckets[index] += 1;
    });
    this.histograms.set(key, histogram);
  }

  /** Las métricas tal cual, sin etiqueta de instancia. */
  renderPrometheus(): string {
    return this.render({});
  }

  /** Las métricas de esta instancia con la etiqueta `instance`, más las del proceso. */
  renderInstance(): string {
    this.sampleProcess();
    return this.render({ instance: this.instanceId });
  }

  private sampleProcess(): void {
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    this.setGauge('sitpverse_instance_up', 1);
    this.setGauge('process_cpu_seconds_total', Number(((cpu.user + cpu.system) / 1e6).toFixed(3)));
    this.setGauge('process_resident_memory_bytes', memory.rss);
    this.setGauge('nodejs_heap_used_bytes', memory.heapUsed);
    this.setGauge('process_uptime_seconds', Math.round(process.uptime()));
    // Retraso del event loop (p99 desde la última muestra): si sube, la instancia está saturada.
    this.setGauge('nodejs_eventloop_lag_p99_ms', Number((this.eventLoop.percentile(99) / 1e6).toFixed(2)));
    this.eventLoop.reset();
  }

  private render(extra: Record<string, string>): string {
    const lines: string[] = [];
    const withExtra = (key: string) => {
      const { name, labels } = this.parseKey(key);
      return { name, labels: { ...labels, ...extra } };
    };
    for (const [key, value] of this.counters) {
      const { name, labels } = withExtra(key);
      lines.push(`${name}${this.formatLabels(labels)} ${value}`);
    }
    for (const [key, value] of this.gauges) {
      const { name, labels } = withExtra(key);
      lines.push(`${name}${this.formatLabels(labels)} ${value}`);
    }
    for (const [key, histogram] of this.histograms) {
      const { name, labels } = withExtra(key);
      HISTOGRAM_BUCKETS.forEach((bucket, index) => {
        lines.push(`${name}_bucket${this.formatLabels({ ...labels, le: String(bucket) })} ${histogram.buckets[index]}`);
      });
      lines.push(`${name}_bucket${this.formatLabels({ ...labels, le: '+Inf' })} ${histogram.count}`);
      lines.push(`${name}_sum${this.formatLabels(labels)} ${histogram.sum}`);
      lines.push(`${name}_count${this.formatLabels(labels)} ${histogram.count}`);
    }
    return `${lines.join('\n')}\n`;
  }

  private metricKey(name: string, labels: Record<string, string>): string {
    return `${name}${this.formatLabels(labels)}`;
  }

  private formatLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return '';
    return `{${entries.map(([key, value]) => `${key}="${this.escape(value)}"`).join(',')}}`;
  }

  private parseKey(key: string): { name: string; labels: Record<string, string> } {
    const match = /^([^{}]+)(?:\{(.*)\})?$/.exec(key);
    if (!match) return { name: key, labels: {} };
    const labels: Record<string, string> = {};
    // Las etiquetas se separan por `",` y no por `,`: una ruta como `/a/:id,b` no debe partirse.
    for (const item of match[2] ? match[2].split(/(?<="),/) : []) {
      const separator = item.indexOf('=');
      if (separator > 0) labels[item.slice(0, separator)] = this.unescape(item.slice(separator + 2, -1));
    }
    return { name: match[1], labels };
  }

  private escape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  private unescape(value: string): string {
    return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}
