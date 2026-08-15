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

export interface CommitMessageObservationV1 {
  readonly oid: string;
  readonly message: string;
}

export interface CommitObservationV1 {
  readonly exists: boolean;
  readonly message: string | null;
  readonly oid: string;
  readonly resolvedOid: string | null;
}

const COMMIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40}$/;
const COMMIT_OBJECT_SIZE_PATTERN = /^(?:0|[1-9]\d*)$/;
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export function parseCommitObservationBatch(
  oids: readonly string[],
  output: Buffer,
): readonly CommitObservationV1[] {
  const observations: CommitObservationV1[] = [];
  let offset = 0;
  for (const oid of oids) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      throw new Error(`Commit observation batch has a truncated header for ${oid}`);
    }
    const header = output.subarray(offset, headerEnd).toString('ascii');
    const revision = `${oid}^{commit}`;
    if (header === `${revision} missing`) {
      observations.push(Object.freeze({ exists: false, message: null, oid, resolvedOid: null }));
      offset = headerEnd + 1;
      continue;
    }
    const [resolvedOid, objectType, rawSize, ...unexpected] = header.split(' ');
    const objectSize = Number.parseInt(rawSize ?? '', 10);
    if (
      unexpected.length !== 0 ||
      resolvedOid === undefined ||
      !COMMIT_OBJECT_ID_PATTERN.test(resolvedOid) ||
      objectType !== 'commit' ||
      !COMMIT_OBJECT_SIZE_PATTERN.test(rawSize ?? '') ||
      !Number.isSafeInteger(objectSize)
    ) {
      throw new Error(`Commit observation batch has an invalid header for ${oid}: ${header}`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + objectSize;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      throw new Error(`Commit observation batch has truncated content for ${oid}`);
    }
    const content = output.subarray(contentStart, contentEnd);
    const messageStartDelimiter = content.indexOf(Buffer.from('\n\n', 'ascii'));
    if (messageStartDelimiter < 0) {
      throw new Error(`Commit observation batch has no message boundary for ${oid}`);
    }
    let message: string;
    try {
      message = FATAL_UTF8_DECODER.decode(content.subarray(messageStartDelimiter + 2));
    } catch {
      throw new Error(`Commit observation batch has a non-UTF-8 message for ${oid}`);
    }
    observations.push(Object.freeze({ exists: true, message, oid, resolvedOid }));
    offset = contentEnd + 1;
  }
  if (offset !== output.length) {
    throw new Error('Commit observation batch has unconsumed trailing bytes');
  }
  return Object.freeze(observations);
}

export function readCommitObservations(
  repoRoot: string,
  shas: readonly string[],
): readonly CommitObservationV1[] {
  if (new Set(shas).size !== shas.length) {
    throw new TypeError('Commit observation batch contains duplicate object IDs');
  }
  if (shas.length === 0) return Object.freeze([]);
  return HERMETIC_GIT_RUNTIME.withRepositorySync(repoRoot, (session) =>
    parseCommitObservationBatch(
      shas,
      session.read({ kind: 'READ_COMMIT_BATCH', oids: shas }).stdout,
    ),
  );
}

export function readCommitMessages(
  repoRoot: string,
  shas: readonly string[],
): readonly CommitMessageObservationV1[] {
  return Object.freeze(
    readCommitObservations(repoRoot, shas).map((observation) => {
      if (!observation.exists || observation.message === null) {
        throw new Error(`Commit ${observation.oid} does not resolve to a commit object`);
      }
      return Object.freeze({ message: observation.message, oid: observation.oid });
    }),
  );
}

export function readCommitMessage(repoRoot: string, sha: string): string {
  const observation = readCommitMessages(repoRoot, [sha])[0];
  if (observation === undefined) throw new Error('Commit-message batch returned no observation');
  return observation.message;
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
