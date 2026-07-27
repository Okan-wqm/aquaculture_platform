/**
 * Tenant schema routing architecture invariants.
 *
 * WHY: farm-service uses schema-per-tenant routing through PostgreSQL
 * search_path. Tenant-owned entities must not pin `schema: 'farm'`, because
 * explicit schema-qualified SQL bypasses TenantConnectionBootstrap and can
 * write/read source-schema data instead of the current tenant schema.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../');

const SOURCE_SCHEMA_ENTITY_ALLOWLIST = new Set([
  // Shared infrastructure queue. It is intentionally source-schema scoped
  // and excluded from tenant schema provisioning.
  path.normalize('outbox/farm-outbox.entity.ts'),
  // W5 saat/takvim altyapısı: ikisi de CROSS-TENANT ledger'dır (tenantId ile
  // ayrışır, tenant şemalarına klonlanmaz — MODULE_SCHEMAS['farm']
  // .infrastructureTables), bu yüzden `schema: 'farm'` bildirmeleri DOĞRUdur.
  path.normalize('feeding-protocol/entities/tenant-localization.entity.ts'),
  path.normalize('feeding-protocol/entities/feeding-job-run.entity.ts'),
]);

function findEntityFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        files.push(...findEntityFiles(fullPath));
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.entity.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('Tenant schema routing architecture', () => {
  it('keeps tenant-owned entities unqualified so search_path controls tenant isolation', () => {
    const violations = findEntityFiles(SRC_ROOT)
      .map((file) => ({
        absolutePath: file,
        relativePath: path.normalize(path.relative(SRC_ROOT, file)),
        content: fs.readFileSync(file, 'utf-8'),
      }))
      .filter(({ relativePath }) => !SOURCE_SCHEMA_ENTITY_ALLOWLIST.has(relativePath))
      .filter(({ content }) => /@Entity\([^)]*schema:\s*'farm'/.test(content))
      .map(({ relativePath }) => relativePath);

    expect(violations).toEqual([]);
  });
});
