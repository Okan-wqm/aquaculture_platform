/**
 * useReportPrefill — server-assembled regulatory report draft with
 * per-field provenance (automated-reporting plan Phase 1).
 *
 * The backend aggregates every value the platform owns from the
 * operational SSoTs (batches, mortality records, harvests, feeding ledger,
 * tank operations); the form renders it for review and only
 * MANUAL_REQUIRED fields stay editable. Follows the module data-layer
 * conventions: useTenantQuery (tenant-scoped cache keys) + graphqlClient.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';

import { REPORT_PREFILL_QUERY } from '../graphql/regulatory.operations';

// ============================================================================
// TYPES (mirror apps/farm-service/src/regulatory/dto/report-prefill.dto.ts)
// ============================================================================

export type ReportPrefillTypeValue =
  | 'BIOMASS'
  | 'SEA_LICE'
  | 'CLEANER_FISH'
  | 'SMOLT'
  | 'SLAUGHTER_PLANNED'
  | 'SLAUGHTER_EXECUTED'
  | 'WELFARE_EVENT'
  | 'ESCAPE'
  | 'DISEASE_OUTBREAK';

export type ReportFieldProvenanceValue = 'RECORDS' | 'SENSOR' | 'MANUAL_REQUIRED';

export interface ReportFieldMeta {
  /** JSON pointer into draftPayload, e.g. "/mortality/byCause". */
  path: string;
  provenance: ReportFieldProvenanceValue;
  sourceRecordCount?: number | null;
  sourceQuery?: string | null;
  sensorId?: string | null;
  measuredAt?: string | null;
  message?: string | null;
  blocking: boolean;
}

export interface ReportPrefill<TPayload = unknown> {
  reportType: ReportPrefillTypeValue;
  siteId: string;
  periodYear: number;
  periodWeek?: number | null;
  periodMonth?: number | null;
  draftPayload: TPayload;
  fields: ReportFieldMeta[];
  schemaValid: boolean;
  assembledAt: string;
}

export interface ReportPrefillPeriod {
  year: number;
  week?: number;
  month?: number;
}

// ============================================================================
// HOOK
// ============================================================================

export function useReportPrefill<TPayload = unknown>(
  reportType: ReportPrefillTypeValue,
  siteId: string | undefined,
  period: ReportPrefillPeriod,
  options?: { enabled?: boolean },
) {
  return useTenantQuery<ReportPrefill<TPayload>>(
    ['reportPrefill', reportType, siteId, period.year, period.week, period.month],
    async () => {
      const data = await graphqlClient.request<{ reportPrefill: ReportPrefill<TPayload> }>(
        REPORT_PREFILL_QUERY,
        {
          input: {
            reportType,
            siteId,
            periodYear: period.year,
            periodWeek: period.week,
            periodMonth: period.month,
          },
        },
      );
      return data.reportPrefill;
    },
    { enabled: (options?.enabled ?? true) && !!siteId },
  );
}

/** Find the provenance entry governing a payload path (exact or ancestor). */
export function findFieldMeta(
  fields: ReportFieldMeta[] | undefined,
  path: string,
): ReportFieldMeta | undefined {
  if (!fields) return undefined;
  return (
    fields.find((field) => field.path === path) ??
    fields.find((field) => path.startsWith(`${field.path}/`))
  );
}
