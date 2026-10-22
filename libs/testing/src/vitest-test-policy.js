/* global module */
// Vitest projects load config before repository TypeScript transformers exist.
// CommonJS keeps this policy executable on the repository's Node 20 baseline.
module.exports = function createVitestTestPolicy() {
  return Object.freeze({
    // Nx runs projects concurrently. Bounding each project prevents nested
    // worker pools from oversubscribing CI runners.
    maxWorkers: 2,
    // Vitest's 5s default is sized for a plain unit test on an idle machine.
    // These suites are neither: they render charts under jsdom, they run
    // three projects at a time on a two-core runner, and — now that the
    // coverage flag actually reaches the runner — every one of them carries v8
    // instrumentation. The same chart spec that finishes in ~1s uncontended
    // took 8.7s under that load and tripped the default. The repository had
    // already met this and answered it once, in farm-module's
    // `test:water-chemistry` script (`--testTimeout=30000`); the answer
    // belongs here instead, where it applies to every producer that renders
    // anything rather than to the one script whose flake was noticed first.
    testTimeout: 30_000,
    coverage: Object.freeze({
      provider: 'v8',
      // Vitest's InlineConfig owns a mutable reporter array. Return a fresh
      // array for every consumer so no config shares mutable state.
      reporter: ['text', 'lcov'],
      // Vitest 4 removed `coverage.all`: without an `include` pattern a report
      // lists only the files some test happened to import, so a module no test
      // touches drops out of the denominator instead of counting as 0%. Naming
      // the source tree restores the Vitest 3 meaning of every producer's LCOV
      // (all of `src`, tested or not). Test files are excluded by Vitest
      // itself; the two excludes are the Vitest 3 defaults that apply inside
      // `src` (type-only declarations and test fixtures under __tests__).
      // Fresh arrays per consumer, for the same reason as `reporter`.
      include: ['src/**/*.{ts,tsx,js,jsx}'],
      exclude: ['**/*.d.ts', '**/__tests__/**'],
    }),
  });
};
