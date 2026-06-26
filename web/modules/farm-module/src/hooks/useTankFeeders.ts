/**
 * useTankFeeders Hook
 *
 * Fetches sub-equipment of type 'feeder' for a given parent equipment (tank).
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey } from '@aquaculture/shared-ui';

export interface TankFeeder {
  id: string;
  name: string;
  code: string;
  status: string;
}

// subEquipmentByParent accepts only (parentEquipmentId, includeInactive) — there
// is no `category` argument, and SubEquipmentTypeResponse has no `category` field
// (neither exists on the entity/DTO/schema). Feeder narrowing is therefore done
// client-side off the type name / equipment name. See report: a real server-side
// `category` discriminator is a backend gap (FARM sub-equipment-type lacks one).
const GET_TANK_FEEDERS_QUERY = `
  query GetSubEquipmentByParent($parentEquipmentId: ID!, $includeInactive: Boolean) {
    subEquipmentByParent(parentEquipmentId: $parentEquipmentId, includeInactive: $includeInactive) {
      id
      name
      code
      isActive
      subEquipmentType {
        id
        name
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
  };
}

export function useTankFeeders(tankEquipmentId: string | undefined) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'sub-equipment', 'feeders', tenantId, tankEquipmentId),
    queryFn: async () => {
      if (!tenantId || !tankEquipmentId) return [];

      const data = await graphqlClient.request<{
        subEquipmentByParent: SubEquipmentResponse[];
      }>(GET_TANK_FEEDERS_QUERY, {
        parentEquipmentId: tankEquipmentId,
        includeInactive: false,
      });

      const allSubEquipment = data.subEquipmentByParent || [];

      // Client-side feeder narrowing: the backend exposes no feeder/non-feeder
      // discriminator, so match on the sub-equipment-type name or the unit name.
      const feeders = allSubEquipment.filter(
        (se) =>
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
