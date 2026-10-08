import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * INVARIANT (FARM-MEDIUM-363): admin-api-service never writes a named table in
 * a tenant schema.
 *
 * A tenant schema's tables belong to the service whose entities live there.
 * Admin provisioning used to seed farm's `water_quality_parameter_configs` with
 * its own list, beside farm's onboarding seeder, so the table had two writers
 * and two default sets. Admin now publishes `TenantOnboardingRequested` and the
 * owning service seeds its own tables.
 *
 * This fails on:
 * - a raw-SQL INSERT/UPDATE/DELETE/TRUNCATE whose target is a literal table in
 *   a schema built at runtime — any interpolation (`${schemaName}`,
 *   `${record.schemaName}`, `${schemaOf(id)}`), quoted or not, with a prefix
 *   (`tenant_${hex}`) or not, and across line breaks;
 * - a search_path set from a runtime value, which would let an unqualified
 *   write land in a tenant schema. The one such setter is the explorer's EXPLAIN,
 *   inside a READ ONLY transaction (DYNAMIC_SEARCH_PATH_ALLOWED).
 *
 * The database explorer's generic row editor names no table
 * (`"${schema}"."${table}"`) and is not matched.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_API_SRC = path.resolve(REPO_ROOT, 'apps/admin-api-service/src');

const RUNTIME_SCHEMA = String.raw`"?[A-Za-z0-9_]*\$\{[^}]+\}[A-Za-z0-9_]*"?`;
const NAMED_TENANT_TABLE_WRITE = new RegExp(
  String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+` +
    RUNTIME_SCHEMA +
    String.raw`\s*\.\s*(?!"?\$\{)"?[a-z_][a-z0-9_]*"?`,
  'gi',
);
const DYNAMIC_SEARCH_PATH = /search_path\s*(?:TO|=)\s*[^;`]*?\$\{/gi;
const DYNAMIC_SEARCH_PATH_ALLOWED = new Set([
  'apps/admin-api-service/src/database-management/services/database-monitoring.service.ts',
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'migrations') continue;
      out.push(...sourceFiles(abs));
    } else if (entry.isFile() && abs.endsWith('.ts') && !abs.endsWith('.spec.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/** The 1-based lines of every match of `pattern` in `text` (matches may span lines). */
function matchLines(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => text.slice(0, match.index).split('\n').length);
}

const writes = (sql: string): boolean => matchLines(sql, NAMED_TENANT_TABLE_WRITE).length > 0;

describe('INVARIANT (FARM-MEDIUM-363): admin-api never writes a named tenant-schema table', () => {
  it('detects every shape it guards against', () => {
    expect(writes('INSERT INTO "${schemaName}".water_quality_parameter_configs (id)')).toBe(true);
    expect(writes('INSERT INTO "${schemaRecord.schemaName}".water_quality_parameter_configs')).toBe(
      true,
    );
    expect(writes('UPDATE "${getTenantSchemaName(id)}".tanks SET x = 1')).toBe(true);
    expect(writes('DELETE FROM ${schema}.tanks WHERE id = $1')).toBe(true);
    expect(writes('TRUNCATE "tenant_${hex}".sensor_metrics')).toBe(true);
    expect(writes('INSERT INTO\n  "${schemaName}"\n  .water_quality_parameter_configs')).toBe(true);
    expect(writes('DELETE FROM "${schema}"."${table}" WHERE id = $1')).toBe(false);
    expect(writes('UPDATE admin.tenant_records SET x = 1')).toBe(false);
    expect(matchLines('SET LOCAL search_path TO "${schemaName}"', DYNAMIC_SEARCH_PATH)).toEqual([
      1,
    ]);
  });

  it('finds no such write in admin-api source', () => {
    const offenders = sourceFiles(ADMIN_API_SRC).flatMap((file) => {
      const relative = path.relative(REPO_ROOT, file);
      const text = readFileSync(file, 'utf8');
      const searchPaths = DYNAMIC_SEARCH_PATH_ALLOWED.has(relative)
        ? []
        : matchLines(text, DYNAMIC_SEARCH_PATH);
      return [...matchLines(text, NAMED_TENANT_TABLE_WRITE), ...searchPaths].map(
        (line) => `${relative}:${line}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it('keeps its search_path allowance pointed at a setter that still exists', () => {
    for (const file of DYNAMIC_SEARCH_PATH_ALLOWED) {
      const text = readFileSync(path.resolve(REPO_ROOT, file), 'utf8');
      expect({ file, setters: matchLines(text, DYNAMIC_SEARCH_PATH).length }).toEqual({
        file,
        setters: 1,
      });
      expect(text).toContain('BEGIN TRANSACTION READ ONLY');
    }
  });
});
