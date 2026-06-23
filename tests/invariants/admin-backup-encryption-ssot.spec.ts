import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'apps/admin-api-service/src/migrations');
const BACKUP_SERVICE_PATH = join(
  REPO_ROOT,
  'apps/admin-api-service/src/database-management/services/backup-restore.service.ts',
);
const BACKUP_ENTITY_PATH = join(
  REPO_ROOT,
  'apps/admin-api-service/src/database-management/entities/database-management.entity.ts',
);
const DATABASE_MANAGEMENT_MODULE_PATH = join(
  REPO_ROOT,
  'apps/admin-api-service/src/database-management/database-management.module.ts',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('admin backup encryption SSoT', () => {
  const retirementMigration = read(
    join(MIGRATIONS_DIR, '1800750000000-RetirePlaintextSchemaBackups.ts'),
  );
  const invariantMigration = read(
    join(MIGRATIONS_DIR, '1800800000000-BackupEncryptionInvariant.ts'),
  );
  const backupService = read(BACKUP_SERVICE_PATH);
  const backupEntity = read(BACKUP_ENTITY_PATH);
  const databaseManagementModule = read(DATABASE_MANAGEMENT_MODULE_PATH);

  it('retires legacy plaintext backups before enforcing encrypted-only active backups', () => {
    expect(retirementMigration).toContain('RetirePlaintextSchemaBackups1800750000000');
    expect(retirementMigration).toContain('"admin"."retired_schema_backups"');
    expect(retirementMigration).toContain('"retiredReason" IN (\'legacy_plaintext_backup\')');
    expect(retirementMigration).toContain('WHERE b."isEncrypted" IS DISTINCT FROM true');
    expect(retirementMigration).toContain('to_jsonb(b)');
    expect(retirementMigration).toContain('b."completedAt",\n        now(),\n        b."createdAt"');
    expect(retirementMigration).toContain('DELETE FROM "admin"."schema_backups"');
    expect(retirementMigration).toContain('AND b."isEncrypted" IS DISTINCT FROM true');
    expect(retirementMigration).toContain('ON CONFLICT ("backupId") DO NOTHING');
    expect(retirementMigration).not.toContain('ON CONFLICT ("backupId") DO UPDATE');
  });

  it('preserves cleanup and restore evidence without keeping plaintext rows active', () => {
    expect(retirementMigration).toContain('ADD COLUMN IF NOT EXISTS "retiredBackupId" UUID NULL');
    expect(retirementMigration).toContain('"retiredBackupId" = cr."backupId"');
    expect(retirementMigration).toContain('"backupId" = NULL');
    expect(retirementMigration).toContain('ALTER COLUMN "backupId" DROP NOT NULL');
    expect(retirementMigration).toContain('fk_cleanup_runs_retired_backup');
    expect(retirementMigration).toContain('"cleanupRunIds" UUID[] NOT NULL DEFAULT \'{}\'');
    expect(retirementMigration).toContain('"restoreIds" UUID[] NOT NULL DEFAULT \'{}\'');
    expect(retirementMigration).toContain('UPDATE "admin"."schema_restores" sr');
    expect(retirementMigration).toContain('SET "retiredBackupId" = sr."backupId",');
    expect(retirementMigration).toContain('FROM "admin"."schema_restores" sr');
    expect(retirementMigration).toContain('fk_schema_restores_retired_backup');
    expect(retirementMigration).toContain('idx_schema_restores_retired_backup');
  });

  it('registers the retired backup ledger as the admin backup domain SSoT', () => {
    expect(backupEntity).toContain("export class RetiredSchemaBackup");
    expect(backupEntity).toContain("@Entity('retired_schema_backups', { schema: 'admin' })");
    expect(backupEntity).toContain('@PrimaryColumn({ type: \'uuid\' })');
    expect(backupEntity).toContain("retiredReason!: 'legacy_plaintext_backup'");
    expect(backupEntity).toContain('cleanupRunIds!: string[]');
    expect(backupEntity).toContain('restoreIds!: string[]');
    expect(backupEntity).toContain('originalRecord!: Record<string, unknown>');
    expect(backupEntity).toContain('backupId!: string | null');
    expect(backupEntity).toContain('retiredBackupId!: string | null');
    expect(backupEntity).toContain("@Index(['retiredBackupId'])");
    expect(databaseManagementModule).toContain('RetiredSchemaBackup');
    expect(databaseManagementModule).toContain('SchemaBackup,');
    expect(databaseManagementModule.indexOf('RetiredSchemaBackup')).toBeGreaterThan(
      databaseManagementModule.indexOf('SchemaBackup,'),
    );
  });

  it('keeps retired plaintext artifacts under a cleanup lifecycle authority', () => {
    expect(backupService).toContain('RetiredSchemaBackup');
    expect(backupService).toContain('retiredBackupRepository');
    expect(backupService).toContain('cleanupExpiredRetiredBackups(now)');
    expect(backupService).toContain('disposeRetiredBackupArtifact');
    expect(backupService).toContain(")).filter((backup) => backup.status !== 'expired')");
    expect(backupService).toContain('plaintextArtifactDisposition');
    expect(backupService).toContain("error.code === 'ENOENT'");
    expect(backupService).toContain('await this.retiredBackupRepository.save(backup)');
  });

  it('keeps the active schema_backups invariant strict instead of adding a plaintext exception', () => {
    expect(invariantMigration).toContain('"isEncrypted" IS DISTINCT FROM true');
    expect(invariantMigration).toContain('CHECK ("isEncrypted" IS TRUE)');
    expect(invariantMigration).not.toContain('legacy_plaintext_backup');
    expect(invariantMigration).not.toContain('retired_schema_backups');
  });

  it('keeps new backup creation fail-closed and encrypted by default', () => {
    expect(backupEntity).toContain("@Column({ type: 'boolean', default: true })");
    expect(backupService).toContain('resolveBackupEncryption(options.encrypt)');
    expect(backupService).toContain('Plaintext database backups are not allowed');
    expect(backupService).toContain("encryptionAlgorithm: ENCRYPTION_ALGORITHM");
    expect(backupService).toContain('encryptionKeyId: this.getBackupEncryptionKeyId()');
  });
});
