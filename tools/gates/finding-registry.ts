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

interface SweepConfig {
  readonly staleAfterDays: number;
  readonly dryRun: boolean;
  readonly now: Date;
}

interface SweepAction {
  readonly id: string;
  readonly fromState: Finding['state'];
  readonly toState: Finding['state'];
  readonly reason: string;
}

/**
 * Phase 6 state-sweep automation — runs daily in CI, transitions state
 * based on declarative rules:
 *
 *   * OPEN / IN-PROGRESS finding older than `staleAfterDays`
 *     (default 30) → STALE.
 *   * Any non-RESOLVED finding with `deadline` in the past → BLOCKED.
 *
 * Deterministic ordering: deadline check before staleness check so a
 * past-deadline STALE-candidate lands in BLOCKED (the stronger signal).
 *
 * --dry-run prints the proposed transitions WITHOUT mutating the
 * registry. The daily workflow opens a PR with the mutations so a
 * human reviews before merge — direct auto-commit would open a
 * tampering surface (bot push to main).
 */
function planSweep(entries: readonly Finding[], config: SweepConfig): SweepAction[] {
  const actions: SweepAction[] = [];
  const staleThresholdMs = config.staleAfterDays * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    if (entry.state === 'RESOLVED') continue;

    // Deadline check (stronger signal) runs first.
    if (entry.deadline) {
      const deadlineDate = new Date(entry.deadline);
      if (!Number.isNaN(deadlineDate.getTime()) && deadlineDate < config.now) {
        if (entry.state !== 'BLOCKED') {
          actions.push({
            id: entry.id,
            fromState: entry.state,
            toState: 'BLOCKED',
            reason: `past deadline ${entry.deadline}`,
          });
        }
        continue;
      }
    }

    // Staleness check (OPEN + IN-PROGRESS only, not BLOCKED/STALE).
    if (entry.state === 'OPEN' || entry.state === 'IN-PROGRESS') {
      const created = new Date(entry.created_at);
      if (Number.isNaN(created.getTime())) continue;
      const ageMs = config.now.getTime() - created.getTime();
      if (ageMs >= staleThresholdMs) {
        actions.push({
          id: entry.id,
          fromState: entry.state,
          toState: 'STALE',
          reason: `${Math.floor(ageMs / 86400000)} days old (threshold ${config.staleAfterDays})`,
        });
      }
    }
  }
  return actions;
}

function cmdSweep(args: string[]): number {
  const dryRun = args.includes('--dry-run');
  const staleArg = args.find((a) => a.startsWith('--stale-after='));
  // Use Number.isFinite + explicit null check so `--stale-after=0` is NOT
  // coerced back to 30 by an || fallback (0 is falsy). The 0-threshold is
  // useful for dry-run debugging and should round-trip.
  let staleAfterDays = 30;
  if (staleArg) {
    const parsed = parseInt(staleArg.replace('--stale-after=', ''), 10);
    if (Number.isFinite(parsed) && parsed >= 0) staleAfterDays = parsed;
  }

  const entries = loadRegistry();
  const actions = planSweep(entries, {
    staleAfterDays,
    dryRun,
    now: new Date(),
  });

  if (actions.length === 0) {
    console.log(`Sweep clean: 0 transitions needed (${entries.length} entries scanned).`);
    return 0;
  }

  console.log(`Sweep plan (${actions.length} transitions):`);
  for (const a of actions) {
    console.log(`  ${a.id}: ${a.fromState} → ${a.toState}  (${a.reason})`);
  }

  if (dryRun) {
    console.log('');
    console.log('--dry-run: no mutations written.');
    return 0;
  }

  // Apply transitions; earliest mutated entry anchors rechain scope.
  let minIndex = entries.length;
  for (const a of actions) {
    const i = entries.findIndex((e) => e.id === a.id);
    if (i === -1) continue;
    const entry = entries[i];
    if (!entry) continue;
    entry.state = a.toState;
    if (i < minIndex) minIndex = i;
  }
  rechain(entries, minIndex);

  const post = verify(entries);
  if (!post.ok) {
    console.error(`Post-sweep integrity check FAILED: ${post.reason}`);
    return 1;
  }

  writeRegistry(entries);
  const tip = entries.length === 0 ? ZERO_HASH : entries[entries.length - 1]?.content_hash ?? '';
  console.log('');
  console.log(`Applied ${actions.length} transitions. Chain tip: ${tip}`);
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

/**
 * `list` — tabular registry view filtered by state / severity / owner.
 *
 * Added in Phase 14 (docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#14.1)
 * as the read-only dev-loop equivalent of `findings:list` / `findings:list:all`
 * npm scripts. Purely a query — does NOT mutate the registry or recompute
 * hashes. When no flags are passed, prints every entry.
 *
 * Flags:
 *   --state <CSV>    OPEN,IN-PROGRESS,RESOLVED,STALE,BLOCKED
 *   --severity <CSV> CRITICAL,HIGH,MEDIUM,LOW
 *   --owner <name>   owner_agent substring match
 *   --format <fmt>   table (default) | id-only | json
 *
 * Exit 0 always unless the registry itself is missing/malformed; absence
 * of matches is NOT an error (an empty OPEN list is a good result).
 */
function cmdList(args: readonly string[]): number {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }
  const entries = loadRegistry();
  const stateFilter = flags['state']?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const sevFilter = flags['severity']?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const ownerFilter = flags['owner'] ?? null;

  const matched = entries.filter((e) => {
    if (stateFilter && !stateFilter.includes(e.state)) return false;
    if (sevFilter && !sevFilter.includes(e.severity)) return false;
    if (ownerFilter && !e.owner_agent.includes(ownerFilter)) return false;
    return true;
  });

  const format = flags['format'] ?? 'table';
  if (format === 'id-only') {
    for (const e of matched) console.log(e.id);
    return 0;
  }
  if (format === 'json') {
    console.log(JSON.stringify(matched, null, 2));
    return 0;
  }
  // table (default)
  if (matched.length === 0) {
    const criteria = [
      stateFilter ? `state=${stateFilter.join(',')}` : null,
      sevFilter ? `severity=${sevFilter.join(',')}` : null,
      ownerFilter ? `owner=${ownerFilter}` : null,
    ].filter(Boolean).join(' ') || 'all';
    console.log(`(no findings matched: ${criteria})`);
    return 0;
  }
  const header = ['ID', 'SEV', 'STATE', 'OWNER', 'TITLE'];
  const rows = matched.map((e) => [
    e.id,
    e.severity,
    e.state,
    e.owner_agent,
    e.title.length > 60 ? e.title.slice(0, 57) + '...' : e.title,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmtRow = (r: readonly string[]): string =>
    r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(fmtRow(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(fmtRow(r));
  console.log(`\n${matched.length} / ${entries.length} entries matched.`);
  return 0;
}

function cmdRechainFrom(startIdxRaw: string | undefined): number {
  // Merge-commit helper: after a 3-way merge of `findings.jsonl`
  // concatenates two branches' additions, the first entry of the
  // latter branch carries a `prev_hash` pointing at an entry that
  // is no longer its predecessor in the merged file. This
  // subcommand re-hashes from the named index to EOF, restoring
  // the integrity chain.
  //
  // Discovery path for the index: run `verify` first — on failure
  // it prints `chain break at entry N (<id>)`. Pass N here.
  if (!startIdxRaw) {
    console.error(
      'rechain-from requires a start index: finding-registry rechain-from <N>',
    );
    return 2;
  }
  const startIndex = Number.parseInt(startIdxRaw, 10);
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    console.error(
      `rechain-from: <N> must be a non-negative integer; got "${startIdxRaw}".`,
    );
    return 2;
  }
  const entries = loadRegistry();
  if (startIndex >= entries.length) {
    console.error(
      `rechain-from: index ${startIndex} is out of range (entries=${entries.length}).`,
    );
    return 2;
  }
  rechain(entries, startIndex);
  writeRegistry(entries);
  const result = verify(entries);
  if (!result.ok) {
    console.error(
      `rechain-from: registry is STILL invalid post-rechain: ${result.reason}`,
    );
    return 1;
  }
  console.log(
    `rechain-from: registry integrity restored from entry ${startIndex} (total entries=${entries.length}).`,
  );
  return 0;
}

function main(): void {
  const [, , sub, ...args] = process.argv;
  if (!sub) {
    console.error('Usage: finding-registry <verify|add|close|sweep|export|list|rechain-from> [args]');
    console.error('  verify');
    console.error('  add <stub.json>');
    console.error('  close <finding-id> <short-sha>');
    console.error('  sweep [--dry-run] [--stale-after=<days>]');
    console.error('  export <json-array|csv>');
    console.error('  list [--state <CSV>] [--severity <CSV>] [--owner <name>] [--format table|id-only|json]');
    console.error('  rechain-from <N>   — post-merge integrity repair (see docblock)');
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
  } else if (sub === 'sweep') {
    exitCode = cmdSweep(args);
  } else if (sub === 'list') {
    exitCode = cmdList(args);
  } else if (sub === 'rechain-from') {
    exitCode = cmdRechainFrom(args[0]);
  } else {
    console.error(`Unknown subcommand: ${sub}`);
    process.exit(2);
  }

  process.exit(exitCode);
}

main();
