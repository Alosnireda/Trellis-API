import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';

export interface Session {
  sessionId: string;
  userId: string;
  createdAt: Date;
  lastActiveAt: Date;
  token: string;
}

export interface RevocationRecord {
  token: string;
  revokedAt: Date;
  reason: string;
}

export interface SessionRevocationConfig {
  /** Sessions inactive for more than this many ms are considered stale. Default: 30 min. */
  inactivityTtlMs?: number;
  /** Absolute maximum session age in ms. Default: 24 hours. */
  maxAgeTtlMs?: number;
}

/**
 * Tracks active sessions and an explicit revocation list for tokens.
 *
 * Authorization paths:
 * - validateSession() throws UnauthorizedException for stale, expired, or revoked sessions.
 *
 * Retry/failure paths:
 * - revokeToken() is idempotent: revoking an already-revoked token is a no-op.
 * - pruneStale() is safe to call repeatedly; it only removes sessions beyond the TTL.
 *
 * Recovery: revoked tokens persist until purgeExpiredRevocations() is called.
 * Sessions are removed on revocation but their tokens stay in the revocation list
 * to block replay attacks even after the session record is gone.
 */
@Injectable()
export class SessionRevocationService {
  private readonly logger = new Logger(SessionRevocationService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly revokedTokens = new Map<string, RevocationRecord>();

  private inactivityTtlMs = 30 * 60 * 1000;
  private maxAgeTtlMs = 24 * 60 * 60 * 1000;

  configure(config: SessionRevocationConfig): void {
    if (config.inactivityTtlMs !== undefined) this.inactivityTtlMs = config.inactivityTtlMs;
    if (config.maxAgeTtlMs !== undefined) this.maxAgeTtlMs = config.maxAgeTtlMs;
  }

  /** Register a new session. */
  register(session: Session): void {
    this.sessions.set(session.sessionId, { ...session });
    this.logger.debug(`Session registered: ${session.sessionId}`);
  }

  /**
   * Validate a session by id. Updates lastActiveAt on success.
   * Throws UnauthorizedException on stale, expired, missing, or revoked session.
   */
  validateSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new UnauthorizedException('Session not found or already revoked');
    }

    const now = Date.now();

    if (this.revokedTokens.has(session.token)) {
      this.sessions.delete(sessionId);
      throw new UnauthorizedException('Token has been revoked');
    }

    if (now - session.lastActiveAt.getTime() > this.inactivityTtlMs) {
      this.sessions.delete(sessionId);
      throw new UnauthorizedException('Session expired due to inactivity');
    }

    if (now - session.createdAt.getTime() > this.maxAgeTtlMs) {
      this.sessions.delete(sessionId);
      throw new UnauthorizedException('Session exceeded maximum age');
    }

    session.lastActiveAt = new Date(now);
    return session;
  }

  /** Explicitly revoke a token. Idempotent. */
  revokeToken(token: string, reason = 'explicit revocation'): void {
    if (!this.revokedTokens.has(token)) {
      this.revokedTokens.set(token, { token, revokedAt: new Date(), reason });
      this.logger.log(`Token revoked: reason=${reason}`);
    }

    // Remove any sessions using this token
    for (const [id, session] of this.sessions.entries()) {
      if (session.token === token) {
        this.sessions.delete(id);
      }
    }
  }

  /** Revoke all sessions for a user (e.g. on password change). */
  revokeAllForUser(userId: string, reason = 'user-triggered revocation'): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        this.revokeToken(session.token, reason);
        count++;
      }
    }
    return count;
  }

  /** Remove sessions that have gone stale without an explicit revoke. */
  pruneStale(): number {
    const now = Date.now();
    let count = 0;
    for (const [id, session] of this.sessions.entries()) {
      const inactiveTooLong = now - session.lastActiveAt.getTime() > this.inactivityTtlMs;
      const tooOld = now - session.createdAt.getTime() > this.maxAgeTtlMs;
      if (inactiveTooLong || tooOld) {
        this.sessions.delete(id);
        count++;
      }
    }
    this.logger.debug(`Pruned ${count} stale sessions`);
    return count;
  }

  /** Purge revocation records for tokens older than retentionMs. */
  purgeExpiredRevocations(retentionMs = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - retentionMs);
    let count = 0;
    for (const [token, record] of this.revokedTokens.entries()) {
      if (record.revokedAt < cutoff) {
        this.revokedTokens.delete(token);
        count++;
      }
    }
    return count;
  }

  isRevoked(token: string): boolean {
    return this.revokedTokens.has(token);
  }

  activeSessions(): number {
    return this.sessions.size;
  }
}
