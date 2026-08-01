/** Honest terminal states returned by a tenant-erasure target. */
export type TenantErasureExecutionState = 'PURGED' | 'ALREADY_PURGED' | 'DRY_RUN_COMPLETED';

/**
 * Keeps dry-run result naming consistent across the shared executor and the
 * farm service's legacy/custom erasure implementation.
 */
export function tenantErasureCompletionState(
  dryRun: boolean,
  replayed: boolean,
): TenantErasureExecutionState {
  if (dryRun) {
    return 'DRY_RUN_COMPLETED';
  }
  return replayed ? 'ALREADY_PURGED' : 'PURGED';
}
