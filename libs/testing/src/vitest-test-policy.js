// Vitest projects load config before repository TypeScript transformers exist.
// CommonJS keeps this policy executable on the repository's Node 20 baseline.
module.exports = Object.freeze({
  // Nx runs projects concurrently. Bounding each project prevents nested
  // worker pools from oversubscribing CI runners.
  maxWorkers: 2,
  coverage: Object.freeze({
    provider: 'v8',
    reporter: Object.freeze(['text', 'lcov']),
  }),
});
