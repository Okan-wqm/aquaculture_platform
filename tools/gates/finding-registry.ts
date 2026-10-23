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
 *   project              — the registry as readers see it: every row as
 *                           stored, RESOLVED derived from merged Closes:
 *                           trailers (finding-registry-projection.ts).
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
 *
 * Design notes:
 *   * Nothing writes RESOLVED (MF-1, PROC-HIGH-039). A fix commit's merged
 *     `Closes:` trailer IS the closure; the projection derives it at read
 *     time, so main is consistent the moment the fix merges and no second
 *     commit records it.
 *   * A mutation of a past row (reopen, assign, canonicalize-owner, sweep)
 *     re-stitches the chain from that row on (prev_hash pointers of later
 *     entries point at the mutated row's OLD content_hash) and verifies the
 *     result before it is written.
 *
 * Exit codes:
 *   0 — OK
 *   1 — integrity failure / missing id / chain break
 *   2 — usage error
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { findingIdAliasesBeside } from './finding-id-aliases';
import { applyAssignment, type AssignmentRequest } from './finding-registry-assign';
import {
  canonicalJson,
  chainTip,
  type Finding,
  hasAccountableOwner,
  isDeadlineLapsed,
  isUnresolvedFindingState,
  parseRegistryJsonl,
  rechain,
  serializeRegistryJsonl,
  verify,
  ZERO_HASH,
} from './finding-registry-chain';
import {
  applyOwnerCanonicalization,
  canonicalOwner,
  type OwnerCanonicalizationRequest,
} from './finding-registry-owners';
import {
  applyClosureRejection,
  type ClosureRejection,
  closureVerdicts,
  commitNamesFinding,
  listMergedClosers,
  projectRegistry,
  REGISTRY_RELATIVE_PATH,
} from './finding-registry-projection';
import {
  RegistryWriteRefused,
  refuseInvalidChangedRows,
  rowContractViolations,
} from './finding-registry-rows';
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
import { repoPinnedEnv } from './git-reachability';
import { hermeticGitEnv } from './hermetic-git';

// __dirname (CommonJS, per tools/gates/tsconfig.json) — this file
// previously derived REPO_ROOT from import.meta.url, which forced the
// whole CLI through ts-node's ESM loader, made relative TS imports
// unresolvable (ERR_MODULE_NOT_FOUND for both extensionless and .js
// specifiers) and tripped TS1343/TS5097 in the changed-files
// type-check. Every other gate in this directory is CJS; the odd one
// out is now aligned (farm-service-enterprise-guardrails.ts precedent).
const REPO_ROOT = resolve(__dirname, '..', '..');
const REGISTRY_PATH = resolve(REPO_ROOT, REGISTRY_RELATIVE_PATH);
const SCHEMA_PATH = resolve(
  REPO_ROOT,
  'docs',
  'reviews',
  '_registry',
  'findings.jsonl.schema.json',
);
const ORPHAN_FINDINGS_MD_PATH = resolve(REPO_ROOT, 'docs', 'reviews', 'orphan-findings.md');
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

const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = hermeticGitEnv();

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
 * Finding schema mirror — narrow to what the CLI touches. The canonical
 * schema lives in docs/reviews/_registry/findings.jsonl.schema.json; we
 * keep these interfaces structural (no runtime validation here — the
 * integrity invariant test enforces schema conformance separately).
 */
// The Finding shape and the hash-chain algebra live in
// ./finding-registry-chain (one implementation, shared with the git merge
// driver). Re-exported here so existing importers of this CLI keep working.
export type { Finding };

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

function loadRegistry(registryPath = REGISTRY_PATH): Finding[] {
  if (!existsSync(registryPath)) return [];
  return parseRegistryJsonl(readFileSync(registryPath, 'utf8'));
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

/**
 * Append every element of `source` to `target` without spreading it into a
 * call: `target.push(...source)` passes each element as an argument and V8
 * refuses past ~100k of them (RangeError: Maximum call stack size exceeded).
 * The active-registry sweep below concatenates every worktree's registry —
 * 98 worktrees × ~1,600 rows on 2026-09-13 — and failed every registry
 * mutation closed under the authority's own catch. A loop has no such bound.
 */
function appendAll(target: string[], source: ReadonlyArray<string>): void {
  for (const value of source) target.push(value);
}

/** How the sweep reads one registry's ids; the default reads the file, a test injects the ids. */
export interface ActiveRegistryReader {
  readIds: (registryPath: string) => ReadonlyArray<string>;
}

const FILE_REGISTRY_READER: ActiveRegistryReader = {
  readIds: (registryPath) =>
    existsSync(registryPath) ? loadRegistry(registryPath).map((entry) => entry.id) : [],
};

function idsFromActiveRegistries(
  authority: FindingAllocationAuthority,
  reader: ActiveRegistryReader = FILE_REGISTRY_READER,
): string[] {
  const ids: string[] = [];
  for (const registryPath of authority.activeRegistryPaths()) {
    appendAll(ids, reader.readIds(registryPath));
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

/**
 * The registry's only write. Every row this write changes is held to the row
 * contract first (`refuseInvalidChangedRows`, ARIA-HIGH-044), so no mutator —
 * add, reopen, sweep, dedupe, assign, canonicalize-owner, or one written later —
 * can persist a row the schema refuses. A refusal throws before the atomic
 * write; `runRegistryMutation` reports it and exits 1.
 */
export function writeRegistry(
  entries: readonly Finding[],
  lease: RegistryLockLease,
  paths: RegistryPaths = DEFAULT_REGISTRY_PATHS,
): void {
  refuseInvalidChangedRows(loadRegistry(paths.registryPath), entries, paths.schemaPath);
  atomicWriteRegistryFile(paths.registryPath, serializeRegistryJsonl(entries), lease);
}

function cmdVerify(): number {
  const entries = loadRegistry();
  const result = verify(entries);
  if (!result.ok) {
    process.stderr.write(`FAIL: ${result.reason}\n\n`);
    return 1;
  }
  process.stdout.write(`OK: registry chain valid (${result.entries} entries).\n\n`);
  const tip = chainTip(entries);
  if (tip) process.stdout.write(`Chain tip: ${tip}\n\n`);
  return 0;
}

/**
 * ARIA-HIGH-016 — `verify --stdin`: the same admission test (`verify` from
 * finding-registry-chain) over registry bytes the caller read from a Git
 * tree, so a snapshot is judged by the one chain implementation instead of a
 * transcription of it. The autonomy closure verifier
 * (aria-kernel/aria_kernel/autonomy_closure.py) pipes the registry blob at its
 * evidence target here; whether the snapshot's findings are closed is the
 * projection's answer (`project --stdin --format=closures`). Prints one JSON
 * line; exit 0 only when the chain holds.
 */
function cmdVerifyStdin(): number {
  let entries: Finding[];
  try {
    entries = parseRegistryJsonl(readFileSync(0, 'utf8'));
  } catch (error) {
    const reason = `registry_unparseable: ${error instanceof Error ? error.message : String(error)}`;
    process.stdout.write(JSON.stringify({ ok: false, entries: 0, reason, tip: null }) + '\n');
    return 1;
  }
  const result = verify(entries);
  process.stdout.write(
    JSON.stringify({
      ok: result.ok,
      entries: result.entries,
      reason: result.reason,
      tip: result.ok ? chainTip(entries) : null,
    }) + '\n',
  );
  return result.ok ? 0 : 1;
}

const PROJECT_FORMATS = ['jsonl', 'csv', 'json-array', 'closures'] as const;
type ProjectFormat = (typeof PROJECT_FORMATS)[number];
const CSV_COLUMNS = [
  'id',
  'severity',
  'state',
  'title',
  'owner_agent',
  'created_at',
  'closed_at',
  'closing_commits',
] as const;

interface ProjectArgs {
  readonly ref?: string;
  readonly stdin: boolean;
  readonly ids: readonly string[] | null;
  readonly format: ProjectFormat;
}

const PROJECT_USAGE =
  'usage: finding-registry project [--ref=<rev>] [--stdin] [--ids <ID>...] ' +
  '[--format=jsonl|csv|json-array|closures]\n';

function parseProjectArgs(args: readonly string[]): ProjectArgs | null {
  let ref: string | undefined;
  let stdin = false;
  let ids: string[] | null = null;
  let format: ProjectFormat = 'jsonl';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg.startsWith('--ref=') && arg.length > '--ref='.length) {
      ref = arg.slice('--ref='.length);
    } else if (arg === '--stdin') {
      stdin = true;
    } else if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      const known = PROJECT_FORMATS.find((candidate) => candidate === value);
      if (known === undefined) return null;
      format = known;
    } else if (arg === '--ids') {
      ids = [];
      while (index + 1 < args.length && !(args[index + 1] ?? '').startsWith('--')) {
        ids.push(args[index + 1] ?? '');
        index += 1;
      }
      if (ids.length === 0) return null;
    } else {
      return null;
    }
  }
  if (format === 'closures' && ids === null) return null;
  return { ref, stdin, ids, format };
}

function csvCell(value: unknown): string {
  const text = Array.isArray(value)
    ? value.join('|')
    : typeof value === 'string'
      ? value
      : value === null || value === undefined
        ? ''
        : JSON.stringify(value);
  // CSV-escape: wrap in quotes if it contains a comma, a quote or a newline.
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * `project` — the registry as every reader sees it (finding-registry-projection.ts):
 * the rows of the working tree, or of `--ref`, or of `--stdin` (a snapshot a
 * caller read from a Git tree), with RESOLVED derived from the trailers
 * merged into `--ref` (HEAD by default). Writes nothing. `--format=closures`
 * prints, per named finding, whether the projection closes it at the ref and
 * why not; exit 0 only when every named finding is closed.
 */
function cmdProject(args: readonly string[]): number {
  const parsed = parseProjectArgs(args);
  if (parsed === null) {
    process.stderr.write(PROJECT_USAGE);
    return 2;
  }
  try {
    const rows = parsed.stdin ? parseRegistryJsonl(readFileSync(0, 'utf8')) : undefined;
    if (parsed.format === 'closures') {
      const verdicts = closureVerdicts(REPO_ROOT, { ref: parsed.ref, rows }, parsed.ids ?? []);
      for (const verdict of verdicts) writeOut(JSON.stringify(verdict));
      return verdicts.every((verdict) => verdict.ok) ? 0 : 1;
    }
    const projected = projectRegistry(REPO_ROOT, { ref: parsed.ref, rows });
    const wanted = parsed.ids;
    if (wanted !== null) {
      const unknown = wanted.filter((id) => !projected.some((row) => row.id === id));
      if (unknown.length > 0) {
        process.stderr.write(`project: not in the registry: ${unknown.join(', ')}\n`);
        return 1;
      }
    }
    const selected =
      wanted === null ? projected : projected.filter((row) => wanted.includes(row.id));
    if (parsed.format === 'json-array') {
      writeOut(JSON.stringify(selected));
    } else if (parsed.format === 'csv') {
      writeOut(CSV_COLUMNS.join(','));
      for (const row of selected)
        writeOut(CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
    } else {
      for (const row of selected) writeOut(JSON.stringify(row));
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `project refused: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
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
  // ARIA-MEDIUM-535: the owner is stored as its CODEOWNERS handle, or refused.
  let ownerUser: string | null = null;
  if (stub.owner_user !== undefined && stub.owner_user !== null) {
    const resolved = canonicalOwner(stub.owner_user);
    if (!resolved.ok) {
      process.stderr.write(`Stub ${resolved.reason}\n\n`);
      return null;
    }
    ownerUser = resolved.owner;
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
    owner_user: ownerUser,
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
  const contract = rowContractViolations(newEntry, paths.schemaPath, 'always');
  if (contract.schema.length > 0) {
    process.stderr.write('Stub failed schema validation:\n');
    for (const message of contract.schema) {
      process.stderr.write(`  ${message}\n\n`);
    }
    return 1;
  }

  const invalidEvidence = contract.evidence;
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
  writeRegistry(entries, lease, paths);
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
  const violations: string[] = [];

  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index];
    const contract = rowContractViolations(entry, schemaPath, 'post-cutover');
    for (const message of contract.schema) violations.push(`entry ${index} schema ${message}`);

    const finding = entry as { id?: string };
    for (const violation of contract.evidence) {
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
  reader: ActiveRegistryReader = FILE_REGISTRY_READER,
  aliasIds: readonly string[] = [],
): string[] {
  const claimed = entries.map((entry) => entry.id);
  if (authority) appendAll(claimed, idsFromActiveRegistries(authority, reader));
  if (domain === 'ORPHAN') {
    appendAll(claimed, orphanMarkdownReservedIds(ORPHAN_FINDINGS_MD_PATH));
  }
  // An alias (the finding-id-aliases.yaml beside the registry) names a merged
  // trailer whose ledger row lives under another id; the alias itself has no
  // row. Handing its sequence out again would give a new finding the id old
  // trailers already resolve to another one — finding-id-aliases.spec.ts would
  // catch the shadowing, but only after the row was written. Claim it here.
  appendAll(
    claimed,
    aliasIds.filter((id) => id.startsWith(`${domain}-`)),
  );
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
  const existingIds = claimedIdsForDomain(
    domain,
    entries,
    authority,
    FILE_REGISTRY_READER,
    findingIdAliasesBeside(paths.registryPath).map((alias) => alias.alias),
  );
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
  const claimed = claimedSequences(
    idParts[1],
    claimedIdsForDomain(
      idParts[1],
      entries,
      authority,
      FILE_REGISTRY_READER,
      findingIdAliasesBeside(paths.registryPath).map((alias) => alias.alias),
    ),
  );
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
  if (authority) appendAll(structuredIds, idsFromActiveRegistries(authority));
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

/**
 * `reopen <id>` — two decisions, each recorded on the stored row.
 *
 * Without `--reject-closure`: a registration repair. A row registered
 * RESOLVED at birth with no closing commit (an error: a closure is the fix
 * commit's merged trailer, which cannot exist before the fix merges) goes
 * back to OPEN. A row that names a closer is not a registration error.
 *
 * With `--reject-closure=<sha> --reason=<why>`: the override decision
 * (`applyClosureRejection`). Every closer the projection would still derive
 * on origin/main must be rejected in the same decision, or the finding is
 * still closed the moment the registry is read.
 */
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
    // finding (or a closer the registry already recorded): rejecting anything
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
      const trailer = commitNamesFinding(REPO_ROOT, resolved.sha, entry);
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
    // undone by the projection's next read, so it is not persisted at all.
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
          'reopening a finding a commit closed is an override decision: ' +
          'reopen <id> --reject-closure=<sha> --reason=<why>.\n',
      );
      return 1;
    }

    entry.state = 'OPEN';
    entry.closed_at = null;
    entry.notes =
      String(entry.notes ?? '') +
      " [governed reopen: was registered RESOLVED at birth in error — the closure is derived from the fix commit's merged Closes: trailer.]";
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
  const tip = chainTip(entries);
  process.stdout.write(`Chain tip: ${tip}\n`);
  return 0;
}

/**
 * `assign <id> [--owner-user=<handle>] [--deadline=<date>] --reason=<why>` —
 * gives a row its missing accountability fields (ARIA-HIGH-044). The rules
 * are `applyAssignment`'s (fill, never change; a reason; no lapsed deadline);
 * the chain is restitched from the row on, and `writeRegistry` holds the result
 * to the row contract.
 */
export function assignFinding(
  id: string,
  request: AssignmentRequest,
  lease: RegistryLockLease,
  paths: RegistryPaths = DEFAULT_REGISTRY_PATHS,
): number {
  const entries = loadRegistry(paths.registryPath);
  const index = entries.findIndex((e) => e.id === id);
  const entry = entries[index];
  if (entry === undefined) {
    process.stderr.write(`assign refused: ${id} is not in the registry\n`);
    return 1;
  }
  const outcome = applyAssignment(entry, request);
  if (!outcome.ok) {
    process.stderr.write(`assign refused: ${outcome.reason}\n`);
    return 1;
  }
  if (!outcome.changed) {
    process.stdout.write(`No-op: ${id} already carries the requested owner_user/deadline.\n`);
    return 0;
  }
  rechain(entries, index);
  const post = verify(entries);
  if (!post.ok) {
    process.stderr.write(`Post-assign integrity check FAILED: ${post.reason}\n`);
    return 1;
  }
  writeRegistry(entries, lease, paths);
  process.stdout.write(
    `Assigned: ${id} at position ${index} → ${outcome.fields.join(', ')}\nChain tip: ${chainTip(entries)}\n`,
  );
  return 0;
}

/**
 * `canonicalize-owner <spelling> [--to=<handle>] --reason=<why>` — rewrites
 * every row whose owner_user is exactly `spelling` to its CODEOWNERS handle
 * (ARIA-MEDIUM-535, `applyOwnerCanonicalization`). Without `--to` the spelling
 * must name a handle by itself (`@okan-wqm`, `Okan-Wqm`); with it, the caller
 * states which person a legacy spelling means. The chain is restitched from the
 * first changed row and `writeRegistry` holds the result to the row contract.
 */
export function canonicalizeOwnerSpelling(
  request: OwnerCanonicalizationRequest,
  lease: RegistryLockLease,
  paths: RegistryPaths = DEFAULT_REGISTRY_PATHS,
): number {
  const entries = loadRegistry(paths.registryPath);
  const outcome = applyOwnerCanonicalization(entries, request);
  if (!outcome.ok) {
    process.stderr.write(`canonicalize-owner refused: ${outcome.reason}\n`);
    return 1;
  }
  const [first] = outcome.indexes;
  if (first === undefined) {
    process.stdout.write(`No-op: no row carries owner_user ${JSON.stringify(request.spelling)}.\n`);
    return 0;
  }
  rechain(entries, first);
  const post = verify(entries);
  if (!post.ok) {
    process.stderr.write(`Post-canonicalize integrity check FAILED: ${post.reason}\n`);
    return 1;
  }
  writeRegistry(entries, lease, paths);
  process.stdout.write(
    `Canonicalized: ${outcome.indexes.length} row(s) owner_user ${request.spelling} -> ${outcome.owner}\nChain tip: ${chainTip(entries)}\n`,
  );
  return 0;
}

function cmdCanonicalizeOwner(args: readonly string[], lease: RegistryLockLease): number {
  const [spelling] = args;
  const flag = (name: string): string | undefined =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
  if (!spelling || spelling.startsWith('--')) {
    process.stderr.write(
      'canonicalize-owner requires a spelling: finding-registry canonicalize-owner <spelling> [--to=<handle>] --reason=<why>\n',
    );
    return 2;
  }
  return canonicalizeOwnerSpelling(
    { spelling, to: flag('to'), reason: flag('reason') ?? '', now: new Date() },
    lease,
  );
}

function cmdAssign(args: readonly string[], lease: RegistryLockLease): number {
  const [id] = args;
  const flag = (name: string): string | undefined =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
  if (!id || id.startsWith('--')) {
    process.stderr.write(
      'assign requires an id: finding-registry assign <id> [--owner-user=<handle>] [--deadline=<YYYY-MM-DD>] --reason=<why>\n',
    );
    return 2;
  }
  return assignFinding(
    id,
    {
      ownerUser: flag('owner-user'),
      deadline: flag('deadline'),
      reason: flag('reason') ?? '',
      now: new Date(),
    },
    lease,
  );
}

export interface SweepConfig {
  readonly staleAfterDays: number;
  readonly dryRun: boolean;
  readonly now: Date;
}

export interface SweepAction {
  readonly id: string;
  readonly fromState: Finding['state'];
  readonly toState: Finding['state'];
  readonly reason: string;
}

/**
 * ARIA-MEDIUM-601 — an unresolved row whose deadline has lapsed but that
 * names no accountable owner. BLOCKED is an override someone signs as the
 * row's `owner_user` (README "Override protocol"), and the row contract
 * (`$defs/accountable`) refuses a BLOCKED row without one, so the sweep
 * cannot block it: it reports it UNOWNED instead, with the `assign` command
 * that gives it an owner. The one predicate `planSweep` and
 * `findUnownedPastDeadline` share.
 */
function isUnownedPastDeadline(entry: Finding, now: Date): boolean {
  return (
    isUnresolvedFindingState(entry.state) &&
    typeof entry.deadline === 'string' &&
    entry.deadline !== '' &&
    isDeadlineLapsed(entry.deadline, now) &&
    !hasAccountableOwner(entry)
  );
}

/** The lapsed unresolved rows the sweep reports UNOWNED rather than blocking. */
export function findUnownedPastDeadline(entries: readonly Finding[], now: Date): Finding[] {
  return entries.filter((entry) => isUnownedPastDeadline(entry, now));
}

/**
 * The sweep's report. The first line is the verdict the finding-state-sweep
 * workflow greps (`^Sweep clean:` means no transition, so no PR); UNOWNED rows
 * follow it, so they reach the log in the clean case and the sweep PR body
 * otherwise, and then each planned transition.
 */
export function sweepReportLines(report: {
  readonly scanned: number;
  readonly actions: readonly SweepAction[];
  readonly unowned: readonly Finding[];
}): string[] {
  const head =
    report.actions.length === 0
      ? `Sweep clean: 0 transitions needed (${report.scanned} entries scanned).`
      : `Sweep plan (${report.actions.length} transitions):`;
  return [
    head,
    ...report.unowned.map(
      (entry) =>
        `  UNOWNED ${entry.id} past deadline ${entry.deadline} (finding-registry assign ${entry.id} --owner-user=<handle>)`,
    ),
    ...report.actions.map(
      (action) => `  ${action.id}: ${action.fromState} → ${action.toState}  (${action.reason})`,
    ),
  ];
}

/**
 * Phase 6 state-sweep automation — runs daily in CI, transitions state
 * based on declarative rules:
 *
 *   * OPEN / IN-PROGRESS finding older than `staleAfterDays`
 *     (default 30) → STALE.
 *   * Any non-RESOLVED finding with `deadline` in the past → BLOCKED, when
 *     it names an accountable `owner_user`. One that does not gets no
 *     transition at all (not STALE either): it is reported UNOWNED
 *     (`findUnownedPastDeadline`, ARIA-MEDIUM-601).
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
    // Only unresolved rows carry a deadline or an age that still matters; the
    // predicate is the registry's one answer to "is this finding still owed?"
    // (ARIA-HIGH-534), shared with debt-plan-truth.
    if (!isUnresolvedFindingState(entry.state)) continue;

    // Deadline check (stronger signal) runs first.
    if (entry.deadline && isDeadlineLapsed(entry.deadline, config.now)) {
      // ARIA-MEDIUM-601 — no owner, no override signer: reported UNOWNED,
      // never blocked, and never retired to STALE by the calendar either.
      if (isUnownedPastDeadline(entry, config.now)) continue;
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

  // The plan reads the projection: a finding a merged trailer closed is
  // RESOLVED there, so the sweep never stales or blocks finished work. The
  // transitions are then written to the stored rows.
  const entries = loadRegistry();
  const projected = projectRegistry(REPO_ROOT);
  const now = new Date();
  const actions = planSweep(projected, { staleAfterDays, dryRun, now });
  const unowned = findUnownedPastDeadline(projected, now);
  for (const line of sweepReportLines({ scanned: projected.length, actions, unowned })) {
    writeOut(line);
  }
  if (actions.length === 0) return 0;

  if (dryRun) {
    writeOut('');
    writeOut('--dry-run: no mutations written.');
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
  const tip = chainTip(entries);
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
 * `list` — tabular registry view filtered by state / severity / owner.
 *
 * Added in Phase 14 (docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#14.1)
 * as the read-only dev-loop equivalent of `findings:list` / `findings:list:all`
 * npm scripts. It reads the projection, so a finding a merged trailer closed
 * lists as RESOLVED. Purely a query — does NOT mutate the registry or recompute
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
  const entries = projectRegistry(REPO_ROOT);
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
  // operation; an already-merged row changes only through a governed
  // mutation (reopen, assign, canonicalize-owner, sweep).
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
    process.stderr.write(
      [
        'Usage: finding-registry <verify|project|add|add-explicit|import-narrative|reopen|assign|canonicalize-owner|sweep|list|rechain-from|dedupe> [args]',
        '  verify [--stdin]  — the chain over the file or the stdin bytes',
        '  project [--ref=<rev>] [--stdin] [--ids <ID>...] [--format=jsonl|csv|json-array|closures]  — the registry with RESOLVED derived from merged Closes: trailers',
        '  add <domain> <stub.json>  — atomically allocate id + append',
        '  add-explicit <stub.json>  — governed replay/import with fixed id',
        '  import-narrative <stub.json>  — import one exact ORPHAN heading as OPEN',
        '  reopen <finding-id> [--reject-closure=<sha> ... --reason=<why>]',
        '  assign <finding-id> [--owner-user=<handle>] [--deadline=<YYYY-MM-DD>] --reason=<why>  — fill a missing owner/deadline',
        '  canonicalize-owner <spelling> [--to=<handle>] --reason=<why>  — rewrite an owner_user spelling to its CODEOWNERS handle',
        '  sweep [--dry-run] [--stale-after=<days>]',
        '  list [--state <CSV>] [--severity <CSV>] [--owner <name>] [--format table|id-only|json]',
        '  rechain-from <N>   — post-merge integrity repair (see docblock)',
        '  dedupe [--dry-run] — one-time duplicate-id cleanup (see docblock)',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }

  let exitCode = 0;
  if (sub === 'verify') {
    if (args.length === 0) {
      exitCode = cmdVerify();
    } else if (args.length === 1 && args[0] === '--stdin') {
      exitCode = cmdVerifyStdin();
    } else {
      process.stderr.write('usage: finding-registry verify [--stdin]\n');
      process.exit(2);
    }
  } else if (sub === 'project') {
    exitCode = cmdProject(args);
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
  } else if (sub === 'assign') {
    exitCode = runRegistryMutation((lease) => cmdAssign(args, lease));
  } else if (sub === 'canonicalize-owner') {
    exitCode = runRegistryMutation((lease) => cmdCanonicalizeOwner(args, lease));
  } else if (sub === 'sweep') {
    exitCode = runRegistryMutation((lease) => cmdSweep(args, lease));
  } else if (sub === 'list') {
    exitCode = cmdList(args);
  } else if (sub === 'rechain-from') {
    exitCode = runRegistryMutation((lease) => cmdRechainFrom(args[0], lease));
  } else if (sub === 'dedupe') {
    exitCode = runRegistryMutation((lease) => cmdDedupe(args, lease));
  } else {
    process.stderr.write(`Unknown subcommand: ${sub}\n`);
    process.exit(2);
  }

  // Not process.exit(): a projection is megabytes, and exiting while a pipe
  // still holds part of it drops the rest. Setting the code lets Node drain
  // stdout first.
  process.exitCode = exitCode;
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
    if (error instanceof RegistryWriteRefused) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    process.stderr.write(
      `Registry mutation authority failed closed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (process.env.FINDING_REGISTRY_DEBUG === '1' && error instanceof Error) {
      process.stderr.write(`${error.stack ?? ''}\n`);
    }
    return 1;
  }
}

if (require.main === module) main();
