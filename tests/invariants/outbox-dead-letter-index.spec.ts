/**
 * Outbox dead-letter index invariant.
 *
 * The outbox worker's queue gauges count dead-lettered rows with
 * `"publishedAt" IS NULL AND "isDeadLettered" = true`. Outbox tables keep
 * published rows for days, so without a partial index for that predicate the
 * count is a sequential scan of the whole history on every refresh. Every
 * service that owns an outbox table must therefore ship the index, through the
 * shared `buildOutboxDeadLetterIndexUpSql` builder so the predicate cannot
 * drift from the one the gauge SQL spells (`outbox-migration.spec.ts`).
 *
 * Without this check a new service's outbox entity compiles, migrates and
 * passes its unit tests, and the sequential scan only shows up as database CPU
 * once its table is large.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const APPS_DIR = join(REPO_ROOT, 'apps');

interface OutboxTable {
  readonly service: string;
  readonly schema: string;
  readonly table: string;
  readonly entityFile: string;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.archive') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** The text of the `@Entity(...)` decorator that directly precedes `extends OutboxEntityBase`. */
function entityDecoratorOf(source: string): string | null {
  const classIndex = source.search(/class\s+\w+\s+extends\s+OutboxEntityBase/);
  if (classIndex < 0) return null;
  const decoratorIndex = source.lastIndexOf('@Entity(', classIndex);
  if (decoratorIndex < 0) return null;
  return source.slice(decoratorIndex, classIndex);
}

function discoverOutboxTables(): OutboxTable[] {
  const tables: OutboxTable[] = [];
  for (const service of readdirSync(APPS_DIR)) {
    const srcDir = join(APPS_DIR, service, 'src');
    if (!statSync(join(APPS_DIR, service)).isDirectory()) continue;
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of sourceFiles(srcDir)) {
      const decorator = entityDecoratorOf(readFileSync(file, 'utf8'));
      if (decorator === null) continue;
      const table =
        /name:\s*'([^']+)'/.exec(decorator)?.[1] ?? /@Entity\(\s*'([^']+)'/.exec(decorator)?.[1];
      const schema = /schema:\s*'([^']+)'/.exec(decorator)?.[1];
      if (table === undefined || schema === undefined) {
        throw new Error(`${file}: could not read the table and schema from ${decorator.trim()}`);
      }
      tables.push({ service, schema, table, entityFile: file.replace(`${REPO_ROOT}/`, '') });
    }
  }
  return tables;
}

function migrationFiles(service: string): string[] {
  return sourceFiles(join(APPS_DIR, service, 'src')).filter((file) =>
    /\/migrations\/[^/]+\.ts$/.test(file),
  );
}

describe('outbox dead-letter index', () => {
  const tables = discoverOutboxTables();

  it('finds the outbox tables it is meant to guard', () => {
    // A floor, not an exact count: it exists so a broken discovery regex fails
    // loudly instead of letting the per-table check below pass over nothing.
    expect(tables.length).toBeGreaterThanOrEqual(13);
  });

  it.each(tables.map((t) => [`${t.schema}.${t.table}`, t] as const))(
    '%s has a migration creating its dead-letter index',
    (_qualified, outbox) => {
      const creators = migrationFiles(outbox.service).filter((file) => {
        const source = readFileSync(file, 'utf8');
        return (
          source.includes('buildOutboxDeadLetterIndexUpSql') &&
          source.includes(`schema: '${outbox.schema}'`) &&
          source.includes(`table: '${outbox.table}'`)
        );
      });

      expect({ entity: outbox.entityFile, migrations: creators.length > 0 }).toEqual({
        entity: outbox.entityFile,
        migrations: true,
      });
    },
  );
});
