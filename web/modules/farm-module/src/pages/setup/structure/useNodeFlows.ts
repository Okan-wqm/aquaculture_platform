/**
 * The process diagrams ("linked flows") one facility node takes part in.
 *
 * WHY: sensor-service diagrams are scoped to a site or department and draw
 * farm equipment as nodes, so the link is read, not assigned: a site or
 * department shows the diagrams scoped to it; a piece of equipment shows the
 * site's diagrams that draw it; a system shows the site's diagrams that draw
 * any of its equipment (read through the same equipment query the tree uses).
 *
 * WHAT: the matching diagrams, a load status, and the page cap of the diagram
 * list so the card can say when a scope holds more than one page.
 */
import { useEquipmentList } from '../../../hooks/useEquipment';
import { useProcessFlows, type ProcessFlow } from '../../../hooks/useProcessFlows';

import type { FacilityNode } from './facilityTree';

export type FlowsStatus = 'loading' | 'error' | 'ready';

export interface NodeFlowsState {
  flows: ProcessFlow[];
  status: FlowsStatus;
  capped: { shown: number; total: number } | null;
}

export function useNodeFlows(node: FacilityNode): NodeFlowsState {
  const scope = node.kind === 'department' ? { departmentId: node.id } : { siteId: node.siteId };
  const flowsQuery = useProcessFlows(scope);
  const isSystem = node.kind === 'system';
  const systemEquipment = useEquipmentList(isSystem ? { systemId: node.id } : undefined, {
    enabled: isSystem,
  });

  const list = flowsQuery.data;
  if (flowsQuery.isError || (isSystem && systemEquipment.isError)) {
    return { flows: [], status: 'error', capped: null };
  }
  // keepPreviousData would show the previous node's rows while this one loads;
  // a placeholder is not this node's answer, so it counts as loading.
  const equipmentPending = isSystem && (!systemEquipment.data || systemEquipment.isPlaceholderData);
  if (!list || flowsQuery.isPlaceholderData || equipmentPending) {
    return { flows: [], status: 'loading', capped: null };
  }

  let flows = list.flows;
  if (node.kind === 'equipment') {
    flows = flows.filter((flow) => flow.equipmentIds.includes(node.id));
  } else if (isSystem && systemEquipment.data) {
    const ids = new Set(systemEquipment.data.items.map((item) => item.id));
    flows = flows.filter((flow) => flow.equipmentIds.some((id) => ids.has(id)));
  }
  return {
    flows,
    status: 'ready',
    capped: list.total > list.flows.length ? { shown: list.flows.length, total: list.total } : null,
  };
}
