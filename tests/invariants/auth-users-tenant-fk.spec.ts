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

import { migrationCorpus } from './lib/migration-corpus';

describe('INVARIANT (DBR-HIGH-002): auth.users.tenantId has a FOREIGN KEY to auth.tenants(id)', () => {
  it('a migration declares the FK with ON DELETE RESTRICT', () => {
    // THE EVIDENCE SET IS THE POINT. This used to be
    // `git ls-files 'apps/auth-service/src/migrations/*.ts'`, and a git
    // pathspec `*` crosses `/` — so it returned all 32 files including the 13
    // under `.archive/`. The 2026-05-18 squash left the constraint ONLY there,
    // and this assertion passed for months against a migration the runtime
    // never applies. The corpus is the set the runtime's own glob selects.
    const aggregate = migrationCorpus('auth-service').source;

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
    // Asserted over the effective set rather than one filename. Pinning a
    // filename is what turned the squash into an ENOENT that named a file
    // instead of a report that the pre-flight was gone.
    const src = migrationCorpus('auth-service').source;
    // Pre-flight detects orphan rows before applying the constraint
    // (cannot add an FK over rows that already violate it). The shape
    // is specific enough that a future maintainer who deletes the
    // pre-flight gets a CI fail with a clear pointer to add it back.
    expect(src).toMatch(/LEFT JOIN auth\.tenants/i);
    expect(src).toMatch(/orphan/i);
    expect(src).toMatch(/throw new Error\(/);
  });
});
