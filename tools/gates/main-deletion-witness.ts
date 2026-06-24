#!/usr/bin/env node
/**
 * main-deletion-witness — silent-regression gate for cherry-pick PRs.
 *
 * Purpose
 * ============================================================================
 * Git's three-way auto-merge keys on line-level hunk context, not semantic
 * content. When main deletes a block of code and our branch touched only
 * unrelated lines in the same file, the merge can silently resurrect the
 * deleted block. The 2026-04-24 failed merge of origin/main into
 * agentic-rust-unified caught exactly this on
 * apps/farm-service/src/batch/resolvers/cleaner-fish.resolver.ts: main's
 * commit f9cfa7c2 deleted two @ObjectType classes + a resolver stub, and
 * the auto-merge restored them. No conflict marker; ESLint green; tsc
 * green; test suite green — yet dead code resurrected.
 *
 * The architectural-correct detection is NOT a grep heuristic but a patch
 * reverse-apply: take every deletion main made between the merge-base and
 * origin/main, and check that HEAD would accept that same deletion
 * cleanly. Any rejected hunk = a line main deleted that still exists in
 * HEAD (or in a modified form that no longer matches the pre-deletion
 * context).
 *
 * # Algorithm
 *
 *   1. Resolve merge base:  MB = $(git merge-base origin/main HEAD)
 *   2. Compute main's patch: git diff $MB origin/main -- . > /tmp/main.patch
 *   3. Reverse-apply to HEAD: git apply --check --reverse /tmp/main.patch
 *      — success means every deletion in main's patch matches a deletable
 *        region on HEAD, i.e. we'd merge cleanly with respect to
 *        deletions.
 *      — rejection means at least one deletion doesn't apply: either we
 *        modified the context (benign — auto-merge would likely still
 *        resolve) or we still have the block main deleted (suspect).
 *   4. For each rejected hunk, print file + line range + the deleted
 *      lines so the operator can judge whether the deletion semantically
 *      still applies.
 *
 * # Usage
 *
 *   npm run gates:deletion-witness                   # current HEAD vs origin/main
 *   ts-node tools/gates/main-deletion-witness.ts --base=origin/main --head=HEAD
 *   ts-node tools/gates/main-deletion-witness.ts --report  # verbose output
 *
 * Exit codes:
 *   0  clean — no rejected deletions
 *   1  candidate regressions detected (prints list + instructions)
 *   2  invocation error (missing git base, etc.)
 *
 * # Why this is a required gate
 *
 * Every cherry-pick PR cut from origin/main for the 2026-04 cold-audit
 * remediation campaign MUST pass this gate before merging. Without it,
 * each cherry-pick can silently resurrect main-deleted code — the exact
 * regression class that sank PR #86. See
 * docs/plans/2026-04-22-cold-audit-remediation/README.md for the
 * campaign.
 */

/* eslint-disable no-console */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '../..');

interface Args {
  base: string;
  head: string;
  report: boolean;
}

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  const get = (name: string, dflt: string): string => {
    const hit = raw.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(`--${name}=`.length) || dflt : dflt;
  };
  return {
    base: get('base', 'origin/main'),
    head: get('head', 'HEAD'),
    report: raw.includes('--report'),
  };
}

function git(cmd: string, opts: { cwd?: string; capture?: boolean } = {}): string {
  const { cwd = REPO, capture = true } = opts;
  try {
    return execSync(`git ${cmd}`, {
      cwd,
      encoding: 'utf-8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    const msg = [
      `git ${cmd}`,
      e.stdout ? e.stdout.toString() : '',
      e.stderr ? e.stderr.toString() : '',
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(msg);
  }
}

function resolveRef(ref: string): string {
  return git(`rev-parse ${ref}`).trim();
}

function mergeBase(a: string, b: string): string {
  return git(`merge-base ${a} ${b}`).trim();
}

interface RejectedHunk {
  file: string;
  oldLine: number;
  trueDeletions: string[];
}

function parseReject(reject: string): RejectedHunk[] {
  // `git apply --check --reverse` prints errors to stderr. We actually
  // need to do a real --reject to get .rej files, OR parse the apply-check
  // output which names the rejecting hunk's file + hunk header.
  //
  // Output shape (stderr):
  //   error: patch failed: path/to/file.ts:123
  //   error: path/to/file.ts: patch does not apply
  //
  // We key on the first line — file:line — and cluster by file.
  const out: RejectedHunk[] = [];
  const lines = reject.split('\n');
  for (const line of lines) {
    const m = /^error: patch failed: (.+?):(\d+)$/.exec(line);
    if (m) {
      const file = m[1];
      const oldLine = m[2];
      if (!file || !oldLine) continue;
      out.push({
        file,
        oldLine: parseInt(oldLine, 10),
        trueDeletions: [],
      });
    }
  }
  return out;
}

interface HunkDeletionInfo {
  /**
   * Lines this hunk genuinely removed — `-` lines whose content does NOT
   * appear verbatim on any `+` line in the same hunk.
   *
   * Lines present on both sides of a hunk are MODIFICATIONS (main replaced
   * one shape with another); auto-merge resolves them by taking main's
   * replacement, so they are not silent-regression candidates.
   *
   * Lines present only on the `-` side are TRUE DELETIONS; if HEAD still
   * carries them, the cleaner-fish-class silent regression applies — main
   * deleted a block, our branch left it alone (or modified unrelated
   * context), auto-merge keeps our copy.
   */
  trueDeletions: string[];
}

function extractHunkInfo(patch: string, file: string, hunkStart: number): HunkDeletionInfo {
  const lines = patch.split('\n');
  let inFile = false;
  let inHunk = false;
  const minus: string[] = [];
  const plus: string[] = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      inFile = line.includes(` a/${file} `) || line.endsWith(` a/${file}`);
      inHunk = false;
      continue;
    }
    if (!inFile) continue;
    const hm = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (hm) {
      if (inHunk) break; // next hunk starts; our target hunk already scanned
      const start = hm[1];
      inHunk = start ? parseInt(start, 10) === hunkStart : false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) minus.push(line.slice(1));
    else if (line.startsWith('+')) plus.push(line.slice(1));
    else if (line.startsWith('diff ')) break;
  }
  // True deletion = appears on minus side but not on plus side of this hunk.
  const plusSet = new Set(plus);
  const trueDeletions = minus.filter((l) => !plusSet.has(l));
  return { trueDeletions };
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`[deletion-witness] base=${args.base}  head=${args.head}`);

  let baseSha: string;
  let headSha: string;
  let mb: string;
  try {
    baseSha = resolveRef(args.base);
    headSha = resolveRef(args.head);
    mb = mergeBase(baseSha, headSha);
  } catch (err) {
    console.error(`[deletion-witness] failed to resolve refs: ${(err as Error).message}`);
    process.exit(2);
  }

  console.log(`[deletion-witness] merge-base=${mb.slice(0, 8)}`);
  console.log(`[deletion-witness] base=${baseSha.slice(0, 8)}  head=${headSha.slice(0, 8)}`);

  // Compute main's patch (from merge-base to base — what main added/removed).
  const patchPath = '/tmp/main-deletion-witness.patch';
  try {
    const patch = git(`diff ${mb} ${baseSha} --`);
    writeFileSync(patchPath, patch);
  } catch (err) {
    console.error(`[deletion-witness] failed to compute base patch: ${(err as Error).message}`);
    process.exit(2);
  }

  if (!existsSync(patchPath)) {
    console.error(`[deletion-witness] patch not written: ${patchPath}`);
    process.exit(2);
  }

  // Check HEAD is currently checked out — `git apply --check` operates on
  // the working tree (or uses --cached / index). We want working-tree state
  // reflecting HEAD.
  const currentHead = resolveRef('HEAD');
  if (currentHead !== headSha) {
    console.error(
      `[deletion-witness] HEAD (${currentHead.slice(0, 8)}) does not match requested head ` +
        `(${headSha.slice(0, 8)}). Check out the head commit first or omit --head to use HEAD.`,
    );
    process.exit(2);
  }

  // Reverse-apply check — dry-run, no file modifications.
  const check = spawnSync(
    'git',
    ['apply', '--check', '--reverse', '--ignore-whitespace', patchPath],
    { cwd: REPO, encoding: 'utf-8' },
  );

  if (check.status === 0) {
    console.log('[deletion-witness] ✓ no rejected deletions — HEAD accepts main\'s patch in reverse.');
    console.log('[deletion-witness] No silent-regression candidates detected.');
    return;
  }

  // Parse the rejection output
  const stderr = check.stderr || '';
  const rejected = parseReject(stderr);

  // Enrich each rejection with the true-deletion set from main's patch
  const patch = git(`diff ${mb} ${baseSha} --`);
  for (const r of rejected) {
    const info = extractHunkInfo(patch, r.file, r.oldLine);
    r.trueDeletions = info.trueDeletions;
  }

  // Classify each rejection: TRUE silent regression requires all three —
  //   (a) merge-base's copy of the file HAD the line,
  //   (b) main's copy of the file does NOT have the line (genuine deletion),
  //   (c) HEAD's copy STILL has the line (we resurrected it).
  //
  // Lines that only satisfy (c) alone are context lines that never moved —
  // the rejection is benign context drift, not a regression.
  //
  // Trivial lines that don't signal regression on their own:
  //   - empty lines
  //   - lone `}`, `)`, `]`, `;`
  //   - JSDoc block delimiters `/**` `*/`
  //   - import-list syntax artifacts (commas alone)
  const isTrivial = (line: string): boolean => {
    const t = line.trim();
    return (
      t === '' ||
      /^[})\]],?;?$/.test(t) ||
      t === '/**' ||
      t === '*/' ||
      t === '*' ||
      /^[,;]$/.test(t)
    );
  };

  interface Classified {
    file: string;
    oldLine: number;
    resurrectedLines: string[];
  }
  const regressions: Classified[] = [];

  // Cache file content per (sha, file) to avoid repeat git-show calls.
  const fileCache = new Map<string, string>();
  const fileAt = (sha: string, path: string): string | null => {
    const key = `${sha}:${path}`;
    if (fileCache.has(key)) return fileCache.get(key) ?? null;
    try {
      const content = git(`show ${sha}:${path}`);
      fileCache.set(key, content);
      return content;
    } catch {
      fileCache.set(key, '');
      return null;
    }
  };

  for (const r of rejected) {
    if (r.trueDeletions.length === 0) continue; // hunk was a pure modification

    const headContent = fileAt(headSha, r.file);
    const baseContent = fileAt(baseSha, r.file);
    if (headContent === null) continue;

    const resurrected = r.trueDeletions.filter((l) => {
      if (isTrivial(l)) return false;
      // main genuinely removed it — not present in base (= origin/main).
      if (baseContent && baseContent.includes(l)) return false;
      // HEAD still carries it verbatim.
      return headContent.includes(l);
    });

    if (resurrected.length > 0) {
      regressions.push({
        file: r.file,
        oldLine: r.oldLine,
        resurrectedLines: resurrected,
      });
    }
  }

  console.log('');
  console.log(
    `[deletion-witness] ${rejected.length} total reject(s), ${regressions.length} classified as SILENT REGRESSION:`,
  );
  console.log('');

  if (regressions.length === 0) {
    console.log('  (all rejected hunks are benign context drift — HEAD does not still');
    console.log('   carry any non-trivial main-deleted line verbatim.)');
    console.log('');
    console.log('[deletion-witness] ✓ no silent regressions detected.');
    return;
  }

  for (const r of regressions) {
    console.log(`  ${r.file}:${r.oldLine}  (+${r.resurrectedLines.length} line(s) main deleted but HEAD still carries)`);
    if (args.report) {
      const preview = r.resurrectedLines
        .slice(0, 8)
        .map((l) => `    ${l.slice(0, 100)}`)
        .join('\n');
      console.log(preview);
      if (r.resurrectedLines.length > 8) {
        console.log(`    ... +${r.resurrectedLines.length - 8} more resurrected lines`);
      }
      console.log('');
    }
  }

  console.log('');
  console.log('# Meaning');
  console.log('');
  console.log('  Each line above is code that main deleted in its range of commits, and');
  console.log('  that still exists verbatim in HEAD. When this PR merges into main the');
  console.log('  auto-merge will silently restore the deleted block. That is a regression.');
  console.log('');
  console.log('# Resolve');
  console.log('');
  console.log('  For each flagged file, decide whether main\'s deletion still applies:');
  console.log('');
  console.log('    (i)  Yes (usually): delete the block in HEAD as well, commit, re-run.');
  console.log('    (ii) No: main\'s deletion is incorrect / should be reverted on main.');
  console.log('         Open a separate revert PR; annotate this gate run with the rationale.');
  console.log('');
  console.log('  Re-run with --report to see the resurrected lines inline.');
  console.log('');

  process.exit(1);
}

main().catch((err) => {
  console.error(`[deletion-witness] unexpected error: ${(err as Error).stack ?? err}`);
  process.exit(2);
});
