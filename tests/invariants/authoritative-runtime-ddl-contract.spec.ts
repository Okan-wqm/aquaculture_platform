import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const APP_MODULES = [
  'auth-service',
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'notification-service',
  'config-service',
  'hydroponics-service',
  'alert-engine',
  'ai-service',
  'billing-service',
  'event-store-service',
  'observability-service',
] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function appModuleSource(service: string): string {
  return stripComments(
    readFileSync(resolve(REPO_ROOT, 'apps', service, 'src/app.module.ts'), 'utf8'),
  );
}

describe('INVARIANT: authoritative deployments do not register runtime DDL bootstraps unconditionally', () => {
  it.each(APP_MODULES)('%s has no unconditional RLS DDL bootstrap flags', (service) => {
    const src = appModuleSource(service);
    expect(src).not.toMatch(/autoApply\s*:\s*true/);
    expect(src).not.toMatch(/syncTenantSchemas\s*:\s*true/);
  });

  it.each(APP_MODULES)('%s gates AuditColumnsModule behind db-migrate authority', (service) => {
    const src = appModuleSource(service);
    if (!src.includes('AuditColumnsModule.forRoot')) {
      return;
    }

    expect(src).toContain('resolveDbMigrateAuthoritative');
    expect(src).toMatch(/\?\s*\[\]\s*:\s*\[\s*AuditColumnsModule\.forRoot/);
  });

  it.each(APP_MODULES)(
    '%s gates SourceSchemaWriteGuardService provider behind db-migrate authority',
    (service) => {
      const src = appModuleSource(service);
      if (!src.includes('SourceSchemaWriteGuardService')) {
        return;
      }

      expect(src).toContain('resolveDbMigrateAuthoritative');
      expect(src).toMatch(/\?\s*\[\]\s*:\s*\[\s*SourceSchemaWriteGuardService\s*\]/);
    },
  );

  it('observability-service is schema gated and remains non-tenant-aware', () => {
    const src = appModuleSource('observability-service');
    expect(src).toContain("createSchemaVersionGate('observability'");
    expect(src).toMatch(/tenantAware\s*:\s*false/);
    expect(src).toMatch(/migrationsRunFromEnv\s*:/);
    expect(src).not.toMatch(/TenantSchemaSyncService|syncTenantSchemas\s*:/);
  });

  it('db-migrate registry owns post-migration hardening for services whose runtime DDL was disabled', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'apps/db-migrate/src/schema-registry.ts'), 'utf8');

    for (const schema of [
      'auth',
      'farm',
      'sensor',
      'hr',
      'messaging',
      'hydroponics',
      'alert',
      'notification',
      'ai',
      'config',
      'event_store',
    ]) {
      const entry = new RegExp(`schema:\\s*'${schema}'[\\s\\S]*?postMigrationHardening\\s*:`);
      expect(src).toMatch(entry);
    }
  });
});
