/**
 * Subtree counts of the selected facility node.
 *
 * WHY: farm-service already walks a node's whole subtree for the delete
 * previews (siteDeletePreview → departments, systems, equipment, tanks; and the
 * department / system / equipment variants), so the counts come from those
 * reads instead of a second aggregation. Those queries are role-gated on the
 * server to TENANT_ADMIN + MODULE_MANAGER; FRONTEND_MUTATION_ROLES.deleteSite
 * mirrors exactly that pair, so `useCanMutate('deleteSite')` is the gate here
 * and other roles never fire a request that would be refused.
 *
 * WHAT: the counts for the node's kind as message-key/value pairs, or the
 * reason there are none (restricted, loading, error).
 */
import { useCanMutate, type MessageKey } from '@aquaculture/shared-ui';

import { useDepartmentDeletePreview } from '../../../hooks/useDepartments';
import { useEquipmentDeletePreview } from '../../../hooks/useEquipment';
import { useSiteDeletePreview } from '../../../hooks/useSites';
import { useSystemDeletePreview } from '../../../hooks/useSystems';

import type { FacilityNode, FacilityNodeKind } from './facilityTree';

export interface NodeCount {
  labelKey: MessageKey;
  value: number;
  /** Tanks holding live stock, shown under the tank count. */
  liveStock?: number;
}

export type NodeCountsState =
  | { status: 'restricted' | 'loading' | 'error' }
  | { status: 'ready'; counts: NodeCount[] };

interface PreviewRead<T> {
  data: T | undefined;
  isError: boolean;
  /** A kept-previous result belongs to the previously selected node. */
  isPlaceholderData: boolean;
}

function idFor(node: FacilityNode, kind: FacilityNodeKind, canRead: boolean): string | null {
  return canRead && node.kind === kind ? node.id : null;
}

function settle<T>(read: PreviewRead<T>, toCounts: (data: T) => NodeCount[]): NodeCountsState {
  if (read.isError) return { status: 'error' };
  if (!read.data || read.isPlaceholderData) return { status: 'loading' };
  return { status: 'ready', counts: toCounts(read.data) };
}

export function useNodeCounts(node: FacilityNode): NodeCountsState {
  const canRead = useCanMutate('deleteSite');
  const site = useSiteDeletePreview(idFor(node, 'site', canRead));
  const department = useDepartmentDeletePreview(idFor(node, 'department', canRead));
  const system = useSystemDeletePreview(idFor(node, 'system', canRead));
  const equipment = useEquipmentDeletePreview(idFor(node, 'equipment', canRead));

  if (!canRead) return { status: 'restricted' };
  switch (node.kind) {
    case 'site':
      return settle(site, ({ affectedItems: items }) => [
        { labelKey: 'facilityStructure.kpi.departments', value: items.departments.length },
        { labelKey: 'facilityStructure.kpi.systems', value: items.systems.length },
        { labelKey: 'facilityStructure.kpi.equipment', value: items.equipment.length },
        {
          labelKey: 'facilityStructure.kpi.tanks',
          value: items.tanks.length,
          liveStock: items.tanks.filter((tank) => tank.hasActiveBiomass).length,
        },
      ]);
    case 'department':
      return settle(department, ({ affectedItems: items }) => [
        { labelKey: 'facilityStructure.kpi.equipment', value: items.equipment.length },
        {
          labelKey: 'facilityStructure.kpi.tanks',
          value: items.tanks.length,
          liveStock: items.tanks.filter((tank) => tank.hasActiveBiomass).length,
        },
      ]);
    case 'system':
      return settle(system, ({ affectedItems: items }) => [
        { labelKey: 'facilityStructure.kpi.childSystems', value: items.childSystems.length },
        { labelKey: 'facilityStructure.kpi.equipment', value: items.equipment.length },
      ]);
    case 'equipment':
      return settle(equipment, ({ affectedItems: items }) => [
        { labelKey: 'facilityStructure.kpi.equipment', value: items.childEquipment.length },
        { labelKey: 'facilityStructure.kpi.subEquipment', value: items.subEquipment.length },
      ]);
  }
}
