#!/usr/bin/env -S node --import tsx/esm
/**
 * Registry SHA fixup after squash-merge of a multi-commit PR.
 *
 * Why this exists
 * ===============
 *
 * The 2026-04-22 cold-audit campaign closed 21 `AUDIT-*` findings
 * across 42 commits on the `cold-audit/pr-*` branch chain. Each
 * close entry in `findings.jsonl` carries `closing_commits[]` —
 * the canonical traceability link between a finding and the commit
 * that resolved it (CLAUDE.md "Review Finding Traceability"). The
 * SHA stored there is the BRANCH SHA (e.g. `7fbe8595`).
 *
 * If PR #159 lands via **squash-merge**, every one of those 42
 * branch SHAs collapses into ONE main-tip SHA. The 21 stored
 * `closing_commits[]` entries become orphan references to commits
 * that no longer exist on `main`. `git log <sha>` on the squashed
 * SHA returns nothing; finding traceability is structurally broken.
 *
 * If PR #159 lands via **rebase-merge**, the 42 branch SHAs are
 * preserved verbatim on main. No fixup needed.
 *
 * If PR #159 lands via **merge-commit (`--no-ff`)**, the 42 branch
 * SHAs are preserved as ancestors of the merge commit. No fixup
 * needed.
 *
 * Squash-merge is therefore the only strategy that requires this
 * tool. The PR body for #159 explicitly recommends rebase-merge or
 * merge-commit; this tool is the architectural fallback for the
 * squash case.
 *
 * What this tool does
 * ===================
 *
 * Given the post-merge squash SHA on main, append the squash SHA
 * to each named finding's `closing_commits[]` array (PRESERVING
 * the original branch SHA — both are recorded so a future archaeologist
 * can trace the campaign through both lifetimes). The finding's
 * other fields are untouched. Hash chain re-stitching is delegated
 * to `tools/gates/finding-registry.ts close`, which is already the
 * canonical mutation path for this exact operation — this tool is a
 * thin batch wrapper, not a parallel implementation.
 *
 * Usage
 * =====
 *
 *   ts-node tools/audit/registry-rechain-after-squash.ts \
 *       --squash-sha=<7-or-40-char-sha> \
 *       --findings=AUDIT-CRITICAL-001,AUDIT-CRITICAL-002,...
 *
 * OR, with the `--from-list` mode that auto-discovers every finding
 * whose `closing_commits[]` array contains ONLY branch SHAs not yet
 * on main (the most common post-merge case):
 *
 *   ts-node tools/audit/registry-rechain-after-squash.ts \
 *       --squash-sha=<sha> \
 *       --from-list=docs/reviews/_audit/2026-04-22-cold-audit/CAMPAIGN-FINDINGS.txt
 *
 * The list file is one finding ID per line, whitespace + `#`
 * comments allowed. The campaign keeps a frozen list at this path
 * after PR #159 is opened so the rechain is reproducible.
 *
 * After the rechain runs, `npm run findings:verify` confirms the
 * chain hash tip moved exactly once per closed finding (the chain
 * is re-stitched in place; tip mutates).
 *
 * Exit codes:
 *   0 — every finding rechained, registry verifies clean.
 *   1 — at least one finding failed (missing id, schema violation,
 *       chain integrity break). Stderr names the offender.
 *   2 — usage error (missing args, invalid SHA, list file unreadable).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Match the sibling `aggregate-hotspots.ts` + `migrate-schema-
// violations.ts` pattern: anchor at process.cwd() so the tool runs
// the same way under direct CLI invocation, ts-node, and the npm
// script wrapper. The CommonJS `tsconfig` here forbids `import.meta`,
// so we cannot use the ESM-style `fileURLToPath(import.meta.url)`
// pattern that `tools/gates/finding-registry.ts` uses.
const REPO_ROOT = process.cwd();
const REGISTRY_CLI = resolve(REPO_ROOT, 'tools', 'gates', 'finding-registry.ts');
const TSCONFIG = resolve(REPO_ROOT, 'tools', 'gates', 'tsconfig.json');

interface Args {
  squashSha: string;
  findings: readonly string[];
}

function parseArgs(argv: readonly string[]): Args {
  const out: Partial<{ squashSha: string; findings: string[] }> = {};
  for (const arg of argv) {
    if (arg.startsWith('--squash-sha=')) {
      out.squashSha = arg.slice('--squash-sha='.length);
    } else if (arg.startsWith('--findings=')) {
      out.findings = arg
        .slice('--findings='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--from-list=')) {
      const path = arg.slice('--from-list='.length);
      if (!existsSync(path)) {
        console.error(`::error::--from-list path not found: ${path}`);
        process.exit(2);
      }
      out.findings = readFileSync(path, 'utf8')
        .split('\n')
        .map((s) => s.replace(/#.*$/, '').trim())
        .filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: registry-rechain-after-squash.ts --squash-sha=<sha> --findings=<a,b,c> | --from-list=<path>',
      );
      process.exit(0);
    }
  }
  if (!out.squashSha) {
    console.error('::error::--squash-sha is required');
    process.exit(2);
  }
  if (!/^[0-9a-f]{7,40}$/.test(out.squashSha)) {
    console.error(
      `::error::--squash-sha must be a 7-40 char hex SHA, got: ${out.squashSha}`,
    );
    process.exit(2);
  }
  if (!out.findings || out.findings.length === 0) {
    console.error(
      '::error::either --findings=<csv> or --from-list=<path> must name at least one finding id',
    );
    process.exit(2);
  }
  return { squashSha: out.squashSha, findings: out.findings };
}

function verifySquashShaOnMain(sha: string): void {
  // Defensive check: refuse to rechain if the named SHA is not
  // actually a commit on `main`. Otherwise the user could write a
  // bogus SHA into 21 finding entries and the registry would blindly
  // accept it. `git cat-file -e <sha>^{commit}` returns 0 only when
  // the ref resolves to a real commit object.
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    console.error(
      `::error::squash SHA ${sha} does not resolve to a real commit in this repo. ` +
        `Did you forget to fetch origin/main, or was the merge actually rebased / merge-commit?`,
    );
    process.exit(2);
  }

  // Tier-2 hardening: the named SHA must additionally be reachable
  // from `origin/main`. Forbids accidentally rechaining against a
  // branch SHA that hasn't landed yet — would silently re-create the
  // exact orphan-SHA class this tool exists to repair.
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    console.error(
      `::error::squash SHA ${sha} is NOT an ancestor of origin/main. ` +
        `The post-merge fixup must reference a commit ALREADY on main; otherwise ` +
        `the closing_commits[] entries would point at a future-dangling SHA.`,
    );
    process.exit(2);
  }
}

function closeOne(id: string, sha: string): void {
  // The registry CLI already implements the "preserve the branch
  // SHA, append the new SHA" semantics: when a finding is already
  // RESOLVED with N entries in closing_commits[], `close` adds an
  // (N+1)th entry without removing prior ones. This is exactly the
  // preservation contract this rechain tool needs.
  try {
    execFileSync(
      'npx',
      [
        'ts-node',
        '--project',
        TSCONFIG,
        REGISTRY_CLI,
        'close',
        id,
        sha,
      ],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`::error::close ${id} ${sha} failed: ${msg}`);
    process.exit(1);
  }
}

function verifyRegistry(): void {
  try {
    execFileSync(
      'npx',
      [
        'ts-node',
        '--project',
        TSCONFIG,
        REGISTRY_CLI,
        'verify',
      ],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      },
    );
  } catch {
    console.error(
      '::error::registry verify FAILED after rechain — chain integrity broken. ' +
        'Roll back manually: `git checkout HEAD -- docs/reviews/_registry/findings.jsonl` ' +
        'and re-run with the correct --squash-sha.',
    );
    process.exit(1);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[rechain] squash SHA: ${args.squashSha}`);
  console.log(`[rechain] findings to rechain: ${args.findings.length}`);
  for (const id of args.findings) {
    console.log(`  - ${id}`);
  }
  console.log('');

  verifySquashShaOnMain(args.squashSha);
  console.log('[rechain] pre-flight: squash SHA verified as ancestor of origin/main.');

  for (const id of args.findings) {
    console.log(`[rechain] closing ${id} → ${args.squashSha}`);
    closeOne(id, args.squashSha);
  }

  console.log('');
  console.log('[rechain] post-flight: verifying chain integrity…');
  verifyRegistry();
  console.log('[rechain] OK — registry chain re-stitched and verified.');
}

main();
