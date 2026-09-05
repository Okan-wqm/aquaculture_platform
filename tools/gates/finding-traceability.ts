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
  /**
   * Historical ids that name this same finding in merged commit trailers,
   * from `docs/reviews/_registry/finding-id-aliases.yaml`. A trailer written
   * before an integration renumbered the finding cannot be amended (the
   * force-push ban), so the derivation resolves it through the alias instead.
   */
  readonly aliases?: readonly string[];
  /**
   * Closing commits an override reopen has REJECTED as closure evidence: their
   * `Closes:` trailer names this finding, but the finding was reopened on the
   * judgement that the change did not close it (a version-gated tracking
   * finding swept shut, a fix later found partial). Neither the ceremony nor
   * the derivation may count them again; only a NEW closing commit may.
   */
  readonly rejected_closing_commits?: readonly string[] | null;
}

function shaMatches(candidate: string, sha: string): boolean {
  const a = candidate.toLowerCase();
  const b = sha.toLowerCase();
  return a.length >= 7 && (a.startsWith(b) || b.startsWith(a));
}

/** True when `sha` is one of the finding's rejected closing commits. */
export function findingRejectsClosure(finding: FindingTrailerTarget, sha: string): boolean {
  return (finding.rejected_closing_commits ?? []).some((rejected) => shaMatches(rejected, sha));
}

/**
 * Closure admission guard shared by `close` and `reconcile`: a commit an
 * override reopen rejected is refused as a closer, whatever its trailer says.
 */
export function closureAdmissible(finding: FindingTrailerTarget, sha: string): TraceabilityResult {
  if (!findingRejectsClosure(finding, sha)) return { ok: true };
  return {
    ok: false,
    reason:
      `commit ${sha} was rejected as a closer of ${finding.id} by an override reopen ` +
      `(rejected_closing_commits). The finding closes only through a NEW commit that ` +
      `carries its Closes: trailer.`,
  };
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
  for (const alias of finding.aliases ?? []) {
    // An alias is a different NAME for this finding, not a different finding:
    // the review-file binding still applies, so the alias is matched under the
    // same rules rather than as a free-text escape hatch.
    if (commitMessageClosesFindingExactly(message, { ...finding, id: alias, aliases: [] })) {
      return true;
    }
  }
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
