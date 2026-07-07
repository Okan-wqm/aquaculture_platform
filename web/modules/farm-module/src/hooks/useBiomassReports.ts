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
  useTenantMutation,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';
import {
  BIOMASS_REPORT_QUERY,
  BIOMASS_REPORTS_QUERY,
  BIOMASS_REPORT_ALTINN_EXPORT_QUERY,
  MARK_BIOMASS_REPORT_READY_MUTATION,
  REVERT_BIOMASS_REPORT_TO_DRAFT_MUTATION,
  CONFIRM_BIOMASS_REPORT_SUBMITTED_MUTATION,
} from '../graphql/regulatory.operations';

/**
 * Biomass report lifecycle. The report is submitted to Fiskeridirektoratet
 * MANUALLY via Altinn (FD-0001), so there is no electronic-submit state:
 *   DRAFT ─markReady→ READY ─confirmSubmitted→ CONFIRMED_SUBMITTED (terminal)
 *     ▲                 │
 *     └──revertToDraft──┘
 * `SUBMITTED` is the legacy terminal state from before the Altinn honesty fix.
 */
export type BiomassReportStatusValue = 'DRAFT' | 'READY' | 'CONFIRMED_SUBMITTED' | 'SUBMITTED';

/** The terminal, immutable biomass states (confirmed Altinn submission + legacy). */
export const TERMINAL_BIOMASS_STATUSES: ReadonlySet<BiomassReportStatusValue> = new Set([
  'CONFIRMED_SUBMITTED',
  'SUBMITTED',
]);

export function isTerminalBiomassStatus(status: BiomassReportStatusValue): boolean {
  return TERMINAL_BIOMASS_STATUSES.has(status);
}

export interface BiomassReportListRow {
  id: string;
  reportMonth: number;
  reportYear: number;
  status: BiomassReportStatusValue;
  /** Postgres decimal — arrives as a string; format with Number(). */
  totalBiomassKg: string;
  readyAt?: string | null;
  altinnReference?: string | null;
  submittedAt?: string | null;
  updatedAt: string;
}

/** The FD-0001 export the operator transcribes into the Altinn form. */
export interface BiomassAltinnExport {
  filename: string;
  periodLabel: string;
  csv: string;
  printable: string;
  generatedAt: string;
}

/** The lifecycle mutation return shape (mirrors BIOMASS_REPORT_STATE_FIELDS). */
export interface BiomassReportStateRow {
  id: string;
  status: BiomassReportStatusValue;
  totalBiomassKg: string;
  readyAt?: string | null;
  altinnReference?: string | null;
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
  readyAt?: string | null;
  altinnReference?: string | null;
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

// ============================================================================
// ALTINN MANUAL-SUBMISSION STATE MACHINE (RPT-001)
//
// The three lifecycle mutations + the FD-0001 export query. Each mutation
// invalidates both the period-history list and the single-period lookup so
// the tab reflects the new status without a manual refetch.
// ============================================================================

/** Invalidation keys touched by every biomass lifecycle transition. */
const BIOMASS_INVALIDATE = [['biomassReports'], ['biomassReport']] as const;

/** DRAFT → READY. */
export function useMarkBiomassReportReady() {
  return useTenantMutation<BiomassReportStateRow, Error, string>(
    async (id: string) => {
      const data = await graphqlClient.request<{ markBiomassReportReady: BiomassReportStateRow }>(
        MARK_BIOMASS_REPORT_READY_MUTATION,
        { id },
      );
      return data.markBiomassReportReady;
    },
    { invalidate: BIOMASS_INVALIDATE },
  );
}

/** READY → DRAFT (reopen). */
export function useRevertBiomassReportToDraft() {
  return useTenantMutation<BiomassReportStateRow, Error, string>(
    async (id: string) => {
      const data = await graphqlClient.request<{
        revertBiomassReportToDraft: BiomassReportStateRow;
      }>(REVERT_BIOMASS_REPORT_TO_DRAFT_MUTATION, { id });
      return data.revertBiomassReportToDraft;
    },
    { invalidate: BIOMASS_INVALIDATE },
  );
}

/** READY → CONFIRMED_SUBMITTED, recording the Altinn receipt reference. */
export function useConfirmBiomassReportSubmitted() {
  return useTenantMutation<
    BiomassReportStateRow,
    Error,
    { id: string; altinnReference: string }
  >(
    async ({ id, altinnReference }) => {
      const data = await graphqlClient.request<{
        confirmBiomassReportSubmitted: BiomassReportStateRow;
      }>(CONFIRM_BIOMASS_REPORT_SUBMITTED_MUTATION, { id, altinnReference });
      return data.confirmBiomassReportSubmitted;
    },
    { invalidate: BIOMASS_INVALIDATE },
  );
}

/**
 * On-demand FD-0001 export for a READY report. `enabled` should gate the fetch
 * on the report being READY so DRAFT/terminal periods issue no query.
 */
export function useBiomassReportAltinnExport(
  id: string | undefined,
  options: { enabled?: boolean } = {},
) {
  return useTenantQuery<BiomassAltinnExport | null>(
    ['biomassReportAltinnExport', id],
    async () => {
      const data = await graphqlClient.request<{
        biomassReportAltinnExport: BiomassAltinnExport;
      }>(BIOMASS_REPORT_ALTINN_EXPORT_QUERY, { id });
      return data.biomassReportAltinnExport;
    },
    { enabled: (options.enabled ?? true) && !!id },
  );
}
