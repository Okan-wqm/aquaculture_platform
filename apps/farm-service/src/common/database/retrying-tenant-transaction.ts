import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { sanitizePgError } from '@aquaculture/backend-common/utils';
import { ConflictException } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';

/**
 * A farm tenant transaction that a deadlock (40P01) or a serialization
 * failure (40001) does not turn into a 500: the whole callback re-runs —
 * re-reading everything under fresh locks — and a collision that persists is
 * a 409 the caller can retry. Used by every write that takes measurement-point
 * and parameter-source locks (the binding commands and the handlers that
 * retire a tank, system, equipment, department or site).
 */
const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set(['40P01', '40001']);

/** Runs a tenant transaction, retrying deadlocks and serialization failures; 409 if they persist. */
export async function runRetryingTenantTransaction<T>(
  dataSource: DataSource,
  tenantId: string,
  work: (queryRunner: QueryRunner) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runInTenantTransaction(dataSource, 'farm', tenantId, work);
    } catch (error) {
      const { sqlState } = sanitizePgError(error);
      if (sqlState === null || !RETRYABLE.has(sqlState)) {
        throw error;
      }
      if (attempt >= MAX_ATTEMPTS) {
        throw new ConflictException('A concurrent change kept colliding with this one; retry');
      }
    }
  }
}
