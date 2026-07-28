declare function createVitestTestPolicy(): {
  readonly maxWorkers: 2;
  readonly coverage: {
    readonly provider: 'v8';
    readonly reporter: ['text', 'lcov'];
  };
};

export = createVitestTestPolicy;
