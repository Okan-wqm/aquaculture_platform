/**
 * Equipment rows of one opened department or system in the facility tree.
 *
 * WHY: equipment is the largest level, so it is read per container when the
 * container is opened, through the same useEquipmentList the Equipment tab
 * uses (one cache entry per filter). The backend filters a system's equipment
 * through the equipment_systems junction and a tank's systemId, so tanks come
 * back with the system that holds them.
 *
 * WHAT: the container's equipment nodes plus the page cap (the list query
 * reads page 1 of 100) so the tree can say when a container holds more.
 */
import { useMemo } from 'react';

import { useEquipmentList } from '../../../hooks/useEquipment';

import {
  equipmentNodes,
  type DepartmentNode,
  type EquipmentNode,
  type SystemNode,
} from './facilityTree';

export interface NodeEquipmentState {
  nodes: EquipmentNode[];
  isLoading: boolean;
  isError: boolean;
  /** Set when the container holds more equipment than one page returned. */
  capped: { shown: number; total: number } | null;
}

export function useNodeEquipment(parent: DepartmentNode | SystemNode): NodeEquipmentState {
  const query = useEquipmentList(
    parent.kind === 'system' ? { systemId: parent.id } : { departmentId: parent.id },
  );
  const page = query.data;
  const nodes = useMemo(() => (page ? equipmentNodes(parent, page.items) : []), [parent, page]);
  return {
    nodes,
    isLoading: query.isLoading,
    isError: query.isError,
    capped:
      page && page.total > page.items.length
        ? { shown: page.items.length, total: page.total }
        : null,
  };
}
