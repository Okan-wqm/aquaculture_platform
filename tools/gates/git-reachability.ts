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

import {
  HERMETIC_GIT_RUNTIME,
  type HermeticGitReadQueryV1,
  type HermeticGitRepositorySyncSessionV1,
} from './lib/hermetic-git-runtime';

export interface ReachabilityResult {
  readonly ok: boolean;
  /** Human-actionable failure reason; undefined when ok. */
  readonly reason?: string;
}

function gitStatus(
  session: HermeticGitRepositorySyncSessionV1,
  query: HermeticGitReadQueryV1,
): number {
  try {
    return session.readText(query).status;
  } catch {
    return 128;
  }
}

function canonicalReachabilityRef(ref: string): string {
  return ref.startsWith('origin/') ? `refs/remotes/${ref}` : ref;
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
  return HERMETIC_GIT_RUNTIME.withRepositorySync(repoRoot, (session) => {
    const canonicalRef = canonicalReachabilityRef(ref);
    if (
      gitStatus(session, {
        kind: 'RESOLVE_OBJECT',
        revision: canonicalRef,
        peel: 'COMMIT',
        quiet: true,
      }) !== 0
    ) {
      return {
        ok: false,
        reason:
          `ref "${ref}" does not resolve to a commit in this checkout. ` +
          `Run \`git fetch origin main\` (or fetch the relevant ref) and retry — ` +
          `the reachability guard refuses to certify against an invisible ref.`,
      };
    }

    if (
      gitStatus(session, {
        kind: 'RESOLVE_OBJECT',
        revision: sha,
        peel: 'COMMIT',
        quiet: true,
      }) !== 0
    ) {
      return {
        ok: false,
        reason: `commit "${sha}" is unknown to this repository — fetch it or check the SHA.`,
      };
    }

    const ancestorStatus = gitStatus(session, {
      kind: 'IS_ANCESTOR',
      ancestor: sha,
      descendant: canonicalRef,
    });
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
  });
}
