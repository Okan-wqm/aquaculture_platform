/**
 * Messaging-service request-reply command contracts.
 *
 * Admin provisioning uses these commands when a tenant schema is created after
 * messaging-service bootstrap. The command is the durable acknowledgement path;
 * TenantProvisioned remains an event fan-out, not the source of truth for
 * provisioning success.
 */

export const MESSAGING_COMMAND_SUBJECTS = {
  ENSURE_TENANT_PARTITIONS: 'request.messaging.ensureTenantPartitions',
} as const;

export interface EnsureTenantMessagingPartitionsCommand {
  tenantId: string;
  correlationId?: string;
}

export interface EnsureTenantMessagingPartitionsResult {
  success: boolean;
  tenantId?: string;
  schemaName?: string;
  errorCode?: 'INVALID_TENANT' | 'PARTITION_FAILURE' | 'INTERNAL_ERROR';
  error?: string;
}
