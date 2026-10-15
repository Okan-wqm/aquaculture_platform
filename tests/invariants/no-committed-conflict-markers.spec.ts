/**
 * No committed merge-conflict markers (PROC-LOW-049)
 * ============================================================================
 *
 * WHAT. Every tracked text file in the repository is scanned with `git grep`
 * for a line that STARTS with a conflict-marker run — seven or more `<` or `>`
 * characters followed by a space or the end of the line, which is exactly what
 * git's merge machinery writes for the opening and closing marker of a
 * conflicted hunk. Any hit fails the suite with `file:line: text`.
 *
 * WHY. `docs/plans/2026-06-18-enterprise-grade-debt-closure/finding-truth-table.md`
 * carried `<<<<<<< HEAD` / `=======` / `>>>>>>> 291d2adb8 ...` (both sides
 * empty; the label names the merged side) from commit 453d442da onward, on
 * main, in a document that `tools/gates/debt-plan-truth.ts` parses — and
 * nothing refused it. The only other check, pre-commit-hooks'
 * `check-merge-conflict` in `.pre-commit-config.yaml`, is opt-in on a
 * developer machine, scans only while a merge is in progress, and runs in no
 * husky hook and no CI workflow, so it cannot refuse a committed marker. A
 * half-resolved merge is invisible to ESLint, tsc and every content gate that
 * reads only the lines it knows; this invariant is the one CI owner of the
 * question none of them ask.
 *
 * WHAT IS DELIBERATELY NOT MATCHED.
 *   - A lone `=======` line: Markdown setext headings and ASCII rules use it.
 *     Every conflicted hunk also carries an opening and a closing marker, so
 *     checking those two loses no conflict.
 *   - A marker run that does not start the line, e.g. a spec asserting
 *     `toContain('<<<<<<<')` or a merge-driver fixture: only git-written
 *     markers start at column 0.
 *   - Binary files (`-I`) and untracked files (`git grep` reads the index's
 *     file list): neither is committed text.
 *
 * WHY `{7,}` AND `( |$)` RATHER THAN EXACTLY "seven and a space". The marker
 * length is the `conflict-marker-size` attribute (default 7; the merge driver
 * protocol passes it as `%L`), and a marker written without a label has no
 * trailing space. The detector test below proves both shapes against markers
 * produced by `git merge-file` itself, not by hand-written strings.
 *
 * Finding: docs/reviews/claude/2026-10-14-aria-wave2-spawned-findings.md#PROC-LOW-049
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * A line that starts with a run of 7+ `<` or 7+ `>` followed by a space (a
 * labelled marker) or the end of the line (an unlabelled one). POSIX ERE, as
 * `git grep -E` reads it.
 */
const CONFLICT_MARKER_LINE = '^(<{7,}|>{7,})( |$)';

interface ConflictMarkerHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Every tracked text line under `repoRoot` that starts with a conflict marker.
 *
 * `-z` makes the path and line-number separators NUL, so a path that contains
 * `:` or non-ASCII bytes is read verbatim. `--no-color` and `--no-column` pin
 * the output shape against a `color.grep=always` or `grep.column=true` in the
 * caller's git config, either of which would otherwise change what is parsed.
 */
function findConflictMarkerLines(repoRoot: string, env: NodeJS.ProcessEnv): ConflictMarkerHit[] {
  const result = spawnSync(
    'git',
    [
      '-C',
      repoRoot,
      'grep',
      '--no-color',
      '--no-column',
      '-I',
      '-n',
      '-z',
      '-E',
      '-e',
      CONFLICT_MARKER_LINE,
      '--',
      '.',
    ],
    { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 },
  );
  // `git grep` exits 1 for "no line matched" — the passing answer, not an
  // error. Anything other than 0 or 1 (a bad pathspec, not a repository, git
  // missing) means the scan did not happen, and a scan that did not happen
  // must not read as a clean tree.
  if (result.error !== undefined) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(`git grep exited ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout
    .split('\n')
    .filter((record) => record.length > 0)
    .map((record) => {
      const [file, line, ...rest] = record.split('\0');
      return { file: file as string, line: Number(line), text: rest.join('\0') };
    });
}

/**
 * Environment for the throwaway fixture repository: every inherited `GIT_*`
 * variable is dropped, so a run inside a git hook (which exports `GIT_DIR` /
 * `GIT_INDEX_FILE`) cannot point the fixture's `git add` at the real
 * repository, and global/system config cannot change how markers are written.
 */
const FIXTURE_GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

function fixtureGit(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: FIXTURE_GIT_ENV });
}

/**
 * Run git's own three-way merge on one hunk and return what it wrote. The
 * exit status of `git merge-file` is the number of conflicts, so `1` proves
 * the output carries a real, git-written conflict.
 */
function gitWrittenConflict(root: string, extraArgs: readonly string[]): string {
  writeFileSync(join(root, 'ours.tmp'), 'a\nOURS\nc\n', 'utf8');
  writeFileSync(join(root, 'base.tmp'), 'a\nb\nc\n', 'utf8');
  writeFileSync(join(root, 'theirs.tmp'), 'a\nTHEIRS\nc\n', 'utf8');
  const merged = spawnSync(
    'git',
    [
      'merge-file',
      '-p',
      ...extraArgs,
      '-L',
      'HEAD',
      '-L',
      'base',
      '-L',
      'feature',
      'ours.tmp',
      'base.tmp',
      'theirs.tmp',
    ],
    { cwd: root, encoding: 'utf8', env: FIXTURE_GIT_ENV },
  );
  expect(merged.status).toBe(1);
  return merged.stdout;
}

describe('no committed merge-conflict markers (PROC-LOW-049)', () => {
  describe('the detector', () => {
    let root = '';

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'conflict-markers-'));
      fixtureGit(root, ['init', '--quiet', '--initial-branch=main']);
    });

    afterEach(() => {
      removeFixtureTree(root);
    });

    it('reports git-written markers in tracked text, and nothing else', () => {
      // A conflict exactly as `git merge` leaves it, then staged unresolved.
      writeFileSync(join(root, 'conflicted.md'), gitWrittenConflict(root, []), 'utf8');
      // diff3 style with a widened marker (`conflict-marker-size=9`).
      writeFileSync(
        join(root, 'wide.txt'),
        gitWrittenConflict(root, ['--diff3', '--marker-size=9']),
        'utf8',
      );
      // Markers without a label carry no trailing space.
      const open = '<'.repeat(7);
      const close = '>'.repeat(7);
      writeFileSync(join(root, 'unlabelled.txt'), `x\n${open}\ny\n=======\nz\n${close}\n`, 'utf8');
      // Not conflicts: a setext heading, a mid-line marker, a binary blob.
      writeFileSync(join(root, 'setext.md'), 'Title\n=======\n\nbody\n', 'utf8');
      writeFileSync(
        join(root, 'inline.ts'),
        `expect(text).toContain('${open} HEAD');\nconst s = "${close} feature";\n`,
        'utf8',
      );
      writeFileSync(
        join(root, 'blob.bin'),
        Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\n${open} HEAD\n`, 'utf8')]),
      );
      fixtureGit(root, [
        'add',
        '--',
        'conflicted.md',
        'wide.txt',
        'unlabelled.txt',
        'setext.md',
        'inline.ts',
        'blob.bin',
      ]);
      // Untracked, so never committed: not the gate's business.
      writeFileSync(join(root, 'untracked.md'), `${open} HEAD\n=======\n${close} x\n`, 'utf8');

      expect(findConflictMarkerLines(root, FIXTURE_GIT_ENV)).toEqual([
        { file: 'conflicted.md', line: 2, text: '<<<<<<< HEAD' },
        { file: 'conflicted.md', line: 6, text: '>>>>>>> feature' },
        { file: 'unlabelled.txt', line: 2, text: '<<<<<<<' },
        { file: 'unlabelled.txt', line: 6, text: '>>>>>>>' },
        { file: 'wide.txt', line: 2, text: '<<<<<<<<< HEAD' },
        { file: 'wide.txt', line: 8, text: '>>>>>>>>> feature' },
      ]);
    });

    it('answers an empty list for a clean tree, and throws when it cannot scan', () => {
      writeFileSync(join(root, 'clean.md'), 'Title\n=======\n', 'utf8');
      fixtureGit(root, ['add', '--', 'clean.md']);
      expect(findConflictMarkerLines(root, FIXTURE_GIT_ENV)).toEqual([]);

      const notARepository = mkdtempSync(join(tmpdir(), 'conflict-markers-norepo-'));
      try {
        expect(() =>
          findConflictMarkerLines(notARepository, {
            ...FIXTURE_GIT_ENV,
            GIT_CEILING_DIRECTORIES: tmpdir(),
          }),
        ).toThrow(/git grep exited/);
      } finally {
        removeFixtureTree(notARepository);
      }
    });
  });

  it('no tracked text file in this repository carries a conflict-marker line', () => {
    expect(findConflictMarkerLines(REPO_ROOT, process.env)).toEqual([]);
  });
});
