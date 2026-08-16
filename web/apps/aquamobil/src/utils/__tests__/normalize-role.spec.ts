// FE-MEDIUM-051 — role normalization at the auth boundary.
//
// The server emits only the 4 canonical Role values, but the boundary must
// validate (never cast) the inbound string, normalize legacy aliases from older
// tokens, and FAIL CLOSED to the least-privileged role on anything unknown.

import { describe, it, expect } from 'vitest';

import { normalizeRole } from '../normalize-role';

describe('normalizeRole', () => {
  it('passes the 4 canonical roles through unchanged', () => {
    expect(normalizeRole('SUPER_ADMIN')).toBe('SUPER_ADMIN');
    expect(normalizeRole('TENANT_ADMIN')).toBe('TENANT_ADMIN');
    expect(normalizeRole('MODULE_MANAGER')).toBe('MODULE_MANAGER');
    expect(normalizeRole('MODULE_USER')).toBe('MODULE_USER');
  });

  it('rejects the retired v0 AquaMobil vocabulary to minimum privilege', () => {
    expect(normalizeRole('MANAGER')).toBe('MODULE_USER');
    expect(normalizeRole('OPERATOR')).toBe('MODULE_USER');
    expect(normalizeRole('VIEWER')).toBe('MODULE_USER');
  });

  it('FAILS CLOSED to MODULE_USER for an unknown role', () => {
    expect(normalizeRole('ROOT')).toBe('MODULE_USER');
    expect(normalizeRole('admin')).toBe('MODULE_USER');
  });

  it('FAILS CLOSED to MODULE_USER for null/undefined/empty', () => {
    expect(normalizeRole(null)).toBe('MODULE_USER');
    expect(normalizeRole(undefined)).toBe('MODULE_USER');
    expect(normalizeRole('')).toBe('MODULE_USER');
  });
});
