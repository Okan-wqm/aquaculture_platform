/**
 * Critical infra SSoT regressions.
 *
 * These checks pin the architecture-level fixes behind the remaining
 * INFRA-CRITICAL registry rows so they cannot regress into local patches.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DROPLET_COMPOSE = 'docker-compose.droplet.yml';
const SERVICE_CATALOG = 'infrastructure/deploy/service-catalog.generated.json';

function repoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

function repoJson<T>(relPath: string): T {
  return JSON.parse(repoFile(relPath)) as T;
}

function expectContainsAll(source: string, values: readonly string[]): void {
  for (const value of values) {
    expect(source).toContain(value);
  }
}

function composeServiceBlock(composeSource: string, serviceName: string): string {
  const lines = composeSource.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  if (start === -1) {
    throw new Error(`${DROPLET_COMPOSE}: service ${serviceName} not found`);
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (
      /^ {2}[A-Za-z0-9_-]+:$/.test(lines[index] ?? '') ||
      /^(volumes|networks):/.test(lines[index] ?? '')
    ) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

interface DeployCatalog {
  deploy: {
    backendImageTargets: string[];
  };
}

describe('INVARIANT (INFRA-CRITICAL-023): entity schema discipline is active', () => {
  it('the ADR-011 entity declaration invariant is active in the registry shard', () => {
    const jestConfig = repoFile('tests/invariants/jest.config.ts');
    const spec = repoFile('tests/invariants/entity-schema-declaration.spec.ts');

    expect(jestConfig).toContain("'<rootDir>/entity-schema-declaration.spec.ts'");
    expect(spec).toContain('TENANT_SCOPED_SERVICE_DIRS');
    expect(spec).toContain('CROSS_TENANT_FILENAME_PATTERNS');
    expect(spec).toContain('per-tenant entities OMIT schema');
    expect(spec).toContain('cross-tenant entities (outbox/audit/retention/compliance) DECLARE schema');
  });
});

describe('INVARIANT (INFRA-CRITICAL-024): production DDL authority is db-migrate-only', () => {
  const catalog = repoJson<DeployCatalog>(SERVICE_CATALOG);
  const compose = repoFile(DROPLET_COMPOSE);
  const runtimeBackends = catalog.deploy.backendImageTargets.filter((service) => service !== 'db-migrate');

  it('db-migrate is the only backend image with DATABASE_MIGRATIONS_RUN=true', () => {
    const dbMigrateBlock = composeServiceBlock(compose, 'db-migrate');
    expect(dbMigrateBlock).toMatch(/DATABASE_MIGRATIONS_RUN:\s*'true'/);

    for (const service of runtimeBackends) {
      const block = composeServiceBlock(compose, service);
      expect(block).toMatch(/DB_MIGRATE_AUTHORITATIVE:\s*'true'/);
      expect(block).toMatch(/DATABASE_MIGRATIONS_RUN:\s*'false'/);
    }
  });

  it('every runtime backend waits for the db-migrate success condition', () => {
    for (const service of runtimeBackends) {
      const block = composeServiceBlock(compose, service);
      expect(block).toMatch(/db-migrate:\n\s+condition:\s+service_completed_successfully/);
    }
  });

  it('the deploy workflow verifies images before mutating the droplet', () => {
    const workflow = repoFile('.github/workflows/deploy-digitalocean.yml');
    expect(workflow).toContain('verify-images:');
    expect(workflow).toContain('docker buildx imagetools inspect');
    expect(workflow).toContain('capacity-preflight:');
    expect(workflow).toContain('bash scripts/deploy/droplet-up.sh');
  });
});

describe('INVARIANT (INFRA-CRITICAL-027): farm outbox shape follows OutboxEntityBase', () => {
  const requiredColumns = [
    '"tenantId" UUID',
    '"aggregateId" UUID',
    '"nextAttemptAt" TIMESTAMPTZ',
    '"idempotencyKey" VARCHAR(255)',
    '"isDeadLettered" BOOLEAN',
    '"leasedAt" TIMESTAMPTZ',
    '"leasedBy" VARCHAR(128)',
  ] as const;

  it('legacy farm_outbox migration carries every modern outbox column', () => {
    const migration = repoFile(
      'apps/farm-service/src/database/migrations/1800200000000-CreateFarmOutboxTable.ts',
    );
    expectContainsAll(migration, requiredColumns);
  });

  it('canonical farm outbox writes target farm.outbox_events, not farm_outbox', () => {
    const entity = repoFile('apps/farm-service/src/outbox/farm-outbox.entity.ts');
    const module = repoFile('apps/farm-service/src/outbox/farm-outbox.module.ts');
    expect(entity).toContain("name: 'outbox_events'");
    expect(entity).toContain('extends OutboxEntityBase');
    expect(module).toContain('canonical farm.outbox_events');
  });

  it('runtime farm outbox wiring has no farm_outbox writer left', () => {
    const entity = repoFile('apps/farm-service/src/outbox/farm-outbox.entity.ts');
    const registry = repoFile(
      'libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-registry.ts',
    );
    expect(entity).not.toContain("name: 'farm_outbox'");
    expect(registry).toContain("outbox: { schema: 'farm', table: 'outbox_events' }");
  });
});

describe('INVARIANT (INFRA-CRITICAL-026): shared cross-tenant tables stay canonical', () => {
  it('shared schema parity invariant is active and covers the platform bootstrap writer', () => {
    const jestConfig = repoFile('tests/invariants/jest.config.ts');
    const spec = repoFile('tests/invariants/shared-schema-canonical.spec.ts');
    expect(jestConfig).toContain("'<rootDir>/shared-schema-canonical.spec.ts'");
    expect(spec).toContain('006-shared-schema-tables.sql');
    expect(spec).toContain('PROTECTED_TABLES');
    expect(spec).toContain('SHARED_SCHEMA_TABLES');
  });

  it('platform bootstrap creates the canonical shared tables in shared schema', () => {
    const bootstrap = repoFile('apps/db-migrate/src/sql/platform-bootstrap/006-shared-schema-tables.sql');
    // user_permissions retired 2026-07-12 (ADR-042, ORPHAN-HIGH-378) — stage
    // 006 must no longer create it.
    for (const table of [
      'audit_logs',
      'gdpr_data_requests',
      'user_consents',
      'access_logs',
    ] as const) {
      expect(bootstrap).toMatch(new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+shared\\.${table}`, 'i'));
    }
    // Retirement lock: recreating the retired catalog in bootstrap would
    // resurrect the parallel-RBAC drift ADR-042 removed.
    expect(bootstrap).not.toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?shared\.user_permissions/i);
  });
});

describe('INVARIANT (INFRA-CRITICAL-028): billing and alert tenant columns are UUID-compatible', () => {
  it.each([
    ['subscriptions', 'apps/billing-service/src/billing/entities/subscription.entity.ts'],
    ['invoices', 'apps/billing-service/src/billing/entities/invoice.entity.ts'],
    ['payments', 'apps/billing-service/src/billing/entities/payment.entity.ts'],
  ] as const)('%s entity declares tenant_id as uuid and keeps soft-delete columns', (_table, path) => {
    const src = repoFile(path);
    expect(src).toMatch(/@Column\(\{\s*name:\s*['"]tenant_id['"],\s*type:\s*['"]uuid['"]/s);
    expect(src).toContain("name: 'is_deleted'");
    expect(src).toContain("name: 'deleted_at'");
    expect(src).toContain("name: 'deleted_by'");
  });

  it('billing baseline creates tenant_id as uuid for subscriptions, invoices, and payments', () => {
    const baseline = repoFile('apps/billing-service/src/database/migrations/1800000000000-Baseline.ts');
    expect(baseline).toMatch(/"billing"\."subscriptions"[\s\S]*"tenant_id" uuid NOT NULL/);
    expect(baseline).toMatch(/"billing"\."invoices"[\s\S]*"tenant_id" uuid NOT NULL/);
    expect(baseline).toMatch(/"billing"\."payments"[\s\S]*"tenant_id" uuid NOT NULL/);
  });

  it('alert incident and audit entities declare tenant_id as uuid', () => {
    expect(repoFile('apps/alert-engine/src/database/entities/alert-incident.entity.ts')).toMatch(
      /@Column\(\{\s*name:\s*['"]tenant_id['"],\s*type:\s*['"]uuid['"]/s,
    );
    expect(repoFile('apps/alert-engine/src/audit/entities/audit-entry.entity.ts')).toMatch(
      /@Column\(\{\s*name:\s*['"]tenant_id['"],\s*type:\s*['"]uuid['"],\s*nullable:\s*true/s,
    );
  });

  it('alert migration chain aligns tenant_id columns to uuid in source and tenant fan-out', () => {
    const baseline = repoFile('apps/alert-engine/src/database/migrations/1800000000000-Baseline.ts');
    const align = repoFile(
      'apps/alert-engine/src/database/migrations/1800100000000-AlignAlertTenantColumnsToUuid.ts',
    );
    expect(baseline).toMatch(/"alert"\."alert_incidents"[\s\S]*"tenant_id" uuid NOT NULL/);
    expect(baseline).toMatch(/"alert"\."alert_audit_log"[\s\S]*"tenant_id" uuid/);
    expect(align).toContain("'alert_rules'");
    expect(align).toContain("'escalation_policies'");
    expect(align).toContain("'alert_history'");
  });
});

describe('INVARIANT (INFRA-CRITICAL-030): tenant migration ledgers are source-schema namespaced', () => {
  it('all tenant fan-out runners use tenantMigrationLedgerTable(sourceSchema)', () => {
    expect(repoFile('apps/db-migrate/src/main.ts')).toContain('tenantMigrationLedgerTable(sourceSchema)');
    expect(repoFile('apps/db-migrate/src/tenant-schema-provisioner.ts')).toContain(
      'tenantMigrationLedgerTable(entry.schema)',
    );
    expect(repoFile('libs/backend-common/src/database/schema-version-gate.service.ts')).toContain(
      'tenantMigrationLedgerTable(sourceSchema)',
    );
  });

  it('the SSoT helper rejects unsafe source schemas and keeps source ledgers canonical', () => {
    const helper = repoFile('libs/backend-common/src/database/migration-ledger.ts');
    expect(helper).toContain("export const MIGRATION_LEDGER_TABLE = 'migrations' as const");
    expect(helper).toContain('SAFE_SCHEMA_RE');
    expect(helper).toContain('return `${MIGRATION_LEDGER_TABLE}_${sourceSchema}`');
  });
});

describe('INVARIANT (INFRA-CRITICAL-031): HR drift is owned by db-migrate + migration harness', () => {
  it('db-migrate registry owns HR migrations and HR entity metadata', () => {
    const registry = repoFile('apps/db-migrate/src/schema-registry.ts');
    expect(registry).toMatch(/service:\s*'hr-service'[\s\S]*schema:\s*'hr'/);
    expect(registry).toContain('apps/hr-service/src/database/migrations/[0-9]*{.ts,.js}');
    expect(registry).toContain('apps/hr-service/src/**/*.entity.{ts,js}');
  });

  it('the HR drift regression harness remains in the active migration-harness suite', () => {
    const spec = repoFile('libs/migration-harness/src/__tests__/hr-drift-regression.integration.spec.ts');
    expect(spec).toContain('hr');
    expect(spec).toContain('expectNoDrift');
    expect(spec).toContain('bootPostgresContainer');
  });
});

describe('INVARIANT (INFRA-CRITICAL-029/032): admin and HR drift closure has owned gates', () => {
  it('admin-api cross-schema entities are read views and SchemaDriftValidator skips them by contract', () => {
    const jestConfig = repoFile('tests/invariants/jest.config.ts');
    const boundarySpec = repoFile('tests/invariants/admin-api-schema-boundaries.spec.ts');
    const validator = repoFile('libs/backend-common/src/database/schema-drift-validator.service.ts');
    const appModule = repoFile('apps/admin-api-service/src/app.module.ts');

    // The property is "this boundary invariant RUNS", and it used to be spelled
    // as "the config text contains this filename" — true only while shard
    // membership was an enumeration. Membership is a glob now, so the filename
    // is correctly absent and the property is unchanged; asserting the spelling
    // would have made a coverage improvement look like a coverage regression.
    // Reachability is the dormancy manifest's complement, so that is what is
    // read.
    const dormant = JSON.parse(
      repoFile('tests/invariants/invariant-reachability.dormant.json'),
    ) as Record<string, unknown>;
    expect(Object.keys(dormant)).not.toContain('admin-api-schema-boundaries.spec.ts');
    expect(boundarySpec).toContain("const WRITE_ALLOWED: ReadonlySet<string> = new Set(['admin', 'auth', 'shared'])");
    expect(boundarySpec).toContain('must declare synchronize: false');
    expect(validator).toContain('if (entity.synchronize === false)');
    expect(validator).toContain('skippedCrossSchemaReadViews');
    expect(appModule).toContain("SchemaDriftModule.forRoot({ serviceName: 'admin-api' })");
  });

  it('HR schema drift cannot close without both db-migrate metadata and migration-harness execution', () => {
    const registry = repoFile('apps/db-migrate/src/schema-registry.ts');
    const dbMigrateTsconfig = repoFile('apps/db-migrate/tsconfig.build.json');
    const project = repoFile('libs/migration-harness/project.json');
    const spec = repoFile('libs/migration-harness/src/__tests__/hr-drift-regression.integration.spec.ts');

    expect(registry).toContain("entitiesGlob: ['apps/hr-service/src/**/*.entity.{ts,js}']");
    expect(dbMigrateTsconfig).toContain('"../hr-service/src/**/*.entity.ts"');
    expect(project).toContain('"jestConfig": "libs/migration-harness/jest.config.cts"');
    expect(spec).toContain('expectNoDriftAgainst');
    expect(spec).toContain('toHaveNoDrift');
  });
});
