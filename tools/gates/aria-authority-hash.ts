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

function gitIn(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function ariaAuthorityFiles(repoRoot: string = ariaRepoRoot()): string[] {
  const tracked = gitIn(repoRoot, ['ls-files', ...AUTHORITY_ROOTS])
    .split(/\r?\n/)
    .filter(Boolean);
  const workflowFiles = gitIn(repoRoot, ['ls-files', '.github/workflows'])
    .split(/\r?\n/)
    .filter((rel) => /^\.github\/workflows\/aria-[^/]+\.ya?ml$/.test(rel));
  return [...new Set([...tracked, ...workflowFiles])].sort();
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
  return gitIn(repoRoot, ['ls-files', '--others', '--exclude-standard', ...AUTHORITY_ROOTS])
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
}

export function normalizedAriaAuthorityContent(
  rel: string,
  repoRoot: string = ariaRepoRoot(),
): string {
  const body = readFileSync(join(repoRoot, rel), 'utf8');
  if (rel !== CURRENT_STATE_PATH) return body;
  return body.replace(ARIA_AUTHORITY_HASH_LINE, ARIA_AUTHORITY_HASH_SENTINEL);
}

export function ariaAuthorityHash(repoRoot: string = ariaRepoRoot()): string {
  const hash = createHash('sha256');
  for (const rel of ariaAuthorityFiles(repoRoot)) {
    hash.update(rel);
    hash.update('\0');
    hash.update(normalizedAriaAuthorityContent(rel, repoRoot));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Returns the hash recorded in CURRENT_STATE, or null if the line is absent. */
export function recordedAriaAuthorityHash(repoRoot: string = ariaRepoRoot()): string | null {
  const body = readFileSync(join(repoRoot, CURRENT_STATE_PATH), 'utf8');
  return body.match(/Last verified ARIA authority hash: `([a-f0-9]{64})`/)?.[1] ?? null;
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
  // WHY --check: the tool could print the digest and it could write it, but it
  // could not ANSWER "is the declared pin current?" without the caller doing
  // the string comparison itself. That left the question to CI, which answers
  // it thirty minutes later. --check answers in a second and exits non-zero
  // naming both digests, so a hook can stand on it.
  if (argv.includes('--check')) {
    const expected = ariaAuthorityHash(repoRoot);
    const declared = recordedAriaAuthorityHash(repoRoot);
    if (declared === expected) {
      process.stdout.write(`aria authority hash: current (${expected})\n`);
      return 0;
    }
    process.stderr.write(
      'aria authority hash: STALE pin.\n' +
        `  declared in docs/aria/CURRENT_STATE.md: ${declared ?? '(none)'}\n` +
        `  computed from the authority surface:    ${expected}\n` +
        '  A merge commit runs no pre-commit, so `git merge origin/main` can move\n' +
        '  the surface and leave the pin behind. Fix it here, not in CI:\n' +
        '    npm run aria:authority-hash:write && git add docs/aria/CURRENT_STATE.md\n',
    );
    return 1;
  }
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
