#!/usr/bin/env node
/**
 * check-advisory-ignore-sync — RUST-CVE-001 make-it-detectable gate.
 *
 * WHY: the cargo-audit / cargo-deny advisory ignore lists live in NINE
 * places (2 deny.toml, 2 .cargo/audit.toml, --ignore flags in 4 workflow
 * audit steps, and the GHSA allow-list in dependency-review.yml). The
 * lock-step between them used to be a hand-maintained invariant — and it
 * drifted twice before this gate existed: rust-ci.yml was missing
 * RUSTSEC-2026-0104, and edge-agent-release.yml was missing
 * RUSTSEC-2026-0173 (which would have failed the next agent-v* release).
 *
 * WHAT this gate enforces, per workspace (root + sens-api-gateway):
 *   1. deny.toml [advisories].ignore == .cargo/audit.toml [advisories].ignore
 *   2. every workflow audit step's --ignore set == the audit.toml set
 *   3. every ignored advisory carries a tracked finding id, an Owner and a
 *      Deadline in the comment block that precedes it
 *   4. no dated Deadline is in the past — an expired ignore fails CI
 *      instead of silently outliving its justification
 *   5. tombstoned advisories (resolved by the crates/local-rumqttc fork)
 *      can never be re-ignored or re-allow-listed anywhere
 *
 * Invocation: node scripts/ci/check-advisory-ignore-sync.ts
 * Exit codes: 0 = lock-step intact, 1 = violation(s), 2 = parse failure.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** RUST-CVE-001 graveyard — resolved by the crates/local-rumqttc fork +
 *  testcontainers 0.27 bump. Re-ignoring any of these would mask the
 *  deny.toml [bans] regression guard, so they are forbidden forever. */
const TOMBSTONED_RUSTSEC = [
  'RUSTSEC-2026-0098',
  'RUSTSEC-2026-0099',
  'RUSTSEC-2026-0049',
  'RUSTSEC-2026-0104',
  'RUSTSEC-2025-0134',
] as const;

/** GHSA aliases of the tombstoned rustls-webpki advisories
 *  (dependency-review.yml allow-ghsas surface). */
const TOMBSTONED_GHSA = [
  'GHSA-xgp8-3hg3-c2mh',
  'GHSA-965h-392x-2mh5',
  'GHSA-pwjx-qhcg-rvj4',
] as const;

/** GHSAs that MUST stay in dependency-review.yml allow-ghsas while their
 *  upstream-blocked findings remain open (SUPPLY-LOW-001: accidental
 *  removal would silently fail dependency-review on a tracked advisory). */
const REQUIRED_GHSA: ReadonlyArray<{ id: string; finding: string }> = [
  { id: 'GHSA-h395-gr6q-cpjc', finding: 'RUST-CVE-002 (jsonwebtoken < 10.3.0)' },
  { id: 'GHSA-9q82-xgwf-vj6h', finding: 'Apollo Server 4 XS-Search (docs/bugs/2026-05-02)' },
];

/** Deadline markers that are valid without a calendar date — they encode
 *  an explicit review cadence instead (deny.toml rubric). */
const NON_DATE_DEADLINE_MARKERS = ['RE-EVAL QUARTERLY', 'NO_FIX_AVAILABLE'];

const FINDING_ID_RE = /\b(?:[A-Z][A-Z0-9]*-)+(?:CI|CVE)-\d{3}\b|\bRUST-CVE-\d{3}\b/;
const RUSTSEC_RE = /RUSTSEC-\d{4}-\d{4}/g;
const DEADLINE_RE = /Deadline:\s*([^\n]+)/i;
const OWNER_RE = /Owner:\s*\S+/i;

interface Violation {
  surface: string;
  reason: string;
}

const violations: Violation[] = [];

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/**
 * Extract the `ignore = [ ... ]` array body from a TOML [advisories]
 * section, returning each advisory id with the comment block that
 * precedes it inside the array (comment blocks apply to every advisory
 * line until the next comment block begins — matches the file layout
 * where e.g. one EDGE-CI-00x block covers several advisory lines).
 */
function parseTomlIgnores(rel: string): Map<string, string> {
  const text = read(rel);
  // Scope to the [advisories] section so RUSTSEC mentions in [bans]
  // comments or other sections can never leak into the ignore set.
  const sectionStart = text.search(/^\[advisories\]\s*$/m);
  if (sectionStart === -1) {
    violations.push({ surface: rel, reason: 'no [advisories] section found — file shape changed under the gate' });
    return new Map();
  }
  const afterHeader = text.slice(sectionStart + '[advisories]'.length);
  const nextSection = afterHeader.search(/^\[[a-z[]/m);
  const section = nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
  // Single-line empty form (`ignore = []`) and multi-line array both count.
  const match =
    section.match(/^ignore\s*=\s*\[([\s\S]*?)^\s*\]/m) ??
    section.match(/^ignore\s*=\s*\[([^\]\n]*)\]/m);
  if (!match) {
    violations.push({ surface: rel, reason: 'no `ignore = [...]` array found in [advisories] — file shape changed under the gate' });
    return new Map();
  }
  const body = match[1] ?? '';
  const result = new Map<string, string>();
  let commentBlock = '';
  let lastLineWasComment = false;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      // A fresh comment block starts after an advisory line.
      if (!lastLineWasComment) commentBlock = '';
      commentBlock += `${trimmed}\n`;
      lastLineWasComment = true;
      continue;
    }
    lastLineWasComment = false;
    const ids = trimmed.match(RUSTSEC_RE);
    if (ids) for (const id of ids) result.set(id, commentBlock);
  }
  return result;
}

/** Extract `--ignore RUSTSEC-XXXX-XXXX` flags from a workflow file.
 *  SUPPLY-LOW-002: any `--ignore` whose value is NOT a literal RUSTSEC id
 *  (env-var indirection, YAML anchor, glob) is itself a violation — a
 *  static text scan cannot follow indirection, so indirection is banned. */
function parseWorkflowIgnores(rel: string): Set<string> {
  const text = read(rel);
  const set = new Set<string>();
  for (const m of text.matchAll(/--ignore[=\s]+(\S+)/g)) {
    const value = (m[1] as string).replace(/\\$/, '');
    if (/^RUSTSEC-\d{4}-\d{4}$/.test(value)) {
      set.add(value);
    } else {
      violations.push({ surface: rel, reason: `--ignore with non-literal advisory value "${value}" — indirection defeats the lock-step gate; use a literal RUSTSEC id` });
    }
  }
  return set;
}

function assertSetEquality(aName: string, a: ReadonlySet<string>, bName: string, b: ReadonlySet<string>): void {
  for (const id of a) {
    if (!b.has(id)) violations.push({ surface: bName, reason: `${id} present in ${aName} but missing here — lock-step drift` });
  }
  for (const id of b) {
    if (!a.has(id)) violations.push({ surface: aName, reason: `${id} present in ${bName} but missing here — lock-step drift` });
  }
}

function assertMetadata(rel: string, ignores: Map<string, string>): void {
  for (const [id, comment] of ignores) {
    if (!FINDING_ID_RE.test(comment)) {
      violations.push({ surface: rel, reason: `${id}: no tracked finding id in the preceding comment block` });
    }
    if (!OWNER_RE.test(comment)) {
      violations.push({ surface: rel, reason: `${id}: no "Owner:" in the preceding comment block` });
    }
    const deadline = comment.match(DEADLINE_RE)?.[1]?.trim();
    if (!deadline) {
      violations.push({ surface: rel, reason: `${id}: no "Deadline:" in the preceding comment block` });
      continue;
    }
    const dateMatch = deadline.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch) {
      const due = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T23:59:59Z`);
      if (due.getTime() < Date.now()) {
        violations.push({ surface: rel, reason: `${id}: deadline ${dateMatch[0]} has PASSED — resolve upstream, fork, or re-justify with a new reviewed deadline` });
      }
    } else if (!NON_DATE_DEADLINE_MARKERS.some((marker) => deadline.toUpperCase().includes(marker))) {
      violations.push({ surface: rel, reason: `${id}: Deadline "${deadline}" is neither a YYYY-MM-DD date nor an approved cadence marker (${NON_DATE_DEADLINE_MARKERS.join(' / ')})` });
    }
  }
}

function assertNoTombstones(surface: string, ids: Iterable<string>): void {
  for (const id of ids) {
    if ((TOMBSTONED_RUSTSEC as readonly string[]).includes(id)) {
      violations.push({ surface, reason: `${id} is tombstoned (RUST-CVE-001 resolved via crates/local-rumqttc) — it must never be re-ignored; fix the dependency instead` });
    }
  }
}

interface Workspace {
  name: string;
  denyToml: string;
  auditToml: string;
  workflows: string[];
}

const WORKSPACES: Workspace[] = [
  {
    name: 'root',
    denyToml: 'deny.toml',
    auditToml: '.cargo/audit.toml',
    workflows: ['.github/workflows/rust-ci.yml'],
  },
  {
    name: 'sens-api-gateway',
    denyToml: 'sens-api-gateway/deny.toml',
    auditToml: 'sens-api-gateway/.cargo/audit.toml',
    workflows: [
      '.github/workflows/sens-api-gateway-ci.yml',
      '.github/workflows/edge-agent-release.yml',
      '.github/workflows/ci-affected.yml',
    ],
  },
];

for (const ws of WORKSPACES) {
  const denyIgnores = parseTomlIgnores(ws.denyToml);
  const auditIgnores = parseTomlIgnores(ws.auditToml);

  assertSetEquality(ws.denyToml, new Set(denyIgnores.keys()), ws.auditToml, new Set(auditIgnores.keys()));
  assertMetadata(ws.denyToml, denyIgnores);
  assertMetadata(ws.auditToml, auditIgnores);
  assertNoTombstones(ws.denyToml, denyIgnores.keys());
  assertNoTombstones(ws.auditToml, auditIgnores.keys());

  for (const wf of ws.workflows) {
    const wfIgnores = parseWorkflowIgnores(wf);
    assertSetEquality(ws.auditToml, new Set(auditIgnores.keys()), wf, wfIgnores);
    assertNoTombstones(wf, wfIgnores);
  }
}

// dependency-review.yml GHSA surface: the tombstoned webpki GHSAs must not
// reappear in allow-ghsas (comment mentions are fine — only the live list
// counts).
{
  const rel = '.github/workflows/dependency-review.yml';
  const text = read(rel);
  const allowLine = text.match(/^\s*allow-ghsas:\s*(\S+)\s*$/m)?.[1] ?? '';
  const allowed = allowLine.split(',').map((s) => s.trim()).filter(Boolean);
  for (const ghsa of allowed) {
    if ((TOMBSTONED_GHSA as readonly string[]).includes(ghsa)) {
      violations.push({ surface: rel, reason: `${ghsa} is a tombstoned rustls-webpki GHSA (RUST-CVE-001 resolved) — it must never be re-allow-listed` });
    }
  }
  for (const { id, finding } of REQUIRED_GHSA) {
    if (!allowed.includes(id)) {
      violations.push({ surface: rel, reason: `${id} missing from allow-ghsas — its upstream-blocked finding ${finding} is still open; removing the allow-list entry breaks dependency-review without resolving the advisory` });
    }
  }
}

if (violations.length > 0) {
  console.error(`advisory-ignore-sync: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  [${v.surface}] ${v.reason}`);
  process.exit(1);
}

console.log('advisory-ignore-sync: all surfaces in lock-step (2 deny.toml, 2 audit.toml, 4 workflows, 1 GHSA allow-list)');
