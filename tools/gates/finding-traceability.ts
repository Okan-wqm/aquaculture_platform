import { HERMETIC_GIT_RUNTIME } from './lib/hermetic-git-runtime';

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

export function readCommitMessage(repoRoot: string, sha: string): string {
  return HERMETIC_GIT_RUNTIME.runText(repoRoot, ['show', '-s', '--format=%B', sha]).stdout;
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
