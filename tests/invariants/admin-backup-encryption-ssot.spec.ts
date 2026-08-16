import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ADMIN_SOURCE_ROOT = resolve(REPO_ROOT, 'apps/admin-api-service/src');
const FRONTEND_SOURCE_ROOT = resolve(REPO_ROOT, 'web/modules/admin-panel/src');
const BACKUP_CONTROLLER = resolve(
  ADMIN_SOURCE_ROOT,
  'database-management/controllers/backup.controller.ts',
);
const BACKUP_SERVICE = resolve(
  ADMIN_SOURCE_ROOT,
  'database-management/services/backup-restore.service.ts',
);
const DATABASE_MANAGEMENT_MODULE = resolve(
  ADMIN_SOURCE_ROOT,
  'database-management/database-management.module.ts',
);
const RETIREMENT_MIGRATION = resolve(
  ADMIN_SOURCE_ROOT,
  'migrations/1800750000000-RetirePlaintextSchemaBackups.ts',
);
const MANIFEST = resolve(
  REPO_ROOT,
  'docs/evidence/admin-http-contracts/admin-route-contract-manifest.generated.json',
);

const RETIRED_RUNTIME_PATTERNS = Object.freeze([
  /\bBackupRestoreService\b/u,
  /\b(?:SchemaBackup|RetiredSchemaBackup|SchemaRestore)\b/u,
  /\bpg_dump\b/u,
  /\bBACKUP_BASE_PATH\b/u,
  /\/database\/backups(?:\/|\b)/u,
  /\bSUPERSEDED_PENDING_RETIREMENT\b/u,
  /\bpointInTimeRecovery\b/u,
  /\b(?:runDailyBackups|runWeeklyBackups|cleanupExpiredBackups)\b/u,
  /\/backups\/schemas/u,
  /\blastBackupAt\b/u,
  /\btenant_deprovision\b/u,
]);

function activeTypeScriptFiles(root: string): readonly string[] {
  return readdirSync(root).flatMap((entry) => {
    const absolute = resolve(root, entry);
    if (statSync(absolute).isDirectory()) {
      if (['__tests__', 'generated', 'migrations'].includes(entry)) return [];
      return activeTypeScriptFiles(absolute);
    }
    if (!/\.tsx?$/u.test(entry) || /\.(?:spec|test)\.tsx?$/u.test(entry)) return [];
    return [absolute];
  });
}

function runtimeViolations(): readonly string[] {
  return [
    ...activeTypeScriptFiles(ADMIN_SOURCE_ROOT),
    ...activeTypeScriptFiles(FRONTEND_SOURCE_ROOT),
  ].flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return RETIRED_RUNTIME_PATTERNS.flatMap((pattern) =>
      pattern.test(source) ? [`${relative(REPO_ROOT, file)}:${pattern.source}`] : [],
    );
  });
}

describe('admin backup runtime retirement authority', () => {
  it('physically removes the local controller and pg_dump service', () => {
    expect(existsSync(BACKUP_CONTROLLER)).toBe(false);
    expect(existsSync(BACKUP_SERVICE)).toBe(false);
    expect(runtimeViolations()).toEqual([]);
  });

  it('registers no local backup entity, provider, controller, or export', () => {
    const moduleSource = readFileSync(DATABASE_MANAGEMENT_MODULE, 'utf8');

    expect(moduleSource).not.toMatch(
      /BackupController|BackupRestoreService|SchemaBackup|RetiredSchemaBackup|SchemaRestore/u,
    );
  });

  it('projects an exact generated route set with no backup compatibility lifecycle', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      readonly routes: readonly { readonly id: string; readonly lifecycle: string }[];
      readonly serverRequestRuntimeProjection: {
        readonly lifecycleExceptions: readonly {
          readonly id: string;
          readonly lifecycle: string;
        }[];
      };
    };

    expect(manifest.routes.filter((route) => route.id.includes('/database/backups'))).toEqual([]);
    expect([...new Set(manifest.routes.map((route) => route.lifecycle))].sort()).toEqual([
      'ACTIVE',
      'INTERNAL_GATEWAY_ONLY',
    ]);
    expect(manifest.serverRequestRuntimeProjection.lifecycleExceptions).toEqual(
      manifest.routes
        .filter((route) => route.lifecycle !== 'ACTIVE')
        .map((route) => ({ id: route.id, lifecycle: route.lifecycle })),
    );
  });

  it('keeps legacy plaintext retirement as immutable migration history only', () => {
    const migration = readFileSync(RETIREMENT_MIGRATION, 'utf8');

    expect(migration).toContain('RetirePlaintextSchemaBackups1800750000000');
    expect(migration).toContain('DELETE FROM "admin"."schema_backups"');
    expect(migration).toContain('ON CONFLICT ("backupId") DO NOTHING');
  });
});
