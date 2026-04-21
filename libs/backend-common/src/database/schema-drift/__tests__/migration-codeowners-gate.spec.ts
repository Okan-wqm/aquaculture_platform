/**
 * Exercises the tools/gates/migration-codeowners-coverage main()
 * function — asserts current CODEOWNERS covers every migration path
 * in the repo, and tests --json output shape.
 *
 * This spec runs the production gate against the real repository,
 * so a future accidental CODEOWNERS trim that drops migration coverage
 * fails this test in CI before landing.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { main } = require('../../../../../../tools/gates/migration-codeowners-coverage') as {
  main: (argv: readonly string[]) => number;
};

describe('migration-codeowners-coverage gate', () => {
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

  it('exits 0 — current CODEOWNERS covers every migration path', () => {
    const code = main([]);
    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toContain('All migration paths are CODEOWNERS-covered');
  });

  it('--json emits the uncovered list + counts', () => {
    const code = main(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutChunks.join('')) as {
      totalPaths: number;
      uncoveredCount: number;
      uncovered: string[];
    };
    expect(parsed.totalPaths).toBeGreaterThan(0);
    expect(parsed.uncoveredCount).toBe(0);
    expect(parsed.uncovered).toEqual([]);
  });
});
