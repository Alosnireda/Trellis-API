import { Injectable, Logger } from '@nestjs/common';

/** High-cardinality PII field names that must be stripped from spans. */
const REDACTED_KEYS = new Set([
  'email',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'apiKey',
  'api_key',
  'secret',
  'phone',
  'ssn',
  'creditCard',
  'credit_card',
]);

const REDACTED_PLACEHOLDER = '[REDACTED]';

export interface TelemetrySpan {
  name: string;
  priority?: 'low' | 'normal' | 'high';
  attributes: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RedactionConfig {
  /** Additional field names to redact beyond the default set. */
  extraKeys?: string[];
}

export interface SamplingConfig {
  /** Fraction [0, 1] of low-priority spans to keep. Default 0.1 (10%). */
  lowPrioritySampleRate?: number;
  /** Fraction [0, 1] of normal-priority spans to keep. Default 1.0. */
  normalPrioritySampleRate?: number;
}

@Injectable()
export class TelemetryRedactionService {
  private readonly logger = new Logger(TelemetryRedactionService.name);
  private readonly extraKeys: Set<string> = new Set();
  private lowPrioritySampleRate = 0.1;
  private normalPrioritySampleRate = 1.0;

  configure(redaction?: RedactionConfig, sampling?: SamplingConfig): void {
    if (redaction?.extraKeys) {
      for (const k of redaction.extraKeys) this.extraKeys.add(k);
    }
    if (sampling?.lowPrioritySampleRate !== undefined) {
      this.lowPrioritySampleRate = sampling.lowPrioritySampleRate;
    }
    if (sampling?.normalPrioritySampleRate !== undefined) {
      this.normalPrioritySampleRate = sampling.normalPrioritySampleRate;
    }
  }

  /** Recursively redact PII fields from an attributes object. */
  redact(attributes: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (this.isSensitiveKey(key)) {
        result[key] = REDACTED_PLACEHOLDER;
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.redact(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Process a span: apply redaction and sampling.
   * Returns null if the span should be dropped by sampling.
   */
  process(span: TelemetrySpan): TelemetrySpan | null {
    if (!this.shouldSample(span)) {
      return null;
    }
    return { ...span, attributes: this.redact(span.attributes) };
  }

  /** Process a batch of spans, dropping sampled-out ones. */
  processBatch(spans: TelemetrySpan[]): TelemetrySpan[] {
    const result: TelemetrySpan[] = [];
    for (const span of spans) {
      const processed = this.process(span);
      if (processed) result.push(processed);
    }
    this.logger.debug(`Telemetry batch: ${spans.length} in, ${result.length} out`);
    return result;
  }

  private isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase();
    for (const k of REDACTED_KEYS) {
      if (lower === k.toLowerCase()) return true;
    }
    for (const k of this.extraKeys) {
      if (lower === k.toLowerCase()) return true;
    }
    return false;
  }

  private shouldSample(span: TelemetrySpan): boolean {
    const rand = Math.random();
    if (span.priority === 'low') return rand < this.lowPrioritySampleRate;
    if (span.priority === 'high') return true;
    return rand < this.normalPrioritySampleRate;
  }
}
