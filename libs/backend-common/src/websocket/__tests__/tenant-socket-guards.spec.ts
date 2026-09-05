import { TenantConnectionLimiter, WsTokenRevalidator } from '../tenant-socket-guards';

describe('TenantConnectionLimiter (SEC-MEDIUM-073 — 2026-08-23 scan №26)', () => {
  it('admits sockets up to the ceiling and rejects the overflow WITHOUT registering it', () => {
    const limiter = new TenantConnectionLimiter({ maxPerTenant: 2 });
    expect(limiter.register('t1', 's1')).toBe(true);
    expect(limiter.register('t1', 's2')).toBe(true);
    expect(limiter.register('t1', 's3')).toBe(false);
    expect(limiter.count('t1')).toBe(2);
  });

  it('release frees capacity and empties the tenant bucket', () => {
    const limiter = new TenantConnectionLimiter({ maxPerTenant: 1 });
    limiter.register('t1', 's1');
    limiter.release('t1', 's1');
    expect(limiter.register('t1', 's2')).toBe(true);
  });

  it('tenants are independent', () => {
    const limiter = new TenantConnectionLimiter({ maxPerTenant: 1 });
    expect(limiter.register('t1', 's1')).toBe(true);
    expect(limiter.register('t2', 's2')).toBe(true);
  });
});

describe('WsTokenRevalidator (SEC-MEDIUM-082 — 2026-08-23 scan №18)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const tick = async (ms: number): Promise<void> => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  };

  it('disconnects a socket whose token became revoked on the next cycle', async () => {
    let valid = true;
    const revalidator = new WsTokenRevalidator({
      intervalMs: 1000,
      isStillValid: () => Promise.resolve(valid),
    });
    const disconnect = jest.fn();
    revalidator.register('s1', {
      tenantId: 't1',
      userId: 'u1',
      jti: 'jti-1',
      disconnect,
    });

    await tick(1000);
    expect(disconnect).not.toHaveBeenCalled();

    valid = false;
    await tick(1000);
    expect(disconnect).toHaveBeenCalledWith('token-revoked');
  });

  it('a predicate THROW is fail-closed (disconnect)', async () => {
    const revalidator = new WsTokenRevalidator({
      intervalMs: 1000,
      isStillValid: () => Promise.reject(new Error('redis down')),
    });
    const disconnect = jest.fn();
    revalidator.register('s1', { tenantId: 't1', userId: 'u1', jti: 'jti-1', disconnect });

    await tick(1000);
    expect(disconnect).toHaveBeenCalledWith('token-revoked');
  });

  it('a jti-less credential is refused immediately (never re-checkable)', () => {
    const revalidator = new WsTokenRevalidator({
      intervalMs: 1000,
      isStillValid: () => Promise.resolve(true),
    });
    const disconnect = jest.fn();
    revalidator.register('s1', { tenantId: 't1', userId: 'u1', jti: '  ', disconnect });
    expect(disconnect).toHaveBeenCalledWith('token-uncheckable');
  });

  it('unregistered sockets are never re-checked', async () => {
    let calls = 0;
    const revalidator = new WsTokenRevalidator({
      intervalMs: 1000,
      isStillValid: () => {
        calls += 1;
        return Promise.resolve(true);
      },
    });
    const disconnect = jest.fn();
    revalidator.register('s1', { tenantId: 't1', userId: 'u1', jti: 'jti-1', disconnect });
    revalidator.unregister('s1');
    await tick(1000);
    expect(calls).toBe(0);
    expect(disconnect).not.toHaveBeenCalled();
  });
});
