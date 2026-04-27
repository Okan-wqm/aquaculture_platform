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
 * # What the gate accepts
 *
 *   - `uses: actions/checkout@<40-char-sha>` (with optional `# v4.2.2` comment)
 *   - `uses: ./.github/actions/<local-action>` (repo-local; not subject to tag drift)
 *   - `uses: ./<any-relative-path>` (local action)
 *   - Blank / comment / non-`uses:` lines
 *
 * # What the gate rejects
 *
 *   - `uses: actions/checkout@v4` (tag pin)
 *   - `uses: actions/checkout@main` (branch pin)
 *   - `uses: actions/checkout@42` (short SHA)
 *   - Any mutable reference
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

export interface PinViolation {
  readonly file: string;
  readonly line: number;
  readonly uses: string;
}

function collectYamlFiles(): string[] {
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

function checkFile(path: string): PinViolation[] {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  const violations: PinViolation[] = [];
  const rel = path.replace(REPO_ROOT + '/', '');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip comments + empty.
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    // Match `uses: <ref>` or `- uses: <ref>`.
    const match = trimmed.match(/^-?\s*uses:\s*(\S+)/);
    if (!match) continue;
    const ref = match[1]!;
    // Local action (./ or ../) — always allowed.
    if (ref.startsWith('./') || ref.startsWith('../')) continue;
    // External reference: owner/repo@<ref>.
    const atIdx = ref.lastIndexOf('@');
    if (atIdx === -1) {
      // No @ — implicit default branch, reject.
      violations.push({ file: rel, line: i + 1, uses: ref });
      continue;
    }
    const pin = ref.slice(atIdx + 1);
    if (!SHA40.test(pin)) {
      violations.push({ file: rel, line: i + 1, uses: ref });
    }
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
    process.stderr.write(
      `[gha-sha-pin] workflows dir missing: ${WORKFLOWS_DIR}\n`,
    );
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
    process.stdout.write(
      `gha-sha-pin: ${violations.length} violation(s)\n`,
    );
    if (violations.length > 0) {
      process.stdout.write('\n── NON-SHA uses: ──\n');
      for (const v of violations) {
        process.stdout.write(`  ${v.file}:${v.line}  ${v.uses}\n`);
      }
      process.stdout.write(
        '\n✗ Plan v3 R27: every third-party `uses:` MUST be pinned to a 40-char commit SHA. Replace tag/branch refs with the commit SHA + a `# vX.Y.Z` comment.\n',
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
