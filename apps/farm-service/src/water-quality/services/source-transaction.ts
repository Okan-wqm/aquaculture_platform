import { sanitizePgError } from '@aquaculture/backend-common/utils';
import { PARAMETER_SOURCE_ERROR } from '@aquaculture/shared-contracts';
import { HttpStatus } from '@nestjs/common';

import { runRetryingTenantTransaction } from '../../common/database/retrying-tenant-transaction';
import { ParameterSourceError } from '../../common/errors/farm-errors';
import { type DataSource, QueryFailedError, type QueryRunner } from 'typeorm';

/**
 * The transactions that write a parameter's sources, its meaning, or retire
 * the measurement points sources stand at.
 *
 * Writers take their locks in one order — parameter config, then point, then
 * source rows — so they serialize instead of deadlocking. What can still
 * collide is translated into what the caller can act on:
 *
 * - a deadlock (40P01) or serialization failure (40001) is retried — the
 *   whole callback re-runs, re-reading everything — and reported as a 409 if
 *   it persists, never a 500 (runRetryingTenantTransaction);
 * - a unique violation (23505) names the rule it broke as a 409
 *   (runSourceTransaction). The rule is recognised by the violated key's
 *   columns, so an index cloned under a Postgres-generated name (tenant
 *   schemas built with LIKE … INCLUDING ALL) reads the same as the
 *   migration-named one.
 */
/** The unique rules of the source and config tables, by their key columns (sorted). */
const UNIQUE_RULES: Readonly<Record<string, string>> = {
  'parameterConfigId,pointKey,tenantId': 'The parameter already has a manual source at this point',
  'parameterConfigId,pointKey,priority,tenantId':
    'The parameter already has a source of this priority at this point; replace or unbind it first',
  'channelKey,parameterConfigId,pointKey,sensorId,tenantId':
    'This channel is already a source of the parameter at this point',
  'effectiveQuantity,tenantId': 'Another active parameter already records this measured quantity',
  'code,tenantId': 'A parameter with this code already exists',
};

/** runRetryingTenantTransaction with unique violations answered as the rule they broke. */
export async function runSourceTransaction<T>(
  dataSource: DataSource,
  tenantId: string,
  work: (queryRunner: QueryRunner) => Promise<T>,
): Promise<T> {
  try {
    return await runRetryingTenantTransaction(dataSource, tenantId, work);
  } catch (error) {
    throw translateSourceWriteError(error);
  }
}

/** A unique violation as the conflict it means; anything else unchanged. */
export function translateSourceWriteError(error: unknown): unknown {
  const { sqlState } = sanitizePgError(error);
  if (sqlState !== '23505') {
    return error;
  }
  const columns = violatedKeyColumns(error);
  return new ParameterSourceError(
    PARAMETER_SOURCE_ERROR.SOURCE_CONFLICT,
    HttpStatus.CONFLICT,
    (columns !== null ? UNIQUE_RULES[columns] : undefined) ??
      'A concurrent change conflicts with this write; retry',
    columns !== null ? { key: columns.split(',') } : undefined,
  );
}

/**
 * The violated key's column names, sorted and comma-joined, from the driver's
 * `Key (a, b)=(…)` detail. Only the column list is read; the values never
 * leave this function.
 */
function violatedKeyColumns(error: unknown): string | null {
  if (!(error instanceof QueryFailedError)) {
    return null;
  }
  const driver: unknown = error.driverError;
  if (typeof driver !== 'object' || driver === null || !('detail' in driver)) {
    return null;
  }
  const detail = driver.detail;
  if (typeof detail !== 'string') {
    return null;
  }
  const match = /^Key \(([^)]*)\)=/.exec(detail);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return match[1]
    .split(',')
    .map((column) => column.trim().replace(/^"|"$/g, ''))
    .sort()
    .join(',');
}
