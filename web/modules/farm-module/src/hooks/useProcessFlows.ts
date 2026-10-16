/**
 * Process diagrams ("flows") of one site or department, for farm-module.
 *
 * WHY: the facility structure page shows which flows a node takes part in.
 * Those are sensor-service process diagrams; Module-Federation remotes cannot
 * import each other's internals, so — like useSensors — farm-module runs the
 * federated `processes` query itself through the shared graphqlClient.
 *
 * WHAT: a tenant-scoped read (useTenantQuery: tenant key + auth gate) of the
 * diagrams in one scope, each reduced to what the page needs: id, name,
 * status and the farm equipment ids its nodes draw. A null scope disables the
 * query. The key segment is farm-module's own (`processFlows`) so it never
 * shares a cache entry with sensor-module's richer process rows.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';
import type { ProcessStatus } from '@platform/shared-ui/generated/graphql-types';
import type { UseQueryResult } from '@tanstack/react-query';

import {
  PROCESS_FLOWS_QUERY,
  type ProcessFlowFilter,
  type ProcessFlowsResult,
} from '../graphql/processFlows.operations';

export interface ProcessFlow {
  id: string;
  name: string;
  status: ProcessStatus;
  siteId: string | null;
  departmentId: string | null;
  /** Farm equipment ids drawn as nodes of the diagram. */
  equipmentIds: string[];
}

export interface ProcessFlowList {
  flows: ProcessFlow[];
  /** Diagrams in the scope; larger than `flows.length` when the page was capped. */
  total: number;
}

/** sensor-service caps ProcessPaginationInput.limit at 100 (StandardPaginationInput). */
const PROCESS_PAGE_LIMIT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The equipment ids a diagram's JSON node list carries (`node.data.equipmentId`,
 * process.entity.ts ProcessNode). Nodes without one — labels, junctions — are skipped.
 */
export function equipmentIdsOfNodes(nodes: unknown): string[] {
  const list: unknown[] = Array.isArray(nodes) ? nodes : [];
  const ids = new Set<string>();
  for (const node of list) {
    if (!isRecord(node) || !isRecord(node.data)) continue;
    const equipmentId = node.data.equipmentId;
    if (typeof equipmentId === 'string' && equipmentId !== '') ids.add(equipmentId);
  }
  return [...ids];
}

export function useProcessFlows(
  scope: ProcessFlowFilter | null,
): UseQueryResult<ProcessFlowList, Error> {
  return useTenantQuery<ProcessFlowList>(
    ['processFlows', 'list', scope],
    async () => {
      const data = await graphqlClient.request<ProcessFlowsResult>(PROCESS_FLOWS_QUERY, {
        filter: scope,
        pagination: { page: 1, limit: PROCESS_PAGE_LIMIT },
      });
      return {
        total: data.processes.total,
        flows: data.processes.items.map((row) => ({
          id: row.id,
          name: row.name,
          status: row.status,
          siteId: row.siteId ?? null,
          departmentId: row.departmentId ?? null,
          equipmentIds: equipmentIdsOfNodes(row.nodes),
        })),
      };
    },
    { staleTime: 60_000, enabled: scope !== null },
  );
}
