import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backendHealthCircuit, refetchWhenBackendHealthy } from './backend-health-circuit';

describe('backendHealthCircuit', () => {
  beforeEach(() => {
    backendHealthCircuit.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    backendHealthCircuit.reset();
  });

  it('stays closed below the failure threshold (refetch allowed)', () => {
    backendHealthCircuit.recordFailure();
    backendHealthCircuit.recordFailure();
    expect(backendHealthCircuit.isOpen()).toBe(false);
    expect(refetchWhenBackendHealthy()).toBe(true);
  });

  it('opens after 3 consecutive transport failures (refetch suppressed)', () => {
    backendHealthCircuit.recordFailure();
    backendHealthCircuit.recordFailure();
    backendHealthCircuit.recordFailure();
    expect(backendHealthCircuit.isOpen()).toBe(true);
    expect(refetchWhenBackendHealthy()).toBe(false);
  });

  it('a single success closes the breaker immediately', () => {
    backendHealthCircuit.recordFailure();
    backendHealthCircuit.recordFailure();
    backendHealthCircuit.recordFailure();
    expect(backendHealthCircuit.isOpen()).toBe(true);

    backendHealthCircuit.recordSuccess();
    expect(backendHealthCircuit.isOpen()).toBe(false);
    expect(refetchWhenBackendHealthy()).toBe(true);
  });

  it('half-opens after the cooldown so a probe can attempt recovery', () => {
    backendHealthCircuit.recordFailure();
    backendHealthCircuit.recordFailure();
    backendHealthCircuit.recordFailure();
    expect(backendHealthCircuit.isOpen()).toBe(true);

    // Within the cooldown → still suppressed.
    vi.advanceTimersByTime(14_000);
    expect(backendHealthCircuit.isOpen()).toBe(true);

    // After the cooldown → half-open (one probe allowed).
    vi.advanceTimersByTime(2_000);
    expect(backendHealthCircuit.isOpen()).toBe(false);
  });

  it('a failing probe re-opens (resets the cooldown)', () => {
    backendHealthCircuit.recordFailure();
    backendHealthCircuit.recordFailure();
    backendHealthCircuit.recordFailure();
    vi.advanceTimersByTime(16_000); // half-open
    expect(backendHealthCircuit.isOpen()).toBe(false);

    backendHealthCircuit.recordFailure(); // probe failed
    expect(backendHealthCircuit.isOpen()).toBe(true); // re-opened, fresh cooldown
  });
});
