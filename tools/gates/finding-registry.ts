#!/usr/bin/env ts-node
/**
 * finding-registry — CLI for the Phase 6 append-only registry at
 * docs/reviews/_registry/findings.jsonl.
 *
 * Phase 2 deliverable per
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2.
 *
 * Subcommands:
 *   verify               — re-compute the hash chain, assert every
 *                           prev_hash + content_hash is intact. Matches
 *                           tests/invariants/finding-registry-integrity
 *                           .spec.ts algorithm exactly — a CI gate and
 *                           a local smoke check in one CLI.
 *   add <json-path>      — append one finding from a JSON stub file.
 *                           The stub supplies id / severity / state /
 *                           title / layer / owner_agent / notes; the
 *                           CLI fills prev_hash + content_hash and
 *                           appends a newline-terminated entry.
 *   close <id> <sha>     — mutate a finding to state=RESOLVED, set
 *                           closed_at, and APPEND the short SHA to
 *                           closing_commits[]. Because the registry is
 *                           hash-chained, every entry FROM the
 *                           mutated position onward must have its
 *                           chain re-stitched (prev_hash preserved,
 *                           content_hash recomputed).
 *   export <format>      — dump alternate representations (json-array,
 *                           csv) for dashboards / reporting.
 *
 * Design notes:
 *   * Registry mutation preserves append-only SEMANTICS for OPEN/
 *     IN-PROGRESS additions (new entry at tail). `close` is the one
 *     mutation that legitimately modifies a past entry — the state
 *     transition contract in CLAUDE.md "Review Finding Traceability"
 *     REQUIRES closing_commits[] population, which cannot be written
 *     before the fix commit SHA exists. An alternative "close-event"
 *     record (state-machine replay) is Phase 12 territory; the CLI
 *     here matches the jsonl shape the invariant test already expects.
 *   * `close` re-seeds only the closed entry + subsequent entries
 *     (prev_hash pointers from later entries still point to the
 *     closed entry's OLD content_hash; they must be updated to the
 *     NEW content_hash). Validated end-to-end by running `verify`
 *     immediately after a `close`.
 *
 * Exit codes:
 *   0 — OK
 *   1 — integrity failure / missing id / chain break
 *   2 — usage error
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY_PATH = resolve(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');
const ZERO_HASH = '0'.repeat(64);

/**
 * Finding schema mirror — narrow to what the CLI touches. The canonical
 * schema lives in docs/reviews/_registry/findings.jsonl.schema.json; we
 * keep these interfaces structural (no runtime validation here — the
 * integrity invariant test enforces schema conformance separately).
 */
interface Finding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  state: 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';
  title: string;
  layer: number;
  evidence?: string[];
  rule_violated?: string;
  owner_agent: string;
  raised_in_cycle: string;
  review_file?: string;
  created_at: string;
  closed_at: string | null;
  closing_commits: string[];
  deadline: string | null;
  owner_user: string | null;
  override_of: string | null;
  notes?: string;
  prev_hash: string;
  content_hash: string;
  [key: string]: unknown;
}

/**
 * Key-sorted JSON without whitespace. Canonical form for hashing;
 * identical to the algorithm in tools/scripts/seed-finding-registry.mjs
 * and tests/invariants/finding-registry-integrity.spec.ts.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
  );
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function loadRegistry(): Finding[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  const raw = readFileSync(REGISTRY_PATH, 'utf8').trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Finding);
}

function writeRegistry(entries: readonly Finding[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(REGISTRY_PATH, content, 'utf8');
}

/**
 * Recompute prev_hash + content_hash pointers from `startIndex` to the
 * end of `entries`. Mutation in place. Used by `close` after mutating
 * a past entry; every downstream entry carries a stale prev_hash until
 * rechained here.
 */
function rechain(entries: Finding[], startIndex: number): void {
  let prev = startIndex === 0 ? ZERO_HASH : (entries[startIndex - 1]?.content_hash ?? ZERO_HASH);
  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    entry.prev_hash = prev;
    // content_hash = sha256(canonical JSON of entry minus content_hash)
    const { content_hash: _, ...forHash } = entry;
    const hash = sha256hex(canonicalJson(forHash));
    entry.content_hash = hash;
    prev = hash;
  }
}

interface VerifyResult {
  ok: boolean;
  entries: number;
  firstFailureIndex: number | null;
  reason: string | null;
}

function verify(entries: readonly Finding[]): VerifyResult {
  let prev = ZERO_HASH;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.prev_hash !== prev) {
      return {
        ok: false,
        entries: entries.length,
        firstFailureIndex: i,
        reason: `chain break at entry ${i} (${entry.id}): prev_hash=${entry.prev_hash} expected=${prev}`,
      };
    }
    const { content_hash, ...forHash } = entry;
    const recomp = sha256hex(canonicalJson(forHash));
    if (recomp !== content_hash) {
      return {
        ok: false,
        entries: entries.length,
        firstFailureIndex: i,
        reason: `hash mismatch at entry ${i} (${entry.id}): recomputed=${recomp} stored=${content_hash}`,
      };
    }
    prev = content_hash;
  }
  return { ok: true, entries: entries.length, firstFailureIndex: null, reason: null };
}

function cmdVerify(): number {
  const entries = loadRegistry();
  const result = verify(entries);
  if (!result.ok) {
    console.error(`FAIL: ${result.reason}`);
    return 1;
  }
  console.log(`OK: registry chain valid (${result.entries} entries).`);
  const tip = entries.length === 0 ? ZERO_HASH : entries[entries.length - 1]?.content_hash ?? '';
  if (tip) console.log(`Chain tip: ${tip}`);
  return 0;
}

function cmdAdd(stubPath: string): number {
  if (!existsSync(stubPath)) {
    console.error(`Stub file not found: ${stubPath}`);
    return 2;
  }
  const stubRaw = readFileSync(stubPath, 'utf8');
  const stub = JSON.parse(stubRaw) as Partial<Finding>;

  const required: (keyof Finding)[] = [
    'id',
    'severity',
    'state',
    'title',
    'layer',
    'owner_agent',
    'raised_in_cycle',
    'created_at',
  ];
  for (const field of required) {
    if (stub[field] === undefined || stub[field] === null) {
      console.error(`Stub missing required field: ${field}`);
      return 2;
    }
  }

  const entries = loadRegistry();
  if (entries.some((e) => e.id === stub.id)) {
    console.error(`Duplicate id: ${stub.id} already exists in registry.`);
    return 1;
  }

  const newEntry: Finding = {
    id: stub.id as string,
    severity: stub.severity as Finding['severity'],
    state: stub.state as Finding['state'],
    title: stub.title as string,
    layer: stub.layer as number,
    evidence: stub.evidence ?? [],
    rule_violated: stub.rule_violated ?? '',
    owner_agent: stub.owner_agent as string,
    raised_in_cycle: stub.raised_in_cycle as string,
    review_file: stub.review_file ?? '',
    created_at: stub.created_at as string,
    closed_at: stub.closed_at ?? null,
    closing_commits: stub.closing_commits ?? [],
    deadline: stub.deadline ?? null,
    owner_user: stub.owner_user ?? null,
    override_of: stub.override_of ?? null,
    notes: stub.notes ?? '',
    prev_hash: ZERO_HASH, // fixed by rechain
    content_hash: ZERO_HASH, // fixed by rechain
  };

  entries.push(newEntry);
  rechain(entries, entries.length - 1);

  const post = verify(entries);
  if (!post.ok) {
    console.error(`Post-add integrity check FAILED: ${post.reason}`);
    return 1;
  }

  writeRegistry(entries);
  console.log(`Added: ${newEntry.id} at position ${entries.length - 1}`);
  console.log(`Chain tip: ${newEntry.content_hash}`);
  return 0;
}

function cmdClose(id: string, shortSha: string): number {
  if (!/^[a-f0-9]{7,40}$/i.test(shortSha)) {
    console.error(`Invalid SHA: ${shortSha} (expected 7-40 hex chars).`);
    return 2;
  }
  const entries = loadRegistry();
  const index = entries.findIndex((e) => e.id === id);
  if (index === -1) {
    console.error(`Finding not found: ${id}`);
    return 1;
  }

  const entry = entries[index];
  if (!entry) {
    console.error(`Finding at index ${index} is undefined — registry corruption?`);
    return 1;
  }

  if (entry.state === 'RESOLVED' && entry.closing_commits.includes(shortSha)) {
    console.log(`No-op: ${id} is already RESOLVED with closing commit ${shortSha}.`);
    return 0;
  }

  entry.state = 'RESOLVED';
  entry.closed_at = entry.closed_at ?? new Date().toISOString();
  if (!entry.closing_commits.includes(shortSha)) {
    entry.closing_commits = [...entry.closing_commits, shortSha];
  }

  // Rechain from mutated entry to tail; earlier entries unchanged.
  rechain(entries, index);

  const post = verify(entries);
  if (!post.ok) {
    console.error(`Post-close integrity check FAILED: ${post.reason}`);
    return 1;
  }

  writeRegistry(entries);
  console.log(`Closed: ${id} at position ${index} → state=RESOLVED, +commit ${shortSha}`);
  const tip = entries.length === 0 ? ZERO_HASH : entries[entries.length - 1]?.content_hash ?? '';
  console.log(`Chain tip: ${tip}`);
  return 0;
}

function cmdExport(format: string): number {
  const entries = loadRegistry();
  if (format === 'json-array') {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }
  if (format === 'csv') {
    const cols = [
      'id',
      'severity',
      'state',
      'title',
      'owner_agent',
      'created_at',
      'closed_at',
      'closing_commits',
    ];
    console.log(cols.join(','));
    for (const e of entries) {
      const row = cols.map((c) => {
        const v = (e as Record<string, unknown>)[c];
        const s = Array.isArray(v) ? v.join('|') : String(v ?? '');
        // CSV-escape: wrap in quotes if contains comma/quote/newline
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      });
      console.log(row.join(','));
    }
    return 0;
  }
  console.error(`Unknown export format: ${format} (supported: json-array, csv).`);
  return 2;
}

function main(): void {
  const [, , sub, ...args] = process.argv;
  if (!sub) {
    console.error('Usage: finding-registry <verify|add|close|export> [args]');
    console.error('  verify');
    console.error('  add <stub.json>');
    console.error('  close <finding-id> <short-sha>');
    console.error('  export <json-array|csv>');
    process.exit(2);
  }

  let exitCode = 0;
  if (sub === 'verify') {
    exitCode = cmdVerify();
  } else if (sub === 'add') {
    const stubPath = args[0];
    if (!stubPath) {
      console.error('add requires a stub path: finding-registry add <stub.json>');
      process.exit(2);
    }
    exitCode = cmdAdd(resolve(stubPath));
  } else if (sub === 'close') {
    const id = args[0];
    const sha = args[1];
    if (!id || !sha) {
      console.error('close requires id and sha: finding-registry close <id> <sha>');
      process.exit(2);
    }
    exitCode = cmdClose(id, sha);
  } else if (sub === 'export') {
    const format = args[0];
    if (!format) {
      console.error('export requires a format: finding-registry export <json-array|csv>');
      process.exit(2);
    }
    exitCode = cmdExport(format);
  } else {
    console.error(`Unknown subcommand: ${sub}`);
    process.exit(2);
  }

  process.exit(exitCode);
}

main();
