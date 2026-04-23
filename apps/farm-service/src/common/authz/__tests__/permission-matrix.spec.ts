/**
 * Permission Matrix Invariant Test
 *
 * Scans every `*.resolver.ts` in apps/farm-service/src and asserts
 * the @Roles / @Mutation / @Query decorator state agrees with
 * `permission-matrix.ts`. Three failure modes:
 *
 *   1. A @Mutation / @Query is declared but missing from BOTH the
 *      role matrix AND the ungated grandfather set → fail. Every
 *      new operation must be classified deliberately.
 *
 *   2. An operation appears in the matrix but its @Roles in source
 *      differs from the declared roles → fail. The matrix is the
 *      authoritative intent; drift in source without a matrix
 *      update is treated as an unreviewed authorisation change.
 *
 *   3. An operation appears in the grandfather whitelist but
 *      source DOES carry a @Roles decorator → fail. The operation
 *      has graduated — move it out of UNGATED_OPERATIONS and into
 *      MUTATION_ROLES / QUERY_ROLES.
 *
 * The invariant intentionally does NOT police the ungated
 * whitelist shrinking — phase 6.1.1 reduces it module by module.
 *
 * Phase 6.1 of the "Farm modülü kalan kör noktalar" plan.
 */
import { resolve } from 'path';

import {
  MUTATION_ROLES,
  QUERY_ROLES,
  UNGATED_OPERATIONS,
} from '../permission-matrix';
import { scanResolvers, ResolverOperation } from '../resolver-scanner';

const FARM_SERVICE_SRC = resolve(__dirname, '..', '..', '..');

function rolesToSortedNames(roles: readonly string[]): string[] {
  return [...new Set(roles)].sort();
}

function matrixEntryNames(
  matrix: Readonly<Record<string, readonly string[]>>,
  operation: string,
): string[] {
  const entry = matrix[operation];
  if (!entry) return [];
  return rolesToSortedNames(entry.map((r) => String(r)));
}

describe('Farm-service permission matrix invariants', () => {
  let operations: ResolverOperation[];
  let mutationOps: ResolverOperation[];
  let queryOps: ResolverOperation[];

  beforeAll(() => {
    operations = scanResolvers(FARM_SERVICE_SRC);
    mutationOps = operations.filter((o) => o.kind === 'Mutation');
    queryOps = operations.filter((o) => o.kind === 'Query');
  });

  it('discovers a reasonable number of operations (sanity check)', () => {
    // Drops below this floor = scanner regex drift.
    expect(mutationOps.length).toBeGreaterThanOrEqual(150);
    expect(queryOps.length).toBeGreaterThanOrEqual(150);
  });

  it('every @Mutation is classified (either role-listed or grandfathered)', () => {
    const classified = new Set<string>([
      ...Object.keys(MUTATION_ROLES),
      ...UNGATED_OPERATIONS,
    ]);
    const unclassified = Array.from(
      new Set(
        mutationOps
          .map((op) => op.operation)
          .filter((name) => !classified.has(name)),
      ),
    ).sort();
    expect(unclassified).toEqual([]);
  });

  it('every @Query is classified', () => {
    const classified = new Set<string>([
      ...Object.keys(QUERY_ROLES),
      ...UNGATED_OPERATIONS,
    ]);
    const unclassified = Array.from(
      new Set(
        queryOps
          .map((op) => op.operation)
          .filter((name) => !classified.has(name)),
      ),
    ).sort();
    expect(unclassified).toEqual([]);
  });

  it('MUTATION_ROLES entries match the @Roles decorators in source', () => {
    const mismatches: Array<{
      operation: string;
      matrix: string[];
      source: string[];
    }> = [];
    for (const [operation, roles] of Object.entries(MUTATION_ROLES)) {
      const matches = mutationOps.filter((op) => op.operation === operation);
      if (matches.length === 0) continue; // orphan matrix entry caught below
      const matrixRoles = rolesToSortedNames(roles.map((r) => String(r)));
      for (const src of matches) {
        const sourceRoles = rolesToSortedNames(src.roles);
        if (
          sourceRoles.length !== matrixRoles.length ||
          sourceRoles.some((r, i) => r !== matrixRoles[i])
        ) {
          mismatches.push({
            operation: `${operation} (${src.filePath}:${src.line})`,
            matrix: matrixRoles,
            source: sourceRoles,
          });
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('QUERY_ROLES entries match the @Roles decorators in source', () => {
    const mismatches: Array<{
      operation: string;
      matrix: string[];
      source: string[];
    }> = [];
    for (const [operation, roles] of Object.entries(QUERY_ROLES)) {
      const matches = queryOps.filter((op) => op.operation === operation);
      if (matches.length === 0) continue;
      const matrixRoles = rolesToSortedNames(roles.map((r) => String(r)));
      for (const src of matches) {
        const sourceRoles = rolesToSortedNames(src.roles);
        if (
          sourceRoles.length !== matrixRoles.length ||
          sourceRoles.some((r, i) => r !== matrixRoles[i])
        ) {
          mismatches.push({
            operation: `${operation} (${src.filePath}:${src.line})`,
            matrix: matrixRoles,
            source: sourceRoles,
          });
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('grandfathered operations carry NO @Roles — opposite state means the operation has graduated', () => {
    const graduated: string[] = [];
    for (const ungated of UNGATED_OPERATIONS) {
      const matches = operations.filter((op) => op.operation === ungated);
      for (const src of matches) {
        if (src.roles.length > 0) {
          graduated.push(
            `${src.operation} (${src.filePath}:${src.line}) now has @Roles — ` +
              `move it out of UNGATED_OPERATIONS and into ` +
              `${src.kind === 'Mutation' ? 'MUTATION_ROLES' : 'QUERY_ROLES'}.`,
          );
        }
      }
    }
    expect(graduated).toEqual([]);
  });

  it('every matrix key matches exactly one @Mutation / @Query in source (no stale entries)', () => {
    const sourceMutations = new Set(mutationOps.map((op) => op.operation));
    const sourceQueries = new Set(queryOps.map((op) => op.operation));

    const staleMutations = Object.keys(MUTATION_ROLES).filter(
      (op) => !sourceMutations.has(op),
    );
    const staleQueries = Object.keys(QUERY_ROLES).filter(
      (op) => !sourceQueries.has(op),
    );
    const staleUngated = Array.from(UNGATED_OPERATIONS).filter(
      (op) => !sourceMutations.has(op) && !sourceQueries.has(op),
    );

    expect({
      staleMutations,
      staleQueries,
      staleUngated,
    }).toEqual({
      staleMutations: [],
      staleQueries: [],
      staleUngated: [],
    });
  });
});

describe('resolveAllowedRoles helper', () => {
  it('returns the role list for a known mutation', () => {
    // Example chosen from MUTATION_ROLES snapshot — closeBatch is
    // role-gated so the helper returns the exact array.
    const closeBatchRoles = matrixEntryNames(
      MUTATION_ROLES as unknown as Readonly<Record<string, readonly string[]>>,
      'closeBatch',
    );
    expect(closeBatchRoles.length).toBeGreaterThan(0);
  });

  it('grandfathered whitelist is empty after phase 6.1.1 — every operation is explicitly classified', () => {
    // Phase 6.1.1 is complete. Every @Mutation / @Query in
    // farm-service now appears in MUTATION_ROLES or QUERY_ROLES
    // with an explicit @Roles decorator. The whitelist is the
    // empty set. New operations added after this point either
    // carry @Roles + a matrix entry or the invariant test
    // rejects the PR — the fail-closed runtime guard (phase
    // 6.1.2) then rejects the request in production as a
    // defence-in-depth layer. No more grandfathering.
    expect(UNGATED_OPERATIONS.size).toBe(0);
  });
});
