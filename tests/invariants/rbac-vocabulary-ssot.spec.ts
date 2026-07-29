/**
 * Platform-wide invariant — SSOT-H-06:
 *
 * The backend has ONE canonical role vocabulary. hr-service used to ship its own
 * `export enum Role` + `export class RolesGuard` (strict, hierarchy-less) that
 * paired with the canonical `@Roles()` decorator and silently denied SUPER_ADMIN.
 * That fork is deleted; this invariant forbids any backend service from
 * re-introducing a second `Role` enum or `RolesGuard` class.
 *
 * Scope is the BACKEND only (apps/ libs/ platform/). The aquaculture-mobile PWA's
 * deliberate offline `ROLE_RANK` mirror (web/apps/aquamobil/src/utils/role-rank.ts)
 * and the Rust SCADA operator vocabulary (sens-api-gateway) are intentionally
 * separate and live outside this path scope.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const CANONICAL_ROLE_ENUM = 'libs/backend-common/src/decorators/roles.decorator.ts';
const CANONICAL_ROLES_GUARD = 'libs/backend-common/src/guards/roles.guard.ts';

// APA-050 — the role vocabulary's definition sites. There used to be three; the
// admin panel's hand-written mirror is gone, so there are two, and the third is
// GENERATED from the contract by tools/codegen/admin-contracts.
const CONTRACT_ROLES_FILE = 'libs/event-contracts/src/roles.ts';
const FE_ROLES_FILE = 'web/modules/admin-panel/src/services/types/users.ts';
const GENERATED_CONTRACTS =
  'web/modules/admin-panel/src/services/types/generated/admin-contracts.ts';

function readRepo(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/** String VALUES of the canonical `export enum Role { X = 'X', ... }`. */
function canonicalRoleEnumValues(): string[] {
  const body = /export enum Role\s*\{([\s\S]*?)\}/.exec(readRepo(CANONICAL_ROLE_ENUM))?.[1];
  if (body == null) {
    throw new Error(`Role enum not found in ${CANONICAL_ROLE_ENUM}`);
  }
  return Array.from(body.matchAll(/=\s*'([^']+)'/g), (m) => m[1]!);
}

/**
 * Members of an `export const <NAME> = [ '...', ... ] as const` tuple literal.
 *
 * Accepts either quote style: the backend writes single quotes, the generator
 * emits JSON-quoted values.
 */
function constTupleMembers(rel: string, name: string): string[] {
  const body = new RegExp(
    `export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`,
    'm',
  ).exec(readRepo(rel))?.[1];
  if (body == null) {
    throw new Error(`${name} tuple not found in ${rel}`);
  }
  return Array.from(body.matchAll(/['"]([^'"]+)['"]/g), (m) => m[1]!);
}

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

/**
 * Platform-wide invariant — APA-050:
 *
 * The role vocabulary is declared in three places that cannot share a single
 * literal (the backend `Role` enum, the cross-service `PLATFORM_ROLE_CODES`
 * contract, and the federated FE mirror that cannot import backend libs). This
 * guard holds them member-for-member identical, bans the retired phantom
 * vocabulary (MANAGER/OPERATOR/VIEWER/SUPERVISOR) from production code, and
 * closes the SSOT-H-06 evasion where a role-shaped enum hides under a different
 * name in admin-api's external entities.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/users-roles.md#APA-050
 */
describe('INVARIANT (APA-050): role vocabulary is one set across BE enum, contract, and FE mirror', () => {
  const canonical = [...canonicalRoleEnumValues()].sort();

  it('the canonical Role enum carries exactly the 4-role platform vocabulary', () => {
    expect(canonical).toEqual(
      ['MODULE_MANAGER', 'MODULE_USER', 'SUPER_ADMIN', 'TENANT_ADMIN'].sort(),
    );
  });

  it('PLATFORM_ROLE_CODES (event-contracts) is member-for-member equal to the Role enum', () => {
    expect([...constTupleMembers(CONTRACT_ROLES_FILE, 'PLATFORM_ROLE_CODES')].sort()).toEqual(
      canonical,
    );
  });

  it('the admin panel derives the vocabulary instead of mirroring it', () => {
    // This used to compare a hand-written FE `PLATFORM_ROLES` tuple to the enum.
    // There is no FE tuple any more: `tools/codegen/admin-contracts` emits the
    // contract's `as const` arrays into the panel's tree and `types/users.ts`
    // re-exports them under the names its call sites already use. A parity
    // comparison needs two declarations; there is one.
    const feRoles = readRepo(FE_ROLES_FILE);
    expect(feRoles).not.toMatch(/export const PLATFORM_ROLES\s*=\s*\[/);
    expect(feRoles).toMatch(
      /export \{\s*PLATFORM_ROLE_CODES as PLATFORM_ROLES,\s*INVITABLE_ROLE_CODES\s*\}/,
    );
  });

  it('the generated vocabulary carries exactly the canonical members', () => {
    // Codegen staleness is caught by `admin-contracts-generated`; a WRONG
    // emission is not, and this is a vocabulary that decides what an operator
    // is allowed to do.
    expect([...constTupleMembers(GENERATED_CONTRACTS, 'PLATFORM_ROLE_CODES')].sort()).toEqual(
      canonical,
    );
    expect([...constTupleMembers(GENERATED_CONTRACTS, 'INVITABLE_ROLE_CODES')].sort()).toEqual(
      canonical.filter((r) => r !== 'SUPER_ADMIN'),
    );
  });

  it('INVITABLE_ROLE_CODES is the canonical set minus the platform-level SUPER_ADMIN', () => {
    expect([...constTupleMembers(CONTRACT_ROLES_FILE, 'INVITABLE_ROLE_CODES')].sort()).toEqual(
      canonical.filter((r) => r !== 'SUPER_ADMIN'),
    );
  });
});

describe('INVARIANT (APA-050): no retired phantom role literal survives in production code', () => {
  /**
   * Word-boundary quoted match: the quote must sit immediately against the
   * word, so `'MODULE_MANAGER'` (canonical) does NOT trip on `'MANAGER'`.
   * Scope is production `.ts`/`.tsx` under apps/, libs/, and the admin-panel;
   * tests legitimately reference the retired literals as rejection cases.
   */
  function quotedPhantomHits(): string[] {
    let out = '';
    try {
      out = execFileSync(
        'git',
        [
          '-C',
          REPO_ROOT,
          'grep',
          '-n',
          '-E',
          `['"](MANAGER|OPERATOR|VIEWER|SUPERVISOR)['"]`,
          '--',
          'apps',
          'libs',
          'web/modules/admin-panel',
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
    } catch {
      // git grep exits 1 with no matches — the clean state.
      return [];
    }
    return out
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        const file = line.slice(0, line.indexOf(':'));
        return (
          (file.endsWith('.ts') || file.endsWith('.tsx')) &&
          !file.includes('/__tests__/') &&
          !file.endsWith('.spec.ts') &&
          !file.endsWith('.test.ts') &&
          !file.endsWith('.spec.tsx') &&
          !file.endsWith('.test.tsx')
        );
      });
  }

  it('finds no quoted MANAGER/OPERATOR/VIEWER/SUPERVISOR role literal', () => {
    expect(quotedPhantomHits()).toEqual([]);
  });
});

describe('INVARIANT (APA-050): no role-shaped enum hides under a different name in admin-api', () => {
  /**
   * Closes the SSOT-H-06 evasion: the deleted `analytics/.../user.entity.ts`
   * `UserRole` enum duplicated the role vocabulary under a name the
   * `export enum Role` grep never saw. Any admin-api enum sharing ≥2 members
   * with the canonical role set is a second role vocabulary and is banned.
   */
  it('no admin-api enum shares ≥2 members with the canonical Role vocabulary', () => {
    const canonicalSet = new Set(canonicalRoleEnumValues());
    let listed = '';
    try {
      listed = execFileSync(
        'git',
        ['-C', REPO_ROOT, 'grep', '-l', '-E', 'export enum ', '--', 'apps/admin-api-service/src'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
    } catch {
      listed = '';
    }
    const files = listed
      .split('\n')
      .filter(Boolean)
      .filter((f) => f.endsWith('.ts') && !f.includes('/__tests__/') && !f.endsWith('.spec.ts'));

    const offenders: string[] = [];
    for (const f of files) {
      const src = readRepo(f);
      for (const m of src.matchAll(/export enum (\w+)\s*\{([\s\S]*?)\}/g)) {
        const values = Array.from(m[2]!.matchAll(/'([^']+)'/g), (mm) => mm[1]!);
        const overlap = values.filter((v) => canonicalSet.has(v));
        if (overlap.length >= 2) {
          offenders.push(`${f} :: export enum ${m[1]} (shares ${overlap.join(', ')})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
