/**
 * Process-diagram reads for the facility structure page (farm-module).
 *
 * WHY: a site, department, system or piece of equipment is "linked" to the
 * flows it takes part in through sensor-service process diagrams — each
 * diagram is scoped to a site/department and its nodes carry the farm
 * `equipmentId` they draw. Remotes cannot import sensor-module internals, so
 * farm-module runs the federated `processes` query itself, through the shared
 * graphqlClient, and links out to the sensor-module editor routes.
 *
 * WHAT: only the fields the structure page reads — id, name, status, scope and
 * the node list (to match equipment ids). Edges, metadata and audit fields stay
 * with the sensor-module editor that owns them.
 *
 * @module FarmModule/GraphQL
 */
import type { ProcessFilterInput, ProcessType } from '@platform/shared-ui/generated/graphql-types';

export const PROCESS_FLOWS_QUERY = `
  query FarmProcessFlows($filter: ProcessFilterInput, $pagination: ProcessPaginationInput) {
    processes(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        status
        siteId
        departmentId
        nodes
      }
      total
    }
  }
`;

/** The selected fields of a process diagram, nullable as the schema says. */
export type ProcessFlowRow = Pick<
  ProcessType,
  'id' | 'name' | 'status' | 'siteId' | 'departmentId' | 'nodes'
>;

export interface ProcessFlowsResult {
  processes: { items: ProcessFlowRow[]; total: number };
}

export type ProcessFlowFilter = Pick<ProcessFilterInput, 'siteId' | 'departmentId'>;
