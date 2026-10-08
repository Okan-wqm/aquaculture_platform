/**
 * Measurement form parameters for a unit (tank or water equipment).
 *
 * Reads the server's `unitMeasurementPlan`: the unit's plan, or every active
 * parameter when nobody mapped one, each marked required exactly as the
 * server's validator requires it — so the form and the validator cannot
 * disagree. Transformed into ParameterFieldConfig[] for DynamicMeasurementForm.
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey } from '@aquaculture/shared-ui';
import type { ParameterFieldConfig } from '@aquaculture/farm-shared';

// ============================================================================
// GRAPHQL QUERY
// ============================================================================

const GET_UNIT_MEASUREMENT_PLAN = `
  query UnitMeasurementPlan($unitId: ID!) {
    unitMeasurementPlan(unitId: $unitId) {
      planned
      entries {
        required
        parameter {
          id code name unit dataType precision group
          optimalMin optimalMax warningMin warningMax criticalMin criticalMax
          enumValues displayOrder chartColor
        }
      }
    }
  }
`;

// ============================================================================
// TYPES
// ============================================================================

interface UnitMeasurementPlanEntry {
  required: boolean;
  parameter: {
    id: string;
    code: string;
    name: string;
    unit: string;
    dataType: string;
    precision: number;
    group: string;
    optimalMin: number | null;
    optimalMax: number | null;
    warningMin: number | null;
    warningMax: number | null;
    criticalMin: number | null;
    criticalMax: number | null;
    enumValues: string[] | null;
    displayOrder: number;
    chartColor: string;
  };
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * The parameters to record at a unit (tank or water equipment), from the
 * server's measurement plan. Returns ParameterFieldConfig[] sorted by
 * displayOrder, ready for DynamicMeasurementForm.
 */
export function useEquipmentParameterConfigs(equipmentId: string | null) {
  const { token } = useAuth();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'unitMeasurementPlan', equipmentId),
    queryFn: async (): Promise<ParameterFieldConfig[]> => {
      if (!equipmentId) return [];
      const response = await graphqlClient.request<{
        unitMeasurementPlan: { planned: boolean; entries: UnitMeasurementPlanEntry[] };
      }>(GET_UNIT_MEASUREMENT_PLAN, { unitId: equipmentId });

      return response.unitMeasurementPlan.entries
        .map(({ parameter, required }) => ({
          code: parameter.code,
          name: parameter.name,
          unit: parameter.unit,
          dataType: parameter.dataType as 'NUMBER' | 'ENUM' | 'BOOLEAN',
          precision: parameter.precision,
          enumValues: parameter.enumValues,
          isRequired: required,
          group: parameter.group,
          displayOrder: parameter.displayOrder,
          chartColor: parameter.chartColor,
          limits: {
            optimalMin: parameter.optimalMin,
            optimalMax: parameter.optimalMax,
            warningMin: parameter.warningMin,
            warningMax: parameter.warningMax,
            criticalMin: parameter.criticalMin,
            criticalMax: parameter.criticalMax,
          },
        }))
        .sort((a, b) => a.displayOrder - b.displayOrder);
    },
    enabled: !!token && !!equipmentId,
    staleTime: 300000, // 5 min — matches backend cache TTL
  });
}
