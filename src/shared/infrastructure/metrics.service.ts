import { Injectable } from '@nestjs/common';

const HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface Histogram {
  count: number;
  sum: number;
  buckets: number[];
}

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, number>();

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

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    for (const [key, value] of this.gauges) lines.push(`${key} ${value}`);
    for (const [key, histogram] of this.histograms) {
      const { name, labels } = this.parseKey(key);
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
    for (const item of match[2]?.split(',') ?? []) {
      const [name, value] = item.split('=');
      if (name && value) labels[name] = value.slice(1, -1);
    }
    return { name: match[1], labels };
  }

  private escape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }
}
