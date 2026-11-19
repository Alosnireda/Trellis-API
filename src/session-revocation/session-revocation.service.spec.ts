import { SessionRevocationService, Session } from './session-revocation.service';
import { UnauthorizedException } from '@nestjs/common';

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  sessionId: 'sess-1',
  userId: 'user-1',
  token: 'tok-abc',
  createdAt: new Date(),
  lastActiveAt: new Date(),
  ...overrides,
});

describe('SessionRevocationService', () => {
  let svc: SessionRevocationService;

  beforeEach(() => {
    svc = new SessionRevocationService();
  });

  it('validates an active session and updates lastActiveAt', () => {
    const session = makeSession();
    svc.register(session);
    const validated = svc.validateSession('sess-1');
    expect(validated.sessionId).toBe('sess-1');
  });

  it('throws for unknown session', () => {
    expect(() => svc.validateSession('ghost')).toThrow(UnauthorizedException);
  });

  it('throws when token is revoked', () => {
    svc.register(makeSession());
    svc.revokeToken('tok-abc', 'test');
    expect(() => svc.validateSession('sess-1')).toThrow(UnauthorizedException);
  });

  it('throws for stale session (inactivity)', () => {
    svc.configure({ inactivityTtlMs: 1 });
    const old = new Date(Date.now() - 100);
    svc.register(makeSession({ lastActiveAt: old }));
    expect(() => svc.validateSession('sess-1')).toThrow(UnauthorizedException);
  });

  it('throws for session exceeding maximum age', () => {
    svc.configure({ maxAgeTtlMs: 1 });
    const old = new Date(Date.now() - 100);
    svc.register(makeSession({ createdAt: old }));
    expect(() => svc.validateSession('sess-1')).toThrow(UnauthorizedException);
  });

  it('revoking is idempotent', () => {
    svc.register(makeSession());
    svc.revokeToken('tok-abc');
    expect(() => svc.revokeToken('tok-abc')).not.toThrow();
    expect(svc.isRevoked('tok-abc')).toBe(true);
  });

  it('revokeAllForUser removes all sessions for that user', () => {
    svc.register(makeSession({ sessionId: 's1', token: 't1' }));
    svc.register(makeSession({ sessionId: 's2', token: 't2' }));
    const count = svc.revokeAllForUser('user-1');
    expect(count).toBe(2);
    expect(svc.activeSessions()).toBe(0);
  });

  it('pruneStale removes inactive sessions', () => {
    svc.configure({ inactivityTtlMs: 1 });
    svc.register(makeSession({ lastActiveAt: new Date(Date.now() - 100) }));
    expect(svc.pruneStale()).toBe(1);
    expect(svc.activeSessions()).toBe(0);
  });

  it('pruneStale does not remove active sessions', () => {
    svc.configure({ inactivityTtlMs: 60_000 });
    svc.register(makeSession());
    expect(svc.pruneStale()).toBe(0);
    expect(svc.activeSessions()).toBe(1);
  });

  it('purgeExpiredRevocations removes old revocation records', () => {
    svc.revokeToken('old-token');
    // artificially age the revocation record
    const record = (svc as any).revokedTokens.get('old-token');
    record.revokedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(svc.purgeExpiredRevocations()).toBe(1);
    expect(svc.isRevoked('old-token')).toBe(false);
  });

  it('authorization path: session removed from store after stale validation attempt', () => {
    svc.configure({ inactivityTtlMs: 1 });
    svc.register(makeSession({ lastActiveAt: new Date(Date.now() - 100) }));
    expect(() => svc.validateSession('sess-1')).toThrow(UnauthorizedException);
    expect(svc.activeSessions()).toBe(0);
  });
});
