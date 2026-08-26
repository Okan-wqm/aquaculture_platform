import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

describe('INVARIANT (SENSOR-HIGH-100): tenant-isolated telemetry cold storage', () => {
  const coordinator = source(
    'apps/sensor-service/src/telemetry-archive/telemetry-archive-coordinator.service.ts',
  );
  const postgresSource = source(
    'apps/sensor-service/src/telemetry-archive/postgres-telemetry-archive-source.service.ts',
  );
  const parquet = source(
    'apps/sensor-service/src/telemetry-archive/telemetry-parquet-codec.service.ts',
  );
  const objectStore = source(
    'apps/sensor-service/src/telemetry-archive/s3-telemetry-archive-object-store.service.ts',
  );
  const bucketProvisioner = source(
    'apps/sensor-service/src/telemetry-archive/telemetry-archive-bucket-provisioner.service.ts',
  );
  const scratchRestore = source(
    'apps/sensor-service/src/telemetry-archive/postgres-telemetry-scratch-restore.service.ts',
  );
  const presign = source(
    'apps/sensor-service/src/telemetry-archive/telemetry-archive-presign.service.ts',
  );
  const archiveModule = source(
    'apps/sensor-service/src/telemetry-archive/telemetry-archive.module.ts',
  );
  const appModule = source('apps/sensor-service/src/app.module.ts');
  const migration = source(
    'apps/sensor-service/src/database/migrations/1816000000003-TelemetryArchiveErasure.ts',
  );

  it('uses one bucket per tenant and four distinct least-privilege identities', () => {
    expect(coordinator).toContain('aqua-telemetry-${tenantId.replaceAll');
    expect(coordinator).not.toContain('.slice(0, 16)');
    expect(coordinator).toContain('identities.size !== 4');
    expect(bucketProvisioner).toContain("Sid: 'ExporterWriteOnly'");
    expect(bucketProvisioner).toContain("Sid: 'VerifierReadOnly'");
    expect(bucketProvisioner).toContain("Sid: 'RestoreReadOnly'");
    expect(bucketProvisioner).not.toContain('aqua-telemetry-*');
    expect(objectStore).toContain(
      "type TelemetryArchiveStorageCapability = 'WRITE' | 'READ' | 'ERASE'",
    );
    expect(presign).toContain('const PRESIGN_TTL_SECONDS = 900');
    expect(presign).toContain("createHash('sha256').update(url)");
    expect(archiveModule).toContain('TELEMETRY_ARCHIVE_EXPORTER_ACCESS_KEY');
    expect(archiveModule).toContain('TELEMETRY_ARCHIVE_VERIFIER_ACCESS_KEY');
    expect(archiveModule).toContain('TELEMETRY_ARCHIVE_RESTORE_ACCESS_KEY');
    expect(archiveModule).toContain('TELEMETRY_ARCHIVE_ERASURE_ACCESS_KEY');
    expect(appModule).toContain('telemetryArchiveEnabled ? [TelemetryArchiveModule] : []');
  });

  it('exports a deterministic raw Parquet snapshot with complete manifest evidence', () => {
    expect(postgresSource).toContain("startTransaction('REPEATABLE READ')");
    expect(postgresSource).toContain('SET TRANSACTION READ ONLY');
    expect(postgresSource).toContain('pg_export_snapshot()');
    expect(postgresSource).toContain('pg_current_wal_lsn()');
    expect(postgresSource).toContain('ORDER BY time, sensor_id, channel_id');
    expect(parquet).toContain("!== 'PAR1'");
    expect(parquet).not.toContain('readFile(');
    expect(objectStore).not.toContain('transformToByteArray');
    expect(objectStore).toContain('createReadStream');
    expect(objectStore).toContain('createWriteStream');
    expect(coordinator).toContain("format: 'PARQUET'");
    expect(migration).toContain('append_telemetry_archive_event_v2');
    expect(migration).toContain('VERIFIED manifest must exactly match EXPORTED manifest');
  });

  it('keeps restore out of production schemas and erasure behind repeated legal-hold checks', () => {
    expect(scratchRestore).toContain("const RESTORE_ROLE = 'telemetry_archive_restore'");
    expect(scratchRestore).toContain('canWriteTenantSchema');
    expect(scratchRestore).toContain('canMutateArchiveLedger');
    expect(scratchRestore).toContain('restore_${request.operationId.replaceAll');
    expect(objectStore).toContain('beforeDestructiveStep');
    expect(migration).toContain('compliance.legal_holds');
    expect(migration).not.toContain('messaging.legal_holds');
    expect(migration).toContain('evidence_sha256');
    expect(archiveModule).toContain('TELEMETRY_ARCHIVE_RESTORE_DB_USER');
    expect(archiveModule).toContain('TELEMETRY_ARCHIVE_ERASURE_DB_USER');
  });
});
