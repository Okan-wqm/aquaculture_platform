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
 *   add <domain> <json-path>
 *                         — allocate a domain-wide monotonic id and append
 *                           one finding from a JSON stub file. The stub
 *                           supplies severity / state /
 *                           title / layer / owner_agent / notes; the
 *                           CLI fills id / prev_hash / content_hash and
 *                           appends a newline-terminated entry.
 *   add-explicit <json-path>
 *                         — governed import/replay path for a stub whose id
 *                           is already externally fixed. It uses the same
 *                           exclusive registry mutation lock as `add`.
 *   import-narrative <json-path>
 *                         — import one exact ORPHAN heading into the
 *                           structured registry as a new OPEN row.
 *   close <id> <sha>     — mutate a finding to state=RESOLVED, set
 *                           closed_at, and APPEND the short SHA to
 *                           closing_commits[]. The SHA must be
 *                           reachable from origin/main and its commit
 *                           message must carry a matching Closes:
 *                           trailer. Because the registry is
 *                           hash-chained, every entry FROM the mutated
 *                           position onward must have its chain
 *                           re-stitched (prev_hash preserved,
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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The .js extension on the ajv specifier survives both module systems
// (it is a real file in node_modules); ts-jest interop in the Jest
// invariant test omits it.
import Ajv2020Mod, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// PROC-HIGH-001 structural guard — close ceremony refuses branch-local
// SHAs (see cmdClose). The shared SSOT helper is import-safe for
// node:test specs, which use the same extensionless CJS specifier.
import {
  findNonCanonicalFindingEvidence,
  requiresCanonicalFindingEvidence,
} from './finding-evidence-shape';
import {
  atomicWriteFileWithRegistryLease,
  atomicWriteRegistryFile,
  claimedSequences,
  nextFindingId,
  ORPHAN_MD_HEADING_REGEX,
  orphanMarkdownReservedIds,
  RegistryLockError,
  type RegistryLockLease,
  withRegistryFileLock,
} from './finding-registry-store';
import {
  closureAdmissible,
  commitHasFindingCloseTrailer,
  commitMessageClosesFindingExactly,
  findingRejectsClosure,
  type FindingTrailerTarget,
} from './finding-traceability';
import { commitReachableFrom, repoPinnedEnv } from './git-reachability';

const Ajv2020 = (Ajv2020Mod as unknown as { default?: typeof Ajv2020Mod }).default ?? Ajv2020Mod;

// __dirname (CommonJS, per tools/gates/tsconfig.json) — this file
// previously derived REPO_ROOT from import.meta.url, which forced the
// whole CLI through ts-node's ESM loader, made relative TS imports
// unresolvable (ERR_MODULE_NOT_FOUND for both extensionless and .js
// specifiers) and tripped TS1343/TS5097 in the changed-files
// type-check. Every other gate in this directory is CJS; the odd one
// out is now aligned (farm-service-enterprise-guardrails.ts precedent).
const REPO_ROOT = resolve(__dirname, '..', '..');
const REGISTRY_RELATIVE_PATH = join('docs', 'reviews', '_registry', 'findings.jsonl');
const REGISTRY_PATH = resolve(REPO_ROOT, REGISTRY_RELATIVE_PATH);
const SCHEMA_PATH = resolve(
  REPO_ROOT,
  'docs',
  'reviews',
  '_registry',
  'findings.jsonl.schema.json',
);
const ORPHAN_FINDINGS_MD_PATH = resolve(REPO_ROOT, 'docs', 'reviews', 'orphan-findings.md');
const ZERO_HASH = '0'.repeat(64);
const GIT_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface RegistryPaths {
  readonly registryPath: string;
  readonly schemaPath: string;
}

export interface NarrativeImportPaths extends RegistryPaths {
  readonly narrativePath: string;
  readonly narrativeReviewFile: string;
}

const DEFAULT_REGISTRY_PATHS: RegistryPaths = {
  registryPath: REGISTRY_PATH,
  schemaPath: SCHEMA_PATH,
};

const DEFAULT_NARRATIVE_IMPORT_PATHS: NarrativeImportPaths = {
  ...DEFAULT_REGISTRY_PATHS,
  narrativePath: ORPHAN_FINDINGS_MD_PATH,
  narrativeReviewFile: 'docs/reviews/orphan-findings.md',
};

interface FindingIdReservation {
  readonly sequence: number;
  readonly finding_id: string;
  readonly reserved_at: string;
  readonly registry_path: string;
}

interface FindingIdReservationLedger {
  readonly version: 1;
  readonly domains: Record<string, FindingIdReservation>;
}

export interface FindingAllocationAuthority {
  readonly lockPath: string;
  readonly reservationPath: string;
  readonly activeRegistryPaths: () => readonly string[];
}

const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function gitOutput(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    env: HERMETIC_GIT_ENV,
    maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
  }).trim();
}

export function resolveGitFindingAllocationAuthority(
  repoRoot: string,
  registryRelativePath = REGISTRY_RELATIVE_PATH,
): FindingAllocationAuthority {
  const commonDir = gitOutput(repoRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!commonDir) {
    throw new Error(`Git common-dir resolution returned an empty path for ${repoRoot}`);
  }

  return {
    lockPath: join(commonDir, 'finding-registry-v1.lock'),
    reservationPath: join(commonDir, 'finding-id-reservations-v1.json'),
    activeRegistryPaths: () => {
      const output = execFileSync(
        'git',
        ['-C', repoRoot, 'worktree', 'list', '--porcelain', '-z'],
        { encoding: 'utf8', env: HERMETIC_GIT_ENV },
      );
      const paths = output
        .split('\0')
        .filter((field) => field.startsWith('worktree '))
        .map((field) => resolve(field.slice('worktree '.length), registryRelativePath));
      return [...new Set(paths)].sort();
    },
  };
}

/**
 * Ajv-compiled validator for the finding schema. Compiled once at
 * first-use; exits 1 if the stub fails validation. This is the
 * add-time half of the Tier-1 defence (companion to the
 * finding-registry-integrity Jest invariant that validates the whole
 * ledger in CI). Before this existed, historical seed scripts wrote
 * entries with free-text evidence and over-long titles that violated
 * the schema; those entries survived until the invariant ran post-hoc.
 * Now every append is schema-checked before the hash chain advances.
 */
const cachedValidators = new Map<string, ValidateFunction>();
function loadStubValidator(schemaPath = SCHEMA_PATH): ValidateFunction {
  const cached = cachedValidators.get(schemaPath);
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator = ajv.compile(schema);
  cachedValidators.set(schemaPath, validator);
  return validator;
}

/**
 * Finding schema mirror — narrow to what the CLI touches. The canonical
 * schema lives in docs/reviews/_registry/findings.jsonl.schema.json; we
 * keep these interfaces structural (no runtime validation here — the
 * integrity invariant test enforces schema conformance separately).
 */
export interface Finding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  state: 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';
  title: string;
  layer?: number;
  evidence?: string[];
  rule_violated?: string;
  owner_agent: string;
  raised_in_cycle: string;
  review_file?: string;
  created_at: string;
  closed_at: string | null;
  closing_commits: string[];
  /** Closers an override reopen rejected; see `closureAdmissible`. */
  rejected_closing_commits?: string[];
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
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export interface CanonicalRegistryPrefixCheck {
  violation: string | null;
  branchSuffixStartIndex: number;
}

export function checkCanonicalRegistryPrefix(
  currentEntries: readonly unknown[],
  canonicalEntries: readonly unknown[],
  startIndex: number,
): CanonicalRegistryPrefixCheck {
  const branchSuffixStartIndex = canonicalEntries.length;
  if (startIndex < canonicalEntries.length) {
    return {
      branchSuffixStartIndex,
      violation:
        `start index ${startIndex} enters the canonical origin/main prefix ` +
        `(${canonicalEntries.length} entries)`,
    };
  }
  if (currentEntries.length < canonicalEntries.length) {
    return {
      branchSuffixStartIndex,
      violation:
        `branch registry has ${currentEntries.length} entries but canonical origin/main has ` +
        `${canonicalEntries.length}`,
    };
  }
  for (let index = 0; index < canonicalEntries.length; index += 1) {
    if (canonicalJson(currentEntries[index]) !== canonicalJson(canonicalEntries[index])) {
      return {
        branchSuffixStartIndex,
        violation: `canonical origin/main entry ${index} differs from the branch registry`,
      };
    }
  }
  return { branchSuffixStartIndex, violation: null };
}

export function parseRechainStartIndex(raw: string | undefined): number | null {
  if (raw === undefined || !/^(?:0|[1-9]\d*)$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function loadRegistry(registryPath = REGISTRY_PATH): Finding[] {
  if (!existsSync(registryPath)) return [];
  const raw = readFileSync(registryPath, 'utf8').trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Finding);
}

function loadReservationLedger(reservationPath: string): FindingIdReservationLedger {
  if (!existsSync(reservationPath)) return { version: 1, domains: {} };
  const value = JSON.parse(readFileSync(reservationPath, 'utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Finding ID reservation ledger is not an object: ${reservationPath}`);
  }
  const candidate = value as Partial<FindingIdReservationLedger>;
  if (
    candidate.version !== 1 ||
    candidate.domains === null ||
    typeof candidate.domains !== 'object' ||
    Array.isArray(candidate.domains)
  ) {
    throw new Error(`Finding ID reservation ledger has an invalid envelope: ${reservationPath}`);
  }

  for (const [domain, reservation] of Object.entries(candidate.domains)) {
    if (
      !/^[A-Z][A-Z0-9]*$/.test(domain) ||
      reservation === null ||
      typeof reservation !== 'object' ||
      !Number.isSafeInteger(reservation.sequence) ||
      reservation.sequence < 1 ||
      reservation.sequence > 999 ||
      typeof reservation.finding_id !== 'string' ||
      !new RegExp(`^${domain}-[A-Z0-9]+-${String(reservation.sequence).padStart(3, '0')}$`).test(
        reservation.finding_id,
      ) ||
      typeof reservation.reserved_at !== 'string' ||
      !Number.isFinite(Date.parse(reservation.reserved_at)) ||
      typeof reservation.registry_path !== 'string' ||
      reservation.registry_path.length === 0
    ) {
      throw new Error(
        `Finding ID reservation ledger has an invalid ${domain} record: ${reservationPath}`,
      );
    }
  }
  return candidate as FindingIdReservationLedger;
}

function idsFromActiveRegistries(authority: FindingAllocationAuthority): string[] {
  const ids: string[] = [];
  for (const registryPath of authority.activeRegistryPaths()) {
    if (!existsSync(registryPath)) continue;
    ids.push(...loadRegistry(registryPath).map((entry) => entry.id));
  }
  return ids;
}

function reserveFindingId(
  authority: FindingAllocationAuthority,
  ledger: FindingIdReservationLedger,
  domain: string,
  findingId: string,
  registryPath: string,
  lease: RegistryLockLease,
): void {
  const sequence = Number.parseInt(findingId.slice(-3), 10);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999) {
    throw new RangeError(`Finding reservation sequence is out of range: ${findingId}`);
  }
  const current = ledger.domains[domain];
  if (current && current.sequence >= sequence) return;
  const nextLedger: FindingIdReservationLedger = {
    version: 1,
    domains: {
      ...ledger.domains,
      [domain]: {
        sequence,
        finding_id: findingId,
        reserved_at: new Date().toISOString(),
        registry_path: registryPath,
      },
    },
  };
  atomicWriteFileWithRegistryLease(
    authority.reservationPath,
    `${JSON.stringify(nextLedger)}\n`,
    lease,
  );
}

function writeRegistry(
  entries: readonly Finding[],
  lease: RegistryLockLease,
  registryPath = REGISTRY_PATH,
): void {
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  atomicWriteRegistryFile(registryPath, content, lease);
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
    process.stderr.write(`FAIL: ${result.reason}\n\n`);
    return 1;
  }
  process.stdout.write(`OK: registry chain valid (${result.entries} entries).\n\n`);
  const tip = entries.length === 0 ? ZERO_HASH : (entries[entries.length - 1]?.content_hash ?? '');
  if (tip) process.stdout.write(`Chain tip: ${tip}\n\n`);
  return 0;
}

function readFindingStub(stubPath: string): Partial<Finding> | null {
  if (!existsSync(stubPath)) {
    process.stderr.write(`Stub file not found: ${stubPath}\n\n`);
    return null;
  }
  const stubRaw = readFileSync(stubPath, 'utf8');
  return JSON.parse(stubRaw) as Partial<Finding>;
}

function buildFinding(stub: Partial<Finding>, id: string): Finding | null {
  const required: (keyof Finding)[] = [
    'severity',
    'state',
    'title',
    'owner_agent',
    'raised_in_cycle',
    'created_at',
  ];
  for (const field of required) {
    if (stub[field] === undefined || stub[field] === null) {
      process.stderr.write(`Stub missing required field: ${field}\n\n`);
      return null;
    }
  }

  return {
    id,
    severity: stub.severity as Finding['severity'],
    state: stub.state as Finding['state'],
    title: stub.title as string,
    ...(stub.layer === undefined || stub.layer === null ? {} : { layer: stub.layer }),
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
    ...(stub.narrative ? { narrative: stub.narrative } : {}),
    prev_hash: ZERO_HASH, // fixed by rechain
    content_hash: ZERO_HASH, // fixed by rechain
  };
}

function validateAndAppendFinding(
  newEntry: Finding,
  entries: Finding[],
  lease: RegistryLockLease,
  paths: RegistryPaths,
  beforeRegistryWrite?: () => void,
): number {
  if (entries.some((entry) => entry.id === newEntry.id)) {
    process.stderr.write(`Duplicate id: ${newEntry.id} already exists in registry.\n\n`);
    return 1;
  }

  // Schema validation BEFORE rechain: reject malformed stubs at the
  // earliest point. The prev_hash/content_hash placeholders match the
  // schema's pattern rule (64-hex OR 64-zero), so validation can run
  // pre-rechain. This guarantees no schema-violating entry ever hits
  // the JSONL — the invariant test becomes a belt-and-suspenders
  // check rather than the primary defence.
  const validate = loadStubValidator(paths.schemaPath);
  if (!validate(newEntry)) {
    process.stderr.write('Stub failed schema validation:\n');
    for (const err of validate.errors ?? []) {
      process.stderr.write(
        `  ${err.instancePath || '<root>'}: ${err.message} (${err.keyword})\n\n`,
      );
    }
    return 1;
  }

  const invalidEvidence = findNonCanonicalFindingEvidence(newEntry.evidence);
  if (invalidEvidence.length > 0) {
    process.stderr.write(
      'Stub evidence must use canonical file/path citation shapes; move diagnostic prose to narrative:\n',
    );
    for (const violation of invalidEvidence) {
      process.stderr.write(
        `  evidence[${violation.index}]: ${JSON.stringify(violation.evidence)}\n`,
      );
    }
    return 1;
  }

  entries.push(newEntry);
  rechain(entries, entries.length - 1);

  const post = verify(entries);
  if (!post.ok) {
    process.stderr.write(`Post-add integrity check FAILED: ${post.reason}\n\n`);
    return 1;
  }

  beforeRegistryWrite?.();
  writeRegistry(entries, lease, paths.registryPath);
  process.stdout.write(`Added: ${newEntry.id} at position ${entries.length - 1}\n\n`);
  process.stdout.write(`Chain tip: ${newEntry.content_hash}\n\n`);
  return 0;
}

/**
 * Rechain is a writer boundary too: it must never bless malformed suffix rows.
 * Historical pre-cutover evidence keeps its original relaxed contract, while
 * every later row is checked by the same citation authority as fresh appends.
 */
export function validateRegistrySuffixForRechain(
  entries: readonly unknown[],
  startIndex: number,
  schemaPath = SCHEMA_PATH,
): string[] {
  const validate = loadStubValidator(schemaPath);
  const violations: string[] = [];

  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!validate(entry)) {
      for (const error of validate.errors ?? []) {
        violations.push(
          `entry ${index} schema ${error.instancePath || '<root>'}: ${error.message} (${error.keyword})`,
        );
      }
      continue;
    }

    const finding = entry as { id?: string; created_at?: unknown; evidence?: unknown[] };
    if (!requiresCanonicalFindingEvidence(finding.created_at)) continue;
    for (const violation of findNonCanonicalFindingEvidence(finding.evidence)) {
      violations.push(
        `entry ${index} (${String(finding.id ?? '<unknown>')}) evidence[${violation.index}]: ${JSON.stringify(violation.evidence)}`,
      );
    }
  }

  return violations;
}

export type PreparedRegistryRechain =
  | { ok: true; entries: Finding[] }
  | { ok: false; stage: 'suffix' | 'integrity'; failures: string[] };

/**
 * Builds and verifies a rechain candidate without mutating the caller's array.
 * Persistent storage is eligible only when this function returns `ok: true`.
 */
export function prepareRegistryRechain(
  entries: readonly Finding[],
  validationStartIndex: number,
  rechainStartIndex: number,
  schemaPath = SCHEMA_PATH,
): PreparedRegistryRechain {
  const validationFailures = validateRegistrySuffixForRechain(
    entries,
    validationStartIndex,
    schemaPath,
  );
  if (validationFailures.length > 0) {
    return { ok: false, stage: 'suffix', failures: validationFailures };
  }

  const candidate = structuredClone(entries) as Finding[];
  rechain(candidate, rechainStartIndex);
  const result = verify(candidate);
  if (!result.ok) {
    return {
      ok: false,
      stage: 'integrity',
      failures: [result.reason ?? 'registry verification failed without a reason'],
    };
  }
  return { ok: true, entries: candidate };
}

/**
 * Every id already claimed in `domain`, across EVERY store that claims ids.
 *
 * ORPHAN-HIGH-457 — the single reader both append paths must use.
 * `ORPHAN-HIGH-417` fixed the allocator by teaching it to read the markdown
 * orphan store as well as the registry, and left `appendExplicitFinding`
 * reading only the registry. So the exact defect that forced this branch to
 * be retraced — an id handed out that already names a live finding — was
 * still reachable through the other door, and an adversarial audit walked
 * through it: `appendExplicitFinding` accepted `ORPHAN-MEDIUM-416`, which is
 * a live heading in `orphan-findings.md`, and returned 0.
 *
 * Two readers that must agree is the shape that produced the bug. One reader
 * that both callers are forced through is the shape that cannot: a third
 * append path added later inherits every store by construction rather than by
 * the author remembering all of them.
 *
 * The stores, and why each counts:
 *   * the JSONL registry — the obvious one;
 *   * sibling active worktree registries via `authority`, so two concurrent
 *     branches cannot mint the same id;
 *   * `docs/reviews/orphan-findings.md`, which allocates from the SAME ORPHAN
 *     sequence space. At the time this was found the registry's ORPHAN
 *     maximum was 332 while the markdown store was already at 416, so the
 *     next nineteen ids handed out (333-351) all named findings that already
 *     existed. Eight collided exactly, and their commit trailers resolved —
 *     to the wrong finding.
 */
export function claimedIdsForDomain(
  domain: string,
  entries: ReadonlyArray<{ id: string }>,
  authority?: FindingAllocationAuthority,
): string[] {
  const claimed = entries.map((entry) => entry.id);
  if (authority) claimed.push(...idsFromActiveRegistries(authority));
  if (domain === 'ORPHAN') {
    claimed.push(...orphanMarkdownReservedIds(ORPHAN_FINDINGS_MD_PATH));
  }
  return claimed;
}

export function appendAllocatedFinding(
  domain: string,
  stubPath: string,
  lease: RegistryLockLease,
  paths: RegistryPaths = DEFAULT_REGISTRY_PATHS,
  authority?: FindingAllocationAuthority,
): number {
  if (
    lease.resourcePath !== paths.registryPath ||
    (authority !== undefined && lease.lockPath !== authority.lockPath)
  ) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      'Allocated append requires a lease for both the target registry and its allocation authority.',
    );
  }
  const stub = readFindingStub(stubPath);
  if (!stub) return 2;
  if (stub.id !== undefined) {
    process.stderr.write(
      'Allocated add refuses a caller-supplied id; remove id from the stub or use add-explicit for governed replay/import.\n',
    );
    return 2;
  }
  if (stub.severity === undefined) {
    process.stderr.write('Stub missing required field: severity\n');
    return 2;
  }

  const entries = loadRegistry(paths.registryPath);
  const reservationLedger = authority ? loadReservationLedger(authority.reservationPath) : null;
  const existingIds = claimedIdsForDomain(domain, entries, authority);
  const reserved = reservationLedger?.domains[domain];
  if (reserved) {
    existingIds.push(`${domain}-RESERVED-${String(reserved.sequence).padStart(3, '0')}`);
  }
  let id: string;
  try {
    id = nextFindingId(domain, stub.severity, existingIds);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    return 2;
  }
  const newEntry = buildFinding(stub, id);
  if (!newEntry) return 2;
  return validateAndAppendFinding(newEntry, entries, lease, paths, () => {
    if (authority && reservationLedger) {
      reserveFindingId(authority, reservationLedger, domain, id, paths.registryPath, lease);
    }
  });
}

export function appendExplicitFinding(
  stubPath: string,
  lease: RegistryLockLease,
  paths: RegistryPaths = DEFAULT_REGISTRY_PATHS,
  authority?: FindingAllocationAuthority,
): number {
  if (
    lease.resourcePath !== paths.registryPath ||
    (authority !== undefined && lease.lockPath !== authority.lockPath)
  ) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      'Explicit append requires a lease for both the target registry and its allocation authority.',
    );
  }
  const stub = readFindingStub(stubPath);
  if (!stub) return 2;
  if (typeof stub.id !== 'string' || stub.id.length === 0) {
    process.stderr.write('Explicit-id stub missing required field: id\n');
    return 2;
  }
  const entries = loadRegistry(paths.registryPath);

  const idParts = /^([A-Z][A-Z0-9]*)-([A-Z0-9]+)-([0-9]{3})$/.exec(stub.id);
  if (!idParts?.[1] || !idParts[2] || !idParts[3]) {
    process.stderr.write(`Explicit finding id has an invalid allocation shape: ${stub.id}\n\n`);
    return 2;
  }
  // ORPHAN-HIGH-457 — the same stores AND the same sequence extraction the
  // allocator uses. Shape is parsed first because the domain decides which
  // stores apply. Two things were wrong here before: this path consulted the
  // registry alone, and it compared full id strings. Both matter — the
  // markdown store normalizes to `ORPHAN-RESERVED-NNN` (a heading carries no
  // severity) and the classifier segment varies with severity anyway, so
  // `ORPHAN-MEDIUM-416` never string-matched the live `416` heading. The
  // sequence is the identity.
  const claimed = claimedSequences(idParts[1], claimedIdsForDomain(idParts[1], entries, authority));
  if (claimed.has(Number.parseInt(idParts[3], 10))) {
    process.stderr.write(
      `Duplicate id: ${stub.id} — sequence ${idParts[3]} is already claimed in ` +
        `domain ${idParts[1]} by the registry, a sibling worktree registry, or ` +
        `docs/reviews/orphan-findings.md.\n`,
    );
    return 1;
  }
  if (Number.parseInt(idParts[3], 10) < 1) {
    process.stderr.write(`Explicit finding id suffix must be between 001 and 999: ${stub.id}\n\n`);
    return 2;
  }
  if (
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(idParts[2]) &&
    stub.severity !== undefined &&
    idParts[2] !== stub.severity
  ) {
    process.stderr.write(
      `Explicit finding id classifier ${idParts[2]} does not match severity ${stub.severity}: ${stub.id}\n`,
    );
    return 2;
  }
  const reservationLedger = authority ? loadReservationLedger(authority.reservationPath) : null;
  const newEntry = buildFinding(stub, stub.id);
  if (!newEntry) return 2;
  return validateAndAppendFinding(newEntry, entries, lease, paths, () => {
    if (authority && reservationLedger) {
      reserveFindingId(
        authority,
        reservationLedger,
        idParts[1] as string,
        stub.id as string,
        paths.registryPath,
        lease,
      );
    }
  });
}

export function appendNarrativeFinding(
  stubPath: string,
  lease: RegistryLockLease,
  paths: NarrativeImportPaths = DEFAULT_NARRATIVE_IMPORT_PATHS,
  authority?: FindingAllocationAuthority,
): number {
  if (
    lease.resourcePath !== paths.registryPath ||
    (authority !== undefined && lease.lockPath !== authority.lockPath)
  ) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      'Narrative import requires a lease for both the target registry and its allocation authority.',
    );
  }

  const stub = readFindingStub(stubPath);
  if (!stub) return 2;
  if (typeof stub.id !== 'string' || stub.id.length === 0) {
    process.stderr.write('Narrative import stub missing required field: id\n');
    return 2;
  }

  const idParts = /^ORPHAN-(CRITICAL|HIGH|MEDIUM|LOW)-([0-9]{3})$/.exec(stub.id);
  if (!idParts?.[1] || !idParts[2]) {
    process.stderr.write(`Narrative import requires an ORPHAN severity-qualified id: ${stub.id}\n`);
    return 2;
  }
  if (stub.severity !== idParts[1]) {
    process.stderr.write(
      `Narrative finding id classifier ${idParts[1]} does not match severity ${String(stub.severity)}: ${stub.id}\n`,
    );
    return 2;
  }

  const entries = loadRegistry(paths.registryPath);
  const structuredIds = entries.map((entry) => entry.id);
  if (authority) structuredIds.push(...idsFromActiveRegistries(authority));
  if (claimedSequences('ORPHAN', structuredIds).has(Number.parseInt(idParts[2], 10))) {
    process.stderr.write(
      `Duplicate id: ${stub.id} — sequence ${idParts[2]} is already claimed by the registry or a sibling worktree registry.\n`,
    );
    return 1;
  }

  if (!existsSync(paths.narrativePath)) {
    process.stderr.write(`Narrative findings file not found: ${paths.narrativePath}\n`);
    return 1;
  }
  const matchingHeadings: string[] = [];
  const sequenceHeadings: string[] = [];
  for (const line of readFileSync(paths.narrativePath, 'utf8').split('\n')) {
    const heading = ORPHAN_MD_HEADING_REGEX.exec(line);
    if (!heading?.[1] || heading[2] !== idParts[2]) continue;
    sequenceHeadings.push(line);
    if (heading[1] === stub.id) matchingHeadings.push(line);
  }
  if (matchingHeadings.length !== 1 || sequenceHeadings.length !== 1) {
    const reason =
      matchingHeadings.length > 1
        ? `${stub.id} occurs ${matchingHeadings.length} times`
        : sequenceHeadings.length > 0
          ? `sequence ${idParts[2]} belongs to ${sequenceHeadings.join(', ')}`
          : `${stub.id} has no heading`;
    process.stderr.write(`Narrative import refused: ${reason} in ${paths.narrativePath}.\n`);
    return 1;
  }

  if (stub.review_file !== paths.narrativeReviewFile) {
    process.stderr.write(
      `Narrative import review_file must be ${paths.narrativeReviewFile}: ${String(stub.review_file)}\n`,
    );
    return 1;
  }
  const expectedEvidenceAnchor = `${paths.narrativeReviewFile}#${stub.id}`;
  if (!stub.evidence?.includes(expectedEvidenceAnchor)) {
    process.stderr.write(`Narrative import evidence must resolve to ${expectedEvidenceAnchor}.\n`);
    return 1;
  }

  const historicalHeading = matchingHeadings[0] as string;
  const historicalNote = `Historical narrative heading: ${historicalHeading.slice(3)}`;
  const importedStub: Partial<Finding> = {
    ...stub,
    state: 'OPEN',
    closed_at: null,
    closing_commits: [],
    notes: stub.notes ? `${stub.notes}\n${historicalNote}` : historicalNote,
  };
  const newEntry = buildFinding(importedStub, stub.id);
  if (!newEntry) return 2;
  const reservationLedger = authority ? loadReservationLedger(authority.reservationPath) : null;
  return validateAndAppendFinding(newEntry, entries, lease, paths, () => {
    if (authority && reservationLedger) {
      reserveFindingId(
        authority,
        reservationLedger,
        'ORPHAN',
        stub.id as string,
        paths.registryPath,
        lease,
      );
    }
  });
}

function cmdClose(id: string, shortSha: string, lease: RegistryLockLease): number {
  if (!/^[a-f0-9]{7,40}$/i.test(shortSha)) {
    console.error(`Invalid SHA: ${shortSha} (expected 7-40 hex chars).`);
    return 2;
  }

  // PROC-HIGH-001 structural guard (Round-2 cluster-0): the three-store
  // invariant requires every closing_commits SHA to exist in fetchable
  // history. A feature-branch SHA is GUARANTEED to be invalidated by
  // branch cleanup after merge (2026-06-10: 7 rows orphaned by #378,
  // repaired in #384; SEC-CRITICAL-002 / AUDIT-CRITICAL-006 recurrences
  // repaired in #380 / cluster-0). The ceremony therefore runs ONLY
  // post-merge, with a main-reachable commit whose own message carries
  // the matching Closes: trailer. Fail-closed — an unresolvable
  // origin/main (stale fetch, shallow clone) refuses with instructions
  // rather than certifying blind.
  // tier-1: runtime guard commitReachableFrom (git-reachability.ts) refuses branch-local closing SHAs at the only write path; CI invariant finding-registry-integrity.spec.ts enforces the stored chain
  const reachability = commitReachableFrom(REPO_ROOT, shortSha, 'origin/main');
  if (!reachability.ok) {
    // process.stderr.write (not console.error): no-console is an
    // error-level lint rule; the file's legacy console.* calls are
    // baseline-grandfathered but new lines must use the stream API.
    process.stderr.write(`close refused: ${reachability.reason}\n\n`);
    return 1;
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

  const traceability = commitHasFindingCloseTrailer(REPO_ROOT, shortSha, id);
  if (!traceability.ok) {
    process.stderr.write(`close refused: ${traceability.reason}\n\n`);
    return 1;
  }

  const admission = closureAdmissible(entry, shortSha);
  if (!admission.ok) {
    process.stderr.write(`close refused: ${admission.reason}\n\n`);
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

  writeRegistry(entries, lease);
  console.log(`Closed: ${id} at position ${index} → state=RESOLVED, +commit ${shortSha}`);
  const tip = entries.length === 0 ? ZERO_HASH : (entries[entries.length - 1]?.content_hash ?? '');
  console.log(`Chain tip: ${tip}`);
  return 0;
}

/**
 * `reopen <id>` — the inverse admission `close` needs but lacked: a finding
 * registered state=RESOLVED at birth (a registration error — the close
 * ceremony cannot run pre-merge because `close` refuses branch-local SHAs by
 * design, PROC-HIGH-001) had no sanctioned path back to the honest OPEN
 * state. Reopen is deliberately NARROW: it only clears the close fields on a
 * row that has NO closing_commits (a row closed through the ceremony keeps
 * its history — reopening THAT is a state-machine override, a different and
 * heavier decision), restitches the chain exactly like close, and refuses to
 * write if verification fails.
 */
/** `reopen --reject-closure=<sha> --reason=<why>`: the override decision, made explicit. */
export interface ClosureRejection {
  readonly shas: readonly string[];
  readonly reason: string;
  /** ISO-8601 timestamp recorded in the note; injectable for tests. */
  readonly now?: string;
}

export interface ClosureRejectionOutcome {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Override reopen — the inverse of a ceremony close.
 *
 * A closing commit's trailer is permanent history, and `reconcile` re-derives
 * RESOLVED from it on every run. Reopening a ceremonially-closed finding
 * therefore cannot mean "clear the fields": the same commit would close it
 * again at the next derivation (PLAT-MEDIUM-901, 2026-09-04 — a free-text
 * "[REOPENED …]" note was all that stood between the finding and its old
 * closer). The override instead REJECTS the closer: the SHA moves from
 * `closing_commits` to `rejected_closing_commits`, where `close`, `reconcile`
 * and the closure-drift gate refuse it, and only a NEW closing commit can
 * resolve the finding again. Every current closer must be rejected in the
 * same decision — a finding still closed by another commit is still closed.
 */
export function applyClosureRejection(
  entry: Finding,
  rejection: ClosureRejection,
): ClosureRejectionOutcome {
  if (rejection.reason.trim().length === 0) {
    return {
      ok: false,
      reason: 'override reopen requires --reason=<why the closer did not close it>',
    };
  }
  if (rejection.shas.length === 0) {
    return { ok: false, reason: 'override reopen requires at least one --reject-closure=<sha>' };
  }
  if (entry.state !== 'RESOLVED' && entry.state !== 'OPEN' && entry.state !== 'IN-PROGRESS') {
    return {
      ok: false,
      reason: `${entry.id} is ${entry.state}; reject its closers from OPEN/IN-PROGRESS/RESOLVED`,
    };
  }
  const rejects = (closer: string): boolean =>
    rejection.shas.some((sha) =>
      findingRejectsClosure({ id: entry.id, rejected_closing_commits: [sha] }, closer),
    );
  // A RESOLVED row is still closed by every closer the decision leaves standing.
  const remaining = entry.closing_commits.filter((closer) => !rejects(closer));
  if (remaining.length > 0) {
    return {
      ok: false,
      reason:
        `${entry.id} would still be closed by ${remaining.join(', ')}; reject every current closer ` +
        'in the same decision or leave the finding RESOLVED',
    };
  }

  const already = entry.rejected_closing_commits ?? [];
  const fromRow = entry.closing_commits.filter((closer) => !already.includes(closer));
  const extra = rejection.shas.filter(
    (sha) =>
      !fromRow.some((closer) =>
        findingRejectsClosure({ id: entry.id, rejected_closing_commits: [sha] }, closer),
      ) &&
      !already.some((closer) =>
        findingRejectsClosure({ id: entry.id, rejected_closing_commits: [sha] }, closer),
      ),
  );
  const rejected = [...fromRow, ...extra];
  entry.rejected_closing_commits = [...already, ...rejected];
  entry.closing_commits = [];
  entry.state = entry.state === 'RESOLVED' ? 'OPEN' : entry.state;
  entry.closed_at = null;
  const stamp = (rejection.now ?? new Date().toISOString()).slice(0, 10);
  entry.notes =
    String(entry.notes ?? '') +
    ` [override reopen ${stamp}: closer ${rejected.map((sha) => sha.slice(0, 12)).join(', ')} rejected — ${rejection.reason.trim()}]`;
  return { ok: true };
}

/** Resolve a user-supplied SHA prefix to the full commit id, or explain why not. */
function resolveFullSha(repoRoot: string, sha: string): { sha?: string; reason?: string } {
  try {
    const full = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', `${sha}^{commit}`], {
      encoding: 'utf8',
      env: repoPinnedEnv(),
    }).trim();
    return /^[0-9a-f]{40}$/.test(full)
      ? { sha: full }
      : { reason: `${sha} did not resolve to a commit` };
  } catch (err) {
    return { reason: `${sha} is not a readable commit: ${(err as Error).message}` };
  }
}

function cmdReopen(id: string, lease: RegistryLockLease, rejection?: ClosureRejection): number {
  const entries = loadRegistry();
  const index = entries.findIndex((e) => e.id === id);
  if (index === -1) {
    process.stderr.write(`Finding not found: ${id}\n`);
    return 1;
  }
  const entry = entries[index];
  if (!entry) {
    process.stderr.write(`Finding at index ${index} is undefined — registry corruption?\n`);
    return 1;
  }
  if (rejection !== undefined) {
    // Every rejected SHA must be a real commit whose own trailer names this
    // finding (or a closer the ceremony already recorded): rejecting anything
    // else is a typo, not a decision.
    const shas: string[] = [];
    for (const given of rejection.shas) {
      const resolved = resolveFullSha(REPO_ROOT, given);
      if (resolved.sha === undefined) {
        process.stderr.write(`reopen refused: ${resolved.reason}\n`);
        return 1;
      }
      const recorded = entry.closing_commits.some((closer) =>
        closer.startsWith(resolved.sha ?? ''),
      );
      const trailer = commitHasFindingCloseTrailer(REPO_ROOT, resolved.sha, id);
      if (!recorded && !trailer.ok) {
        process.stderr.write(`reopen refused: ${trailer.reason}\n`);
        return 1;
      }
      shas.push(resolved.sha);
    }
    const outcome = applyClosureRejection(entry, { ...rejection, shas });
    if (!outcome.ok) {
      process.stderr.write(`reopen refused: ${outcome.reason}\n`);
      return 1;
    }
    // Fail closed: a reopen that leaves an unrejected closer on origin/main is
    // undone by the next reconcile, so it is not persisted at all.
    const standing = listMergedClosers(REPO_ROOT, 'origin/main', entry);
    if (standing.length > 0) {
      process.stderr.write(
        `reopen refused: origin/main still closes ${id} through ${standing
          .map((sha) => sha.slice(0, 12))
          .join(', ')} — add --reject-closure=<sha> for each, in the same decision.\n`,
      );
      return 1;
    }
  } else {
    if (entry.state !== 'RESOLVED') {
      process.stdout.write(`No-op: ${id} is already ${entry.state}.\n`);
      return 0;
    }
    if (entry.closing_commits.length > 0) {
      process.stderr.write(
        `reopen refused: ${id} carries closing_commits (${entry.closing_commits.join(', ')}) — ` +
          'it was closed through the ceremony; reopening a ceremonially-closed finding is an ' +
          'override decision: reopen <id> --reject-closure=<sha> --reason=<why>.\n',
      );
      return 1;
    }

    entry.state = 'OPEN';
    entry.closed_at = null;
    entry.notes =
      String(entry.notes ?? '') +
      ' [governed reopen: was registered RESOLVED at birth in error — the close ceremony runs post-merge via `close` with the main-reachable fix SHA.]';
  }
  rechain(entries, index);
  const post = verify(entries);
  if (!post.ok) {
    process.stderr.write(`Post-reopen integrity check FAILED: ${post.reason}\n`);
    return 1;
  }
  writeRegistry(entries, lease);
  process.stdout.write(
    `Reopened: ${id} at position ${index} → state=OPEN (close fields cleared).\n`,
  );
  const tip = entries.length === 0 ? ZERO_HASH : (entries[entries.length - 1]?.content_hash ?? '');
  process.stdout.write(`Chain tip: ${tip}\n`);
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
export function planSweep(entries: readonly Finding[], config: SweepConfig): SweepAction[] {
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
    //
    // CRITICAL findings are EXEMPT from auto-staleness: silence is not
    // resolution for a critical. The first live sweep staled 29 open
    // CRITICALs at once and the enterprise-grade debt-plan contract
    // (tests/invariants/enterprise-grade-debt-plan-contract.spec.ts)
    // refused the resulting PR — correctly: retiring unfixed critical
    // debt by timeout is the audit-theater class that contract exists
    // to stop. A critical leaves OPEN through a fix commit's Closes:,
    // an explicit operator waiver, or the past-deadline BLOCKED branch
    // above — never through the calendar.
    if (entry.severity === 'CRITICAL') continue;
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

function cmdSweep(args: string[], lease: RegistryLockLease): number {
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

  writeRegistry(entries, lease);
  const tip = entries.length === 0 ? ZERO_HASH : (entries[entries.length - 1]?.content_hash ?? '');
  console.log('');
  console.log(`Applied ${actions.length} transitions. Chain tip: ${tip}`);
  return 0;
}

/**
 * Stdout writer for new code in this file.
 *
 * `no-console` is an error-level lint rule; this file's existing `console.*`
 * calls are baseline-grandfathered, but lines added after that baseline use the
 * stream API (the same rule `cmdClose` follows for stderr).
 */
function writeOut(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Read-only registry access for gates.
 *
 * Exported rather than duplicating the parse: `loadRegistry` already handles the
 * file's line format and ordering, and a spec that re-implemented it could
 * disagree with the tool about what the registry contains — which is exactly the
 * split this whole reconciliation exists to close.
 */
export function loadRegistryForInspection(registryPath = REGISTRY_PATH): readonly Finding[] {
  return loadRegistry(registryPath);
}

/** A merged commit that closes a finding, as read from git history. */
export interface MergedClosure {
  readonly findingId: string;
  /** Full SHA of the commit whose message carries the `Closes:` trailer. */
  readonly sha: string;
}

/** Record/unit separators — safe inside commit bodies, unlike newlines. */
const LOG_RECORD_SEP = '';
const LOG_FIELD_SEP = '';

interface MergedCommit {
  readonly sha: string;
  readonly message: string;
}

/** Every commit reachable from `ref`, OLDEST first, with its full message. */
function readMergedCommits(repoRoot: string, ref: string): MergedCommit[] {
  const raw = execFileSync(
    'git',
    ['-C', repoRoot, 'log', ref, `--pretty=format:%H${LOG_FIELD_SEP}%B${LOG_RECORD_SEP}`],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: repoPinnedEnv() },
  );

  // `git log` walks newest-first; reverse so the OLDEST closure is recorded.
  return raw
    .split(LOG_RECORD_SEP)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const cut = record.indexOf(LOG_FIELD_SEP);
      return { sha: record.slice(0, cut).trim(), message: record.slice(cut + 1) };
    })
    .reverse();
}

/**
 * EVERY commit reachable from `ref` whose trailer closes `candidate`, oldest
 * first, rejected closers excluded. `collectMergedClosures` records only the
 * oldest; an override reopen must see all of them, because each one the
 * reopen leaves unrejected would close the finding again at the next
 * derivation.
 */
export function listMergedClosers(
  repoRoot: string,
  ref: string,
  candidate: FindingTrailerTarget,
): string[] {
  return readMergedCommits(repoRoot, ref)
    .filter((commit) => /^[0-9a-f]{40}$/i.test(commit.sha))
    .filter((commit) => commit.message.includes('Closes:'))
    .filter((commit) => !findingRejectsClosure(candidate, commit.sha))
    .filter((commit) => commitMessageClosesFindingExactly(commit.message, candidate))
    .map((commit) => commit.sha);
}

/**
 * Finding IDs named by `Closes:` trailers on commits reachable from `ref`.
 *
 * The commit trailer is the ONLY closure signal the platform actually enforces:
 * `commit-msg-validator` refuses a fix/security/refactor commit without one, and
 * validates the ID against this registry. The registry's `state` field, by
 * contrast, is maintained by a manual post-merge ceremony. Two records of the
 * same fact, one enforced and one not — so the unenforced one drifted, and it is
 * the one the dashboards and sweeps read.
 *
 * This makes the enforced record the source: state is DERIVED from merged
 * history rather than remembered.
 *
 * Oldest closure wins when several commits close the same finding: it is the one
 * that made the finding true, and later commits are follow-ups.
 */
export function collectMergedClosures(
  repoRoot: string,
  ref: string,
  candidates: readonly FindingTrailerTarget[],
): MergedClosure[] {
  const commits = readMergedCommits(repoRoot, ref);

  const found = new Map<string, string>();
  for (const commit of commits) {
    if (!/^[0-9a-f]{40}$/i.test(commit.sha)) continue;
    if (!commit.message.includes('Closes:')) continue;
    for (const candidate of candidates) {
      if (found.has(candidate.id)) continue;
      // A closer an override reopen rejected is not evidence, however old it
      // is; the finding closes only through a commit made after the reopen.
      if (findingRejectsClosure(candidate, commit.sha)) continue;
      // Derivation is stricter than admission: the commit-msg gate's matcher
      // accepts a BACKLOG-* trailer for any id (fine when recording one commit
      // against one finding), but read back over the whole of merged history
      // it would close every finding at once and let a reused id be closed by
      // a commit that cited another review file. The exact matcher binds the
      // id and, when the trailer carries an anchor, the finding's review_file.
      if (commitMessageClosesFindingExactly(commit.message, candidate)) {
        found.set(candidate.id, commit.sha);
      }
    }
  }

  return [...found].map(([findingId, sha]) => ({ findingId, sha }));
}

/** A registry entry whose state contradicts merged history. */
export interface ClosureDrift {
  readonly findingId: string;
  readonly sha: string;
  readonly currentState: Finding['state'];
}

/**
 * Findings that merged history says are closed but the registry does not.
 *
 * Shared by `reconcile` (which fixes them) and the closure-drift invariant
 * (which fails the build when any remain) — one definition of "drift", so the
 * gate can never disagree with the repair.
 */
export function planClosureReconciliation(
  entries: readonly Finding[],
  closures: readonly MergedClosure[],
): ClosureDrift[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const drift: ClosureDrift[] = [];
  for (const closure of closures) {
    const entry = byId.get(closure.findingId);
    if (!entry) continue; // ORPHAN-*/ARIA ids live outside this registry by design.
    // An already-RESOLVED finding contradicts nothing, even when the oldest
    // trailer names a different commit than the one the ceremony recorded.
    // Appending that commit would not be reconciliation — it would be this tool
    // second-guessing a completed ceremony about which change actually closed
    // the finding, which is a judgement it has no evidence to make.
    if (entry.state === 'RESOLVED') continue;
    drift.push({ findingId: closure.findingId, sha: closure.sha, currentState: entry.state });
  }
  return drift;
}

/**
 * `reconcile` — derive RESOLVED state from merged history.
 *
 * The close ceremony (`close <id> <sha>`) is correct in every constraint it
 * imposes: the SHA must be reachable from `origin/main`, and that commit's own
 * message must carry the matching trailer. What it lacked was a driver — a human
 * had to remember to run it, once per finding, after every merge. At the time
 * this was written, 136 findings closed by commits already on main were still
 * OPEN or IN-PROGRESS, and the daily `sweep` was on course to relabel that
 * completed work as STALE.
 *
 * Every planned transition is re-validated through the SAME two guards `close`
 * uses. They hold by construction here — the pairs were read out of that very
 * history — but routing through them means there is ONE definition of a legal
 * closure. A guard tightened for `close` tightens for `reconcile` automatically.
 */
function cmdReconcile(args: string[], lease: RegistryLockLease): number {
  const dryRun = args.includes('--dry-run');
  const refArg = args.find((a) => a.startsWith('--ref='));
  const ref = refArg ? refArg.replace('--ref=', '') : 'origin/main';

  const entries = loadRegistry();

  let closures: MergedClosure[];
  try {
    closures = collectMergedClosures(REPO_ROOT, ref, entries);
  } catch (err) {
    process.stderr.write(
      `reconcile refused: cannot read history of "${ref}" — ${(err as Error).message}\n` +
        'Fetch the ref first; certifying closures against an unreadable history is worse ' +
        'than leaving them open.\n',
    );
    return 1;
  }

  const drift = planClosureReconciliation(entries, closures);
  if (drift.length === 0) {
    writeOut(
      `Reconcile clean: registry agrees with ${ref} (${closures.length} merged closures, ` +
        `${entries.length} entries).`,
    );
    return 0;
  }

  writeOut(`Reconcile plan (${drift.length} findings closed on ${ref} but not RESOLVED):`);
  for (const item of drift) {
    writeOut(
      `  ${item.findingId}: ${item.currentState} → RESOLVED  (commit ${item.sha.slice(0, 12)})`,
    );
  }

  if (dryRun) {
    writeOut('');
    writeOut('--dry-run: no mutations written.');
    return 0;
  }

  let minIndex = entries.length;
  for (const item of drift) {
    const reachability = commitReachableFrom(REPO_ROOT, item.sha, ref);
    if (!reachability.ok) {
      process.stderr.write(`reconcile refused for ${item.findingId}: ${reachability.reason}\n`);
      return 1;
    }
    const traceability = commitHasFindingCloseTrailer(REPO_ROOT, item.sha, item.findingId);
    if (!traceability.ok) {
      process.stderr.write(`reconcile refused for ${item.findingId}: ${traceability.reason}\n`);
      return 1;
    }

    const index = entries.findIndex((entry) => entry.id === item.findingId);
    const entry = entries[index];
    if (index === -1 || !entry) continue;
    const admission = closureAdmissible(entry, item.sha);
    if (!admission.ok) {
      process.stderr.write(`reconcile refused for ${item.findingId}: ${admission.reason}\n`);
      return 1;
    }
    entry.state = 'RESOLVED';
    entry.closed_at = entry.closed_at ?? new Date().toISOString();
    if (!entry.closing_commits.includes(item.sha)) {
      entry.closing_commits = [...entry.closing_commits, item.sha];
    }
    if (index < minIndex) minIndex = index;
  }

  rechain(entries, minIndex);
  const post = verify(entries);
  if (!post.ok) {
    process.stderr.write(`Post-reconcile integrity check FAILED: ${post.reason}\n`);
    return 1;
  }

  writeRegistry(entries, lease);
  const tip = entries.length === 0 ? ZERO_HASH : (entries[entries.length - 1]?.content_hash ?? '');
  writeOut('');
  writeOut(`Resolved ${drift.length} findings from ${ref}. Chain tip: ${tip}`);
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
  const stateFilter =
    flags['state']
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
  const sevFilter =
    flags['severity']
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
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
    const criteria =
      [
        stateFilter ? `state=${stateFilter.join(',')}` : null,
        sevFilter ? `severity=${sevFilter.join(',')}` : null,
        ownerFilter ? `owner=${ownerFilter}` : null,
      ]
        .filter(Boolean)
        .join(' ') || 'all';
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
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmtRow = (r: readonly string[]): string =>
    r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(fmtRow(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(fmtRow(r));
  console.log(`\n${matched.length} / ${entries.length} entries matched.`);
  return 0;
}

function cmdRechainFrom(startIdxRaw: string | undefined, lease: RegistryLockLease): number {
  // Branch-suffix helper: after a 3-way merge concatenates branch additions,
  // or before an unmerged malformed tail is corrected, the first branch-only
  // row can carry a stale hash. The canonical origin/main prefix is compared
  // entry-for-entry, including its hashes, and is never eligible for this
  // operation; `close` remains
  // the sole governed command that can transition an already-merged row.
  //
  // Discovery path for the index: run `verify` first — on failure
  // it prints `chain break at entry N (<id>)`. Pass N here.
  if (!startIdxRaw) {
    console.error('rechain-from requires a start index: finding-registry rechain-from <N>');
    return 2;
  }
  const startIndex = parseRechainStartIndex(startIdxRaw);
  if (startIndex === null) {
    console.error(
      `rechain-from: <N> must be a canonical non-negative base-10 integer; got "${startIdxRaw}".`,
    );
    return 2;
  }
  const entries = loadRegistry();
  if (startIndex >= entries.length) {
    console.error(`rechain-from: index ${startIndex} is out of range (entries=${entries.length}).`);
    return 2;
  }
  const canonicalRaw = gitOutput(REPO_ROOT, ['show', `origin/main:${REGISTRY_RELATIVE_PATH}`]);
  const canonicalEntries = canonicalRaw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Finding);
  const prefixCheck = checkCanonicalRegistryPrefix(entries, canonicalEntries, startIndex);
  if (prefixCheck.violation) {
    console.error(`rechain-from: refusing canonical-history mutation: ${prefixCheck.violation}.`);
    return 1;
  }
  // Semantic validation always begins at the canonical-main boundary. The
  // requested index controls only where hashes are recalculated; otherwise a
  // caller could skip invalid branch-only rows by choosing a later hash break.
  const prepared = prepareRegistryRechain(entries, prefixCheck.branchSuffixStartIndex, startIndex);
  if (!prepared.ok) {
    const reason =
      prepared.stage === 'suffix' ? 'an invalid registry suffix' : 'an invalid hash candidate';
    console.error(`rechain-from: refusing to persist ${reason}:`);
    for (const failure of prepared.failures) console.error(`  ${failure}`);
    return 1;
  }
  writeRegistry(prepared.entries, lease);
  console.log(
    `rechain-from: registry integrity restored from entry ${startIndex} (total entries=${entries.length}).`,
  );
  return 0;
}

/**
 * cmdDedupe — one-time cleanup of duplicate ids introduced before the
 * add CLI's uniqueness gate existed. For every id appearing more than
 * once, keeps the entry with the earliest created_at (tie-break: first
 * position) and drops the rest. Rechains from the earliest dropped
 * index; verifies post-rechain.
 *
 * Safety:
 *   - Refuses to drop a duplicate whose content fields differ semantically
 *     from its counterpart (content fields = all fields except prev_hash
 *     and content_hash). Semantic-drift duplicates must be reconciled
 *     by a human editor — automatic-drop would silently lose work.
 *   - --dry-run prints what would change without touching disk.
 *
 * Usage:
 *   finding-registry dedupe [--dry-run]
 */
function cmdDedupe(args: string[], lease: RegistryLockLease): number {
  const dryRun = args.includes('--dry-run');
  const entries = loadRegistry();
  if (entries.length === 0) {
    console.log('dedupe: registry is empty, nothing to do.');
    return 0;
  }

  // Group indices by id.
  const byId = new Map<string, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const list = byId.get(entry.id) ?? [];
    list.push(i);
    byId.set(entry.id, list);
  }

  // Collect indices to drop (sorted descending so splice works without shifting).
  const toDrop: number[] = [];
  const semanticConflicts: { id: string; indices: number[] }[] = [];
  let firstDropIndex = entries.length;

  for (const [id, indices] of byId) {
    if (indices.length < 2) continue;

    const keepers = indices.map((i) => entries[i]!);
    // Detect semantic drift: compare content fields (strip prev_hash + content_hash).
    const canonicals = keepers.map((e) => {
      const { prev_hash: _p, content_hash: _c, ...rest } = e;
      return canonicalJson(rest);
    });
    const allIdentical = canonicals.every((c) => c === canonicals[0]);
    if (!allIdentical) {
      semanticConflicts.push({ id, indices });
      continue;
    }

    // Pick the winner: earliest created_at, tie-break on first index.
    let winnerIdx = indices[0]!;
    let winner = entries[winnerIdx]!;
    for (const i of indices.slice(1)) {
      const candidate = entries[i]!;
      if (candidate.created_at < winner.created_at) {
        winner = candidate;
        winnerIdx = i;
      }
    }
    for (const i of indices) {
      if (i !== winnerIdx) {
        toDrop.push(i);
        if (i < firstDropIndex) firstDropIndex = i;
      }
    }
  }

  if (semanticConflicts.length > 0) {
    console.error(
      `dedupe: ${semanticConflicts.length} duplicate id(s) have semantic drift and CANNOT be auto-dropped:`,
    );
    for (const c of semanticConflicts) {
      console.error(
        `  - ${c.id}: indices [${c.indices.join(', ')}] differ in content; manual reconcile required.`,
      );
    }
    return 1;
  }

  if (toDrop.length === 0) {
    console.log('dedupe: no duplicates found; registry is already clean.');
    return 0;
  }

  console.log(`dedupe: ${toDrop.length} duplicate row(s) will be removed.`);
  console.log(
    `dedupe: affected ids: ${[...byId.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([k]) => k)
      .join(', ')}`,
  );
  console.log(`dedupe: earliest removal position: ${firstDropIndex}`);

  if (dryRun) {
    console.log('dedupe: --dry-run mode, not writing.');
    return 0;
  }

  // Splice highest-index first so earlier indices stay stable.
  toDrop.sort((a, b) => b - a);
  for (const i of toDrop) entries.splice(i, 1);

  rechain(entries, firstDropIndex);
  const result = verify(entries);
  if (!result.ok) {
    console.error(`dedupe: post-rechain verify FAILED: ${result.reason}`);
    return 1;
  }
  writeRegistry(entries, lease);
  console.log(`dedupe: done. Registry is now ${entries.length} entries, chain tip:`);
  console.log(entries[entries.length - 1]?.content_hash ?? '(empty)');
  return 0;
}

function main(): void {
  const [, , sub, ...args] = process.argv;
  if (!sub) {
    console.error(
      'Usage: finding-registry <verify|add|add-explicit|import-narrative|close|sweep|export|list|rechain-from|dedupe> [args]',
    );
    console.error('  verify');
    console.error('  add <domain> <stub.json>  — atomically allocate id + append');
    console.error('  add-explicit <stub.json>  — governed replay/import with fixed id');
    process.stderr.write(
      '  import-narrative <stub.json>  — import one exact ORPHAN heading as OPEN\n',
    );
    console.error('  close <finding-id> <short-sha>');
    console.error('  sweep [--dry-run] [--stale-after=<days>]');
    console.error('  export <json-array|csv>');
    console.error(
      '  list [--state <CSV>] [--severity <CSV>] [--owner <name>] [--format table|id-only|json]',
    );
    // Stream API, not console.*: the surrounding usage lines predate the
    // no-console baseline; new ones do not get to inherit the exemption.
    process.stderr.write(
      '  reconcile [--dry-run] [--ref=<ref>]  — derive RESOLVED from merged Closes: trailers\n',
    );
    console.error('  rechain-from <N>   — post-merge integrity repair (see docblock)');
    console.error('  dedupe [--dry-run] — one-time duplicate-id cleanup (see docblock)');
    process.exit(2);
  }

  let exitCode = 0;
  if (sub === 'verify') {
    exitCode = cmdVerify();
  } else if (sub === 'add') {
    const domain = args[0];
    const stubPath = args[1];
    if (!domain || !stubPath) {
      console.error('add requires domain and stub: finding-registry add <DOMAIN> <stub.json>');
      process.exit(2);
    }
    exitCode = runRegistryMutation((lease, authority) =>
      appendAllocatedFinding(domain, resolve(stubPath), lease, DEFAULT_REGISTRY_PATHS, authority),
    );
  } else if (sub === 'add-explicit') {
    const stubPath = args[0];
    if (!stubPath) {
      console.error('add-explicit requires a stub: finding-registry add-explicit <stub.json>');
      process.exit(2);
    }
    exitCode = runRegistryMutation((lease, authority) =>
      appendExplicitFinding(resolve(stubPath), lease, DEFAULT_REGISTRY_PATHS, authority),
    );
  } else if (sub === 'import-narrative') {
    const stubPath = args[0];
    if (!stubPath) {
      process.stderr.write(
        'import-narrative requires a stub: finding-registry import-narrative <stub.json>\n',
      );
      process.exit(2);
    }
    exitCode = runRegistryMutation((lease, authority) =>
      appendNarrativeFinding(resolve(stubPath), lease, DEFAULT_NARRATIVE_IMPORT_PATHS, authority),
    );
  } else if (sub === 'close') {
    const id = args[0];
    const sha = args[1];
    if (!id || !sha) {
      console.error('close requires id and sha: finding-registry close <id> <sha>');
      process.exit(2);
    }
    exitCode = runRegistryMutation((lease) => cmdClose(id, sha, lease));
  } else if (sub === 'reopen') {
    const id = args[0];
    if (!id) {
      process.stderr.write(
        'reopen requires id: finding-registry reopen <id> [--reject-closure=<sha> ...] [--reason=<why>]\n',
      );
      process.exit(2);
    }
    const rejectedShas = args
      .filter((a) => a.startsWith('--reject-closure='))
      .map((a) => a.slice('--reject-closure='.length));
    const reasonArg = args.find((a) => a.startsWith('--reason='));
    const rejection: ClosureRejection | undefined =
      rejectedShas.length > 0
        ? { shas: rejectedShas, reason: reasonArg ? reasonArg.slice('--reason='.length) : '' }
        : undefined;
    exitCode = runRegistryMutation((lease) => cmdReopen(id, lease, rejection));
  } else if (sub === 'export') {
    const format = args[0];
    if (!format) {
      console.error('export requires a format: finding-registry export <json-array|csv>');
      process.exit(2);
    }
    exitCode = cmdExport(format);
  } else if (sub === 'sweep') {
    exitCode = runRegistryMutation((lease) => cmdSweep(args, lease));
  } else if (sub === 'reconcile') {
    exitCode = runRegistryMutation((lease) => cmdReconcile(args, lease));
  } else if (sub === 'list') {
    exitCode = cmdList(args);
  } else if (sub === 'rechain-from') {
    exitCode = runRegistryMutation((lease) => cmdRechainFrom(args[0], lease));
  } else if (sub === 'dedupe') {
    exitCode = runRegistryMutation((lease) => cmdDedupe(args, lease));
  } else {
    console.error(`Unknown subcommand: ${sub}`);
    process.exit(2);
  }

  process.exit(exitCode);
}

function runRegistryMutation(
  action: (lease: RegistryLockLease, authority: FindingAllocationAuthority) => number,
): number {
  try {
    const authority = resolveGitFindingAllocationAuthority(REPO_ROOT);
    return withRegistryFileLock(REGISTRY_PATH, (lease) => action(lease, authority), {
      lockPath: authority.lockPath,
    });
  } catch (error) {
    if (error instanceof RegistryLockError) {
      process.stderr.write(`Registry mutation refused [${error.code}]: ${error.message}\n\n`);
      return 1;
    }
    process.stderr.write(
      `Registry mutation authority failed closed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (require.main === module) main();
