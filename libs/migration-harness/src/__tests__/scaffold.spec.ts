/**
 * Scaffold smoke test — verifies Jest picks up the __tests__ convention
 * and that the library compiles + tests cleanly.
 *
 * Real harness behavioral tests land in subsequent Phase 1 commits:
 *   - harness-contract.spec.ts  (defineMigrationTest API)
 *   - expect-no-drift.spec.ts   (Jest matcher + drift assertion)
 *   - hr-drift-regression.spec.ts (5-commit HR loop reproduction)
 */

// `export {}` keeps strict-tsc treating this file as a MODULE so its
// top-level declarations stay file-scoped (PROC-MEDIUM-010 invariant).
export {};
describe('migration-harness scaffold', () => {
  it('lib compiles and Jest picks up __tests__ convention', () => {
    expect(true).toBe(true);
  });

  it('barrel export loads without error', async () => {
    const mod = await import('../index');
    // Placeholder barrel; real exports ship in subsequent commits.
    expect(mod).toBeDefined();
  });
});
