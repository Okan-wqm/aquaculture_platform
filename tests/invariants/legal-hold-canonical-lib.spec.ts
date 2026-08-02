/**
 * Platform-wide invariant — LEGAL-CRITICAL-001..003 / LEGAL-HIGH-002..006:
 *
 * The canonical legal-hold registry MUST exist at
 * `libs/backend-common/src/compliance/legal-hold/` and expose the
 * minimum surface every consumer expects.
 *
 * # Why
 *
 * Pre-fix the only working LegalHoldService lived in
 * apps/messaging-service/ and was scoped to messaging only. The
 * audit captured 6+ destructive paths (DROP SCHEMA CASCADE, GDPR
 * erasure cascade, retention sweep, outbox GC) that had no canonical
 * guard to consult. CIRCUIT-CRITICAL-004 had the same shape for
 * resilience; this invariant mirrors that gate for legal-hold.
 *
 * The destructive-path closures (W2.7) cite this library — without it,
 * those closures cannot land. This invariant guards the surface.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrationCorpus } from './lib/migration-corpus';

const REPO_ROOT = resolve(__dirname, '..', '..');
const LIB_BARREL = 'libs/backend-common/src/compliance/legal-hold/index.ts';
const COMPLIANCE_BARREL = 'libs/backend-common/src/compliance/index.ts';

const REQUIRED_VALUE_EXPORTS = [
  'LegalHoldEntity',
  'LegalHoldService',
  'LegalHoldModule',
  'LegalHoldActiveError',
  'LEGAL_HOLD_CACHE_CLIENT',
  'HOLD_SCOPES',
];

const REQUIRED_TYPE_EXPORTS = [
  'HoldScope',
  'LegalHoldRecord',
  'LegalHoldCacheClient',
];

describe('INVARIANT (LEGAL-CRITICAL-001): canonical LegalHold registry library', () => {
  it('the canonical lib exists at libs/backend-common/src/compliance/legal-hold/', () => {
    const tsFiles = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files',
       'libs/backend-common/src/compliance/legal-hold/*.ts'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(tsFiles).toContain(LIB_BARREL);
    expect(tsFiles).toContain('libs/backend-common/src/compliance/legal-hold/legal-hold.entity.ts');
    expect(tsFiles).toContain('libs/backend-common/src/compliance/legal-hold/legal-hold.service.ts');
    expect(tsFiles).toContain('libs/backend-common/src/compliance/legal-hold/legal-hold.module.ts');
    expect(tsFiles).toContain('libs/backend-common/src/compliance/legal-hold/legal-hold.types.ts');
  });

  it('the barrel re-exports the required public surface', () => {
    const src = readFileSync(resolve(REPO_ROOT, LIB_BARREL), 'utf8');
    for (const name of REQUIRED_VALUE_EXPORTS) {
      expect(src).toMatch(new RegExp(`export\\s+\\{[^}]*\\b${name}\\b`));
    }
    for (const name of REQUIRED_TYPE_EXPORTS) {
      expect(src).toMatch(new RegExp(`export\\s+type\\s+\\{[^}]*\\b${name}\\b`));
    }
  });

  it('the compliance subtree barrel re-exports legal-hold', () => {
    const src = readFileSync(resolve(REPO_ROOT, COMPLIANCE_BARREL), 'utf8');
    expect(src).toMatch(/from\s+['"]\.\/legal-hold['"]/);
  });

  it('the canonical service has unit-test coverage', () => {
    const tests = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files',
       'libs/backend-common/src/compliance/legal-hold/__tests__/*.spec.ts'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(tests).toContain('libs/backend-common/src/compliance/legal-hold/__tests__/legal-hold.service.spec.ts');
  });

  it('the migration that creates compliance.legal_holds is registered', () => {
    const migration = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files',
       'apps/admin-api-service/src/migrations/1787500000000-CreateComplianceLegalHolds.ts'],
      { encoding: 'utf8' },
    ).trim();
    expect(migration).toBe('apps/admin-api-service/src/migrations/1787500000000-CreateComplianceLegalHolds.ts');

    // The migration must be one the service ACTUALLY APPLIES.
    //
    // This asserted that the class NAME appears in admin-api's app.module.ts —
    // true only while that service registered migrations as an explicit import
    // list. It registers a glob (`migrations/[0-9]*{.ts,.js}`), so the name is
    // correctly absent and the migration is correctly registered. Asserting the
    // spelling reports a service that moved to the safer registration form as a
    // regression, and the obvious way to silence it is to add a redundant
    // hand-maintained list — the wrong direction.
    //
    // The corpus is the set that glob selects, so membership in it IS
    // registration. It also excludes `.archive/`, which is what makes this a
    // real check: the same file exists there, retired (ORPHAN-CRITICAL-516).
    expect(migrationCorpus('admin-api-service').files).toContain(
      'apps/admin-api-service/src/migrations/1787500000000-CreateComplianceLegalHolds.ts',
    );
  });

  it('the compliance event-contract family includes the 3 lifecycle events', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'libs/event-contracts/src/compliance-events.ts'),
      'utf8',
    );
    expect(src).toMatch(/export interface LegalHoldAppliedEvent\b/);
    expect(src).toMatch(/export interface LegalHoldReleasedEvent\b/);
    expect(src).toMatch(/export interface LegalHoldExpiredEvent\b/);
    expect(src).toMatch(/export type ComplianceEvent\b/);
  });
});
