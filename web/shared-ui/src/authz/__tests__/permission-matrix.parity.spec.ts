/**
 * Permission-matrix parity test
 * ================================================================
 *
 * Lock: every mutation listed in the frontend `FRONTEND_MUTATION_ROLES`
 * map carries the EXACT same role set as the backend's source-of-truth
 * matrix at `apps/farm-service/src/common/authz/permission-matrix.ts`.
 *
 * # Why this test exists
 *
 * The frontend matrix is a static mirror of the backend matrix; drift
 * would mean a button renders (or hides) incorrectly vs. what the
 * backend actually allows. We'd rather get a test failure on PR than
 * a user seeing "Access denied" after clicking a button that rendered.
 *
 * # How it works
 *
 * At test time this spec reads the backend source file as text (no
 * import, no compile) and regex-extracts each mutation's role array.
 * For every mutation listed in the FRONTEND matrix it asserts:
 *   - the mutation exists in the backend matrix
 *   - the role sets are equal (set-equality, not array-order equality)
 *
 * The test does NOT require the frontend matrix to cover every backend
 * mutation — the frontend only mirrors the subset it renders gates
 * for. Backend-only entries are fine.
 *
 * # When this test fails
 *
 * 1. Read the failure message — it lists the mutation + both role
 *    sets.
 * 2. If the backend is the new truth: update
 *    `web/shared-ui/src/authz/permission-matrix.ts` to match.
 * 3. If the frontend is the new truth: that's usually a bug — update
 *    the backend instead, since the BACKEND is the source of truth
 *    for authorisation (the frontend matrix is a UX-only mirror).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  FRONTEND_MUTATION_ROLES,
  type FrontendMutationName,
} from '../permission-matrix';

/**
 * Locate the backend permission-matrix source relative to the repo
 * root. We're running from the shared-ui project; go up the tree
 * until we find `apps/farm-service/src/common/authz/permission-matrix.ts`.
 */
function findBackendMatrixPath(): string {
  // From shared-ui/src/authz/__tests__ it's up 5 levels to the repo
  // root. We accept any of the plausible CWDs vitest is invoked from
  // (repo root, nx-project root, etc.) by walking up.
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(
      dir,
      'apps/farm-service/src/common/authz/permission-matrix.ts',
    );
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      dir = resolve(dir, '..');
    }
  }
  throw new Error(
    'Could not locate apps/farm-service/src/common/authz/permission-matrix.ts ' +
      'from the test file location — is the repo layout changed?',
  );
}

/**
 * Parse the backend `MUTATION_ROLES` object literal out of the
 * source file. Returns `Map<mutationName, sortedRoleArray>`.
 *
 * We look inside the `export const MUTATION_ROLES = Object.freeze({ ... })`
 * block and capture `mutationName: [Role.X, Role.Y, ...]` entries.
 */
function parseBackendMatrix(): Map<string, string[]> {
  const source = readFileSync(findBackendMatrixPath(), 'utf8');

  // Find the MUTATION_ROLES block.
  const blockStart = source.indexOf(
    'export const MUTATION_ROLES',
  );
  if (blockStart < 0) {
    throw new Error('MUTATION_ROLES export not found in backend matrix');
  }
  const blockEnd = source.indexOf('QUERY_ROLES', blockStart);
  const block = source.slice(
    blockStart,
    blockEnd > 0 ? blockEnd : source.length,
  );

  // Match entries of the form:
  //   mutationName: [Role.MODULE_MANAGER, Role.TENANT_ADMIN],
  // across multi-line arrays too. `[\s\S]*?` is non-greedy across newlines.
  const entryRegex = /^\s*([a-zA-Z_][a-zA-Z0-9_]*):\s*\[([\s\S]*?)\],/gm;
  const result = new Map<string, string[]>();

  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(block)) !== null) {
    const mutationName = match[1]!;
    const rolesBlob = match[2]!;
    const roles = rolesBlob
      .split(',')
      .map((r) => r.trim().replace(/^Role\./, ''))
      .filter((r) => r.length > 0);
    // Dedup + sort so set-equality works regardless of backend ordering.
    result.set(mutationName, [...new Set(roles)].sort());
  }
  return result;
}

describe('frontend permission-matrix parity with backend', () => {
  const backendMatrix = parseBackendMatrix();

  it.each(
    Object.keys(FRONTEND_MUTATION_ROLES) as FrontendMutationName[],
  )('mutation "%s" has the same role set on both sides', (mutationName) => {
    const backendRoles = backendMatrix.get(mutationName);
    const frontendRoles = [
      ...new Set(FRONTEND_MUTATION_ROLES[mutationName] as readonly string[]),
    ].sort();

    if (!backendRoles) {
      throw new Error(
        `Mutation "${mutationName}" is NOT present in the backend matrix ` +
          `at apps/farm-service/src/common/authz/permission-matrix.ts — ` +
          `either the backend dropped it (remove from frontend matrix + ` +
          `FrontendMutationName union) or the name was mis-typed.`,
      );
    }

    expect({
      mutation: mutationName,
      roles: frontendRoles,
    }).toEqual({
      mutation: mutationName,
      roles: backendRoles,
    });
  });

  it('backend matrix parse is non-empty (regex sanity)', () => {
    expect(backendMatrix.size).toBeGreaterThan(50);
  });
});
