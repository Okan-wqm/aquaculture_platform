/**
 * useReportPrefill helpers + the "no client-side aggregation" invariant
 * (automated-reporting plan Phase 1, RPT-002/RPT-012).
 *
 * The BiomassReportTab must never re-grow tank-math prefill: the server
 * assembly (reportPrefill) is THE source, so the deleted aggregate helpers
 * and the tank-list dependency are asserted absent from the tab source.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', () => ({
  graphqlClient: { request: vi.fn() },
  useTenantQuery: vi.fn(),
}));

import { findFieldMeta, type ReportFieldMeta } from '../useReportPrefill';

const fields: ReportFieldMeta[] = [
  { path: '/mortality', provenance: 'RECORDS', sourceRecordCount: 7, blocking: false },
  {
    path: '/feedConsumption',
    provenance: 'MANUAL_REQUIRED',
    message: 'empty ledger',
    blocking: false,
  },
];

describe('findFieldMeta', () => {
  it('resolves an exact path', () => {
    expect(findFieldMeta(fields, '/mortality')?.sourceRecordCount).toBe(7);
  });

  it('resolves a nested path to its governing ancestor', () => {
    expect(findFieldMeta(fields, '/mortality/byCause/0/count')?.provenance).toBe('RECORDS');
  });

  it('returns undefined for an unrelated path or missing fields', () => {
    expect(findFieldMeta(fields, '/stockings')).toBeUndefined();
    expect(findFieldMeta(undefined, '/mortality')).toBeUndefined();
  });
});

describe('client-side aggregation stays deleted (dedup verdict RPT-012)', () => {
  it('BiomassReportTab contains no tank-math prefill', () => {
    const source = readFileSync(
      resolve(__dirname, '../../pages/reports/tabs/BiomassReportTab.tsx'),
      'utf8',
    );
    expect(source).not.toContain('aggregateBiomassFromTanks');
    expect(source).not.toContain('aggregateFeedFromTanks');
    expect(source).not.toContain('useTanksList');
    expect(source).toContain('useReportPrefill');
  });

  it.each(['SeaLiceReportTab', 'SmoltReportTab'])(
    '%s consumes the server prefill (Phase 1b seeding stays wired)',
    (tab) => {
      const source = readFileSync(
        resolve(__dirname, `../../pages/reports/tabs/${tab}.tsx`),
        'utf8',
      );
      expect(source).toContain('useReportPrefill');
      expect(source).toContain('ProvenanceBadge');
    },
  );
});
