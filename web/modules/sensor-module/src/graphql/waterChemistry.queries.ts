/**
 * The farm topology the water-chemistry monitoring view is laid out by: the
 * tenant's systems (one tab each), a system's tanks (its other measurement
 * points) and the system a tank belongs to (a tank-scoped link). The sources
 * and resolved inputs at a point are shared-ui's documents
 * (@aquaculture/shared-ui water-chemistry/sources/operations.ts), one owner
 * with the farm module.
 */
import type { SystemType } from '@platform/shared-ui/generated/graphql-types';

export interface WcSystem {
  id: string;
  name: string;
  code: string;
  type: SystemType;
  siteId: string;
}

export interface WcSystemsResult {
  systems: { items: WcSystem[] };
}

export const WC_SYSTEMS_QUERY = `
  query WaterChemistrySystems($pagination: FarmPaginationInput) {
    systems(filter: { isActive: true }, pagination: $pagination) {
      items {
        id
        name
        code
        type
        siteId
      }
    }
  }
`;

export interface WcTank {
  id: string;
  name: string;
  code: string;
}

export interface WcSystemTanksResult {
  equipmentList: { items: WcTank[] };
}

export const WC_SYSTEM_TANKS_QUERY = `
  query WaterChemistrySystemTanks($systemId: ID!, $pagination: FarmPaginationInput) {
    equipmentList(
      filter: { systemId: $systemId, isTank: true, isActive: true }
      pagination: $pagination
    ) {
      items {
        id
        name
        code
      }
    }
  }
`;

export interface WcTankSystemResult {
  equipment: { id: string; systemIds: string[] | null } | null;
}

export const WC_TANK_SYSTEM_QUERY = `
  query WaterChemistryTankSystem($id: ID!) {
    equipment(id: $id) {
      id
      systemIds
    }
  }
`;
