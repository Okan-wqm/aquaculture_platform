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
mkdirSync(join(workspace, 'libs/backend-common/src/database'), { recursive: true });
mkdirSync(join(workspace, 'apps/farm-service/src/database/migrations'), { recursive: true });

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
writeFileSync(
  join(workspace, 'libs/backend-common/src/database/schema-manager.service.ts'),
  `
    export const MODULE_SCHEMAS = [
      {
        moduleName: 'farm',
        sourceSchema: 'farm',
        strictOwnership: true,
        infrastructureTables: ['migrations'],
        referenceDataTables: ['code_sequences'],
        tables: ['schema_entities', 'missing_schema_entities']
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
assert.equal(output.observations.filter((item) => item.type === 'typeorm_entity').length, 4);
assert.equal(
  output.findings.some((finding) => finding.rule === 'typeorm_entity_schema_required'),
  true,
);
assert.deepEqual(
  output.findings
    .filter((finding) => finding.rule === 'typeorm_entity_schema_required')
    .map((finding) => finding.path)
    .sort(),
  ['apps/farm-service/src/bad/dynamic.entity.ts', 'apps/farm-service/src/bad/missing.entity.ts'],
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

console.log('typeorm-entity-schema-adapter tests passed');
