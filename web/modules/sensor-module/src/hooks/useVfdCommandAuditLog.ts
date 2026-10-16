/**
 * One drive's runtime command trail (vfd_command_audit_logs).
 *
 * WHY a query, not the in-memory list `useVfdCommands` keeps: that list holds
 * only what this browser tab sent since it opened. The ledger holds every
 * command from every operator, automation rule and system origin, written by
 * sensor-service before it answers the mutation, and it is never edited.
 *
 * WHAT: `vfdCommandAuditLog(vfdDeviceId, limit)`, newest first (the server
 * caps the limit at 500). The read waits for a drive to be chosen.
 */
import type { UseQueryResult } from '@tanstack/react-query';
import { useTenantQuery } from '@aquaculture/shared-ui';
import type { VfdCommandAuditLog } from '@platform/shared-ui/generated/graphql-types';

import { graphqlFetch } from '../config/api';
import { VFD_COMMAND_AUDIT_LOG_QUERY } from '../graphql/command-log.queries';

/** The fields VFD_COMMAND_AUDIT_LOG_QUERY selects; `command` arrives by enum NAME. */
export type VfdCommandAuditEntry = Pick<
  VfdCommandAuditLog,
  | 'id'
  | 'vfdDeviceId'
  | 'command'
  | 'value'
  | 'success'
  | 'error'
  | 'performedBy'
  | 'performedByEmail'
  | 'source'
  | 'latencyMs'
  | 'timestamp'
>;

/** How many of a drive's latest commands the command log shows. */
export const VFD_COMMAND_LOG_LIMIT = 100;

export function useVfdCommandAuditLog(
  vfdDeviceId: string | undefined,
  limit: number = VFD_COMMAND_LOG_LIMIT,
): UseQueryResult<VfdCommandAuditEntry[]> {
  // useTenantQuery is the SSoT for the tenant-scoped key + authenticated-tenant gate.
  return useTenantQuery(
    ['vfdCommandAuditLog', vfdDeviceId, limit],
    async () => {
      const data = await graphqlFetch<{ vfdCommandAuditLog: VfdCommandAuditEntry[] }>(
        VFD_COMMAND_AUDIT_LOG_QUERY,
        { vfdDeviceId, limit },
      );
      return data.vfdCommandAuditLog;
    },
    // keepPreviousData off: another drive's trail must never stand in for this one's.
    { enabled: vfdDeviceId !== undefined, staleTime: 15_000, keepPreviousData: false },
  );
}
