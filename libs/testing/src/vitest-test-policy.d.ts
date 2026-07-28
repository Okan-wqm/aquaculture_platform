declare const vitestTestPolicy: {
  readonly maxWorkers: 2;
  readonly coverage: {
    readonly provider: 'v8';
    readonly reporter: readonly ['text', 'lcov'];
  };
};

export = vitestTestPolicy;
