/**
 * Platform-wide invariant — SSOT-H-06:
 *
 * The backend has ONE canonical role vocabulary. hr-service used to ship its own
 * `export enum Role` + `export class RolesGuard` (strict, hierarchy-less) that
 * paired with the canonical `@Roles()` decorator and silently denied SUPER_ADMIN.
 * That fork is deleted; this invariant forbids any backend service from
 * re-introducing a second `Role` enum or `RolesGuard` class.
 *
 * Scope is the BACKEND only (apps/ libs/ platform/). The role hierarchy itself has
 * one owner for the backend and the web alike, the shared-contracts platform roles
 * (role-hierarchy-single-owner.spec.ts, RBAC-MEDIUM-024); the mobile PWA's former
 * `ROLE_RANK` mirror is gone. The Rust SCADA operator vocabulary (sens-api-gateway)
 * is a different vocabulary and lives outside this path scope.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const CANONICAL_ROLE_ENUM = 'libs/backend-common/src/decorators/roles.decorator.ts';
const CANONICAL_ROLES_GUARD = 'libs/backend-common/src/guards/roles.guard.ts';

/** Backend production .ts files matching the pattern (excludes tests + non-backend trees). */
function backendDeclarations(pattern: string): string[] {
  let out = '';
  try {
    out = execFileSync('git', ['-C', REPO_ROOT, 'grep', '-l', '-E', pattern], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    // git grep exits 1 when there are no matches — treat as empty.
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter(
      (f) =>
        /^(apps|libs|platform)\/.*\.ts$/.test(f) &&
        !f.includes('/__tests__/') &&
        !f.endsWith('.spec.ts') &&
        !f.endsWith('.test.ts'),
    );
}

describe('INVARIANT (SSOT-H-06): single canonical backend role vocabulary', () => {
  it('declares `export enum Role` in exactly ONE backend file (the canonical decorator)', () => {
    expect(backendDeclarations('export enum Role\\b')).toEqual([CANONICAL_ROLE_ENUM]);
  });

  it('declares `export class RolesGuard` in exactly ONE backend file (the canonical guard)', () => {
    expect(backendDeclarations('export class RolesGuard\\b')).toEqual([CANONICAL_ROLES_GUARD]);
  });
});
