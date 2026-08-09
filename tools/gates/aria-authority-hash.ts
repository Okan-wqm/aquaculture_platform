/**
 * The ARIA authority hash — one implementation, two consumers.
 *
 * `docs/aria/CURRENT_STATE.md` carries a `Last verified ARIA authority hash`
 * line covering every tracked file under `docs/aria/`, `aria-kernel/`,
 * `tools/aria-poc/`, and the `aria-*` workflows. It is what makes the document
 * falsifiable: a stale hash means CURRENT_STATE is describing a runtime that has
 * since moved, and `aria-doc-runtime-ssot.spec.ts` goes red.
 *
 * WHY THIS FILE EXISTS: the hash had no producer. The spec computed it and
 * compared; refreshing it meant reading the expected value out of a Jest
 * failure and pasting it in by hand. That is the same trap the debt-plan
 * manifest was in — a mirrored value with a checker and no writer — and it
 * failed the same way, going stale the moment a kernel module changed.
 *
 * The recompute-and-write path lives here rather than in the spec so that the
 * writer and the checker cannot drift: a script that reimplements the digest
 * would confidently write a value the spec then rejects, which is worse than no
 * script. The spec imports `ariaAuthorityHash` from this module, so there is
 * exactly one definition of what the hash covers.
 *
 * CLI:
 *   ts-node tools/gates/aria-authority-hash.ts           # print, exit 0
 *   ts-node tools/gates/aria-authority-hash.ts --write    # rewrite the line
 *
 * `--write` is idempotent and rewrites only the 64 hex characters inside the
 * sentinel line. It touches no prose, because the prose is a human claim about
 * the runtime and recomputing a digest does not re-verify it.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import { errorWithCause } from './lib/error-cause';
import {
  HERMETIC_GIT_EXECUTION_POLICY_V1,
  HERMETIC_GIT_RUNTIME,
  runWithHermeticGitExecutionBudget,
  type HermeticGitReadQueryV1,
} from './lib/hermetic-git-runtime';

export const CURRENT_STATE_PATH = 'docs/aria/CURRENT_STATE.md';

/** The placeholder the hash line is normalized to before hashing itself. */
export const ARIA_AUTHORITY_HASH_SENTINEL =
  'Last verified ARIA authority hash: `ARIA_AUTHORITY_HASH_SENTINEL`';

/**
 * Matches the line in either state — already-hashed or sentinel — so the digest
 * is a fixed point: hashing the document with its own hash line collapsed to
 * the sentinel yields a value that stays valid once written back.
 */
export const ARIA_AUTHORITY_HASH_LINE =
  /Last verified ARIA authority hash: `(?:[a-f0-9]{64}|ARIA_AUTHORITY_HASH_SENTINEL)`/;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

type AriaAuthorityGitQueryV1 = Extract<
  HermeticGitReadQueryV1,
  {
    readonly kind: 'REPOSITORY_COORDINATE' | 'LIST_INDEX_PATHS' | 'LIST_TREE';
  }
>;

export interface AriaAuthorityGitReaderV1 {
  readonly schemaVersion: 1;
  read(repoRoot: string, query: AriaAuthorityGitQueryV1, signal: AbortSignal): Promise<Buffer>;
}

interface AriaAuthorityGitOperationAuthorityV1 extends AriaAuthorityGitReaderV1 {
  withRepositoryOperation<T>(
    repoRoot: string,
    signal: AbortSignal,
    action: (reader: AriaAuthorityGitReaderV1) => Promise<T>,
  ): Promise<T>;
}

function readAriaAuthorityGitQuery(
  repoRoot: string,
  query: AriaAuthorityGitQueryV1,
  signal: AbortSignal,
): Promise<Buffer> {
  return runWithHermeticGitExecutionBudget(
    HERMETIC_GIT_EXECUTION_POLICY_V1.commandDeadlineMs,
    signal,
    async () =>
      HERMETIC_GIT_RUNTIME.withRepository(
        repoRoot,
        async (session) => (await session.readAsync(query)).stdout,
      ),
  );
}

/** The sole production Git read authority for ARIA inventory discovery. */
export const HERMETIC_ARIA_AUTHORITY_GIT_READER_V1: AriaAuthorityGitOperationAuthorityV1 =
  Object.freeze({
    schemaVersion: 1,
    read: readAriaAuthorityGitQuery,
    withRepositoryOperation: <T>(
      repoRoot: string,
      signal: AbortSignal,
      action: (reader: AriaAuthorityGitReaderV1) => Promise<T>,
    ): Promise<T> =>
      HERMETIC_GIT_RUNTIME.withRepository(repoRoot, (session) => {
        const operationReader: AriaAuthorityGitReaderV1 = Object.freeze({
          schemaVersion: 1,
          read: (
            requestedRoot: string,
            query: AriaAuthorityGitQueryV1,
            operationSignal: AbortSignal,
          ): Promise<Buffer> => {
            if (requestedRoot !== repoRoot) {
              return Promise.reject(
                new Error('ARIA Git operation reader cannot cross repository roots'),
              );
            }
            return runWithHermeticGitExecutionBudget(
              HERMETIC_GIT_EXECUTION_POLICY_V1.commandDeadlineMs,
              operationSignal,
              async () => (await session.readAsync(query)).stdout,
            );
          },
        });
        assertAriaGitReadNotAborted(signal);
        return action(operationReader);
      }),
  });

function assertAriaGitReadNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw errorWithCause('ARIA authority Git read was aborted', signal.reason);
}

function decodeAriaGitText(raw: Buffer, label: string): string {
  try {
    return utf8Decoder.decode(raw);
  } catch (error) {
    throw errorWithCause(`${label} is not valid UTF-8`, error);
  }
}

function splitAriaGitNulPaths(raw: Buffer, label: string): string[] {
  if (raw.length === 0) return [];
  if (raw.at(-1) !== 0) throw new Error(`${label} is not NUL terminated`);
  return decodeAriaGitText(raw.subarray(0, -1), label).split('\0');
}

export async function ariaRepoRoot(
  signal: AbortSignal,
  gitReader: AriaAuthorityGitReaderV1 = HERMETIC_ARIA_AUTHORITY_GIT_READER_V1,
): Promise<string> {
  assertAriaGitReadNotAborted(signal);
  const root = decodeAriaGitText(
    await gitReader.read(
      resolve(process.cwd()),
      { kind: 'REPOSITORY_COORDINATE', coordinate: 'TOP_LEVEL' },
      signal,
    ),
    'ARIA repository root',
  ).trim();
  assertAriaGitReadNotAborted(signal);
  if (root.length === 0) throw new Error('ARIA repository root is empty');
  return resolve(root);
}

/**
 * Every tracked file the hash covers, sorted.
 *
 * Tracked-only on purpose: an untracked scratch file under `aria-kernel/` is
 * not part of the authority chain, and letting one move the digest would make
 * the spec fail for a file no reviewer can see.
 */
const AUTHORITY_ROOTS = ['docs/aria', 'aria-kernel', 'tools/aria-poc'] as const;
const AUTHORITY_GIT_PATHS = [...AUTHORITY_ROOTS, '.github/workflows'] as const;

function isAriaAuthorityPath(rel: string): boolean {
  return (
    AUTHORITY_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`)) ||
    /^\.github\/workflows\/aria-[^/]+\.ya?ml$/.test(rel)
  );
}

export function selectAriaAuthorityFiles(paths: readonly string[]): string[] {
  const selected = paths.filter(isAriaAuthorityPath).sort();
  const duplicate = selected.find((path, index) => selected.indexOf(path) !== index);
  if (duplicate !== undefined) {
    throw new Error(`ARIA authority Git inventory contains a duplicate path: ${duplicate}`);
  }
  return selected;
}

export async function ariaAuthorityFiles(
  repoRoot: string,
  signal: AbortSignal,
  gitReader: AriaAuthorityGitReaderV1 = HERMETIC_ARIA_AUTHORITY_GIT_READER_V1,
): Promise<string[]> {
  assertAriaGitReadNotAborted(signal);
  const paths = splitAriaGitNulPaths(
    await gitReader.read(
      repoRoot,
      { kind: 'LIST_INDEX_PATHS', selection: 'TRACKED', roots: AUTHORITY_GIT_PATHS },
      signal,
    ),
    'ARIA index authority path stream',
  );
  assertAriaGitReadNotAborted(signal);
  return selectAriaAuthorityFiles(paths);
}

export async function ariaAuthorityFilesAtRevision(
  repoRoot: string,
  revision: string,
  signal: AbortSignal,
  gitReader: AriaAuthorityGitReaderV1 = HERMETIC_ARIA_AUTHORITY_GIT_READER_V1,
): Promise<string[]> {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`ARIA authority revision is not one full SHA-1 object ID: ${revision}`);
  }
  assertAriaGitReadNotAborted(signal);
  const paths = splitAriaGitNulPaths(
    await gitReader.read(
      repoRoot,
      {
        kind: 'LIST_TREE',
        revision,
        projection: 'PATHS',
        recursive: true,
        paths: AUTHORITY_GIT_PATHS,
      },
      signal,
    ),
    'ARIA committed authority path stream',
  );
  assertAriaGitReadNotAborted(signal);
  return selectAriaAuthorityFiles(paths);
}

/**
 * Authority-root files that exist on disk but are not in the index.
 *
 * The digest is defined over `git ls-files`, so an untracked file is invisible
 * to it — and then becomes visible the instant it is staged. That gap is a
 * trap with teeth: write the hash, `git add` a new kernel test, commit, and CI
 * computes a different digest from the same commit you just validated locally.
 * It cost one red build before this guard existed. `--others
 * --exclude-standard` is the same expression `tools/quality/format-scope.json`
 * uses to answer "what will the commit contain".
 */
export async function unstagedAuthorityFiles(
  repoRoot: string,
  signal: AbortSignal,
  gitReader: AriaAuthorityGitReaderV1 = HERMETIC_ARIA_AUTHORITY_GIT_READER_V1,
): Promise<string[]> {
  assertAriaGitReadNotAborted(signal);
  const paths = splitAriaGitNulPaths(
    await gitReader.read(
      repoRoot,
      {
        kind: 'LIST_INDEX_PATHS',
        selection: 'UNTRACKED_STANDARD',
        roots: AUTHORITY_GIT_PATHS,
      },
      signal,
    ),
    'ARIA untracked authority path stream',
  );
  assertAriaGitReadNotAborted(signal);
  return selectAriaAuthorityFiles(paths);
}

export function normalizedAriaAuthorityContent(
  rel: string,
  repoRoot: string,
  readText: (relativePath: string) => string = (relativePath) =>
    readFileSync(join(repoRoot, relativePath), 'utf8'),
): string {
  const body = readText(rel);
  if (rel !== CURRENT_STATE_PATH) return body;
  return body.replace(ARIA_AUTHORITY_HASH_LINE, ARIA_AUTHORITY_HASH_SENTINEL);
}

export function ariaAuthorityHash(
  repoRoot: string,
  readText: ((relativePath: string) => string) | undefined,
  authorityFiles: readonly string[],
): string {
  const hash = createHash('sha256');
  for (const rel of authorityFiles) {
    hash.update(rel);
    hash.update('\0');
    hash.update(normalizedAriaAuthorityContent(rel, repoRoot, readText));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Returns the hash recorded in CURRENT_STATE, or null if the line is absent. */
export function recordedAriaAuthorityHash(
  repoRoot: string,
  readText: (relativePath: string) => string = (relativePath) =>
    readFileSync(join(repoRoot, relativePath), 'utf8'),
): string | null {
  const body = readText(CURRENT_STATE_PATH);
  return body.match(/Last verified ARIA authority hash: `([a-f0-9]{64})`/)?.[1] ?? null;
}

/**
 * Prove that the committed ARIA runtime authority and its compact document link agree.
 * Consumers hash-link CURRENT_STATE instead of copying the kernel's large file inventory, while
 * this assertion prevents a stale link from hiding any runtime change.
 */
export function assertAriaAuthorityHashCurrent(
  repoRoot: string,
  readText: ((relativePath: string) => string) | undefined,
  authorityFiles: readonly string[],
): string {
  const recorded = recordedAriaAuthorityHash(repoRoot, readText);
  const current = ariaAuthorityHash(repoRoot, readText, authorityFiles);
  if (recorded === null || recorded !== current) {
    throw new Error(
      `${CURRENT_STATE_PATH} ARIA authority hash is stale: recorded=${recorded ?? '(missing)'} current=${current}`,
    );
  }
  return current;
}

export function writeAriaAuthorityHash(
  repoRoot: string,
  authorityFiles: readonly string[],
): {
  from: string | null;
  to: string;
  changed: boolean;
} {
  const path = join(repoRoot, CURRENT_STATE_PATH);
  const body = readFileSync(path, 'utf8');
  if (!ARIA_AUTHORITY_HASH_LINE.test(body)) {
    throw new Error(`${CURRENT_STATE_PATH} has no 'Last verified ARIA authority hash' line`);
  }
  const from = recordedAriaAuthorityHash(repoRoot);
  const to = ariaAuthorityHash(repoRoot, undefined, authorityFiles);
  if (from === to) return { from, to, changed: false };
  writeFileSync(
    path,
    body.replace(ARIA_AUTHORITY_HASH_LINE, `Last verified ARIA authority hash: \`${to}\``),
    'utf8',
  );
  return { from, to, changed: true };
}

async function main(argv: string[]): Promise<number> {
  const signal = new AbortController().signal;
  const repoRoot = await ariaRepoRoot(signal);
  return HERMETIC_ARIA_AUTHORITY_GIT_READER_V1.withRepositoryOperation(
    repoRoot,
    signal,
    async (gitReader) => {
      const authorityFiles = await ariaAuthorityFiles(repoRoot, signal, gitReader);
      if (!argv.includes('--write')) {
        process.stdout.write(`${ariaAuthorityHash(repoRoot, undefined, authorityFiles)}\n`);
        return 0;
      }
      // PRECONDITION — refuse rather than write a digest the commit will not have.
      const untracked = await unstagedAuthorityFiles(repoRoot, signal, gitReader);
      if (untracked.length > 0) {
        process.stderr.write(
          'aria authority hash: refusing — untracked files under the authority roots.\n' +
            '  The digest is computed from `git ls-files`, so these are invisible to it now\n' +
            '  and visible the moment they are staged. Writing the hash first produces a\n' +
            '  value the committed tree does not match, and CI is where you find out.\n' +
            '  `git add` them (or ignore them), then re-run.\n' +
            untracked.map((rel) => `    ${rel}\n`).join(''),
        );
        return 1;
      }
      const finalAuthorityFiles = await ariaAuthorityFiles(repoRoot, signal, gitReader);
      if (JSON.stringify(finalAuthorityFiles) !== JSON.stringify(authorityFiles)) {
        throw new Error('ARIA authority index changed while preparing its hash');
      }
      const { from, to, changed } = writeAriaAuthorityHash(repoRoot, authorityFiles);
      process.stdout.write(
        changed
          ? `aria authority hash: ${from ?? '(none)'} -> ${to}\n`
          : `aria authority hash: already current (${to})\n`,
      );
      return 0;
    },
  );
}

if (require.main === module) {
  void main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
