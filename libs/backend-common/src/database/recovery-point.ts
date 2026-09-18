/**
 * Recovery-point capture — the evidence a tenant schema drop must carry.
 *
 * WAL-G is the sole PostgreSQL backup and restore authority (ADR-0009). Its
 * base backups live under `WALG_BACKUP_EPOCH`, and `archive_command` streams
 * every WAL segment there continuously, so the database can be restored to
 * any LSN the archive covers. Before an irreversible drop, the orchestrator
 * asks the database for its current WAL position and records it with the
 * epoch: that pair is exactly what `walg-pitr-restore.sh` needs to bring the
 * dropped data back on isolated compute.
 *
 * What this does NOT claim: that a base backup exists in object storage right
 * now. That attestation belongs to the DR evidence pipeline
 * (`evaluate-walg-evidence.mjs`, `walg-evidence-attestation.spec.ts`), which
 * runs where the bucket is reachable. The recovery point is honest about its
 * scope, which the deleted in-process pg_dump ledger never was.
 */
import { CleanupDropProofRecoveryPoint, WAL_LSN_PATTERN } from './schema-manager.service';

/** The one query the capture runs; exported so tests and gates can pin it. */
export const RECOVERY_POINT_QUERY =
  'SELECT pg_current_wal_lsn()::text AS "walLsn", current_database() AS "database"';

export interface RecoveryPointQueryRunner {
  query(sql: string): Promise<unknown>;
}

interface RecoveryPointRow {
  walLsn: string;
  database: string;
}

function firstRow(result: unknown): RecoveryPointRow {
  const rows = Array.isArray(result) ? result : [];
  const row = rows[0] as Partial<RecoveryPointRow> | undefined;
  if (!row || typeof row.walLsn !== 'string' || typeof row.database !== 'string') {
    throw new Error('Recovery point capture returned no WAL position');
  }
  return { walLsn: row.walLsn, database: row.database };
}

/**
 * Captures the current WAL position under the given WAL-G epoch.
 *
 * @throws when the epoch is empty (the deploy did not state which archive it
 *   writes to) or the database returns an LSN that is not an LSN — either way
 *   the caller has no recovery point and must not proceed with a drop.
 */
export async function captureWalgRecoveryPoint(
  runner: RecoveryPointQueryRunner,
  backupEpoch: string | undefined,
  now: () => Date = () => new Date(),
): Promise<CleanupDropProofRecoveryPoint> {
  const epoch = backupEpoch?.trim() ?? '';
  if (epoch.length === 0) {
    throw new Error(
      'WALG_BACKUP_EPOCH is not set: a tenant schema cannot be dropped without naming the archive that can restore it',
    );
  }
  const row = firstRow(await runner.query(RECOVERY_POINT_QUERY));
  const walLsn = row.walLsn.toUpperCase();
  if (!WAL_LSN_PATTERN.test(walLsn)) {
    throw new Error(`Recovery point capture returned an invalid WAL LSN: ${row.walLsn}`);
  }
  return Object.freeze({
    authority: 'wal-g' as const,
    backupEpoch: epoch,
    walLsn,
    database: row.database,
    capturedAt: now().toISOString(),
  });
}
