/**
 * Integration spec for tools/gates/gha-sha-pin. Asserts the current
 * repository state (every workflow `uses:` is SHA-pinned) and
 * exercises the violation detector against synthetic inputs via
 * the exported runCheck() / main() entry points.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  main: ghaShaPinMain,
  runCheck,
} = require('../../../../../../tools/gates/gha-sha-pin') as {
  main: (argv: readonly string[]) => number;
  runCheck: () => ReadonlyArray<{ file: string; line: number; uses: string }>;
};

describe('gha-sha-pin gate', () => {
  let stdoutSpy: jest.SpyInstance;
  let stdoutChunks: string[] = [];

  beforeEach(() => {
    stdoutChunks = [];
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        stdoutChunks.push(chunk.toString());
        return true;
      }) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('current repo has zero unpinned `uses:` references', () => {
    const violations = runCheck();
    expect(violations).toEqual([]);
  });

  it('main() exits 0 when clean', () => {
    const code = ghaShaPinMain([]);
    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toContain('SHA-pinned');
  });

  it('--json mode emits structured report', () => {
    const code = ghaShaPinMain(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutChunks.join('')) as {
      violationCount: number;
      violations: unknown[];
    };
    expect(parsed.violationCount).toBe(0);
    expect(parsed.violations).toEqual([]);
  });
});
