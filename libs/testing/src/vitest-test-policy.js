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
    }),
  });
};
