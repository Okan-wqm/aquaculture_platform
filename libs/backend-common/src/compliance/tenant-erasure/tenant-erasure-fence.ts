import type { TenantErasureTargetService } from '@platform/event-contracts';

/**
 * Transaction-scoped advisory-lock material shared by erasure and writers.
 *
 * Any writer capable of recreating tenant data after an erasure must acquire
 * this lock and check that target service's durable proof ledger in the same
 * transaction. This serializes the two legal orders:
 *
 * - write commits first, then erasure removes it;
 * - erasure proof commits first, then the writer observes the tombstone and
 *   fails permanently.
 */
export function tenantErasureFenceLockKey(
  tenantId: string,
  targetService: TenantErasureTargetService,
): string {
  return JSON.stringify(['tenant-erasure-fence-v1', targetService, tenantId]);
}

/** Permanent denial: the target already committed a non-dry-run erasure. */
export class TenantErasureTombstoneError extends Error {
  constructor() {
    super('Tenant data has already been erased');
    this.name = 'TenantErasureTombstoneError';
  }
}
