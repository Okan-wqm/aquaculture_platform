/**
 * Real-git fixtures for the worktree-gc specs: a bare "origin", a clone
 * acting as the main checkout, and worktrees made old the way git sees age
 * (a backdated reflog entry and index mtime). The collector runs as a child
 * process exactly as systemd runs it.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Summary, WorktreeReport } from './worktree-gc.ts';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'worktree-gc.ts');
export const OLD_SECONDS = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
export const OLD_ENV = {
  GIT_COMMITTER_DATE: `@${OLD_SECONDS} +0000`,
  GIT_AUTHOR_DATE: `@${OLD_SECONDS} +0000`,
};
const HOOK_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
];

export interface Fixture {
  tmp: string;
  repo: string;
  roots: string;
  procRoot: string;
  textfile: string;
}

export interface GcRun {
  summary: Summary;
  worktrees: WorktreeReport[];
  lines: string[];
  exitCode: number;
}

export function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // The suite also runs from git hooks, which export GIT_DIR and friends.
  const inherited = Object.entries(process.env).filter(([key]) => !HOOK_GIT_VARS.includes(key));
  return {
    ...Object.fromEntries(inherited),
    GIT_AUTHOR_NAME: 'gc-test',
    GIT_AUTHOR_EMAIL: 'gc-test@example.invalid',
    GIT_COMMITTER_NAME: 'gc-test',
    GIT_COMMITTER_EMAIL: 'gc-test@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...extra,
  };
}

export function git(args: string[], extra: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    env: baseEnv(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Adds one fake process to a fake /proc: its cwd, open fds and mapped files. */
export function fakeProcess(
  fx: Fixture,
  pid: number,
  opts: { cwd?: string; fds?: string[]; maps?: string[] } = {},
): void {
  const base = join(fx.procRoot, String(pid));
  mkdirSync(join(base, 'fd'), { recursive: true });
  symlinkSync(opts.cwd ?? '/', join(base, 'cwd'));
  (opts.fds ?? []).forEach((target, i) => symlinkSync(target, join(base, 'fd', String(i + 3))));
  const maps = (opts.maps ?? []).map((p) => `7f00-7f01 r--p 00000000 08:02 1234 ${p}`);
  writeFileSync(join(base, 'maps'), maps.length > 0 ? `${maps.join('\n')}\n` : '');
}

export function fixture(opts: { bareMain?: boolean } = {}): Fixture {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wtgc-')));
  const origin = join(tmp, 'origin.git');
  const seed = join(tmp, 'seed');
  const repo = join(tmp, 'repo');
  git(['init', '--quiet', '--bare', '-b', 'main', origin]);
  git(['clone', '--quiet', origin, seed]);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  writeFileSync(
    join(seed, '.gitignore'),
    'node_modules\n.state/\n.full-review/\ndist\n__pycache__/\naria-findings/\n.aria-ci/\naria-tools/\n.aria-state-store/\n',
  );
  git(['-C', seed, 'add', '.']);
  git(['-C', seed, 'commit', '--quiet', '-m', 'seed'], OLD_ENV);
  git(['-C', seed, 'push', '--quiet', 'origin', 'HEAD:main']);
  git(['clone', '--quiet', origin, repo]);
  // The droplet's /var/aqua-saas is a normal clone with core.bare=true set.
  if (opts.bareMain) git(['-C', repo, 'config', 'core.bare', 'true']);

  const roots = join(tmp, 'wt');
  mkdirSync(roots);
  const fx = { tmp, repo, roots, procRoot: join(tmp, 'proc'), textfile: join(tmp, 'gc.prom') };
  // A readable process table holding none of the fixture's worktrees.
  fakeProcess(fx, 1);
  return fx;
}

export function gitDirOf(worktree: string): string {
  const match = /^gitdir: (.+)$/m.exec(readFileSync(join(worktree, '.git'), 'utf8'));
  assert.ok(match?.[1]);
  return resolve(worktree, match[1].trim());
}

export function backdate(worktree: string): void {
  utimesSync(join(gitDirOf(worktree), 'index'), OLD_SECONDS, OLD_SECONDS);
}

export function addWorktree(
  fx: Fixture,
  name: string,
  opts: { old?: boolean; under?: string } = {},
): string {
  const path = join(opts.under ?? fx.roots, name);
  const old = opts.old ?? true;
  git(
    ['-C', fx.repo, 'worktree', 'add', '--quiet', '-b', name, path, 'origin/main'],
    old ? OLD_ENV : {},
  );
  if (old) backdate(path);
  return path;
}

/**
 * A git that runs `onCall` shell code when its arguments match `match` (a
 * `case` pattern over "$*") and is the real git otherwise. `onCall` can
 * reach the real binary as "$REAL_GIT".
 */
export function wrappedGit(fx: Fixture, name: string, match: string, onCall: string): string {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const wrapper = join(fx.tmp, name);
  const script = [
    '#!/bin/sh',
    `REAL_GIT='${realGit}'`,
    'case "$*" in',
    `  ${match}) ${onCall} ;;`,
    'esac',
    'exec "$REAL_GIT" "$@"',
  ];
  writeFileSync(wrapper, `${script.join('\n')}\n`, { mode: 0o755 });
  return wrapper;
}

/** Runs the collector armed, against the fixture's roots, fake /proc and textfile, unless overridden. */
export function runGc(
  fx: Fixture,
  args: string[] = [],
  env: Record<string, string | null> = {},
): GcRun {
  const merged: Record<string, string | null> = {
    AQUA_REPO: fx.repo,
    WORKTREE_GC_ROOTS: fx.roots,
    WORKTREE_GC_PROC_ROOT: fx.procRoot,
    WORKTREE_GC_TEXTFILE_PATH: fx.textfile,
    WORKTREE_GC_ARMED: '1',
    ...env,
  };
  const unset = new Set(Object.keys(merged).filter((key) => merged[key] === null));
  const childEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries({ ...baseEnv(), ...merged }).filter(
      (entry): entry is [string, string] => !unset.has(entry[0]) && typeof entry[1] === 'string',
    ),
  );
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, ['--experimental-strip-types', TOOL, ...args], {
      encoding: 'utf8',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    exitCode = failure.status ?? 1;
    stdout = failure.stdout ?? '';
  }
  const lines = stdout.split('\n').filter(Boolean);
  const summary = JSON.parse(lines[lines.length - 1] ?? '{}') as Summary;
  const worktrees = lines.slice(0, -1).map((l) => JSON.parse(l) as WorktreeReport);
  return { summary, worktrees, lines, exitCode };
}

export function reportFor(run: GcRun, path: string): WorktreeReport {
  const report = run.worktrees.find((w) => w.path === path);
  assert.ok(report, `no report for ${path}`);
  return report;
}

export function isRoot(): boolean {
  return typeof process.geteuid === 'function' && process.geteuid() === 0;
}
