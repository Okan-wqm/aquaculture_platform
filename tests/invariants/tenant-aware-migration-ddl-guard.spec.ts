import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = join(__dirname, '..', '..');

const TENANT_AWARE_MIGRATION_DIRS = [
  'apps/farm-service/src/database/migrations',
  'apps/sensor-service/src/database/migrations',
  'apps/hr-service/src/database/migrations',
  'apps/messaging-service/src/migrations',
  'apps/messaging-service/src/database/migrations',
  'apps/alert-engine/src/database/migrations',
  'apps/ai-service/src/database/migrations',
  'apps/hydroponics-service/src/database/migrations',
] as const;

const SOURCE_SCHEMAS = ['farm', 'sensor', 'hr', 'messaging', 'alert', 'ai', 'hydroponics'];
const SOURCE_SCHEMA_PATTERN = SOURCE_SCHEMAS.join('|');
const IDENTIFIER_PATTERN = '[A-Za-z_][A-Za-z0-9_]*';
const QUALIFIED_SOURCE_OBJECT_PATTERN = `(?:"(${SOURCE_SCHEMA_PATTERN})"\\."([^"]+)"|\\b(${SOURCE_SCHEMA_PATTERN})\\.(${IDENTIFIER_PATTERN})\\b)`;
const SOURCE_SCHEMA_OBJECT_DDL_TARGET = new RegExp(
  `\\b(?:CREATE|ALTER|DROP|TRUNCATE)\\s+` +
    `(TABLE|TYPE|SEQUENCE|VIEW|MATERIALIZED\\s+VIEW)\\b[\\s\\S]{0,260}?` +
    QUALIFIED_SOURCE_OBJECT_PATTERN,
  'gi',
);
const SOURCE_SCHEMA_INDEX_ON_TARGET = new RegExp(
  `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\b[\\s\\S]{0,360}?\\bON\\s+` + QUALIFIED_SOURCE_OBJECT_PATTERN,
  'gi',
);

function infrastructureTablesBySourceSchema(): Map<string, Set<string>> {
  const src = readFileSync(
    join(REPO_ROOT, 'libs/backend-common/src/database/schema-manager.service.ts'),
    'utf8',
  );
  const bySchema = new Map<string, Set<string>>();
  const entryRe =
    /moduleName:\s*'[^']+'[\s\S]*?sourceSchema:\s*'([^']+)'[\s\S]*?infrastructureTables:\s*\[([\s\S]*?)\]/g;
  let entry: RegExpExecArray | null;
  while ((entry = entryRe.exec(src)) !== null) {
    const schema = entry[1];
    const body = entry[2];
    const tables = new Set<string>();
    const tableRe = /'([^']+)'/g;
    let table: RegExpExecArray | null;
    while ((table = tableRe.exec(body)) !== null) {
      tables.add(table[1]);
    }
    bySchema.set(schema, tables);
  }
  return bySchema;
}

function sourceSchemaDdlOffenders(src: string, infraTables: Map<string, Set<string>>): string[] {
  const offenders: string[] = [];
  SOURCE_SCHEMA_OBJECT_DDL_TARGET.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SOURCE_SCHEMA_OBJECT_DDL_TARGET.exec(src)) !== null) {
    const kind = normalizeDdlKind(match[1]);
    const { schema, objectName } = qualifiedNameFromMatch(match, 2);
    if (!isDeclaredInfrastructureObject(schema, objectName, kind, infraTables)) {
      offenders.push(`${schema}.${objectName}`);
    }
  }
  SOURCE_SCHEMA_INDEX_ON_TARGET.lastIndex = 0;
  while ((match = SOURCE_SCHEMA_INDEX_ON_TARGET.exec(src)) !== null) {
    const { schema, objectName } = qualifiedNameFromMatch(match, 1);
    const declared = infraTables.get(schema) ?? new Set<string>();
    if (!declared.has(objectName)) {
      offenders.push(`${schema}.${objectName} (index target)`);
    }
  }
  return offenders;
}

function qualifiedNameFromMatch(
  match: RegExpExecArray,
  schemaGroupStart: number,
): { schema: string; objectName: string } {
  const quotedSchema = match[schemaGroupStart];
  const quotedObject = match[schemaGroupStart + 1];
  const unquotedSchema = match[schemaGroupStart + 2];
  const unquotedObject = match[schemaGroupStart + 3];
  return {
    schema: quotedSchema ?? unquotedSchema,
    objectName: quotedObject ?? unquotedObject,
  };
}

function normalizeDdlKind(kind: string): string {
  return kind.replace(/\s+/g, ' ').toUpperCase();
}

function isDeclaredInfrastructureObject(
  schema: string,
  objectName: string,
  kind: string,
  infraTables: Map<string, Set<string>>,
): boolean {
  const declared = infraTables.get(schema) ?? new Set<string>();
  if (declared.has(objectName)) return true;

  if (kind === 'SEQUENCE') {
    for (const table of declared) {
      if (objectName === `${table}_sequence_seq`) return true;
    }
  }

  return false;
}

function migrationFiles(): string[] {
  const args = ['ls-files', ...TENANT_AWARE_MIGRATION_DIRS.map((dir) => `${dir}/[0-9]*.ts`)];
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.endsWith('1800000000000-Baseline.ts'));
}

describe('tenant-aware migration DDL guard', () => {
  it('matches only exact declared infrastructure object names', () => {
    const infraTables = new Map([['messaging', new Set(['messaging_outbox'])]]);

    expect(
      sourceSchemaDdlOffenders(
        `CREATE TABLE IF NOT EXISTS messaging.messaging_outbox_shadow ("id" uuid)`,
        infraTables,
      ),
    ).toEqual(['messaging.messaging_outbox_shadow']);
    expect(
      sourceSchemaDdlOffenders(
        `CREATE TABLE IF NOT EXISTS messaging.messaging_outbox ("id" uuid)`,
        infraTables,
      ),
    ).toEqual([]);
  });

  it('checks CREATE INDEX source-schema ownership via the exact ON table target', () => {
    const infraTables = new Map([['messaging', new Set(['messaging_outbox'])]]);

    expect(
      sourceSchemaDdlOffenders(
        `CREATE INDEX IF NOT EXISTS "idx_shadow" ON messaging.messaging_outbox_shadow ("createdAt")`,
        infraTables,
      ),
    ).toEqual(['messaging.messaging_outbox_shadow (index target)']);
    expect(
      sourceSchemaDdlOffenders(
        `CREATE INDEX IF NOT EXISTS "idx_outbox" ON messaging.messaging_outbox ("createdAt")`,
        infraTables,
      ),
    ).toEqual([]);
  });

  it('does not let later source-schema names replace the DDL target', () => {
    const infraTables = new Map([['messaging', new Set(['messaging_outbox'])]]);

    expect(
      sourceSchemaDdlOffenders(
        `
          ALTER TABLE messaging.messaging_outbox DROP COLUMN IF EXISTS "sequence";
          DROP SEQUENCE IF EXISTS messaging.messaging_outbox_sequence_seq;
        `,
        infraTables,
      ),
    ).toEqual([]);
  });

  it('new tenant-aware migrations avoid hard-coded source-schema DDL unless explicitly annotated', () => {
    const offenders: string[] = [];
    const infraTables = infrastructureTablesBySourceSchema();
    for (const file of migrationFiles()) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      const ddlOffenders = sourceSchemaDdlOffenders(src, infraTables);
      if (ddlOffenders.length === 0) continue;
      offenders.push(`${relative(REPO_ROOT, join(REPO_ROOT, file))}: ${ddlOffenders.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });
});
