/**
 * Unit tests for CircuitBreakerService — canonical library coverage.
 *
 * Tests the state machine (CLOSED → OPEN → HALF_OPEN → CLOSED), per-
 * tenant isolation, fail-mode discriminator, and degraded fallback path.
 *
 * Closes: docs/reviews/circuit-breaker-auditor/2026-04-28-core-platform-review.md#CIRCUIT-CRITICAL-004 (foundation)
 */

import {
  CircuitBreakerService,
  CircuitOpenError,
  DEFAULT_BREAKER_OPTIONS,
  CircuitBreakerOptions,
} from '../circuit-breaker.service';

const FAST_OPTIONS: CircuitBreakerOptions = {
  ...DEFAULT_BREAKER_OPTIONS,
  // Aggressive thresholds so unit tests trip quickly without polluting state
  failureThreshold: 3,
  successThreshold: 2,
  volumeThreshold: 3,
  failureRatePct: 50,
  slowCallMs: 50,
  halfOpenRequests: 2,
  openTimeoutMs: 50,
  windowSeconds: 5,
  bucketSeconds: 1,
  failureMode: 'fail-closed',
};

const FAIL_OPEN_OPTIONS: CircuitBreakerOptions = {
  ...FAST_OPTIONS,
  failureMode: 'fail-open-degraded',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('CircuitBreakerService', () => {
  let svc: CircuitBreakerService;

  beforeEach(() => {
    svc = new CircuitBreakerService();
  });

  it('passes through to fn() when CLOSED', async () => {
    const result = await svc.execute({
      serviceName: 'test',
      fn: async () => 'ok',
      options: FAST_OPTIONS,
    });
    expect(result).toBe('ok');
  });

  it('records failures and trips to OPEN after threshold', async () => {
    let calls = 0;
    const fail = async () => {
      calls += 1;
      throw new Error('upstream-failed');
    };

    // Three failures × volumeThreshold=3 → 100% failure rate, trips
    for (let i = 0; i < 3; i += 1) {
      await expect(svc.execute({ serviceName: 'test', fn: fail, options: FAST_OPTIONS })).rejects.toThrow('upstream-failed');
    }

    // Fourth call rejected by breaker (fail-closed)
    await expect(svc.execute({ serviceName: 'test', fn: fail, options: FAST_OPTIONS })).rejects.toBeInstanceOf(CircuitOpenError);
    // fn() did NOT run for the fourth call (calls still 3)
    expect(calls).toBe(3);

    const stats = svc.getAllStats();
    expect(stats[0]!.stats.state).toBe('OPEN');
  });

  it('returns fallback when failureMode=fail-open-degraded and breaker is OPEN', async () => {
    const fail = async () => {
      throw new Error('upstream-failed');
    };
    for (let i = 0; i < 3; i += 1) {
      await expect(svc.execute({ serviceName: 'test', fn: fail, options: FAIL_OPEN_OPTIONS })).rejects.toThrow();
    }

    const result = await svc.execute({
      serviceName: 'test',
      fn: fail,
      options: FAIL_OPEN_OPTIONS,
      fallback: () => 'cached-result',
    });
    expect(result).toBe('cached-result');
  });

  it('throws when failureMode=fail-open-degraded and no fallback supplied', async () => {
    const fail = async () => {
      throw new Error('upstream-failed');
    };
    for (let i = 0; i < 3; i += 1) {
      await expect(svc.execute({ serviceName: 'test', fn: fail, options: FAIL_OPEN_OPTIONS })).rejects.toThrow();
    }

    await expect(
      svc.execute({ serviceName: 'test', fn: fail, options: FAIL_OPEN_OPTIONS }),
    ).rejects.toThrow(/requires an explicit fallback/);
  });

  it('transitions OPEN → HALF_OPEN after openTimeoutMs', async () => {
    const fail = async () => {
      throw new Error('upstream-failed');
    };
    for (let i = 0; i < 3; i += 1) {
      await expect(svc.execute({ serviceName: 'test', fn: fail, options: FAST_OPTIONS })).rejects.toThrow();
    }
    expect(svc.getAllStats()[0]!.stats.state).toBe('OPEN');

    // Wait > openTimeoutMs (50 ms)
    await sleep(80);

    // First call after timeout → admitted as HALF_OPEN probe
    const ok = async () => 'recovered';
    const result = await svc.execute({ serviceName: 'test', fn: ok, options: FAST_OPTIONS });
    expect(result).toBe('recovered');
    expect(svc.getAllStats()[0]!.stats.state).toBe('HALF_OPEN');
  });

  it('closes after successThreshold consecutive successes in HALF_OPEN', async () => {
    const fail = async () => {
      throw new Error('upstream-failed');
    };
    for (let i = 0; i < 3; i += 1) {
      await expect(svc.execute({ serviceName: 'test', fn: fail, options: FAST_OPTIONS })).rejects.toThrow();
    }
    await sleep(80); // open → half-open eligible

    const ok = async () => 'recovered';
    await svc.execute({ serviceName: 'test', fn: ok, options: FAST_OPTIONS });
    await svc.execute({ serviceName: 'test', fn: ok, options: FAST_OPTIONS });
    expect(svc.getAllStats()[0]!.stats.state).toBe('CLOSED');
  });

  it('re-opens immediately if any HALF_OPEN probe fails', async () => {
    const fail = async () => {
      throw new Error('upstream-failed');
    };
    for (let i = 0; i < 3; i += 1) {
      await expect(svc.execute({ serviceName: 'test', fn: fail, options: FAST_OPTIONS })).rejects.toThrow();
    }
    await sleep(80);

    // First HALF_OPEN probe fails → re-open
    await expect(svc.execute({ serviceName: 'test', fn: fail, options: FAST_OPTIONS })).rejects.toThrow();
    expect(svc.getAllStats()[0]!.stats.state).toBe('OPEN');
  });

  it('isolates breakers per (serviceName, tenantId)', async () => {
    const fail = async () => {
      throw new Error('upstream-failed');
    };
    const tenantA = '11111111-1111-4111-8111-111111111111';
    const tenantB = '22222222-2222-4222-8222-222222222222';

    // Trip tenant A
    for (let i = 0; i < 3; i += 1) {
      await expect(
        svc.execute({ serviceName: 'shared-service', tenantId: tenantA, fn: fail, options: FAST_OPTIONS }),
      ).rejects.toThrow();
    }

    // Tenant B unaffected — its calls still flow
    const result = await svc.execute({
      serviceName: 'shared-service',
      tenantId: tenantB,
      fn: async () => 'ok-for-tenant-b',
      options: FAST_OPTIONS,
    });
    expect(result).toBe('ok-for-tenant-b');

    // Confirm both breakers exist with separate state
    const stats = svc.getAllStats();
    const a = stats.find((s) => s.tenantKey === tenantA);
    const b = stats.find((s) => s.tenantKey === tenantB);
    expect(a?.stats.state).toBe('OPEN');
    expect(b?.stats.state).toBe('CLOSED');
  });

  it('"*" key is the global breaker for cross-tenant infrastructure', async () => {
    await svc.execute({
      serviceName: 'jwks-fetch',
      // tenantId omitted → '*' key
      fn: async () => 'ok',
      options: FAST_OPTIONS,
    });
    const stats = svc.getAllStats();
    expect(stats.some((s) => s.tenantKey === '*' && s.serviceName === 'jwks-fetch')).toBe(true);
  });

  it('resetAll() clears every breaker state', async () => {
    const fail = async () => {
      throw new Error('upstream-failed');
    };
    for (let i = 0; i < 3; i += 1) {
      await expect(svc.execute({ serviceName: 'test', fn: fail, options: FAST_OPTIONS })).rejects.toThrow();
    }
    expect(svc.getAllStats()[0]!.stats.state).toBe('OPEN');

    svc.resetAll();
    expect(svc.getAllStats()[0]!.stats.state).toBe('CLOSED');
  });

  it('stats reflect window state — successes, failures, slow calls', async () => {
    const slow = async (): Promise<string> => {
      await sleep(FAST_OPTIONS.slowCallMs + 10);
      return 'slow-but-ok';
    };
    const ok = async () => 'ok';

    await svc.execute({ serviceName: 'test', fn: ok, options: FAST_OPTIONS });
    await svc.execute({ serviceName: 'test', fn: slow, options: FAST_OPTIONS });

    const stats = svc.getAllStats()[0]!.stats;
    expect(stats.successes).toBe(2);
    expect(stats.slowCalls).toBe(1);
    expect(stats.failures).toBe(0);
  });

  it('CircuitOpenError carries serviceName + tenantKey for downstream logging', async () => {
    const fail = async () => {
      throw new Error('upstream-failed');
    };
    const tenantId = '33333333-3333-4333-8333-333333333333';
    for (let i = 0; i < 3; i += 1) {
      await expect(
        svc.execute({ serviceName: 'pinned', tenantId, fn: fail, options: FAST_OPTIONS }),
      ).rejects.toThrow();
    }

    try {
      await svc.execute({ serviceName: 'pinned', tenantId, fn: fail, options: FAST_OPTIONS });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CircuitOpenError);
      expect((e as CircuitOpenError).serviceName).toBe('pinned');
      expect((e as CircuitOpenError).tenantKey).toBe(tenantId);
    }
  });
});
