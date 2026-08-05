import {
  tenantErasureFenceLockKey,
  TenantErasureTombstoneError,
} from '@aquaculture/backend-common/compliance';
import { queryRowsNormalized } from '@aquaculture/backend-common/database';

import { RlsScopeQueryExecutor } from '../../database/rls-scoped-session';

/**
 * Serializes tenant configuration access against config-service erasure and
 * enforces the durable non-dry-run proof as a permanent tombstone.
 *
 * The caller must pin FORCE-RLS to the same tenant and keep its transaction
 * open for the complete read/write operation. This makes the advisory lock a
 * linearization boundary: an operation that acquired it before erasure may
 * finish, while every operation starting after the proof commits fails closed.
 */
export async function assertTenantConfigurationNotErased(
  executor: RlsScopeQueryExecutor,
  tenantId: string,
): Promise<void> {
  await executor.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    tenantErasureFenceLockKey(tenantId, 'config-service'),
  ]);
  const rows = queryRowsNormalized<{ erased: boolean }>(
    await executor.query(
      `SELECT EXISTS (
         SELECT 1
           FROM "config"."tenant_erasure_target_proofs"
          WHERE "tenantId" = $1
            AND "targetService" = 'config-service'
            AND "dryRun" = false
       ) AS "erased"`,
      [tenantId],
    ),
  );
  if (rows.length !== 1 || typeof rows[0]?.erased !== 'boolean') {
    throw new Error('Config tenant erasure tombstone query returned an invalid result');
  }
  if (rows[0].erased) {
    throw new TenantErasureTombstoneError();
  }
}
