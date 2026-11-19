import { TelemetryRedactionService, TelemetrySpan } from './telemetry-redaction.service';

describe('TelemetryRedactionService', () => {
  let svc: TelemetryRedactionService;

  beforeEach(() => {
    svc = new TelemetryRedactionService();
  });

  describe('redact()', () => {
    it('replaces known PII keys with [REDACTED]', () => {
      const result = svc.redact({ email: 'user@example.com', name: 'Alice' });
      expect(result.email).toBe('[REDACTED]');
      expect(result.name).toBe('Alice');
    });

    it('redacts token and password', () => {
      const result = svc.redact({ token: 'abc', password: 'secret', userId: '123' });
      expect(result.token).toBe('[REDACTED]');
      expect(result.password).toBe('[REDACTED]');
      expect(result.userId).toBe('123');
    });

    it('recursively redacts nested objects', () => {
      const result = svc.redact({ user: { email: 'x@y.com', id: 1 } });
      expect((result.user as any).email).toBe('[REDACTED]');
      expect((result.user as any).id).toBe(1);
    });

    it('leaves arrays untouched (not recursed)', () => {
      const result = svc.redact({ tags: ['a', 'b'] });
      expect(result.tags).toEqual(['a', 'b']);
    });

    it('respects extra configured keys', () => {
      svc.configure({ extraKeys: ['ssid'] });
      const result = svc.redact({ ssid: 'net123', value: 1 });
      expect(result.ssid).toBe('[REDACTED]');
      expect(result.value).toBe(1);
    });
  });

  describe('process()', () => {
    it('always keeps high-priority spans', () => {
      const span: TelemetrySpan = { name: 'auth', priority: 'high', attributes: { email: 'a@b.com' } };
      const result = svc.process(span);
      expect(result).not.toBeNull();
      expect(result!.attributes.email).toBe('[REDACTED]');
    });

    it('drops all low-priority spans when sampleRate=0', () => {
      svc.configure(undefined, { lowPrioritySampleRate: 0 });
      const span: TelemetrySpan = { name: 'metric', priority: 'low', attributes: {} };
      let dropped = 0;
      for (let i = 0; i < 20; i++) {
        if (svc.process(span) === null) dropped++;
      }
      expect(dropped).toBe(20);
    });

    it('keeps all low-priority spans when sampleRate=1', () => {
      svc.configure(undefined, { lowPrioritySampleRate: 1 });
      const span: TelemetrySpan = { name: 'metric', priority: 'low', attributes: {} };
      for (let i = 0; i < 10; i++) {
        expect(svc.process(span)).not.toBeNull();
      }
    });
  });

  describe('processBatch()', () => {
    it('filters and redacts a mixed batch', () => {
      svc.configure(undefined, { lowPrioritySampleRate: 0 });
      const spans: TelemetrySpan[] = [
        { name: 'high', priority: 'high', attributes: { token: 'xyz' } },
        { name: 'low', priority: 'low', attributes: { count: 5 } },
        { name: 'normal', priority: 'normal', attributes: { userId: '1' } },
      ];
      const out = svc.processBatch(spans);
      // low is dropped, high and normal kept
      expect(out.length).toBeGreaterThanOrEqual(1);
      const high = out.find(s => s.name === 'high');
      expect(high?.attributes.token).toBe('[REDACTED]');
    });
  });
});
