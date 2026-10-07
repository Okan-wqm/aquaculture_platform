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
 * This fails on a raw-SQL INSERT/UPDATE/DELETE whose target is a literal table
 * name in a schema built at runtime (`"${schemaName}".some_table`). The database
 * explorer's generic row editor names no table (`"${schema}"."${table}"`) and is
 * not matched.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_API_SRC = path.resolve(REPO_ROOT, 'apps/admin-api-service/src');

const NAMED_TENANT_TABLE_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"\$\{[A-Za-z_]+\}"\s*\.\s*"?[a-z_][a-z0-9_]*"?/i;

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

describe('INVARIANT (FARM-MEDIUM-363): admin-api never writes a named tenant-schema table', () => {
  it('detects the shape it guards against', () => {
    expect(
      NAMED_TENANT_TABLE_WRITE.test(
        'INSERT INTO "${schemaName}".water_quality_parameter_configs (id) VALUES ($1)',
      ),
    ).toBe(true);
    expect(NAMED_TENANT_TABLE_WRITE.test('DELETE FROM "${schema}"."${table}" WHERE id = $1')).toBe(
      false,
    );
  });

  it('finds no such write in admin-api source', () => {
    const offenders = sourceFiles(ADMIN_API_SRC).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => NAMED_TENANT_TABLE_WRITE.test(line))
        .map(({ index }) => `${path.relative(REPO_ROOT, file)}:${index + 1}`),
    );
    expect(offenders).toEqual([]);
  });
});
