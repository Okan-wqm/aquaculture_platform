import { execFileSync } from 'node:child_process';

import { repoPinnedEnv } from './git-reachability';

export interface TraceabilityResult {
  readonly ok: boolean;
  readonly reason?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findingCloseTrailerRegex(findingId: string): RegExp {
  const idPattern = escapeRegExp(findingId);
  return new RegExp(`^Closes:\\s+.*\\b(${idPattern}|BACKLOG-[A-Z0-9_-]+)\\b`, 'm');
}

export function commitMessageClosesFinding(message: string, findingId: string): boolean {
  return findingCloseTrailerRegex(findingId).test(message);
}

/** The review-file anchor and id a `Closes:` trailer names, when it names one. */
export interface FindingTrailerTarget {
  readonly id: string;
  readonly review_file?: string;
}

function normalizeReviewPath(value: string): string {
  return value.replace(/^`|`$/g, '').replace(/^\.\//, '');
}

/**
 * Closure DERIVATION matcher — stricter than the commit-msg gate above.
 *
 * `commitMessageClosesFinding` answers "may this commit be recorded against
 * this finding?" and therefore accepts a `BACKLOG-*` trailer for any id. That is
 * the right leniency at commit time and the wrong one when merged history is
 * read back to decide what is closed: one `Closes: BACKLOG-NATS-002` on main
 * would mark every finding in the registry RESOLVED, and an id the registry
 * reused across numbering epochs would be closed by a commit that cited a
 * different review file. Here a trailer closes a finding only when it names
 * the id itself, and — when it carries a `<review-file>#<id>` anchor — only
 * when that file is the finding's own review_file.
 */
export function commitMessageClosesFindingExactly(
  message: string,
  finding: FindingTrailerTarget,
): boolean {
  const idPattern = escapeRegExp(finding.id);
  const anchored = new RegExp(`^Closes:\\s+(\\S+?)#${idPattern}\\b`, 'gm');
  const bare = new RegExp(
    `^Closes:\\s+(?:[^#\\n]*\\s)?${idPattern}\\b(?![^\\n]*#${idPattern})`,
    'm',
  );
  const own =
    finding.review_file === undefined ? undefined : normalizeReviewPath(finding.review_file);
  for (const match of message.matchAll(anchored)) {
    const cited = match[1];
    if (cited === undefined) continue;
    if (own === undefined || normalizeReviewPath(cited) === own) return true;
  }
  return bare.test(message);
}

export function readCommitMessage(repoRoot: string, sha: string): string {
  return execFileSync('git', ['-C', repoRoot, 'show', '-s', '--format=%B', sha], {
    encoding: 'utf8',
    env: repoPinnedEnv(),
  });
}

export function commitHasFindingCloseTrailer(
  repoRoot: string,
  sha: string,
  findingId: string,
): TraceabilityResult {
  let message: string;
  try {
    message = readCommitMessage(repoRoot, sha);
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return {
      ok: false,
      reason:
        `commit ${sha} message is unreadable` +
        (typeof e.status === 'number' ? ` (git status ${e.status})` : '') +
        (e.message ? `: ${e.message}` : '.'),
    };
  }

  if (commitMessageClosesFinding(message, findingId)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      `commit ${sha} does not contain a Closes: trailer for ${findingId}. ` +
      `Record the main-reachable commit that carries the finding trailer; ` +
      `merge commits without the trailer are not valid registry closers.`,
  };
}
