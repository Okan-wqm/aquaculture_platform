/**
 * Biomass report read hooks (FARM-HIGH-125)
 *
 * Wires the frontend to the backend biomass persistence that already
 * existed (`biomassReports` list query) — the tab previously rendered
 * mock history while the create mutation was real.
 *
 * Follows the module data-layer conventions (useTenantQuery — the
 * tenant-key + auth-gate SSoT), mirroring hooks/useRegulatoryReports.ts.
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  graphqlClient,
  useTenantQuery,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';
import {
  BIOMASS_REPORT_QUERY,
  BIOMASS_REPORTS_QUERY,
} from '../graphql/regulatory.operations';

export type BiomassReportStatusValue = 'DRAFT' | 'SUBMITTED';

export interface BiomassReportListRow {
  id: string;
  reportMonth: number;
  reportYear: number;
  status: BiomassReportStatusValue;
  /** Postgres decimal — arrives as a string; format with Number(). */
  totalBiomassKg: string;
  submittedAt?: string | null;
  updatedAt: string;
}

/**
 * Persisted biomass payload — the FE mirror of the backend
 * `BiomassReportPayload` (biomass-report.entity.ts). Kept in lockstep with
 * that type; a change on either side is a same-commit contract change.
 */
export interface BiomassReportPayload {
  currentBiomass: {
    totalKg: number;
    bySpecies: Array<{
      speciesId: string;
      speciesName: string;
      fishCount: number;
      biomassKg: number;
      avgWeightG: number;
    }>;
  };
  stockings: Array<{
    date: string;
    speciesCode: string;
    supplier?: string | null;
    fishCount: number;
    avgWeightG: number;
    biomassKg: number;
    notes?: string | null;
  }>;
  mortality: {
    totalCount: number;
    byCause: Array<{ cause: string; count: number }>;
    details: Array<{
      date: string;
      cause: string;
      speciesCode: string;
      count: number;
      biomassLossKg?: number | null;
      notes?: string | null;
    }>;
  };
  slaughter: {
    totalQuantity: number;
    totalBiomassKg: number;
    records: Array<{
      date: string;
      speciesCode: string;
      quantity: number;
      biomassKg: number;
      buyer?: string | null;
      notes?: string | null;
    }>;
  };
  transfers: Array<{
    date: string;
    direction: 'IN' | 'OUT';
    speciesCode: string;
    fishCount: number;
    biomassKg: number;
    counterparty?: string | null;
    notes?: string | null;
  }>;
  feedConsumption: {
    totalKg: number;
    byFeedType: Array<{
      feedName: string;
      brandName?: string | null;
      quantityKg: number;
    }>;
  };
}

/** Full single-period report incl. the JSONB payload used to pre-fill the wizard. */
export interface BiomassReportDetail {
  id: string;
  status: BiomassReportStatusValue;
  totalBiomassKg: string;
  reportData: BiomassReportPayload;
  submittedAt?: string | null;
  generatedBy?: string | null;
  updatedAt: string;
}

export function useBiomassReports(siteId?: string, limit = 24) {
  return useTenantQuery<BiomassReportListRow[]>(
    ['biomassReports', siteId, limit],
    async () => {
      const data = await graphqlClient.request<{ biomassReports: BiomassReportListRow[] }>(
        BIOMASS_REPORTS_QUERY,
        { siteId, limit },
      );
      return data.biomassReports;
    },
    { enabled: !!siteId },
  );
}

/**
 * Single-period lookup that hydrates the wizard when the user returns to an
 * already-drafted month. Without it, re-opening the (fixed previous-month)
 * wizard starts blank and the create-or-update-if-draft mutation silently
 * overwrites the existing DRAFT on submit. `enabled` should gate the fetch on
 * "a DRAFT for this period exists" so submitted/absent periods issue no query.
 */
export function useBiomassReport(
  siteId: string | undefined,
  reportMonth: number,
  reportYear: number,
  options: { enabled?: boolean } = {},
) {
  return useTenantQuery<BiomassReportDetail | null>(
    ['biomassReport', siteId, reportMonth, reportYear],
    async () => {
      const data = await graphqlClient.request<{
        biomassReport: BiomassReportDetail | null;
      }>(BIOMASS_REPORT_QUERY, { siteId, reportMonth, reportYear });
      return data.biomassReport;
    },
    { enabled: (options.enabled ?? true) && !!siteId },
  );
}

/**
 * Invalidate the biomass history caches after the tab's local create
 * mutation succeeds. The tab submits through its own useMutation (not
 * useRegulatory's helpers), so useRegulatory's predicate invalidation
 * never fires for it.
 */
export function useInvalidateBiomassReports(): () => void {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, 'biomassReports'),
    });
  };
}
