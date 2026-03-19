/**
 * useTankFeeders Hook
 *
 * Fetches sub-equipment of type 'feeder' for a given parent equipment (tank).
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

export interface TankFeeder {
  id: string;
  name: string;
  code: string;
  status: string;
}

// PERF-013: Pass category filter to the server so only feeder-type sub-equipment
// is returned, reducing over-fetch for tanks with many non-feeder sub-equipment items.
const GET_TANK_FEEDERS_QUERY = `
  query GetSubEquipmentByParent($parentEquipmentId: ID!, $includeInactive: Boolean, $category: String) {
    subEquipmentByParent(parentEquipmentId: $parentEquipmentId, includeInactive: $includeInactive, category: $category) {
      id
      name
      code
      isActive
      subEquipmentType {
        id
        name
        category
      }
    }
  }
`;

interface SubEquipmentResponse {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  subEquipmentType?: {
    id: string;
    name: string;
    category: string;
  };
}

export function useTankFeeders(tankEquipmentId: string | undefined) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['sub-equipment', 'feeders', tenantId, tankEquipmentId],
    queryFn: async () => {
      if (!tenantId || !tankEquipmentId) return [];

      const data = await graphqlClient.request<{
        subEquipmentByParent: SubEquipmentResponse[];
      }>(GET_TANK_FEEDERS_QUERY, {
        parentEquipmentId: tankEquipmentId,
        includeInactive: false,
        category: 'feeder', // server-side category filter (PERF-013)
      });

      const allSubEquipment = data.subEquipmentByParent || [];

      // Client-side fallback filter in case the server doesn't support the category param yet
      const feeders = allSubEquipment.filter(
        (se) =>
          !se.subEquipmentType?.category ||
          se.subEquipmentType.category.toLowerCase() === 'feeder' ||
          se.subEquipmentType?.name?.toLowerCase().includes('feeder') ||
          se.name?.toLowerCase().includes('feeder'),
      );

      return feeders.map((f): TankFeeder => ({
        id: f.id,
        name: f.name,
        code: f.code,
        status: f.isActive ? 'ACTIVE' : 'INACTIVE',
      }));
    },
    enabled: !!token && !!tenantId && !!tankEquipmentId,
    staleTime: 60000,
  });
}
