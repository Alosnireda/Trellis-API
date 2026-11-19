import { DeduplicationService } from './deduplication.service';
import { ConflictException } from '@nestjs/common';

describe('DeduplicationService', () => {
  let svc: DeduplicationService;

  beforeEach(() => {
    svc = new DeduplicationService();
  });

  it('accepts a new idempotency key', () => {
    const result = svc.check('key1', { amount: 100 });
    expect(result.isDuplicate).toBe(false);
    expect(result.decision).toBe('accept');
  });

  it('detects duplicate with same payload hash', () => {
    svc.register('key1', { amount: 100 });
    const result = svc.check('key1', { amount: 100 });
    expect(result.isDuplicate).toBe(true);
    expect(result.decision).toBe('accept');
  });

  it('rejects duplicate with different payload hash', () => {
    svc.register('key1', { amount: 100 });
    const result = svc.check('key1', { amount: 999 });
    expect(result.isDuplicate).toBe(true);
    expect(result.decision).toBe('reject');
  });

  it('throws ConflictException on register with different payload', () => {
    svc.register('key1', { amount: 100 });
    expect(() => svc.register('key1', { amount: 999 })).toThrow(ConflictException);
  });

  it('allows re-registration with same payload (idempotent)', () => {
    const r1 = svc.register('key1', { amount: 100 });
    const r2 = svc.register('key1', { amount: 100 });
    expect(r1.key).toBe(r2.key);
  });

  it('records merge review decision', () => {
    svc.register('key1', { amount: 100 });
    const record = svc.review('key1', 'reject');
    expect(record.mergeDecision).toBe('reject');
    expect(record.resolvedAt).toBeDefined();
  });

  it('throws on review of unknown key', () => {
    expect(() => svc.review('nonexistent', 'accept')).toThrow('Unknown idempotency key');
  });

  it('produces deterministic hashes regardless of key order', () => {
    const h1 = svc.hashPayload({ b: 2, a: 1 });
    const h2 = svc.hashPayload({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  it('evicts old records', () => {
    svc.register('old-key', { amount: 1 });
    // artificially age the record
    const record = (svc as any).store.get('old-key');
    record.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const evicted = svc.evict();
    expect(evicted).toBe(1);
    expect(svc.check('old-key', { amount: 1 }).isDuplicate).toBe(false);
  });
});
