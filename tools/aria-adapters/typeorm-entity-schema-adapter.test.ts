import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { analyzeTypeOrmEntities } from './typeorm-entity-schema-adapter';

const workspace = mkdtempSync(join(tmpdir(), 'aria-typeorm-adapter-'));
const root = join(workspace, 'apps/farm-service/src');
mkdirSync(join(root, 'ok'), { recursive: true });
mkdirSync(join(root, 'bad'), { recursive: true });
mkdirSync(join(root, 'tenant'), { recursive: true });
mkdirSync(join(root, 'infra'), { recursive: true });
mkdirSync(join(workspace, 'apps/billing-service/src'), { recursive: true });
mkdirSync(join(workspace, 'libs/backend-common/src/database'), { recursive: true });
mkdirSync(join(workspace, 'apps/farm-service/src/database/migrations/.archive/2026-01-01T00-00-00-000Z'), {
  recursive: true,
});

writeFileSync(
  join(root, 'ok/schema.entity.ts'),
  `
    import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
    @Entity('schema_entities', { schema: 'farm' })
    export class SchemaEntity {
      @PrimaryGeneratedColumn('uuid')
      id: string;

      @Column('uuid')
      tenantId: string;

      @Column({ type: 'text', nullable: true, name: 'display_name' })
      displayName?: string;
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'bad/missing.entity.ts'),
  `
    import { Entity } from 'typeorm';
    @Entity('missing_schema_entities')
    export class MissingSchemaEntity {}
  `,
  'utf8',
);
writeFileSync(
  join(root, 'bad/dynamic.entity.ts'),
  `
    import { Entity } from 'typeorm';
    const schemaName = 'farm';
    @Entity('dynamic_schema_entities', { schema: schemaName })
    export class DynamicSchemaEntity {}
  `,
  'utf8',
);
writeFileSync(
  join(root, 'tenant/code-sequence.entity.ts'),
  `
    import { Entity } from 'typeorm';
    @Entity('code_sequences')
    export class CodeSequence {}
  `,
  'utf8',
);
// ADR-011 TP traps: cross-tenant infrastructure tables MUST declare schema —
// one with an explicit table name, one relying on TypeORM's snake_case default.
writeFileSync(
  join(root, 'infra/outbox-event.entity.ts'),
  `
    import { Entity } from 'typeorm';
    @Entity('outbox_events')
    export class OutboxEvent {}
  `,
  'utf8',
);
writeFileSync(
  join(root, 'infra/infra-ledger.entity.ts'),
  `
    import { Entity } from 'typeorm';
    @Entity()
    export class InfraLedger {}
  `,
  'utf8',
);
// E13 FP class (2): archived entity + archived migration are dead corpus and
// must be invisible to every check.
writeFileSync(
  join(root, 'database/migrations/.archive/2026-01-01T00-00-00-000Z/archived.entity.ts'),
  `
    import { Entity } from 'typeorm';
    @Entity('archived_entities')
    export class ArchivedEntity {}
  `,
  'utf8',
);
writeFileSync(
  join(root, 'database/migrations/.archive/2026-01-01T00-00-00-000Z/1600000000000-RetiredMigration.ts'),
  `export class RetiredMigration1600000000000 {}`,
  'utf8',
);
// Platform-service control: billing is NOT tenant-scoped, so schema stays mandatory.
writeFileSync(
  join(workspace, 'apps/billing-service/src/subscription.entity.ts'),
  `
    import { Entity } from 'typeorm';
    @Entity('subscriptions')
    export class Subscription {}
  `,
  'utf8',
);
writeFileSync(
  join(workspace, 'libs/backend-common/src/database/schema-manager.service.ts'),
  `
    export const TENANT_SCOPED_MODULES: ReadonlySet<string> = new Set(['farm']);
    export const MODULE_SCHEMAS = [
      {
        moduleName: 'farm',
        sourceSchema: 'farm',
        strictOwnership: true,
        infrastructureTables: ['migrations', 'outbox_events', 'infra_ledger'],
        referenceDataTables: ['code_sequences'],
        tables: ['schema_entities', 'missing_schema_entities']
      },
      {
        moduleName: 'billing',
        sourceSchema: 'billing',
        infrastructureTables: ['migrations'],
        referenceDataTables: [],
        tables: ['subscriptions']
      }
    ];
  `,
  'utf8',
);
writeFileSync(
  join(workspace, 'apps/farm-service/src/app.module.ts'),
  `
    import { GoodMigration1780000000000 } from './database/migrations/1780000000000-GoodMigration';
    import { MissingFileMigration1781000000000 } from './database/migrations/1781000000000-MissingFileMigration';
    export const config = {
      migrations: [
        GoodMigration1780000000000,
        MissingFileMigration1781000000000,
      ],
    };
  `,
  'utf8',
);
writeFileSync(
  join(workspace, 'apps/farm-service/src/database/migrations/1780000000000-GoodMigration.ts'),
  `export class GoodMigration1780000000000 {}`,
  'utf8',
);
writeFileSync(
  join(workspace, 'apps/farm-service/src/database/migrations/1782000000000-UnregisteredMigration.ts'),
  `export class UnregisteredMigration1782000000000 {}`,
  'utf8',
);
writeFileSync(
  join(workspace, 'snapshot.json'),
  JSON.stringify(
    {
      schema: 'farm',
      tables: [
        {
          schema: 'farm',
          name: 'schema_entities',
          columns: [
            { name: 'id', dataType: 'uuid', isNullable: 'NO' },
            { name: 'tenantId', dataType: 'text', isNullable: 'YES' },
            { name: 'display_name', dataType: 'text', isNullable: 'YES' },
            { name: 'legacy_column', dataType: 'text', isNullable: 'YES' },
          ],
        },
        { schema: 'farm', name: 'missing_schema_entities', columns: [] },
      ],
    },
    null,
    2,
  ),
  'utf8',
);

const output = analyzeTypeOrmEntities(
  {
    target: 'farm-service',
    root: 'apps/farm-service/src',
    serviceName: 'farm',
    allowlist: ['apps/farm-service/src/tenant/code-sequence.entity.ts'],
    checks: ['entity_schema', 'module_schema', 'migration_registry', 'db_snapshot'],
    dbSnapshotPath: 'snapshot.json',
  },
  workspace,
);

assert.equal(output.metadata.adapter, 'typeorm-entity-schema-adapter');
assert.equal(output.observations.filter((item) => item.type === 'typeorm_entity').length, 6);
assert.equal(
  output.findings.some((finding) => finding.rule === 'typeorm_entity_schema_required'),
  true,
);
// E13 FP class (1): per-tenant tables in a tenant-scoped service (farm) omit
// `schema:` BY DESIGN (ADR-011) and are no longer findings; only the
// cross-tenant infrastructure tables (outbox_events + snake_case-defaulted
// infra_ledger) remain true positives.
assert.deepEqual(
  output.findings
    .filter((finding) => finding.rule === 'typeorm_entity_schema_required')
    .map((finding) => finding.path)
    .sort(),
  [
    'apps/farm-service/src/infra/infra-ledger.entity.ts',
    'apps/farm-service/src/infra/outbox-event.entity.ts',
  ],
);
const infraFinding = output.findings.find(
  (finding) =>
    finding.rule === 'typeorm_entity_schema_required' &&
    finding.path === 'apps/farm-service/src/infra/outbox-event.entity.ts',
);
assert.ok(infraFinding?.message.includes("infrastructureTables"), infraFinding?.message);
// The SSoT MODULE_SCHEMAS entry is cited as evidence for infra-table findings.
assert.equal(
  infraFinding?.evidence.some(
    (evidence) => evidence.path === 'libs/backend-common/src/database/schema-manager.service.ts',
  ),
  true,
);
// Archived corpus is invisible to every check (E13 FP class 2).
assert.equal(
  output.observations.some((item) => item.path?.includes('/.archive/')),
  false,
);
assert.equal(
  output.findings.some(
    (finding) => finding.path.includes('/.archive/') || finding.id.includes('RetiredMigration'),
  ),
  false,
);
assert.equal(
  output.findings.some(
    (finding) =>
      finding.rule === 'module_schema_table_missing' &&
      finding.details?.table === 'dynamic_schema_entities',
  ),
  true,
);
assert.equal(
  output.findings.some((finding) => finding.rule === 'migration_registry_missing_entry'),
  true,
);
assert.equal(
  output.findings.some((finding) => finding.rule === 'migration_registry_missing_file'),
  true,
);
assert.equal(
  output.findings.some((finding) => finding.rule === 'db_snapshot_table_missing'),
  true,
);
assert.equal(
  output.findings.some((finding) => finding.rule === 'db_snapshot_uuid_type_mismatch'),
  true,
);
assert.equal(
  output.findings.some((finding) => finding.rule === 'db_snapshot_nullability_mismatch'),
  true,
);
assert.equal(
  output.observations.some(
    (observation) =>
      observation.type === 'db_snapshot_orphan_column' && observation.column === 'legacy_column',
  ),
  true,
);
assert.ok(output.read_paths.includes('apps/farm-service/src/ok/schema.entity.ts'));
assert.ok(output.read_paths.includes('libs/backend-common/src/database/schema-manager.service.ts'));
assert.ok(output.read_paths.includes('apps/farm-service/src/app.module.ts'));
assert.ok(output.read_paths.includes('snapshot.json'));
assert.equal(output.findings.every((finding) => Array.isArray(finding.evidence)), true);
assert.equal(output.belief_candidates.length, 1);
assert.equal(
  output.belief_candidates[0]?.belief_id,
  'typeorm:farm-service:entity-schema-surface',
);
assert.ok(output.belief_candidates[0]?.evidence_refs.includes('apps/farm-service/src/**/*.ts'));

// Deliberate-break control 1: a platform-level service (billing is NOT in
// TENANT_SCOPED_MODULES) keeps the historical always-declare-schema rule.
const billingOutput = analyzeTypeOrmEntities(
  {
    target: 'billing-service',
    root: 'apps/billing-service/src',
    serviceName: 'billing',
    checks: ['entity_schema'],
  },
  workspace,
);
assert.deepEqual(
  billingOutput.findings.map((finding) => [finding.rule, finding.path]),
  [['typeorm_entity_schema_required', 'apps/billing-service/src/subscription.entity.ts']],
);
assert.equal(billingOutput.findings[0]?.details?.tenantScoped, false);

// Deliberate-break control 2: when the SSoT file is unreadable the check
// fails CLOSED — a tenant-scoped-looking service still gets flagged, so a
// broken/renamed schema-manager cannot silently disable the rule.
const bareWorkspace = mkdtempSync(join(tmpdir(), 'aria-typeorm-adapter-bare-'));
mkdirSync(join(bareWorkspace, 'apps/farm-service/src'), { recursive: true });
writeFileSync(
  join(bareWorkspace, 'apps/farm-service/src/pond.entity.ts'),
  `
    import { Entity } from 'typeorm';
    @Entity('ponds')
    export class Pond {}
  `,
  'utf8',
);
const failClosedOutput = analyzeTypeOrmEntities(
  {
    target: 'farm-service',
    root: 'apps/farm-service/src',
    serviceName: 'farm',
    checks: ['entity_schema'],
  },
  bareWorkspace,
);
assert.deepEqual(
  failClosedOutput.findings.map((finding) => finding.rule),
  ['typeorm_entity_schema_required'],
);

console.log('typeorm-entity-schema-adapter tests passed');
