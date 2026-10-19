/**
 * Integration spec for tools/gates/gha-sha-pin. Asserts the current
 * repository state (every workflow `uses:` is SHA-pinned) and
 * exercises the violation detector against synthetic inputs via
 * the exported runCheck() / main() entry points.
 */
// The top-level imports keep strict-tsc treating this file as a MODULE (so
// its top-level `const runCheck = require(...)` is module-scoped, not
// global). Without one, this file and npm-audit-gate.spec.ts would both
// declare `runCheck` in the global scope and collide. Surfaced by PR-29
// (PROC-MEDIUM-007 ratchet) — ts-jest's permissive transform was hiding the
// script-vs-module ambiguity.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  main: ghaShaPinMain,
  runCheck,
  inspectUsesText,
} = require('../../../../../../tools/gates/gha-sha-pin') as {
  main: (argv: readonly string[]) => number;
  runCheck: () => ReadonlyArray<{ file: string; line: number; uses: string }>;
  inspectUsesText: (
    rel: string,
    raw: string,
  ) => ReadonlyArray<{ file: string; line: number; uses: string; reason: string }>;
};

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

/** The verdict of the gate's rule on one `uses:` target. */
function verdictOf(target: string): string | null {
  const [violation] = inspectUsesText('wf.yml', `steps:\n  - uses: ${target}\n`);
  return violation === undefined ? null : violation.reason;
}

describe('gha-sha-pin gate', () => {
  let stdoutSpy: jest.SpyInstance;
  let stdoutChunks: string[] = [];

  beforeEach(() => {
    stdoutChunks = [];
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
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

  // ARIA-MEDIUM-590 — the gate is the ONE owner of the action-pin rule; the
  // invariant spec and ARIA's workflow/shell safety adapter read its verdict.
  describe('the action-pin rule (ARIA-MEDIUM-590)', () => {
    it('accepts a 40-hex commit SHA and a local action', () => {
      expect(verdictOf(`actions/checkout@${SHA}`)).toBeNull();
      expect(verdictOf('./.github/actions/setup-node-env')).toBeNull();
      expect(verdictOf('../shared/action')).toBeNull();
    });

    it('refuses a tag, a branch and a short SHA as a mutable ref', () => {
      expect(verdictOf('actions/checkout@v4')).toBe('mutable_ref');
      expect(verdictOf('actions/checkout@main')).toBe('mutable_ref');
      expect(verdictOf('actions/checkout@abc1234')).toBe('mutable_ref');
    });

    it('refuses a remote action with no ref: it runs the default branch', () => {
      expect(verdictOf('owner/repo')).toBe('missing_ref');
      expect(verdictOf('owner/repo/path/to/action')).toBe('missing_ref');
    });

    it('accepts a docker image only by sha256 digest', () => {
      expect(verdictOf(`docker://ghcr.io/owner/img@sha256:${DIGEST}`)).toBeNull();
      expect(verdictOf('docker://alpine:3.20')).toBe('docker_not_digest');
      expect(verdictOf('docker://alpine')).toBe('docker_not_digest');
      expect(verdictOf(`docker://alpine@sha256:${DIGEST.slice(1)}`)).toBe('docker_not_digest');
    });

    it('grants no branch-ref exception: a channel action pins a SHA and passes the channel as input', () => {
      // dtolnay/rust-toolchain@nightly was once exempt in the invariant spec
      // only. The tree selects the channel through `with: toolchain:` on a
      // SHA-pinned action (fuzz-st-parser-nightly.yml), so the branch ref
      // buys nothing and would run whatever the branch points at.
      expect(verdictOf('dtolnay/rust-toolchain@nightly')).toBe('mutable_ref');
      expect(verdictOf('dtolnay/rust-toolchain@stable')).toBe('mutable_ref');
    });

    it('reports the 1-based line of each violation', () => {
      const text = [
        'jobs:',
        '  a:',
        '    steps:',
        '      - uses: actions/checkout@v4',
        `      - uses: x/y@${SHA}`,
      ].join('\n');
      expect(inspectUsesText('wf.yml', text)).toEqual([
        { file: 'wf.yml', line: 4, uses: 'actions/checkout@v4', reason: 'mutable_ref' },
      ]);
    });

    it('has no second copy: no other TypeScript source restates the rule', () => {
      // A source that matches `uses:` AND holds a 40-hex SHA pattern is a
      // private copy of this rule. Readers import inspectUsesText instead.
      const owner = 'tools/gates/gha-sha-pin.ts';
      const roots = ['tools', 'tests', 'libs', 'scripts', 'e2e'];
      const copies: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(?:ts|mts|cts|mjs|js)$/.test(entry.name)) {
            const rel = relative(REPO_ROOT, full);
            if (rel === owner) continue;
            const text = readFileSync(full, 'utf8');
            if (/uses:\\s/.test(text) && /\[(?:a-f0-9|0-9a-f)\]\{40\}/.test(text)) copies.push(rel);
          }
        }
      };
      for (const root of roots) walk(join(REPO_ROOT, root));
      expect(copies).toEqual([]);
    });
  });
});
