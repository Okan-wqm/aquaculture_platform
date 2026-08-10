/**
 * Tank status narrowing specs (ORPHAN-HIGH-583).
 *
 * The wire type for a container's status is a free-form String. This mapper used
 * to force it into the frontend union with `as Tank['status']`, and when that
 * union was missing CLEANING and FALLOW a fallowing pen — routine between
 * production cycles — reached the render tree as a status no lookup table had.
 * The unit detail crashed on it.
 *
 * Completing the union fixed the crash. These specs pin the mechanism that made
 * it possible: a value the frontend does not recognise must be caught here, not
 * asserted past the type system and discovered by a user.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { narrowTankStatus } from '../useTanks';

vi.mock('@/utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { logger } = await import('@/utils/logger');

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
});

describe('narrowTankStatus', () => {
  it('accepts all eight backend statuses, in the wire casing', () => {
    // The backend enum stores lower-case values ('fallow', 'cleaning', …).
    for (const wire of [
      'active',
      'preparing',
      'cleaning',
      'maintenance',
      'harvesting',
      'fallow',
      'quarantine',
      'inactive',
    ]) {
      expect(narrowTankStatus(wire)).toBe(wire.toUpperCase());
      expect(logger.warn, `${wire} should not warn`).not.toHaveBeenCalled();
    }
  });

  it('accepts CLEANING and FALLOW — the two that caused the crash', () => {
    expect(narrowTankStatus('fallow')).toBe('FALLOW');
    expect(narrowTankStatus('cleaning')).toBe('CLEANING');
  });

  it('falls back to INACTIVE for a status this app does not know, and says so', () => {
    // A new backend enum member is a real event. Silently defaulting would hide
    // it until something downstream crashed on it again.
    expect(narrowTankStatus('decommissioned')).toBe('INACTIVE');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('never lands on a status implying a stocked, healthy pen', () => {
    // The fallback must not read as ACTIVE — that would state something about
    // the pen the app does not know.
    expect(narrowTankStatus('something-new')).not.toBe('ACTIVE');
  });

  it('treats a missing status as ACTIVE, preserving the previous behaviour', () => {
    // null/undefined is not drift — it is a container the snapshot did not
    // annotate, and the pre-existing default was ACTIVE. Kept deliberately so
    // this change is a narrowing, not a behaviour change.
    expect(narrowTankStatus(null)).toBe('ACTIVE');
    expect(narrowTankStatus(undefined)).toBe('ACTIVE');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
