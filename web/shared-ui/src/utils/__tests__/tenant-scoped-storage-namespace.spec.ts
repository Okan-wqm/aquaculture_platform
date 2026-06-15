/**
 * Tenant-scoped storage namespace tests.
 *
 * Locks the cross-tenant browser-storage isolation contract:
 *   - per-tenant keys are namespaced + tenant-scoped (two tenants never collide)
 *   - no tenant resolved => null key (callers no-op, never write un-scoped)
 *   - logout sweeps the whole namespace (incl. PII-bearing report drafts)
 *     without touching unrelated keys.
 */
import { describe, it, expect } from 'vitest';

import {
  TENANT_SCOPED_STORAGE_NAMESPACE,
  tenantScopedStorageKey,
  sweepTenantScopedStorage,
  sweepStorageByPrefix,
} from '../tenant-scoped-storage-namespace';

describe('tenantScopedStorageKey', () => {
  it('namespaces + tenant-scopes the base key', () => {
    expect(tenantScopedStorageKey('wq-mru-equipment', 'tenant-a')).toBe(
      `${TENANT_SCOPED_STORAGE_NAMESPACE}::tenant-a::wq-mru-equipment`,
    );
  });

  it('produces DIFFERENT keys per tenant (cross-tenant isolation)', () => {
    const a = tenantScopedStorageKey('wq-mru-equipment', 'tenant-a');
    const b = tenantScopedStorageKey('wq-mru-equipment', 'tenant-b');
    expect(a).not.toBe(b);
  });

  it('returns null without a resolved tenant (callers no-op)', () => {
    expect(tenantScopedStorageKey('wq-mru-equipment', null)).toBeNull();
  });
});

/** Minimal in-memory Storage double (no jsdom needed). */
function makeStorage(initial: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length(): number {
      return map.size;
    },
    key(i: number): string | null {
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(k: string): string | null {
      return map.get(k) ?? null;
    },
    setItem(k: string, v: string): void {
      map.set(k, v);
    },
    removeItem(k: string): void {
      map.delete(k);
    },
    has(k: string): boolean {
      return map.has(k);
    },
  };
}

describe('sweepTenantScopedStorage', () => {
  it('removes every tenant-scoped key and leaves all others intact', () => {
    const ns = TENANT_SCOPED_STORAGE_NAMESPACE;
    const storage = makeStorage({
      [`${ns}::tenant-a::wq-mru-equipment`]: '["e1"]',
      [`${ns}::tenant-a::regulatory_report_draft_x`]: '{"contact":"pii"}',
      [`${ns}::tenant-b::wq-mru-equipment`]: '["e2"]',
      tenant_id: 'tenant-a',
      consent_banner_dismissed: 'true',
      'unrelated-pref': 'keep-me',
    });

    const removed = sweepTenantScopedStorage(storage);

    expect(removed).toBe(3);
    expect(storage.has(`${ns}::tenant-a::wq-mru-equipment`)).toBe(false);
    expect(storage.has(`${ns}::tenant-a::regulatory_report_draft_x`)).toBe(false);
    expect(storage.has(`${ns}::tenant-b::wq-mru-equipment`)).toBe(false);
    // Non-namespaced keys are untouched — the fixed auth deny-list owns those.
    expect(storage.has('tenant_id')).toBe(true);
    expect(storage.has('unrelated-pref')).toBe(true);
  });

  it('returns 0 when there are no tenant-scoped keys', () => {
    const storage = makeStorage({ 'some-pref': 'x', tenant_id: 't' });
    expect(sweepTenantScopedStorage(storage)).toBe(0);
  });
});

describe('sweepStorageByPrefix (legacy PII-draft eviction on logout)', () => {
  it('removes only keys matching the prefix and leaves the rest', () => {
    const storage = makeStorage({
      // pre-migration flat PII draft keys (old useReportDraft format)
      'regulatory_report_draft_SEA_LICE_new_t12345678': '{"contact":"pii"}',
      'regulatory_report_draft_BIOMASS_new': '{"contact":"pii"}',
      // unrelated + already-migrated keys must be untouched
      'unrelated-pref': 'keep',
      [`${TENANT_SCOPED_STORAGE_NAMESPACE}::tenant-a::wq-mru-equipment`]: '["e1"]',
    });

    const removed = sweepStorageByPrefix(storage, 'regulatory_report_draft_');

    expect(removed).toBe(2);
    expect(storage.has('regulatory_report_draft_SEA_LICE_new_t12345678')).toBe(false);
    expect(storage.has('regulatory_report_draft_BIOMASS_new')).toBe(false);
    expect(storage.has('unrelated-pref')).toBe(true);
    expect(storage.has(`${TENANT_SCOPED_STORAGE_NAMESPACE}::tenant-a::wq-mru-equipment`)).toBe(true);
  });
});
