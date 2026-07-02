/**
 * Biomass report read hooks (FARM-HIGH-112)
 *
 * Wires the frontend to the backend biomass persistence that already
 * existed (`biomassReports` list query) — the tab previously rendered
 * mock history while the create mutation was real.
 *
 * Follows the module data-layer conventions (useAuth, graphqlClient,
 * tenant-scoped query keys), mirroring hooks/useRegulatoryReports.ts.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  graphqlClient,
  createTenantQueryKey,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';
import { BIOMASS_REPORTS_QUERY } from '../graphql/regulatory.operations';

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

export function useBiomassReports(siteId?: string, limit = 24) {
  const { token, tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'biomassReports', siteId, limit),
    queryFn: async (): Promise<BiomassReportListRow[]> => {
      const data = await graphqlClient.request<{ biomassReports: BiomassReportListRow[] }>(
        BIOMASS_REPORTS_QUERY,
        { siteId, limit },
      );
      return data.biomassReports;
    },
    enabled: !!token && !!tenantId && !!siteId,
  });
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
