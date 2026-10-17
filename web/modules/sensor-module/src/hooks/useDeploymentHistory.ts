/**
 * Automation program deployments to edge devices (deployment_logs).
 *
 * WHY: a deployment is a command record — who pushed which program version to
 * which edge device, when, and whether the edge acknowledged it. The program
 * editor reads one device's history inside its deploy tab; the command log
 * reads every device's, which `deploymentHistory` returns when no device is
 * given (newest first).
 *
 * WHAT: `deploymentHistory(deviceId?, page, limit)` through the existing
 * DEPLOYMENT_HISTORY_QUERY document. The key shares the editor's
 * 'deploymentHistory' prefix, so the editor's post-deploy invalidation
 * refreshes this read as well.
 */
import type { UseQueryResult } from '@tanstack/react-query';
import { useTenantQuery } from '@aquaculture/shared-ui';
import type { DeploymentLog } from '@platform/shared-ui/generated/graphql-types';

import { graphqlFetch } from '../config/api';
import { DEPLOYMENT_HISTORY_QUERY } from '../graphql/automation.queries';

/** The fields DEPLOYMENT_HISTORY_QUERY selects; `status` arrives by enum NAME. */
export type DeploymentHistoryEntry = Pick<
  DeploymentLog,
  | 'id'
  | 'programId'
  | 'deviceId'
  | 'commandId'
  | 'status'
  | 'version'
  | 'deployedBy'
  | 'deployedByEmail'
  | 'deployedAt'
  | 'completedAt'
  | 'edgeAckAt'
  | 'errorMessage'
>;

export interface DeploymentHistoryPage {
  items: DeploymentHistoryEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface DeploymentHistoryParams {
  /** One edge device's history; omit for every device of the tenant. */
  deviceId?: string;
  page: number;
  limit: number;
}

export function useDeploymentHistory({
  deviceId,
  page,
  limit,
}: DeploymentHistoryParams): UseQueryResult<DeploymentHistoryPage> {
  // useTenantQuery is the SSoT for the tenant-scoped key + authenticated-tenant gate.
  return useTenantQuery(
    ['deploymentHistory', deviceId ?? 'all-devices', page, limit],
    async () => {
      const data = await graphqlFetch<{ deploymentHistory: DeploymentHistoryPage }>(
        DEPLOYMENT_HISTORY_QUERY,
        { deviceId, page, limit },
      );
      return data.deploymentHistory;
    },
    { staleTime: 15_000 },
  );
}
