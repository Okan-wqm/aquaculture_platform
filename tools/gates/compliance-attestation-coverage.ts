#!/usr/bin/env ts-node
/**
 * compliance-attestation-coverage — Phase 5 R38 gate.
 * ============================================================================
 *
 * Asserts every RESOLVED CRITICAL/HIGH finding closed on or after the
 * ATTESTATION_REQUIRED_FROM cutoff has a matching markdown file at
 * `docs/compliance/evidence/<finding-id>.md`.
 *
 * Grandfathering: findings closed BEFORE the cutoff are exempt — the
 * gate only applies forward from the date operators explicitly opt in.
 * Retroactively demanding attestation for the 20 already-resolved
 * findings is not actionable; authoring them against commits that
 * already shipped provides no new audit value.
 *
 * # Cutoff resolution
 *
 *   - --cutoff <ISO-date>   explicit CLI override, highest priority
 *   - ATTESTATION_REQUIRED_FROM env var
 *   - else: effectively disabled (cutoff = ISO far-future)
 *
 * # Exit codes
 *
 *   0  every in-scope finding has an attestation file
 *   1  one or more missing attestations
 *   2  input error (malformed JSONL, missing finding registry, etc.)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_DIR = __dirname;
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const REGISTRY_PATH = resolve(
  REPO_ROOT,
  'docs',
  'reviews',
  '_registry',
  'findings.jsonl',
);
const EVIDENCE_DIR = resolve(REPO_ROOT, 'docs', 'compliance', 'evidence');
const FAR_FUTURE_ISO = '9999-12-31T23:59:59Z';

interface FindingEntry {
  id: string;
  severity: string;
  state: string;
  closed_at: string | null;
}

export interface AttestationCoverageArgs {
  cutoffIso: string;
}

export interface AttestationCoverageResult {
  readonly totalInScope: number;
  readonly missing: readonly string[];
  readonly cutoffIso: string;
}

function parseCliCutoff(argv: readonly string[]): string | undefined {
  const idx = argv.indexOf('--cutoff');
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  return value;
}

function resolveCutoff(argv: readonly string[]): string {
  const cli = parseCliCutoff(argv);
  if (cli) return cli;
  const env = process.env['ATTESTATION_REQUIRED_FROM'];
  if (env) return env;
  return FAR_FUTURE_ISO;
}

function loadRegistry(): FindingEntry[] {
  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(
      `[compliance-attestation-coverage] findings registry missing at ${REGISTRY_PATH}`,
    );
  }
  const raw = readFileSync(REGISTRY_PATH, 'utf8');
  const entries: FindingEntry[] = [];
  let lineNum = 0;
  for (const line of raw.split('\n')) {
    lineNum++;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      entries.push(JSON.parse(trimmed) as FindingEntry);
    } catch (e) {
      throw new Error(
        `[compliance-attestation-coverage] findings.jsonl line ${lineNum}: ${(e as Error).message}`,
      );
    }
  }
  return entries;
}

function loadAttestationFiles(): Set<string> {
  if (!existsSync(EVIDENCE_DIR)) return new Set();
  const files = readdirSync(EVIDENCE_DIR);
  const ids = new Set<string>();
  for (const f of files) {
    // Accept both <id>.md and subpaths. Skip template + README.
    if (f.startsWith('_') || f === 'README.md') continue;
    if (!f.endsWith('.md')) continue;
    ids.add(f.replace(/\.md$/, ''));
  }
  return ids;
}

export function runCoverageCheck(
  args: AttestationCoverageArgs,
): AttestationCoverageResult {
  const cutoff = Date.parse(args.cutoffIso);
  if (Number.isNaN(cutoff)) {
    throw new Error(
      `[compliance-attestation-coverage] invalid cutoff ISO '${args.cutoffIso}'`,
    );
  }
  const entries = loadRegistry();
  const attestedIds = loadAttestationFiles();
  const inScope = entries.filter((e) => {
    if (e.state !== 'RESOLVED') return false;
    if (e.severity !== 'CRITICAL' && e.severity !== 'HIGH') return false;
    if (!e.closed_at) return false;
    const closedAt = Date.parse(e.closed_at);
    if (Number.isNaN(closedAt)) return false;
    return closedAt >= cutoff;
  });
  const missing = inScope
    .map((e) => e.id)
    .filter((id) => !attestedIds.has(id))
    .sort();
  return {
    totalInScope: inScope.length,
    missing,
    cutoffIso: args.cutoffIso,
  };
}

export function main(argv: readonly string[]): number {
  const jsonMode = argv.includes('--json');
  let result: AttestationCoverageResult;
  try {
    result = runCoverageCheck({ cutoffIso: resolveCutoff(argv) });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        {
          cutoffIso: result.cutoffIso,
          totalInScope: result.totalInScope,
          missingCount: result.missing.length,
          missing: result.missing,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(
      `compliance-attestation-coverage: cutoff=${result.cutoffIso} — ${result.totalInScope} finding(s) in scope, ${result.missing.length} missing.\n`,
    );
    if (result.missing.length > 0) {
      process.stdout.write('\n── MISSING ATTESTATIONS ──\n');
      for (const id of result.missing) {
        process.stdout.write(`  ${id}  →  docs/compliance/evidence/${id}.md\n`);
      }
      process.stdout.write(
        '\n✗ Phase 5 R38 requires an attestation markdown for every CRITICAL/HIGH finding closed on or after the cutoff. Copy docs/compliance/evidence/_template.md.\n',
      );
    } else {
      process.stdout.write(
        result.totalInScope === 0
          ? '✓ No in-scope findings (grandfathered by cutoff).\n'
          : '✓ All in-scope findings have attestation evidence.\n',
      );
    }
  }
  return result.missing.length === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith('compliance-attestation-coverage.ts')) {
  process.exit(main(process.argv.slice(2)));
}
