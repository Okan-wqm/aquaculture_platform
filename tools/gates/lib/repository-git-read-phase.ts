import { errorFromUnknown } from './error-cause';
import {
  HERMETIC_GIT_RUNTIME,
  type HermeticGitReadQueryV1,
  type HermeticGitRepositorySyncSessionV1,
} from './hermetic-git-runtime';

export interface RepositoryGitTextResultV1 {
  readonly status: number;
  readonly stdout: string;
}

export type RepositoryGitTextReaderV1 = (
  query: HermeticGitReadQueryV1,
) => RepositoryGitTextResultV1;

export interface RepositoryGitGlobalCoordinatesV1 {
  readonly head: RepositoryGitTextResultV1;
  readonly localHeads: RepositoryGitTextResultV1;
  readonly originRemotes: RepositoryGitTextResultV1;
  readonly replaceRefs: RepositoryGitTextResultV1;
  readonly symbolicHead: RepositoryGitTextResultV1;
  readonly worktrees: RepositoryGitTextResultV1;
}

type RepositoryGitSynchronousResult<T> = T & (T extends PromiseLike<unknown> ? never : unknown);

function sessionTextReader(session: HermeticGitRepositorySyncSessionV1): RepositoryGitTextReaderV1 {
  return (query) => {
    const result = session.readText(query);
    return Object.freeze({ status: result.status, stdout: result.stdout });
  };
}

export function captureRepositoryGitGlobalCoordinates(
  readGit: RepositoryGitTextReaderV1,
): RepositoryGitGlobalCoordinatesV1 {
  return Object.freeze({
    head: readGit({ kind: 'RESOLVE_OBJECT', revision: 'HEAD', peel: 'COMMIT', quiet: true }),
    localHeads: readGit({
      kind: 'LIST_REFS',
      namespace: 'LOCAL_HEADS',
      projection: 'NAMES_AND_OBJECT_IDS',
    }),
    originRemotes: readGit({
      kind: 'LIST_REFS',
      namespace: 'ORIGIN_REMOTES',
      projection: 'NAMES_AND_OBJECT_IDS',
    }),
    replaceRefs: readGit({
      kind: 'LIST_REFS',
      namespace: 'REPLACE',
      projection: 'NAMES_AND_OBJECT_IDS',
    }),
    symbolicHead: readGit({ kind: 'SYMBOLIC_HEAD' }),
    worktrees: readGit({ kind: 'LIST_WORKTREES' }),
  });
}

export function assertRepositoryGitGlobalCoordinatesStable(
  label: string,
  start: RepositoryGitGlobalCoordinatesV1,
  end: RepositoryGitGlobalCoordinatesV1,
): void {
  for (const coordinate of Object.keys(start).sort() as Array<
    keyof RepositoryGitGlobalCoordinatesV1
  >) {
    const initial = start[coordinate];
    const final = end[coordinate];
    if (initial.status !== final.status || initial.stdout !== final.stdout) {
      throw new Error(
        `${label} repository ${coordinate} coordinate changed during its Git read phase`,
      );
    }
  }
}

/**
 * The sole source-inventory Git phase kernel. Every semantic read shares one descriptor-bound
 * session and the complete ref/HEAD/worktree coordinate surface is byte-compared at both edges.
 */
export function withPinnedRepositoryGitReadPhase<T>(
  worktreePath: string,
  label: string,
  action: (
    readGit: RepositoryGitTextReaderV1,
    coordinates: RepositoryGitGlobalCoordinatesV1,
  ) => RepositoryGitSynchronousResult<T>,
): T {
  return HERMETIC_GIT_RUNTIME.withRepositorySync(
    worktreePath,
    (session): RepositoryGitSynchronousResult<T> => {
      const readGit = sessionTextReader(session);
      const start = captureRepositoryGitGlobalCoordinates(readGit);
      let result: T | undefined;
      let actionFailure: unknown;
      try {
        result = action(readGit, start);
      } catch (error) {
        actionFailure = error;
      }
      let coordinateFailure: unknown;
      try {
        assertRepositoryGitGlobalCoordinatesStable(
          label,
          start,
          captureRepositoryGitGlobalCoordinates(readGit),
        );
      } catch (error) {
        coordinateFailure = error;
      }
      if (actionFailure !== undefined && coordinateFailure !== undefined) {
        throw new AggregateError(
          [actionFailure, coordinateFailure],
          `${label} action and repository coordinate validation failed`,
        );
      }
      if (actionFailure !== undefined) {
        throw errorFromUnknown(`${label} repository action failed`, actionFailure);
      }
      if (coordinateFailure !== undefined) {
        throw errorFromUnknown(
          `${label} repository coordinate validation failed`,
          coordinateFailure,
        );
      }
      return result as RepositoryGitSynchronousResult<T>;
    },
  );
}
