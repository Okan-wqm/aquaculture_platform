import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { sanitizePgError } from '@aquaculture/backend-common/utils';
import { ConflictException } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';

/**
 * The transaction every write to a parameter's sources or meaning runs in.
 *
 * Writers lock the parameter config FOR UPDATE first (parameter-sources.ts),
 * so they serialize per parameter. What can still collide is translated into
 * what the caller can act on:
 *
 * - a deadlock (40P01) or serialization failure (40001) is retried — the
 *   whole callback re-runs, re-reading everything — and reported as a
 *   conflict if it persists;
 * - a unique violation (23505) names the rule it broke (one manual source,
 *   one primary and one backup, a channel once per point, one active config
 *   per quantity) as a 409, never a 500.
 */
const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set(['40P01', '40001']);

const UNIQUE_RULES: Readonly<Record<string, string>> = {
  UQ_wqpe_manual_source: 'The parameter already has a manual source at this point',
  UQ_wqpe_channel_priority:
    'The parameter already has a source of this priority at this point; replace or unbind it first',
  UQ_wqpe_channel_key: 'This channel is already a source of the parameter at this point',
  UQ_wqpc_tenant_effective_quantity:
    'Another active parameter already records this measured quantity',
};

export async function runSourceTransaction<T>(
  dataSource: DataSource,
  tenantId: string,
  work: (queryRunner: QueryRunner) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runInTenantTransaction(dataSource, 'farm', tenantId, work);
    } catch (error) {
      const { sqlState } = sanitizePgError(error);
      if (sqlState !== null && RETRYABLE.has(sqlState) && attempt < MAX_ATTEMPTS) {
        continue;
      }
      throw translateSourceWriteError(error);
    }
  }
}

/** A database refusal as the conflict it means; anything else unchanged. */
export function translateSourceWriteError(error: unknown): unknown {
  const { sqlState, constraintName } = sanitizePgError(error);
  if (sqlState === '23505') {
    return new ConflictException(
      (constraintName !== null ? UNIQUE_RULES[constraintName] : undefined) ??
        'A concurrent change already wrote this source',
    );
  }
  if (sqlState !== null && RETRYABLE.has(sqlState)) {
    return new ConflictException('The parameter changed concurrently; retry');
  }
  return error;
}
