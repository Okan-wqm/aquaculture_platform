/**
 * useReportDraft storage-isolation tests.
 *
 * Locks the regulatory-report-draft PII isolation contract that motivated the
 * migration off the flat `regulatory_report_draft_*` localStorage key:
 *   - drafts are written under the platform tenant-scoped namespace
 *     (`aqua.tss::<tenantId>::<reportType>_<reportId>`) that `logoutCleanup`
 *     sweeps, so PII drafts never survive logout;
 *   - the key carries the FULL tenantId (not a substring(0,8) prefix), so two
 *     tenants can never collide on a shared browser;
 *   - version / expiry / shape validation still discards stale or corrupt
 *     envelopes.
 *
 * `useAuth` is mocked to supply the tenantId; the REAL `useTenantScopedStorage`
 * + namespace helper run so the test asserts genuine on-disk key placement.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TENANT_SCOPED_STORAGE_NAMESPACE } from '@aquaculture/shared-ui';
import { ReportType } from '../../types/reports.types';
import { isDraftEnvelope, useReportDraft } from '../useReportDraft';

const TENANT_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const TENANT_B = 'aaaaaaaa-9999-8888-7777-666666666666'; // shares first 8 chars with A

let currentTenantId: string | null = TENANT_A;

vi.mock('@aquaculture/shared-ui', async () => {
  const actual =
    await vi.importActual<typeof import('@aquaculture/shared-ui')>('@aquaculture/shared-ui');
  return {
    ...actual,
    useAuth: () => ({ tenantId: currentTenantId }),
  };
});

interface SeaLiceDraft {
  contact: string;
}

const REPORT_TYPE: ReportType = 'sea-lice';
const REPORT_ID = 'report-7';

function keyFor(tenantId: string): string {
  return `${TENANT_SCOPED_STORAGE_NAMESPACE}::${tenantId}::${REPORT_TYPE}_${REPORT_ID}`;
}

beforeEach(() => {
  currentTenantId = TENANT_A;
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isDraftEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(isDraftEnvelope({ data: { x: 1 }, savedAt: '2026-01-01T00:00:00.000Z', version: 1 })).toBe(
      true,
    );
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing data', { savedAt: '2026-01-01T00:00:00.000Z', version: 1 }],
    ['non-string savedAt', { data: {}, savedAt: 123, version: 1 }],
    ['non-number version', { data: {}, savedAt: '2026-01-01T00:00:00.000Z', version: '1' }],
  ])('rejects %s', (_label, value) => {
    expect(isDraftEnvelope(value)).toBe(false);
  });
});

describe('useReportDraft storage placement', () => {
  it('writes the draft under the tenant-scoped namespace with the FULL tenantId', () => {
    const { result } = renderHook(() =>
      useReportDraft<SeaLiceDraft>(REPORT_TYPE, REPORT_ID, { enableAutoSave: false }),
    );

    act(() => {
      result.current.saveDraft({ contact: 'pii' });
    });

    const stored = localStorage.getItem(keyFor(TENANT_A));
    expect(stored).not.toBeNull();
    const envelope: unknown = JSON.parse(stored as string);
    expect(isDraftEnvelope(envelope)).toBe(true);
    // No flat / legacy key escaped the namespace.
    expect(localStorage.getItem(`regulatory_report_draft_${REPORT_TYPE}_${REPORT_ID}`)).toBeNull();
  });

  it('isolates tenants that share the first 8 chars of the tenantId', () => {
    const a = renderHook(() =>
      useReportDraft<SeaLiceDraft>(REPORT_TYPE, REPORT_ID, { enableAutoSave: false }),
    );
    act(() => a.result.current.saveDraft({ contact: 'tenant-a-pii' }));

    currentTenantId = TENANT_B;
    const b = renderHook(() =>
      useReportDraft<SeaLiceDraft>(REPORT_TYPE, REPORT_ID, { enableAutoSave: false }),
    );

    // Tenant B sees no draft despite the shared 8-char prefix.
    expect(b.result.current.hasDraft()).toBe(false);
    expect(b.result.current.loadDraft()).toBeNull();

    // Two distinct keys exist — full tenantId prevents collision.
    expect(localStorage.getItem(keyFor(TENANT_A))).not.toBeNull();
    expect(localStorage.getItem(keyFor(TENANT_B))).toBeNull();
  });

  it('round-trips data through loadDraft', () => {
    const { result } = renderHook(() =>
      useReportDraft<SeaLiceDraft>(REPORT_TYPE, REPORT_ID, { enableAutoSave: false }),
    );
    act(() => result.current.saveDraft({ contact: 'round-trip' }));

    // loadDraft updates lastSaved state on success — capture its return inside
    // act() so the state update is flushed without an act(...) warning. Declared
    // as a discriminated holder so the closure assignment is type-tracked.
    const holder: { value: ReturnType<typeof result.current.loadDraft> } = { value: null };
    act(() => {
      holder.value = result.current.loadDraft();
    });
    expect(holder.value?.data.contact).toBe('round-trip');
    expect(result.current.hasDraft()).toBe(true);
  });

  it('clearDraft removes the tenant-scoped key', () => {
    const { result } = renderHook(() =>
      useReportDraft<SeaLiceDraft>(REPORT_TYPE, REPORT_ID, { enableAutoSave: false }),
    );
    act(() => result.current.saveDraft({ contact: 'pii' }));
    expect(localStorage.getItem(keyFor(TENANT_A))).not.toBeNull();

    act(() => result.current.clearDraft());
    expect(localStorage.getItem(keyFor(TENANT_A))).toBeNull();
    expect(result.current.hasDraft()).toBe(false);
  });

  it('discards an expired draft and removes its key', () => {
    const { result } = renderHook(() =>
      useReportDraft<SeaLiceDraft>(REPORT_TYPE, REPORT_ID, {
        enableAutoSave: false,
        expiryDays: 7,
      }),
    );

    // Plant a draft saved 8 days ago directly under the real key.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(
      keyFor(TENANT_A),
      JSON.stringify({ data: { contact: 'old' }, savedAt: eightDaysAgo, version: 1 }),
    );

    expect(result.current.loadDraft()).toBeNull();
    expect(localStorage.getItem(keyFor(TENANT_A))).toBeNull();
  });

  it('discards a version-mismatched draft', () => {
    const { result } = renderHook(() =>
      useReportDraft<SeaLiceDraft>(REPORT_TYPE, REPORT_ID, { enableAutoSave: false }),
    );
    localStorage.setItem(
      keyFor(TENANT_A),
      JSON.stringify({ data: { contact: 'stale' }, savedAt: new Date().toISOString(), version: 999 }),
    );

    expect(result.current.loadDraft()).toBeNull();
    expect(localStorage.getItem(keyFor(TENANT_A))).toBeNull();
  });

  it('no-ops every accessor when no tenant is resolved (pre-login / post-logout)', () => {
    currentTenantId = null;
    const { result } = renderHook(() =>
      useReportDraft<SeaLiceDraft>(REPORT_TYPE, REPORT_ID, { enableAutoSave: false }),
    );

    act(() => result.current.saveDraft({ contact: 'should-not-persist' }));
    expect(localStorage.length).toBe(0);
    expect(result.current.hasDraft()).toBe(false);
    expect(result.current.loadDraft()).toBeNull();
  });
});
