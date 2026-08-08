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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

export function ariaRepoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
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

function gitIn(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function ariaAuthorityFiles(repoRoot: string = ariaRepoRoot()): string[] {
  return gitIn(repoRoot, ['ls-files', ...AUTHORITY_GIT_PATHS])
    .split(/\r?\n/)
    .filter(isAriaAuthorityPath)
    .sort();
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
export function unstagedAuthorityFiles(repoRoot: string = ariaRepoRoot()): string[] {
  return gitIn(repoRoot, ['ls-files', '--others', '--exclude-standard', ...AUTHORITY_GIT_PATHS])
    .split(/\r?\n/)
    .filter(isAriaAuthorityPath)
    .sort();
}

export function normalizedAriaAuthorityContent(
  rel: string,
  repoRoot: string = ariaRepoRoot(),
  readText: (relativePath: string) => string = (relativePath) =>
    readFileSync(join(repoRoot, relativePath), 'utf8'),
): string {
  const body = readText(rel);
  if (rel !== CURRENT_STATE_PATH) return body;
  return body.replace(ARIA_AUTHORITY_HASH_LINE, ARIA_AUTHORITY_HASH_SENTINEL);
}

export function ariaAuthorityHash(
  repoRoot: string = ariaRepoRoot(),
  readText?: (relativePath: string) => string,
  authorityFiles: readonly string[] = ariaAuthorityFiles(repoRoot),
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
  repoRoot: string = ariaRepoRoot(),
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
  repoRoot: string = ariaRepoRoot(),
  readText?: (relativePath: string) => string,
  authorityFiles: readonly string[] = ariaAuthorityFiles(repoRoot),
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

export function writeAriaAuthorityHash(repoRoot: string = ariaRepoRoot()): {
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
  const to = ariaAuthorityHash(repoRoot);
  if (from === to) return { from, to, changed: false };
  writeFileSync(
    path,
    body.replace(ARIA_AUTHORITY_HASH_LINE, `Last verified ARIA authority hash: \`${to}\``),
    'utf8',
  );
  return { from, to, changed: true };
}

function main(argv: string[]): number {
  const repoRoot = ariaRepoRoot();
  if (!argv.includes('--write')) {
    process.stdout.write(`${ariaAuthorityHash(repoRoot)}\n`);
    return 0;
  }
  // PRECONDITION — refuse rather than write a digest the commit will not have.
  const untracked = unstagedAuthorityFiles(repoRoot);
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
  const { from, to, changed } = writeAriaAuthorityHash(repoRoot);
  process.stdout.write(
    changed
      ? `aria authority hash: ${from ?? '(none)'} -> ${to}\n`
      : `aria authority hash: already current (${to})\n`,
  );
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
