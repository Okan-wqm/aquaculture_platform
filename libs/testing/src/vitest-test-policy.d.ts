declare function createVitestTestPolicy(): {
  readonly maxWorkers: 2;
  readonly testTimeout: 30000;
  readonly coverage: {
    readonly provider: 'v8';
    readonly reporter: ['text', 'lcov'];
    readonly include: ['src/**/*.{ts,tsx,js,jsx}'];
    readonly exclude: ['**/*.d.ts', '**/__tests__/**'];
  };
};

export = createVitestTestPolicy;
