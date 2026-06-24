#!/usr/bin/env ts-node
/**
 * git-reachability — SSOT helper answering one question: is commit X
 * reachable from ref Y in this repository?
 *
 * Primary consumer: tools/gates/finding-registry.ts `close` subcommand
 * (PROC-HIGH-001 structural guard). The registry's three-store invariant
 * requires every closing_commits SHA to exist in fetchable history; a
 * close ceremony that records a feature-branch SHA is guaranteed to be
 * invalidated by the squash-merge + branch-delete flow (incident
 * 2026-06-10: 7 rows orphaned by #378's squash, repaired in #384; the
 * SEC-CRITICAL-002 / AUDIT-CRITICAL-006 recurrence repaired in #380 and
 * the cluster-0 PR). The guard makes the wrong ceremony IMPOSSIBLE
 * (CLAUDE.md tier-1) instead of detectable-after-the-fact.
 *
 * No top-level execution — import-safe for node:test specs.
 */

import { execFileSync } from 'node:child_process';

export interface ReachabilityResult {
  readonly ok: boolean;
  /** Human-actionable failure reason; undefined when ok. */
  readonly reason?: string;
}

/**
 * Repo-location env vars are stripped before every query: the helper's
 * contract is "the repository at repoRoot", never the ambient git
 * context. When a caller runs inside a git hook, git exports GIT_DIR /
 * GIT_INDEX_FILE / GIT_WORK_TREE to the process — an inherited GIT_DIR
 * overrides `-C repoRoot` discovery and redirects the query at whatever
 * repository the hook belongs to (2026-06-10 fixture incident class).
 */
const REPO_LOCATION_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_NAMESPACE',
] as const;

export function repoPinnedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !(REPO_LOCATION_ENV_VARS as readonly string[]).includes(key),
    ),
  );
}

function gitStatus(repoRoot: string, args: readonly string[]): number {
  try {
    execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'ignore', env: repoPinnedEnv() });
    return 0;
  } catch (err) {
    const e = err as { status?: number };
    return typeof e.status === 'number' ? e.status : 128;
  }
}

/**
 * Check that `sha` resolves to a commit AND is an ancestor of (or equal
 * to) `ref`. Fail-closed: an unresolvable ref (shallow clone, missing
 * remote-tracking branch, stale fetch) is a refusal with instructions,
 * never a silent pass — the guard cannot certify what it cannot see.
 */
export function commitReachableFrom(
  repoRoot: string,
  sha: string,
  ref: string,
): ReachabilityResult {
  if (gitStatus(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== 0) {
    return {
      ok: false,
      reason:
        `ref "${ref}" does not resolve to a commit in this checkout. ` +
        `Run \`git fetch origin main\` (or fetch the relevant ref) and retry — ` +
        `the reachability guard refuses to certify against an invisible ref.`,
    };
  }

  if (gitStatus(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) !== 0) {
    return {
      ok: false,
      reason: `commit "${sha}" is unknown to this repository — fetch it or check the SHA.`,
    };
  }

  const ancestorStatus = gitStatus(repoRoot, ['merge-base', '--is-ancestor', sha, ref]);
  if (ancestorStatus === 0) {
    return { ok: true };
  }
  if (ancestorStatus === 1) {
    return {
      ok: false,
      reason:
        `commit ${sha} is NOT reachable from ${ref}. The close ceremony must run ` +
        `after the fix PR merges, with a main-reachable commit whose own message ` +
        `carries the matching Closes: trailer — branch-local SHAs die with the ` +
        `branch (PROC-HIGH-001).`,
    };
  }
  return {
    ok: false,
    reason: `git merge-base --is-ancestor failed with status ${ancestorStatus} — repository state is unreadable; refusing to certify.`,
  };
}
