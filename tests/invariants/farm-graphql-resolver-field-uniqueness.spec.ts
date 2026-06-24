/**
 * Farm GraphQL Resolver Field Uniqueness Invariant
 * ============================================================================
 *
 * SSoT: every GraphQL ROOT operation field (`@Query` / `@Mutation` /
 * `@Subscription`) served by the farm-service subgraph MUST be declared by
 * EXACTLY ONE resolver method. A root field is its own single source of truth.
 *
 * Why this gate exists (2026-06-24):
 *   `availableTanks` was declared twice —
 *     - BatchResolver.listAvailableTanks  → (siteId, departmentId, excludeFullTanks)
 *     - TankResolver.getAvailableTanks    → (departmentId) only
 *   NestJS code-first builds the schema by collecting resolver metadata; when a
 *   root field name is registered twice, only ONE definition survives and which
 *   one wins depends on module/resolver load order — non-deterministic across
 *   rebuilds/restarts. When the stripped-down definition won, the schema lost
 *   the `siteId` argument and the browser saw intermittent
 *   `Unknown argument "siteId" on field "Query.availableTanks"` → 400 →
 *   "data sometimes loads, sometimes doesn't".
 *
 *   The FE↔BE parity gate could not catch this: it folds the backend surface
 *   into a `Set<string>`, which silently dedupes the two declarations. This
 *   gate consumes the same shared extractor but asserts on multiplicity.
 *
 * Scope: ROOT operations only. `@ResolveField` is intentionally excluded — the
 * same field name legitimately resolves on different `@ObjectType`s (and a
 * federation `__resolveReference` appears per entity), so cross-type repetition
 * is correct, not drift.
 */
import { extractBackendResolverFields } from './helpers/farm-graphql-surface';

describe('farm-service GraphQL root operation field uniqueness', () => {
  const fields = extractBackendResolverFields();
  const rootOps = fields.filter((f) => f.kind !== 'ResolveField');
  type RootField = (typeof rootOps)[number];

  it('extractor finds a plausible root operation surface (guards extractor rot)', () => {
    // farm-service serves 400+ root fields today; a collapse to near-zero would
    // make the uniqueness assertion below pass vacuously.
    expect(rootOps.length).toBeGreaterThan(200);
  });

  it('every root field (Query/Mutation/Subscription) is declared by exactly one resolver', () => {
    const byName = new Map<string, RootField[]>();
    for (const f of rootOps) {
      const locs = byName.get(f.field) ?? [];
      locs.push(f);
      byName.set(f.field, locs);
    }

    const dups = [...byName.entries()].filter(([, locs]) => locs.length > 1);

    const report = dups
      .map(
        ([name, locs]) =>
          `  ${name}\n` + locs.map((l) => `      ${l.kind} ${l.file}:${l.line}`).join('\n'),
      )
      .join('\n');

    expect(
      dups.length === 0
        ? ''
        : `\n${dups.length} GraphQL root field name(s) are declared by more than one farm-service resolver.\n` +
            `NestJS code-first builds the schema non-deterministically (last-registered-wins) when a\n` +
            `root field is declared twice → intermittent "Unknown argument" 400s in the browser.\n` +
            `Each root field must have exactly one resolver (its SSoT). Remove the duplicate(s):\n${report}\n`,
    ).toBe('');
  });
});
