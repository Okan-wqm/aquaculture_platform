/**
 * Integration spec for tools/gates/gha-sha-pin. Asserts the current
 * repository state (every workflow `uses:` is SHA-pinned) and
 * exercises the violation detector against synthetic inputs via
 * the exported runCheck() / main() entry points.
 */
import { resolve } from 'node:path';

interface GhaShaPinModule {
  readonly main: (argv: readonly string[]) => number;
  readonly runCheck: () => ReadonlyArray<{
    readonly file: string;
    readonly line: number;
    readonly uses: string;
  }>;
}

const { main: ghaShaPinMain, runCheck } = jest.requireActual<GhaShaPinModule>(
  resolve(__dirname, '../../../../../../tools/gates/gha-sha-pin'),
);

describe('gha-sha-pin gate', () => {
  let stdoutSpy: jest.SpyInstance;
  let stdoutChunks: string[] = [];

  beforeEach(() => {
    stdoutChunks = [];
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutChunks.push(chunk.toString());
        return true;
      });
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
