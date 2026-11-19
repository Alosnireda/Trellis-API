import { Injectable, Logger, ConflictException } from '@nestjs/common';
import * as crypto from 'crypto';

export interface DeduplicationRecord {
  key: string;
  hash: string;
  resolvedAt?: Date;
  mergeDecision?: 'accept' | 'reject' | 'pending';
  createdAt: Date;
}

export interface MergeReviewResult {
  isDuplicate: boolean;
  key: string;
  existingRecord?: DeduplicationRecord;
  decision: 'accept' | 'reject' | 'pending';
}

@Injectable()
export class DeduplicationService {
  private readonly logger = new Logger(DeduplicationService.name);
  private readonly store = new Map<string, DeduplicationRecord>();

  /** Deterministic SHA-256 hash of a canonical payload. */
  hashPayload(payload: Record<string, unknown>): string {
    const canonical = JSON.stringify(
      Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))),
    );
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Check whether a request with the given idempotency key and payload hash
   * has already been processed. Returns existing record on duplicate.
   */
  check(idempotencyKey: string, payload: Record<string, unknown>): MergeReviewResult {
    const hash = this.hashPayload(payload);
    const existing = this.store.get(idempotencyKey);

    if (!existing) {
      return { isDuplicate: false, key: idempotencyKey, decision: 'accept' };
    }

    if (existing.hash !== hash) {
      this.logger.warn(`Idempotency key ${idempotencyKey} reused with different payload`);
      return {
        isDuplicate: true,
        key: idempotencyKey,
        existingRecord: existing,
        decision: 'reject',
      };
    }

    return {
      isDuplicate: true,
      key: idempotencyKey,
      existingRecord: existing,
      decision: existing.mergeDecision ?? 'pending',
    };
  }

  /**
   * Register a new idempotency key after successful processing.
   * Throws ConflictException if the key already exists with a different hash.
   */
  register(idempotencyKey: string, payload: Record<string, unknown>): DeduplicationRecord {
    const hash = this.hashPayload(payload);
    const existing = this.store.get(idempotencyKey);

    if (existing && existing.hash !== hash) {
      throw new ConflictException(
        `Idempotency key '${idempotencyKey}' was already used with a different payload`,
      );
    }

    const record: DeduplicationRecord = existing ?? {
      key: idempotencyKey,
      hash,
      createdAt: new Date(),
      mergeDecision: 'accept',
    };

    if (!existing) {
      this.store.set(idempotencyKey, record);
      this.logger.debug(`Registered idempotency key: ${idempotencyKey}`);
    }

    return record;
  }

  /** Mark a duplicate as reviewed with an explicit merge decision. */
  review(
    idempotencyKey: string,
    decision: 'accept' | 'reject',
  ): DeduplicationRecord {
    const record = this.store.get(idempotencyKey);
    if (!record) {
      throw new Error(`Unknown idempotency key: ${idempotencyKey}`);
    }
    record.mergeDecision = decision;
    record.resolvedAt = new Date();
    this.logger.log(`Merge review for ${idempotencyKey}: ${decision}`);
    return record;
  }

  /** Evict records older than ttlMs to prevent unbounded growth. */
  evict(ttlMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - ttlMs);
    let count = 0;
    for (const [key, record] of this.store.entries()) {
      if (record.createdAt < cutoff) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }
}
