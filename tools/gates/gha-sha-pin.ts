#!/usr/bin/env ts-node
/**
 * gha-sha-pin — Phase 7 R27 supply-chain gate.
 * ============================================================================
 *
 * Every `uses:` directive across `.github/workflows/*.yml` + `.github/
 * actions/ * /action.yml` MUST reference a 40-char commit SHA, not a
 * tag or branch. Tag references are mutable — a compromised action
 * maintainer can retag `v4` to point at malicious code without
 * GitHub flagging the change. SHA pinning is the single control that
 * makes third-party workflow code tamper-evident.
 *
 * This module is the ONE owner of the rule (ARIA-MEDIUM-590). The invariant
 * `tests/invariants/aria-workflow-sha-pin.spec.ts` and ARIA's workflow/shell
 * safety adapter read `inspectUsesText`; neither keeps a copy, and the gate's
 * own spec fails on any TypeScript source that restates it.
 *
 * # What the gate accepts
 *
 *   - `uses: actions/checkout@<40-char-sha>` (with optional `# v4.2.2` comment)
 *   - `uses: ./.github/actions/<local-action>` (repo-local; not subject to tag drift)
 *   - `uses: ./<any-relative-path>` / `../<path>` (local action)
 *   - `uses: docker://<image>@sha256:<64-hex digest>` (content-addressed image)
 *   - Blank / comment / non-`uses:` lines
 *
 * # What the gate rejects (`PinViolation.reason`)
 *
 *   - `mutable_ref`: `actions/checkout@v4` (tag), `@main` (branch), `@42`
 *     (short SHA). A channel-style action is no exception: the channel is an
 *     input (`dtolnay/rust-toolchain@<sha>` with `toolchain: nightly`, as
 *     fuzz-st-parser-nightly.yml does), so a branch ref buys nothing.
 *   - `missing_ref`: `owner/repo` with no `@` — runs the default branch.
 *   - `docker_not_digest`: `docker://alpine:3.20` or `docker://alpine` — a
 *     registry tag is as mutable as a git tag.
 *
 * # Exit codes
 *
 *   0 — every third-party `uses:` is SHA-pinned
 *   1 — one or more tag/branch pins present
 *   2 — input error (missing workflow dir, malformed YAML line, etc.)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_DIR = __dirname;
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github', 'workflows');
const ACTIONS_DIR = resolve(REPO_ROOT, '.github', 'actions');

const SHA40 = /^[a-f0-9]{40}$/;
const DOCKER_DIGEST = /^docker:\/\/[^@\s]+@sha256:[a-f0-9]{64}$/;

/** Why a `uses:` reference fails the rule (see the header). */
export type PinViolationReason = 'mutable_ref' | 'missing_ref' | 'docker_not_digest';

export interface PinViolation {
  readonly file: string;
  readonly line: number;
  readonly uses: string;
  readonly reason: PinViolationReason;
}

/**
 * The rule for one `uses:` target: null when it is pinned (a local action, a
 * 40-hex commit SHA, a docker image by sha256 digest), otherwise the reason.
 */
function pinVerdictOf(target: string): PinViolationReason | null {
  if (target.startsWith('./') || target.startsWith('../')) return null;
  if (target.startsWith('docker://')) {
    return DOCKER_DIGEST.test(target) ? null : 'docker_not_digest';
  }
  const atIdx = target.lastIndexOf('@');
  if (atIdx === -1) return 'missing_ref';
  return SHA40.test(target.slice(atIdx + 1)) ? null : 'mutable_ref';
}

/**
 * Every file the rule governs, as absolute paths: the workflows and the
 * composite actions the repository owns. Exported so the invariant spec walks
 * the same set instead of keeping its own.
 */
export function collectYamlFiles(): string[] {
  const out: string[] = [];
  if (existsSync(WORKFLOWS_DIR)) {
    for (const name of readdirSync(WORKFLOWS_DIR)) {
      if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
      out.push(resolve(WORKFLOWS_DIR, name));
    }
  }
  if (existsSync(ACTIONS_DIR)) {
    for (const name of readdirSync(ACTIONS_DIR)) {
      const full = resolve(ACTIONS_DIR, name);
      if (statSync(full).isDirectory()) {
        const action = resolve(full, 'action.yml');
        const actionYaml = resolve(full, 'action.yaml');
        if (existsSync(action)) out.push(action);
        else if (existsSync(actionYaml)) out.push(actionYaml);
      }
    }
  }
  return out.sort();
}

/**
 * The files this gate governs, by repository-relative path: every workflow
 * (`.github/workflows/<name>.yml|yaml`) and every composite action the repo
 * owns (`.github/actions/<name>/action.yml|yaml`) — the set `collectYamlFiles`
 * walks. ARIA's workflow/shell safety adapter (ARIA-HIGH-013) asks this
 * predicate rather than keeping its own copy of the scope.
 */
export function isActionPinScopedPath(path: string): boolean {
  return (
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
    /^\.github\/actions\/[^/]+\/action\.ya?ml$/.test(path)
  );
}

function checkFile(path: string): PinViolation[] {
  return inspectUsesText(path.replace(REPO_ROOT + '/', ''), readFileSync(path, 'utf8'));
}

/**
 * The gate's rule over one file's text: every `uses:` reference that
 * `pinVerdictOf` refuses. Pure, so the gate's walk, the invariant spec and
 * ARIA's workflow/shell safety adapter (ARIA-HIGH-013) read the same verdict
 * for the same text.
 */
export function inspectUsesText(rel: string, raw: string): PinViolation[] {
  const violations: PinViolation[] = [];
  for (const [i, line] of raw.split('\n').entries()) {
    // Skip comments + empty.
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    // Match `uses: <ref>` or `- uses: <ref>`.
    const ref = /^-?\s*uses:\s*(?<ref>\S+)/.exec(trimmed)?.groups?.['ref'];
    if (ref === undefined) continue;
    const reason = pinVerdictOf(ref);
    if (reason !== null) violations.push({ file: rel, line: i + 1, uses: ref, reason });
  }
  return violations;
}

export interface GhaShaPinArgs {
  jsonMode: boolean;
}

export function runCheck(): PinViolation[] {
  const files = collectYamlFiles();
  const violations: PinViolation[] = [];
  for (const f of files) violations.push(...checkFile(f));
  return violations;
}

export function main(argv: readonly string[]): number {
  const jsonMode = argv.includes('--json');
  if (!existsSync(WORKFLOWS_DIR)) {
    process.stderr.write(`[gha-sha-pin] workflows dir missing: ${WORKFLOWS_DIR}\n`);
    return 2;
  }
  const violations = runCheck();
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        {
          violationCount: violations.length,
          violations,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(`gha-sha-pin: ${violations.length} violation(s)\n`);
    if (violations.length > 0) {
      process.stdout.write('\n── NON-SHA uses: ──\n');
      for (const v of violations) {
        process.stdout.write(`  ${v.file}:${v.line}  ${v.uses}  (${v.reason})\n`);
      }
      process.stdout.write(
        '\n✗ Plan v3 R27: every third-party `uses:` MUST be pinned to a 40-char commit SHA (a docker:// image to its sha256 digest). Replace tag/branch refs with the commit SHA + a `# vX.Y.Z` comment.\n',
      );
    } else {
      process.stdout.write('✓ Every third-party `uses:` is SHA-pinned.\n');
    }
  }
  return violations.length === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith('gha-sha-pin.ts')) {
  process.exit(main(process.argv.slice(2)));
}
