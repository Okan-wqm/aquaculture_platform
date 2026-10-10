/**
 * How the worktree collector runs git: bounded by a timeout, with the
 * environment a git hook or parent git process may export removed (any of
 * those variables would redirect the call to another repository), with no
 * credential prompt, and with optional locks off so a read-only `git status`
 * never rewrites an index and makes a worktree look recently used.
 */
import { spawnSync } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  code: number | null;
  /** The call was killed by its timeout, not refused by git. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export const GIT_TIMEOUT_MS = 120_000;

const GIT_ENV_BLOCKLIST = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_NAMESPACE',
];

function gitEnv(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([key]) => !GIT_ENV_BLOCKLIST.includes(key));
  return { ...Object.fromEntries(inherited), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

export function git(bin: string, args: string[], timeout: number = GIT_TIMEOUT_MS): GitResult {
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout,
    env: gitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = r.error !== undefined && 'code' in r.error && r.error.code === 'ETIMEDOUT';
  const suffix = timedOut ? ` timed out after ${timeout} ms` : r.error ? ` ${r.error.message}` : '';
  return {
    ok: r.status === 0 && !r.error,
    code: r.status,
    timedOut,
    stdout: r.stdout ?? '',
    stderr: `${r.stderr ?? ''}${suffix}`.trim(),
  };
}

export function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 300) ?? '';
}
