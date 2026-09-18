/**
 * Cross-language golden vectors (Task 3, SENSOR-CRITICAL-089).
 *
 * Reads the SAME fixture the Rust crate's integration test
 * (crates/tenant-context/tests/schema-golden.rs) includes verbatim, and
 * asserts the TypeScript SSoT (`getTenantSchemaName`) maps every UUID to
 * the identical `tenant_<16-hex>` schema. The sidecar's Rust
 * `SchemaName::from_tenant_id` previously derived the full 32-hex form —
 * schemas NO platform scanner could see; this shared-fixture contract
 * makes that class of drift impossible to reintroduce silently.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getTenantSchemaName } from '../../libs/backend-common/src/database/tenant-schema.utils';
import { validateTenantSchemaName } from '../../libs/backend-common/src/database/schema-manager.service';

const REPO_ROOT = resolve(__dirname, '..', '..');
const GOLDEN_PATH = resolve(REPO_ROOT, 'crates', 'tenant-context', 'tests', 'schema-golden.json');

interface GoldenCase {
  tenantId: string;
  schemaName: string;
}

describe('Tenant schema golden vectors (TS ↔ Rust SSoT parity)', () => {
  const cases: GoldenCase[] = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')).map(
    (row: Record<string, string>) => ({
      tenantId: row['tenant_id'],
      schemaName: row['schema_name'],
    }),
  );

  it('the shared fixture exists and carries at least 4 vectors', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
  });

  it('the TS SSoT maps every golden UUID to the identical schema the Rust crate derives', () => {
    for (const caseRow of cases) {
      expect(getTenantSchemaName(caseRow.tenantId)).toBe(caseRow.schemaName);
      expect(validateTenantSchemaName(caseRow.schemaName)).toBe(caseRow.schemaName);
    }
  });

  it('the legacy 32-hex shape is structurally rejected by the TS validator', () => {
    expect(() => validateTenantSchemaName('tenant_550e8400e29b41d4a716446655440000')).toThrow(
      /Invalid schema name/,
    );
  });
});
