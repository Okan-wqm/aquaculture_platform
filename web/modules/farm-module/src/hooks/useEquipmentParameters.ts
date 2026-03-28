/**
 * Equipment Parameter Configs hook for farm-module
 *
 * Fetches parameter configs that are mapped to a specific equipment item,
 * transformed into ParameterFieldConfig[] ready for DynamicMeasurementForm.
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';
import type { ParameterFieldConfig } from '@aquaculture/farm-shared';

// ============================================================================
// GRAPHQL QUERY
// ============================================================================

const GET_EQUIPMENT_PARAMETER_CONFIGS = `
  query EquipmentParameterConfigs($equipmentId: ID!) {
    equipmentParameters(equipmentId: $equipmentId) {
      id
      parameterConfigId
      equipmentId
      isActive
      parameterConfig {
        id code name unit dataType precision group
        optimalMin optimalMax warningMin warningMax criticalMin criticalMax
        enumValues displayOrder isRequired chartColor
      }
    }
  }
`;

// ============================================================================
// TYPES
// ============================================================================

interface EquipmentParameterMapping {
  id: string;
  parameterConfigId: string;
  equipmentId: string;
  isActive: boolean;
  parameterConfig: {
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
    isRequired: boolean;
    chartColor: string;
  };
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Fetch parameter configs mapped to a specific equipment item.
 * Returns ParameterFieldConfig[] sorted by displayOrder, ready for DynamicMeasurementForm.
 */
export function useEquipmentParameterConfigs(equipmentId: string | null) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['equipmentParameterConfigs', equipmentId],
    queryFn: async (): Promise<ParameterFieldConfig[]> => {
      if (!equipmentId) return [];
      const response = await graphqlClient.request<{
        equipmentParameters: EquipmentParameterMapping[];
      }>(GET_EQUIPMENT_PARAMETER_CONFIGS, { equipmentId });

      return response.equipmentParameters
        .filter((m) => m.isActive)
        .map((m) => ({
          code: m.parameterConfig.code,
          name: m.parameterConfig.name,
          unit: m.parameterConfig.unit,
          dataType: m.parameterConfig.dataType as 'NUMBER' | 'ENUM' | 'BOOLEAN',
          precision: m.parameterConfig.precision,
          enumValues: m.parameterConfig.enumValues,
          isRequired: m.parameterConfig.isRequired,
          group: m.parameterConfig.group,
          displayOrder: m.parameterConfig.displayOrder,
          chartColor: m.parameterConfig.chartColor,
          limits: {
            optimalMin: m.parameterConfig.optimalMin,
            optimalMax: m.parameterConfig.optimalMax,
            warningMin: m.parameterConfig.warningMin,
            warningMax: m.parameterConfig.warningMax,
            criticalMin: m.parameterConfig.criticalMin,
            criticalMax: m.parameterConfig.criticalMax,
          },
        }))
        .sort((a, b) => a.displayOrder - b.displayOrder);
    },
    enabled: !!token && !!equipmentId,
    staleTime: 300000, // 5 min — matches backend cache TTL
  });
}
