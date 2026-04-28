/**
 * Platform-wide invariant — DBR-HIGH-002:
 *
 * `auth.users.tenantId` MUST have a FOREIGN KEY referencing
 * `auth.tenants(id)` with `ON DELETE RESTRICT` so a tenant cannot be
 * deleted while user rows still claim it.
 *
 * # Why
 *
 * Pre-fix the column was a bare `uuid` with no referential integrity.
 * Tenant deletion left orphan user rows whose tenantId pointed at a
 * non-existent tenant — a future tenant with the recycled UUID would
 * unexpectedly inherit them, and the MT-CRITICAL-001 application-layer
 * cure (W0.F) had no DB-level backstop. This invariant guards the FK
 * declaration so a future migration cannot silently drop it.
 *
 * Source-only check; verifies the migration file declares the
 * constraint exactly as W0.F-followup landed it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('INVARIANT (DBR-HIGH-002): auth.users.tenantId has a FOREIGN KEY to auth.tenants(id)', () => {
  it('a migration declares the FK with ON DELETE RESTRICT', () => {
    const migrationFiles = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', 'apps/auth-service/src/migrations/*.ts'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(migrationFiles.length).toBeGreaterThan(0);

    const aggregate = migrationFiles
      .map((rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8'))
      .join('\n---\n');

    // The migration MUST declare the FK with the canonical constraint
    // name + REFERENCES + ON DELETE RESTRICT. The regex is shape-
    // specific to each clause to catch a regression that drops any one
    // (e.g., omits ON DELETE → the default NO ACTION which is weaker).
    expect(aggregate).toMatch(
      /ADD CONSTRAINT\s+"?FK_auth_users_tenantId"?\s+FOREIGN KEY\s*\(\s*"?tenantId"?\s*\)/i,
    );
    expect(aggregate).toMatch(/REFERENCES\s+auth\.tenants\s*\(\s*"?id"?\s*\)/i);
    expect(aggregate).toMatch(/ON DELETE\s+RESTRICT/i);
  });

  it('the migration runs an orphan pre-flight check before adding the FK', () => {
    const file = resolve(
      REPO_ROOT,
      'apps/auth-service/src/migrations/1787200000000-AddAuthUsersTenantFk.ts',
    );
    const src = readFileSync(file, 'utf8');
    // Pre-flight detects orphan rows before applying the constraint
    // (cannot add an FK over rows that already violate it). The shape
    // is specific enough that a future maintainer who deletes the
    // pre-flight gets a CI fail with a clear pointer to add it back.
    expect(src).toMatch(/LEFT JOIN auth\.tenants/i);
    expect(src).toMatch(/orphan/i);
    expect(src).toMatch(/throw new Error\(/);
  });
});
