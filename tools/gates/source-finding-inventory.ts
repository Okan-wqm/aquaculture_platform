#!/usr/bin/env ts-node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';

import type { Options as PrettierOptions } from 'prettier';

import { REPO_ROOT } from './lib/repo-root';
import { computeDirtyContentSha256 } from './capability-source-inventory';
import { resolveGitFindingAllocationAuthority } from './finding-registry';
import {
  atomicWriteFileWithRegistryLease,
  assertRegistryLockOwned,
  listAtomicWriteStagingFiles,
  recoverAtomicWriteStagingFiles,
  type RegistryLockLease,
  withRegistryFileLockAsync,
} from './finding-registry-store';
import {
  deriveRawFindingIdFloors,
  parseFindingRegistrySchemaContract,
} from './lib/finding-registry-schema-contract';

const PLAN_DIRECTORY = 'docs/plans/2026-06-18-enterprise-grade-debt-closure';
const MANIFEST_PATH = `${PLAN_DIRECTORY}/manifest.json`;
const PRETTIER_CONFIG_PATH = '.prettierrc';
const PACKAGE_LOCK_PATH = 'package-lock.json';
const LEGACY_ARTIFACT_PATH = `${PLAN_DIRECTORY}/source-findings.jsonl`;
const ARTIFACT_FILENAME_PATTERN = /^source-findings\.(?<sha256>[0-9a-f]{64})\.jsonl$/;
const ARTIFACT_PATH_PATTERN = new RegExp(
  `^${PLAN_DIRECTORY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/source-findings\\.(?<sha256>[0-9a-f]{64})\\.jsonl$`,
);
const REGISTRY_PATH = 'docs/reviews/_registry/findings.jsonl';
const REGISTRY_SCHEMA_PATH = 'docs/reviews/_registry/findings.jsonl.schema.json';
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_REGISTRY_SCHEMA_BYTES = 1024 * 1024;
const MAX_PRETTIER_CONFIG_BYTES = 64 * 1024;
const MAX_PACKAGE_LOCK_BYTES = 4 * 1024 * 1024;
const PRETTIER_FORMAT_TIMEOUT_MS = 30_000;
const PRETTIER_FORMATTER_SCRIPT = `
void (async () => {
  const { format, version } = await import('prettier');
  process.stdin.setEncoding('utf8');
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }
  const input = JSON.parse(rawInput);
  process.stdout.write(
    JSON.stringify({
      formatted: await format(JSON.stringify(input.manifest, null, 2), {
        ...input.options,
        filepath: input.filepath,
        parser: 'json',
      }),
      prettierVersion: version,
    }),
  );
})().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
`;
const MAX_REGISTRY_BLOB_CACHE_ENTRIES = 8;
const ISOLATED_FULL_EXECUTION_ENV = 'SOURCE_FINDING_INVENTORY_EXECUTION';
const ISOLATED_FULL_EXECUTION_VALUE = 'isolated-evidence-runner';
const BOUNDED_HOST_EXECUTION_VALUE = 'bounded-production-evidence';
const EXPECTED_GITHUB_REPOSITORY = 'Okan-wqm/aquaculture_platform';
const MAX_ISOLATED_MEMORY_BYTES = 16n * 1024n * 1024n * 1024n;
const MIN_ISOLATED_MEMORY_BYTES = 1024n * 1024n * 1024n;
const MAX_ISOLATED_CPU_COUNT = 8;
const MAX_ISOLATED_PROCESS_COUNT = 2048n;
const MIN_BOUNDED_HOST_MEMORY_BYTES = 512n * 1024n * 1024n;
const MAX_BOUNDED_HOST_MEMORY_BYTES = 1024n * 1024n * 1024n;
const MAX_BOUNDED_HOST_CPU_COUNT = 0.5;
const MAX_BOUNDED_HOST_PROCESS_COUNT = 128n;
const MAX_BOUNDED_HOST_CPU_WEIGHT = 10;
const SOURCE_INVENTORY_STAGING_STALE_MS = 5 * 60_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ZERO_GIT_SHA = '0'.repeat(40);
const BLOCKED_BY_PENDING_FINDING_STATES = new Set(['READY', 'INTEGRATING', 'VERIFIED']);
const REGISTRY_SCHEMA_RAW = readBoundedText(
  join(REPO_ROOT, REGISTRY_SCHEMA_PATH),
  MAX_REGISTRY_SCHEMA_BYTES,
);
const FINDING_REGISTRY_SCHEMA_CONTRACT = parseFindingRegistrySchemaContract(
  JSON.parse(REGISTRY_SCHEMA_RAW) as unknown,
);
const REGISTRY_SEMANTIC_FIELDS = FINDING_REGISTRY_SCHEMA_CONTRACT.semanticFields;
const PRELIMINARY_TEXTUAL_AUDIT = {
  occurrenceCount: 1030,
  occurrenceSha256: '3426306d2cd36f6b74f84303030777de1c81613c4e554c8b75888448501676ac',
};
const INTERMEDIATE_SEMANTIC_AUDIT = {
  occurrenceCount: 1010,
  occurrenceSha256: '8631e019aefbfe44e57c8a812a87923758ee99f5de5af4b642f927670e2e494a',
};
const RECHAIN_ONLY_FALSE_POSITIVE_RAW_IDS = [
  'CIRCUIT-HIGH-001',
  'CIRCUIT-MEDIUM-001',
  'CONTRACT-HIGH-003',
  'DATA-LOW-003',
  'FARM-LOW-011',
  'FARM-LOW-014',
  'FARM-MEDIUM-008',
  'FARM-MEDIUM-009',
  'PRODUCT-JOB-CRITICAL-001',
  'REG-HIGH-001',
] as const;
const RECHAIN_ONLY_FALSE_POSITIVE_REFS = ['SRC-R-011', 'SRC-R-012'].flatMap((sourceId) =>
  RECHAIN_ONLY_FALSE_POSITIVE_RAW_IDS.map((rawId) => `${sourceId}#${rawId}`),
);
const ASSIGNMENT_CONTRACT =
  'Every source_id has exactly one source_adjudications queue, which owns evidence adjudication without claiming capability ownership; only a surviving explicit legacy_finding_ref may target an atomic integration unit.';

function discoveryContract(): FindingInventoryManifest['discovery_contract'] {
  return {
    registry_delta: `IDs whose parsed JSON record changes in the frozen ${REGISTRY_SEMANTIC_FIELDS.join(
      ',',
    )} capability projection from merge base to the effective source snapshot; dirty sources compare merge base directly with the effective worktree, and raw-ID references are extracted structurally from those records.`,
    review_mentions:
      'Unique raw IDs matched verbatim only in added non-registry docs/reviews lines from merge base to the effective source snapshot; an ID with its own changed registry record takes REGISTRY_RECORD precedence, and untracked dirty review files are scanned as added content.',
    dirty_overlay:
      'Dirty sources never union merge-base-to-HEAD and HEAD-to-worktree deltas: registry and review evidence are compared directly from merge base to the effective worktree so dirty reverts cannot survive as findings; capability source inventory pins the full content digest before and after discovery.',
    classification:
      'A structured source registry record absent on main is LEGACY_UNREGISTERED; unstructured references are PENDING_ADJUDICATION; the same raw ID with a different frozen capability projection on source and main is ID_COLLISION with canonical_id null.',
  };
}

function auditLineage(): FindingInventoryManifest['audit_lineage'] {
  return {
    preliminary_textual_occurrence_count: PRELIMINARY_TEXTUAL_AUDIT.occurrenceCount,
    preliminary_textual_occurrence_sha256: PRELIMINARY_TEXTUAL_AUDIT.occurrenceSha256,
    intermediate_semantic_occurrence_count: INTERMEDIATE_SEMANTIC_AUDIT.occurrenceCount,
    intermediate_semantic_occurrence_sha256: INTERMEDIATE_SEMANTIC_AUDIT.occurrenceSha256,
    excluded_rechain_only_count: RECHAIN_ONLY_FALSE_POSITIVE_REFS.length,
    excluded_rechain_only_sha256: sourceRefDigest(RECHAIN_ONLY_FALSE_POSITIVE_REFS),
    excluded_source_refs: [...RECHAIN_ONLY_FALSE_POSITIVE_REFS].sort(),
    rationale:
      'The preliminary audit scanned textual registry diff additions. The 1,010-row intermediate pass removed twenty immutable-ledger re-chaining artifacts but still treated lifecycle fields and dirty delta unions as semantic. REGISTRY_SCHEMA_CAPABILITY_V3 governs all rediscovery from the registry schema semantic-field and ID authority; retained host rows are explicitly bounded by generation_attestation and cannot pass full validation.',
  };
}

export type InventoryScope = 'full' | 'remote';
export type EvidenceKind = 'REGISTRY_RECORD' | 'REGISTRY_REFERENCE' | 'REVIEW_MENTION';
export type FindingClassification = 'LEGACY_UNREGISTERED' | 'PENDING_ADJUDICATION' | 'ID_COLLISION';
export type SourceKind = 'REMOTE_BRANCH' | 'LOCAL_BRANCH' | 'DIRTY_WORKTREE';

interface SourceRecord {
  id: string;
  kind: SourceKind;
  locator: string;
  headSha: string;
  contentSha256: string | null;
}

export interface CanonicalPromotionEvidence {
  schemaVersion: 1;
  priorArtifactSha256: string;
  priorOccurrenceId: string;
  priorSourceHeadSha: string;
  sourceRef: string;
  integrationUnitId: string;
  canonicalFindingId: string;
  candidateRegistryBlobSha: string;
  semanticSha256: string;
  recordedAt: string;
  recordedBy: string;
}

export interface IntegrationUnit {
  id: string;
  state: string;
  executionOwner: string;
  findingBindingStatus: string;
  findingIds: string[];
  legacyFindingRefs: string[];
  canonicalPromotion: CanonicalPromotionEvidence | null;
}

export interface SourceAdjudication {
  id: string;
  sourceId: string;
  status: string;
  executionOwner: string;
  deadline: string;
  plan: string;
}

interface RegistryBlobAttestation {
  blob_sha: string;
  sha256: string;
  row_count: number;
}

interface RegistrySchemaBlobAttestation {
  blob_sha: string;
  sha256: string;
}

interface FindingAuthorityCoordinate {
  registry_blob_sha: string;
  schema_blob_sha: string;
}

interface RegistryAuthority {
  reconciled_base: FindingAuthorityCoordinate;
  discovery_candidate: FindingAuthorityCoordinate;
  registry_snapshots: RegistryBlobAttestation[];
  schema_snapshots: RegistrySchemaBlobAttestation[];
}

export interface SourceAttestation {
  source_id: string;
  source_kind: SourceKind;
  source_head_sha: string;
  source_content_sha256: string | null;
  merge_base_sha: string;
  source_adjudication_id: string;
  occurrence_count: number;
  untargeted_occurrence_count: number;
  registry_backed_count: number;
  registry_reference_count: number;
  review_only_count: number;
  collision_count: number;
  occurrence_sha256: string;
}

export interface UnitAttestation {
  integration_unit_id: string;
  targeted_occurrence_count: number;
  pending_targeted_count: number;
  collision_count: number;
  occurrence_sha256: string;
}

interface FindingInventoryManifest {
  schema_version: 3;
  artifact_path: string;
  artifact_sha256: string;
  occurrence_count: number;
  occurrence_sha256: string;
  audit_lineage: {
    preliminary_textual_occurrence_count: number;
    preliminary_textual_occurrence_sha256: string;
    intermediate_semantic_occurrence_count: number;
    intermediate_semantic_occurrence_sha256: string;
    excluded_rechain_only_count: number;
    excluded_rechain_only_sha256: string;
    excluded_source_refs: string[];
    rationale: string;
  };
  discovery_contract: {
    registry_delta: string;
    review_mentions: string;
    dirty_overlay: string;
    classification: string;
  };
  registry_authority: RegistryAuthority;
  generation_attestation: {
    algorithm_version: 'REGISTRY_SCHEMA_CAPABILITY_V3';
    remote_source_state: 'LIVE_REDISCOVERED';
    host_source_state: 'ISOLATED_FULL_REDISCOVERED' | 'RETAINED_PENDING_ISOLATED_REDISCOVERY';
    reconciled_at: string;
    pending_isolated_regeneration: {
      execution_owner: string;
      deadline: string;
      plan: string;
    } | null;
  };
  assignment_contract: string;
  source_attestations: SourceAttestation[];
  unit_attestations: UnitAttestation[];
}

interface ParsedManifest {
  raw: Record<string, unknown>;
  reconciliation: Record<string, unknown>;
  reconciledAt: string;
  reconciledBaseSha: string;
  sources: SourceRecord[];
  sourceAdjudications: SourceAdjudication[];
  units: IntegrationUnit[];
  findingInventory?: FindingInventoryManifest;
}

interface RegistryRecord {
  id: string;
  value: Record<string, unknown>;
  rawLine: string;
}

interface RegistrySnapshot {
  byId: Map<string, RegistryRecord>;
  rowCount: number;
}

interface RegistryBlobSnapshot {
  raw: string;
  snapshot: RegistrySnapshot;
}

const registryBlobCache = new Map<string, RegistryBlobSnapshot>();

export interface LiveMainPin {
  commitSha: string;
  registryBlobSha: string;
  registrySchemaBlobSha: string;
}

export interface DiscoveryCandidatePin {
  headSha: string;
  registryBlobSha: string;
  registrySchemaBlobSha: string;
}

export interface GitHubMainTransitionEvidence {
  githubActions: string | undefined;
  eventName: string | undefined;
  githubRef: string | undefined;
  githubBaseRef: string | undefined;
  githubSha: string | undefined;
  pullRequestBaseSha: string | undefined;
  pushBeforeSha: string | undefined;
  pushAfterSha: string | undefined;
  checkoutSha: string | undefined;
  headSha: string;
  originMainSha: string;
  reconciledBaseSha: string;
  reconciledRegistryBlobSha: string;
  discoveryRegistryBlobSha: string;
  reconciledRegistrySchemaBlobSha: string;
  discoveryRegistrySchemaBlobSha: string;
}

export interface GitHubMainTransitionVerifier {
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean;
  registryBlobAt: (commitSha: string) => string;
  registrySchemaBlobAt: (commitSha: string) => string;
}

interface ReviewEvidence {
  paths: Set<string>;
  frames: Set<string>;
}

export interface DiscoveredFinding {
  sourceId: string;
  sourceRef: string;
  rawId: string;
  evidenceKind: EvidenceKind;
  evidencePaths: string[];
  evidenceSha256: string;
  semanticSha256: string;
  classification: FindingClassification;
  mainRecordSha256: string | null;
}

export interface SourceFindingOccurrence {
  occurrence_id: string;
  source_ref: string;
  source_id: string;
  raw_id: string;
  evidence_kind: EvidenceKind;
  evidence_paths: string[];
  evidence_sha256: string;
  semantic_sha256: string;
  classification: FindingClassification;
  canonical_id: null;
  main_record_sha256: string | null;
  adjudication: {
    status: 'PENDING';
    source_adjudication_id: string;
    target_integration_unit_id: string | null;
  };
}

export interface CanonicalFindingEvidence {
  semanticSha256: string;
  state: string;
}

export interface RefreshAssignmentEvidenceContext {
  priorArtifactSha256: string;
  priorSourceHeadShaById: ReadonlyMap<string, string>;
  candidateRegistryBlobSha: string;
}

export interface CliOptions {
  mode: 'check' | 'write' | 'refresh';
  scope: InventoryScope;
}

export interface FullExecutionSafetyEvidence {
  executionClass: string | undefined;
  githubActions: string | undefined;
  githubEventName: string | undefined;
  githubRepository: string | undefined;
  runnerEnvironment: string | undefined;
  cgroupVersion: 2;
  cgroupPath: string;
  memoryMax: string;
  memorySwapMax: string;
  cpuMax: string;
  cpuWeight: string;
  exclusiveCpus: string;
  cpusetPartition: string;
  pidsMax: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(record, key)).sort(compareText);
  const extra = Object.keys(record)
    .filter((key) => !expected.has(key))
    .sort(compareText);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${field} keys differ from the closed schema; missing=${
        missing.join(',') || '<none>'
      }; extra=${extra.join(',') || '<none>'}`,
    );
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${field} must be a string array`);
  }
  return [...value];
}

function requireSha(value: unknown, field: string): string {
  const sha = requireString(value, field);
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${field} must be a lowercase 40-character Git SHA`);
  }
  return sha;
}

function requireSha256(value: unknown, field: string): string {
  const sha = requireString(value, field);
  if (!SHA256_PATTERN.test(sha)) {
    throw new Error(`${field} must be a lowercase 64-character SHA-256`);
  }
  return sha;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function requireObjectArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${field} must be an object array`);
  }
  return value;
}

function requireSourceKind(value: unknown, field: string): SourceKind {
  if (value !== 'REMOTE_BRANCH' && value !== 'LOCAL_BRANCH' && value !== 'DIRTY_WORKTREE') {
    throw new Error(`${field} must be REMOTE_BRANCH, LOCAL_BRANCH, or DIRTY_WORKTREE`);
  }
  return value;
}

function requireExecutionOwner(record: Record<string, unknown>, field: string): string {
  if (record.ownership !== undefined) {
    const ownership = requireRecord(record.ownership, `${field}.ownership`);
    return requireString(ownership.execution_owner, `${field}.ownership.execution_owner`);
  }
  return requireString(record.owner, `${field}.owner`);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function readBoundedText(path: string, maxBytes: number = MAX_EVIDENCE_FILE_BYTES): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new Error(`${path} must be a regular file`);
    }
    if (before.size > BigInt(maxBytes)) {
      throw new Error(
        `${path} is ${before.size.toString()} bytes; bounded source-finding read limit is ${maxBytes}`,
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const capacity = Math.min(64 * 1024, maxBytes - totalBytes + 1);
      const chunk = Buffer.allocUnsafe(capacity);
      const bytesRead = readSync(descriptor, chunk, 0, capacity, null);
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new Error(`${path} exceeded bounded source-finding read limit ${maxBytes}`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }

    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.size !== BigInt(totalBytes)
    ) {
      throw new Error(`${path} moved during bounded source-finding read`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
  } finally {
    closeSync(descriptor);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function sourceRefDigest(sourceRefs: readonly string[]): string {
  if (sourceRefs.length === 0) {
    return sha256('');
  }
  return sha256(`${[...sourceRefs].sort().join('\n')}\n`);
}

function runGit(
  args: readonly string[],
  worktreePath: string = REPO_ROOT,
  acceptedStatuses: readonly number[] = [0],
): { stdout: string; status: number } {
  const result = spawnSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status === null || !acceptedStatuses.includes(result.status)) {
    throw new Error(
      `git ${args.join(' ')} failed in ${worktreePath} with status ${String(
        result.status,
      )}: ${result.stderr.trim() || 'no stderr'}`,
    );
  }
  return { stdout: result.stdout, status: result.status };
}

function parseRegistry(raw: string, coordinate: string): RegistrySnapshot {
  const byId = new Map<string, RegistryRecord>();
  let rowCount = 0;
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    const record = requireRecord(parsed, `${coordinate}:${index + 1}`);
    const id = requireString(record.id, `${coordinate}:${index + 1}.id`);
    if (byId.has(id)) {
      throw new Error(`${coordinate} contains duplicate finding ID ${id}`);
    }
    byId.set(id, { id, value: record, rawLine: line });
    rowCount += 1;
  }
  return { byId, rowCount };
}

function registryAtCommit(commitSha: string): RegistrySnapshot {
  runGit(['rev-parse', '--verify', `${commitSha}^{commit}`]);
  const treeEntry = runGit([
    'ls-tree',
    '--name-only',
    commitSha,
    '--',
    REGISTRY_PATH,
  ]).stdout.trim();
  if (treeEntry.length === 0) {
    return { byId: new Map(), rowCount: 0 };
  }
  return registryAtBlob(registryBlobAtCommit(commitSha)).snapshot;
}

function registryAtBlob(blobSha: string): RegistryBlobSnapshot {
  const checkedBlobSha = requireSha(blobSha, 'registry blob SHA');
  const cached = registryBlobCache.get(checkedBlobSha);
  if (cached) {
    registryBlobCache.delete(checkedBlobSha);
    registryBlobCache.set(checkedBlobSha, cached);
    return cached;
  }

  const objectType = runGit(['cat-file', '-t', checkedBlobSha]).stdout.trim();
  if (objectType !== 'blob') {
    throw new Error(`registry authority ${checkedBlobSha} is ${objectType}, not a Git blob`);
  }
  const raw = runGit(['cat-file', 'blob', checkedBlobSha]).stdout;
  const result = {
    raw,
    snapshot: parseRegistry(raw, `registry-blob:${checkedBlobSha}`),
  };
  registryBlobCache.set(checkedBlobSha, result);
  if (registryBlobCache.size > MAX_REGISTRY_BLOB_CACHE_ENTRIES) {
    const oldestBlob = registryBlobCache.keys().next().value as string | undefined;
    if (oldestBlob !== undefined) {
      registryBlobCache.delete(oldestBlob);
    }
  }
  return result;
}

function registryAtWorktree(worktreePath: string): RegistrySnapshot {
  const path = join(worktreePath, REGISTRY_PATH);
  if (!existsSync(path)) {
    return { byId: new Map(), rowCount: 0 };
  }
  if (!lstatSync(path).isFile()) {
    throw new Error(`dirty registry evidence must be a regular file: ${path}`);
  }
  return parseRegistry(readBoundedText(path), path);
}

export function semanticRegistryValue(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    REGISTRY_SEMANTIC_FIELDS.filter((key) => Object.hasOwn(record, key)).map((key) => [
      key,
      record[key],
    ]),
  );
}

export function registryRecordChanged(
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
): boolean {
  return (
    stableJson(semanticRegistryValue(baseline)) !== stableJson(semanticRegistryValue(candidate))
  );
}

function registryEvidenceSha256(record: RegistryRecord): string {
  return sha256(stableJson(record.value));
}

function registrySemanticSha256(record: RegistryRecord): string {
  return sha256(stableJson(semanticRegistryValue(record.value)));
}

function changedRegistryIds(baseline: RegistrySnapshot, candidate: RegistrySnapshot): Set<string> {
  const changed = new Set<string>();
  for (const [id, record] of candidate.byId) {
    const baselineRecord = baseline.byId.get(id);
    if (baselineRecord === undefined || registryRecordChanged(baselineRecord.value, record.value)) {
      changed.add(id);
    }
  }
  return changed;
}

export function extractRawFindingIds(line: string): string[] {
  return [...line.matchAll(FINDING_REGISTRY_SCHEMA_CONTRACT.rawIdRegex)].map(
    (match) => match[1] as string,
  );
}

function addReviewEvidence(
  findings: Map<string, ReviewEvidence>,
  path: string,
  line: string,
): void {
  for (const rawId of extractRawFindingIds(line)) {
    const evidence = findings.get(rawId) ?? { paths: new Set(), frames: new Set() };
    evidence.paths.add(path);
    evidence.frames.add(`${path}\0${line}`);
    findings.set(rawId, evidence);
  }
}

export function extractAddedReviewEvidence(
  diff: string,
  evidencePath: string,
): Map<string, ReviewEvidence> {
  const findings = new Map<string, ReviewEvidence>();
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (!inHunk) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!hunk) continue;
      oldRemaining = hunk[1] === undefined ? 1 : Number.parseInt(hunk[1], 10);
      newRemaining = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
      inHunk = oldRemaining > 0 || newRemaining > 0;
      continue;
    }
    if (line === '\\ No newline at end of file') {
      continue;
    }
    const indicator = line[0];
    if (indicator === '+') {
      if (newRemaining <= 0) {
        throw new Error(`review diff has an addition outside its declared hunk: ${evidencePath}`);
      }
      addReviewEvidence(findings, evidencePath, line.slice(1));
      newRemaining -= 1;
    } else if (indicator === '-') {
      if (oldRemaining <= 0) {
        throw new Error(`review diff has a deletion outside its declared hunk: ${evidencePath}`);
      }
      oldRemaining -= 1;
    } else if (indicator === ' ') {
      if (oldRemaining <= 0 || newRemaining <= 0) {
        throw new Error(`review diff context exceeds its declared hunk: ${evidencePath}`);
      }
      oldRemaining -= 1;
      newRemaining -= 1;
    } else {
      throw new Error(`review diff contains an invalid hunk line for ${evidencePath}`);
    }
    if (oldRemaining === 0 && newRemaining === 0) {
      inHunk = false;
    }
  }
  if (inHunk) {
    throw new Error(`review diff ended before its declared hunk completed: ${evidencePath}`);
  }
  return findings;
}

function mergeReviewEvidence(
  target: Map<string, ReviewEvidence>,
  source: ReadonlyMap<string, ReviewEvidence>,
): void {
  for (const [rawId, incoming] of source) {
    const current = target.get(rawId) ?? { paths: new Set(), frames: new Set() };
    for (const path of incoming.paths) current.paths.add(path);
    for (const frame of incoming.frames) current.frames.add(frame);
    target.set(rawId, current);
  }
}

function requireReviewPath(path: string): string {
  if (
    !path.startsWith('docs/reviews/') ||
    path === 'docs/reviews/' ||
    path.split('/').includes('..') ||
    path.includes('\0')
  ) {
    throw new Error(`Git returned an unsafe review evidence path: ${JSON.stringify(path)}`);
  }
  return path;
}

function changedReviewPaths(
  revisionArgs: readonly string[],
  worktreePath: string = REPO_ROOT,
): string[] {
  return runGit(
    [
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--name-only',
      '-z',
      ...revisionArgs,
      '--',
      'docs/reviews',
    ],
    worktreePath,
  )
    .stdout.split('\0')
    .filter(Boolean)
    .map(requireReviewPath)
    .filter((path) => path !== REGISTRY_PATH)
    .sort(compareText);
}

function reviewEvidenceFromPaths(
  revisionArgs: readonly string[],
  worktreePath: string = REPO_ROOT,
): Map<string, ReviewEvidence> {
  const findings = new Map<string, ReviewEvidence>();
  for (const path of changedReviewPaths(revisionArgs, worktreePath)) {
    const diff = runGit(
      ['diff', '--no-ext-diff', '--no-color', '--unified=0', ...revisionArgs, '--', path],
      worktreePath,
    ).stdout;
    mergeReviewEvidence(findings, extractAddedReviewEvidence(diff, path));
  }
  return findings;
}

function registryReferenceEvidence(
  registry: RegistrySnapshot,
  changedIds: ReadonlySet<string>,
): Map<string, ReviewEvidence> {
  const findings = new Map<string, ReviewEvidence>();
  for (const id of [...changedIds].sort()) {
    const record = registry.byId.get(id);
    if (record) {
      addReviewEvidence(findings, REGISTRY_PATH, record.rawLine);
    }
  }
  return findings;
}

function reviewEvidenceBetween(baseSha: string, headSha: string): Map<string, ReviewEvidence> {
  return reviewEvidenceFromPaths([baseSha, headSha]);
}

function dirtyReviewEvidence(
  baselineSha: string,
  worktreePath: string,
): Map<string, ReviewEvidence> {
  const findings = reviewEvidenceFromPaths([baselineSha], worktreePath);
  const untracked = runGit(
    ['ls-files', '--others', '--exclude-standard', '-z', '--', 'docs/reviews'],
    worktreePath,
  ).stdout;
  for (const relativePath of untracked.split('\0').filter(Boolean).sort()) {
    const absolutePath = join(worktreePath, relativePath);
    if (!existsSync(absolutePath)) {
      throw new Error(`untracked review evidence disappeared: ${absolutePath}`);
    }
    if (!lstatSync(absolutePath).isFile()) {
      throw new Error(
        `untracked review evidence must be a regular file, not a symlink or special path: ${absolutePath}`,
      );
    }
    for (const line of readBoundedText(absolutePath).split(/\r?\n/)) {
      addReviewEvidence(findings, relativePath, line);
    }
  }
  return findings;
}

function reviewEvidenceSha256(evidence: ReviewEvidence): string {
  return sourceRefDigest([...evidence.frames]);
}

function reviewSemanticSha256(rawId: string, evidence: ReviewEvidence): string {
  const normalizedFrames = [...evidence.frames]
    .map((frame) => frame.replace(/\s+/g, ' ').trim())
    .sort();
  return sha256(stableJson({ raw_id: rawId, evidence: normalizedFrames }));
}

function mergeBase(sourceHeadSha: string, reconciledBaseSha: string): string {
  return requireSha(
    runGit(['merge-base', sourceHeadSha, reconciledBaseSha]).stdout.trim(),
    `merge-base(${sourceHeadSha}, ${reconciledBaseSha})`,
  );
}

function assertSourceHeadPin(source: SourceRecord): void {
  const resolvedHead =
    source.kind === 'DIRTY_WORKTREE'
      ? requireSha(
          runGit(['rev-parse', '--verify', 'HEAD^{commit}'], source.locator).stdout.trim(),
          `${source.id} dirty worktree HEAD`,
        )
      : requireSha(
          runGit(['rev-parse', '--verify', `${source.locator}^{commit}`]).stdout.trim(),
          `${source.id} source ref`,
        );
  if (resolvedHead !== source.headSha) {
    throw new Error(
      `${source.id} source head moved from attested ${source.headSha} to ${resolvedHead}`,
    );
  }
}

function captureLiveMainPin(): LiveMainPin {
  const commitSha = requireSha(
    runGit(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']).stdout.trim(),
    'live origin/main commit',
  );
  return {
    commitSha,
    registryBlobSha: registryBlobAtCommit(commitSha),
    registrySchemaBlobSha: registrySchemaBlobAtCommit(commitSha),
  };
}

export function assertLiveMainCompatible(
  pin: LiveMainPin,
  reconciledBaseSha: string,
  candidateSha: string,
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean,
): void {
  const reconciled = requireSha(reconciledBaseSha, 'reconciled base');
  const liveMain = requireSha(pin.commitSha, 'live origin/main');
  const candidate = requireSha(candidateSha, 'source-finding candidate');
  if (!isAncestor(reconciled, liveMain)) {
    throw new Error(
      `reconciled base ${reconciled} must be an ancestor of live origin/main ${liveMain}`,
    );
  }
  if (!isAncestor(liveMain, candidate)) {
    throw new Error(
      `source-finding candidate ${candidate} must contain live origin/main ${liveMain}`,
    );
  }
}

function requireAbsent(value: string | undefined, field: string): void {
  if ((value ?? '').length > 0) {
    throw new Error(`${field} must be empty for this GitHub event`);
  }
}

export function assertGitHubMainTransition(
  evidence: GitHubMainTransitionEvidence,
  verifier: GitHubMainTransitionVerifier,
): void {
  if (evidence.githubActions !== 'true') {
    throw new Error('GitHub main transition evidence requires GITHUB_ACTIONS=true');
  }
  const githubSha = requireSha(evidence.githubSha, 'GITHUB_SHA');
  const checkoutSha = requireSha(evidence.checkoutSha, 'SOURCE_FINDING_EVENT_CHECKOUT_SHA');
  const headSha = requireSha(evidence.headSha, 'checked-out HEAD');
  const originMainSha = requireSha(evidence.originMainSha, 'live origin/main');
  const reconciledBaseSha = requireSha(evidence.reconciledBaseSha, 'reconciled base');
  const reconciledRegistryBlobSha = requireSha(
    evidence.reconciledRegistryBlobSha,
    'reconciled registry blob',
  );
  const discoveryRegistryBlobSha = requireSha(
    evidence.discoveryRegistryBlobSha,
    'discovery registry blob',
  );
  const reconciledRegistrySchemaBlobSha = requireSha(
    evidence.reconciledRegistrySchemaBlobSha,
    'reconciled registry schema blob',
  );
  const discoveryRegistrySchemaBlobSha = requireSha(
    evidence.discoveryRegistrySchemaBlobSha,
    'discovery registry schema blob',
  );
  if (githubSha !== checkoutSha || checkoutSha !== headSha) {
    throw new Error(
      `GitHub event/check-out identity mismatch: GITHUB_SHA=${githubSha}, event checkout=${checkoutSha}, HEAD=${headSha}`,
    );
  }

  let frontierSha: string;
  let candidateSha: string;
  let eventMainSha: string;
  if (evidence.eventName === 'pull_request') {
    if (evidence.githubBaseRef !== 'main') {
      throw new Error('source-finding PR validation requires GITHUB_BASE_REF=main');
    }
    if (!/^refs\/pull\/[1-9]\d*\/merge$/.test(evidence.githubRef ?? '')) {
      throw new Error('source-finding PR validation requires the trusted pull-request merge ref');
    }
    requireAbsent(evidence.pushBeforeSha, 'SOURCE_FINDING_EVENT_PUSH_BEFORE_SHA');
    requireAbsent(evidence.pushAfterSha, 'SOURCE_FINDING_EVENT_PUSH_AFTER_SHA');
    frontierSha = requireSha(evidence.pullRequestBaseSha, 'SOURCE_FINDING_EVENT_PR_BASE_SHA');
    candidateSha = checkoutSha;
    eventMainSha = frontierSha;
  } else if (evidence.eventName === 'push') {
    if (evidence.githubRef !== 'refs/heads/main') {
      throw new Error('source-finding push validation requires GITHUB_REF=refs/heads/main');
    }
    requireAbsent(evidence.githubBaseRef, 'GITHUB_BASE_REF');
    requireAbsent(evidence.pullRequestBaseSha, 'SOURCE_FINDING_EVENT_PR_BASE_SHA');
    frontierSha = requireSha(evidence.pushBeforeSha, 'SOURCE_FINDING_EVENT_PUSH_BEFORE_SHA');
    candidateSha = requireSha(evidence.pushAfterSha, 'SOURCE_FINDING_EVENT_PUSH_AFTER_SHA');
    if (candidateSha !== checkoutSha) {
      throw new Error('main push after SHA must equal GITHUB_SHA and checked-out HEAD');
    }
    eventMainSha = candidateSha;
  } else {
    throw new Error(
      `source-finding live validation does not accept GitHub event ${String(evidence.eventName)}`,
    );
  }
  if (
    reconciledBaseSha === ZERO_GIT_SHA ||
    frontierSha === ZERO_GIT_SHA ||
    candidateSha === ZERO_GIT_SHA ||
    originMainSha === ZERO_GIT_SHA
  ) {
    throw new Error('source-finding transition SHAs must not use the all-zero Git sentinel');
  }

  if (!verifier.isAncestor(reconciledBaseSha, frontierSha)) {
    throw new Error(
      `reconciled base ${reconciledBaseSha} is not an ancestor of event frontier ${frontierSha}`,
    );
  }
  if (!verifier.isAncestor(frontierSha, candidateSha)) {
    throw new Error(
      `event frontier ${frontierSha} is not an ancestor of candidate ${candidateSha}`,
    );
  }
  if (!verifier.isAncestor(eventMainSha, originMainSha)) {
    throw new Error(
      `event main ${eventMainSha} is no longer reachable from live origin/main ${originMainSha}`,
    );
  }

  const observedRegistryBlobs = {
    reconciled: requireSha(
      verifier.registryBlobAt(reconciledBaseSha),
      'reconciled base registry blob',
    ),
    frontier: requireSha(verifier.registryBlobAt(frontierSha), 'event frontier registry blob'),
    candidate: requireSha(verifier.registryBlobAt(candidateSha), 'event candidate registry blob'),
    liveMain: requireSha(verifier.registryBlobAt(originMainSha), 'live origin/main registry blob'),
  };
  const observedRegistrySchemaBlobs = {
    reconciled: requireSha(
      verifier.registrySchemaBlobAt(reconciledBaseSha),
      'reconciled base registry schema blob',
    ),
    frontier: requireSha(
      verifier.registrySchemaBlobAt(frontierSha),
      'event frontier registry schema blob',
    ),
    candidate: requireSha(
      verifier.registrySchemaBlobAt(candidateSha),
      'event candidate registry schema blob',
    ),
    liveMain: requireSha(
      verifier.registrySchemaBlobAt(originMainSha),
      'live origin/main registry schema blob',
    ),
  };
  if (observedRegistryBlobs.reconciled !== reconciledRegistryBlobSha) {
    throw new Error(
      `reconciled base registry blob ${observedRegistryBlobs.reconciled} differs from attested ${reconciledRegistryBlobSha}`,
    );
  }
  if (observedRegistryBlobs.candidate !== discoveryRegistryBlobSha) {
    throw new Error(
      `event candidate registry blob ${observedRegistryBlobs.candidate} differs from discovery authority ${discoveryRegistryBlobSha}`,
    );
  }
  if (observedRegistrySchemaBlobs.reconciled !== reconciledRegistrySchemaBlobSha) {
    throw new Error(
      `reconciled base registry schema blob ${observedRegistrySchemaBlobs.reconciled} differs from attested ${reconciledRegistrySchemaBlobSha}`,
    );
  }
  if (observedRegistrySchemaBlobs.candidate !== discoveryRegistrySchemaBlobSha) {
    throw new Error(
      `event candidate registry schema blob ${observedRegistrySchemaBlobs.candidate} differs from discovery authority ${discoveryRegistrySchemaBlobSha}`,
    );
  }
  const expectedLiveMainRegistryBlob =
    evidence.eventName === 'pull_request'
      ? observedRegistryBlobs.frontier
      : discoveryRegistryBlobSha;
  const expectedLiveMainSchemaBlob =
    evidence.eventName === 'pull_request'
      ? observedRegistrySchemaBlobs.frontier
      : discoveryRegistrySchemaBlobSha;
  if (
    observedRegistryBlobs.liveMain !== expectedLiveMainRegistryBlob ||
    observedRegistrySchemaBlobs.liveMain !== expectedLiveMainSchemaBlob
  ) {
    throw new Error(
      `live origin/main finding authority ${observedRegistryBlobs.liveMain}/${observedRegistrySchemaBlobs.liveMain} differs from event authority ${expectedLiveMainRegistryBlob}/${expectedLiveMainSchemaBlob}; rerun against the new main frontier`,
    );
  }
}

function assertLiveMainStable(start: LiveMainPin, end: LiveMainPin): void {
  if (
    start.commitSha !== end.commitSha ||
    start.registryBlobSha !== end.registryBlobSha ||
    start.registrySchemaBlobSha !== end.registrySchemaBlobSha
  ) {
    throw new Error(
      `origin/main moved during source-finding discovery: ${start.commitSha}/${start.registryBlobSha}/${start.registrySchemaBlobSha} -> ${end.commitSha}/${end.registryBlobSha}/${end.registrySchemaBlobSha}`,
    );
  }
}

function gitIsAncestor(ancestorSha: string, descendantSha: string): boolean {
  return (
    runGit(['merge-base', '--is-ancestor', ancestorSha, descendantSha], REPO_ROOT, [0, 1])
      .status === 0
  );
}

function registryBlobAtCommit(commitSha: string): string {
  return blobAtCommit(commitSha, REGISTRY_PATH, 'registry');
}

function registrySchemaBlobAtCommit(commitSha: string): string {
  return blobAtCommit(commitSha, REGISTRY_SCHEMA_PATH, 'registry schema');
}

function blobAtCommit(commitSha: string, path: string, label: string): string {
  return requireSha(
    runGit(['rev-parse', `${commitSha}:${path}`]).stdout.trim(),
    `${commitSha} ${label} blob`,
  );
}

function effectiveRegistrySchemaBlobSha(): string {
  const headSha = requireSha(
    runGit(['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim(),
    'source-finding schema authority HEAD',
  );
  return registrySchemaBlobAtCommit(headSha);
}

async function discoverForSource(
  source: SourceRecord,
  reconciledBaseSha: string,
  mainRegistry: RegistrySnapshot,
): Promise<DiscoveredFinding[]> {
  assertSourceHeadPin(source);
  const sourceMergeBase = mergeBase(source.headSha, reconciledBaseSha);
  const baselineRegistry = registryAtCommit(sourceMergeBase);
  const sourceHeadRegistry = registryAtCommit(source.headSha);
  let effectiveRegistry = sourceHeadRegistry;
  let registryIds: Set<string>;
  let registryReferences: Map<string, ReviewEvidence>;
  let reviews: Map<string, ReviewEvidence>;
  let dirtyContentBefore: string | null = null;

  if (source.kind === 'DIRTY_WORKTREE') {
    if (!isAbsolute(source.locator)) {
      throw new Error(`${source.id} dirty worktree locator must be absolute`);
    }
    dirtyContentBefore = await computeDirtyContentSha256(source.locator);
    if (source.contentSha256 === null || dirtyContentBefore !== source.contentSha256) {
      throw new Error(`${source.id} dirty content differs from its capability source attestation`);
    }
    effectiveRegistry = registryAtWorktree(source.locator);
    registryIds = changedRegistryIds(baselineRegistry, effectiveRegistry);
    registryReferences = registryReferenceEvidence(effectiveRegistry, registryIds);
    reviews = dirtyReviewEvidence(sourceMergeBase, source.locator);
  } else {
    registryIds = changedRegistryIds(baselineRegistry, sourceHeadRegistry);
    registryReferences = registryReferenceEvidence(sourceHeadRegistry, registryIds);
    reviews = reviewEvidenceBetween(sourceMergeBase, source.headSha);
  }

  const rawIds = new Set([...registryIds, ...registryReferences.keys(), ...reviews.keys()]);
  const findings: DiscoveredFinding[] = [];
  for (const rawId of [...rawIds].sort()) {
    const sourceRecord = effectiveRegistry.byId.get(rawId);
    const mainRecord = mainRegistry.byId.get(rawId);
    const isCollision =
      sourceRecord !== undefined &&
      mainRecord !== undefined &&
      stableJson(semanticRegistryValue(sourceRecord.value)) !==
        stableJson(semanticRegistryValue(mainRecord.value));
    const isLegacy = mainRecord === undefined;
    if (!isLegacy && !isCollision) {
      continue;
    }

    const sourceRef = `${source.id}#${rawId}`;
    if (sourceRecord !== undefined && registryIds.has(rawId)) {
      findings.push({
        sourceId: source.id,
        sourceRef,
        rawId,
        evidenceKind: 'REGISTRY_RECORD',
        evidencePaths: [REGISTRY_PATH],
        evidenceSha256: registryEvidenceSha256(sourceRecord),
        semanticSha256: registrySemanticSha256(sourceRecord),
        classification: isCollision ? 'ID_COLLISION' : 'LEGACY_UNREGISTERED',
        mainRecordSha256: isCollision && mainRecord ? registryEvidenceSha256(mainRecord) : null,
      });
      continue;
    }

    const registryReference = registryReferences.get(rawId);
    const reviewEvidence = reviews.get(rawId);
    const mentionEvidence = registryReference ?? reviewEvidence;
    if (!mentionEvidence) {
      throw new Error(`${sourceRef} has neither registry nor review evidence`);
    }
    if (registryReference && reviewEvidence) {
      for (const path of reviewEvidence.paths) {
        registryReference.paths.add(path);
      }
      for (const frame of reviewEvidence.frames) {
        registryReference.frames.add(frame);
      }
    }
    findings.push({
      sourceId: source.id,
      sourceRef,
      rawId,
      evidenceKind: registryReference ? 'REGISTRY_REFERENCE' : 'REVIEW_MENTION',
      evidencePaths: [...mentionEvidence.paths].sort(),
      evidenceSha256: reviewEvidenceSha256(mentionEvidence),
      semanticSha256: reviewSemanticSha256(rawId, mentionEvidence),
      classification: 'PENDING_ADJUDICATION',
      mainRecordSha256: null,
    });
  }
  if (source.kind === 'DIRTY_WORKTREE') {
    const dirtyContentAfter = await computeDirtyContentSha256(source.locator);
    if (dirtyContentAfter !== dirtyContentBefore) {
      throw new Error(`${source.id} dirty content moved during finding discovery`);
    }
  }
  assertSourceHeadPin(source);
  return findings;
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  let mode: CliOptions['mode'] | null = null;
  let scope: InventoryScope = 'full';
  for (const arg of args) {
    if (arg === '--check' || arg === '--write' || arg === '--refresh') {
      const candidate = arg.slice(2) as CliOptions['mode'];
      if (mode !== null && mode !== candidate) {
        throw new Error('--check, --write, and --refresh are mutually exclusive');
      }
      mode = candidate;
      continue;
    }
    if (arg === '--scope=remote') {
      scope = 'remote';
      continue;
    }
    if (arg === '--scope=full') {
      scope = 'full';
      continue;
    }
    throw new Error(`unknown source-finding inventory argument: ${arg}`);
  }
  if (mode === null) {
    throw new Error('source-finding inventory requires --check, --write, or --refresh');
  }
  if ((mode === 'write' || mode === 'refresh') && scope !== 'full') {
    throw new Error(`--${mode} is supported only with --scope=full`);
  }
  return { mode, scope };
}

export function assertExecutionSafety(
  options: CliOptions,
  evidence: FullExecutionSafetyEvidence | undefined,
): void {
  if (options.scope !== 'full' || options.mode === 'refresh') {
    return;
  }
  if (!evidence) {
    throw new Error(
      'full source-finding discovery requires an isolated runner or a kernel-enforced bounded-host cgroup',
    );
  }
  const githubIsolated =
    evidence.cgroupVersion === 2 &&
    evidence.executionClass === ISOLATED_FULL_EXECUTION_VALUE &&
    evidence.githubActions === 'true' &&
    evidence.githubEventName === 'workflow_dispatch' &&
    evidence.githubRepository === EXPECTED_GITHUB_REPOSITORY &&
    (evidence.runnerEnvironment === 'github-hosted' ||
      evidence.runnerEnvironment === 'self-hosted');
  const boundedHost =
    evidence.cgroupVersion === 2 &&
    evidence.executionClass === BOUNDED_HOST_EXECUTION_VALUE &&
    evidence.githubActions !== 'true' &&
    /^\/system\.slice\/aqua-source-finding-inventory-[A-Za-z0-9_.@:-]+\.service$/.test(
      evidence.cgroupPath,
    );
  if (!githubIsolated && !boundedHost) {
    throw new Error(
      `full source-finding discovery requires either the repository workflow_dispatch profile or ${ISOLATED_FULL_EXECUTION_ENV}=${BOUNDED_HOST_EXECUTION_VALUE} inside a dedicated systemd service`,
    );
  }

  const memoryMax = /^\d+$/.test(evidence.memoryMax) ? BigInt(evidence.memoryMax) : null;
  const minimumMemory = boundedHost ? MIN_BOUNDED_HOST_MEMORY_BYTES : MIN_ISOLATED_MEMORY_BYTES;
  const maximumMemory = boundedHost ? MAX_BOUNDED_HOST_MEMORY_BYTES : MAX_ISOLATED_MEMORY_BYTES;
  if (memoryMax === null || memoryMax < minimumMemory || memoryMax > maximumMemory) {
    throw new Error(
      `source-finding memory.max must be finite and between ${minimumMemory.toString()} and ${maximumMemory.toString()} bytes for the selected execution profile`,
    );
  }
  const memorySwapMax = /^\d+$/.test(evidence.memorySwapMax)
    ? BigInt(evidence.memorySwapMax)
    : null;
  if (
    memorySwapMax === null ||
    memorySwapMax > memoryMax ||
    (boundedHost && memorySwapMax !== 0n)
  ) {
    throw new Error(
      boundedHost
        ? 'bounded-host source-finding memory.swap.max must equal zero'
        : 'isolated source-finding memory.swap.max must be finite and no larger than memory.max',
    );
  }

  const cpuMatch = /^(?<quota>\d+) (?<period>\d+)$/.exec(evidence.cpuMax);
  const cpuQuota = cpuMatch?.groups?.quota ? Number.parseInt(cpuMatch.groups.quota, 10) : 0;
  const cpuPeriod = cpuMatch?.groups?.period ? Number.parseInt(cpuMatch.groups.period, 10) : 0;
  if (
    !Number.isSafeInteger(cpuQuota) ||
    !Number.isSafeInteger(cpuPeriod) ||
    cpuQuota <= 0 ||
    cpuPeriod <= 0 ||
    cpuQuota / cpuPeriod > (boundedHost ? MAX_BOUNDED_HOST_CPU_COUNT : MAX_ISOLATED_CPU_COUNT)
  ) {
    throw new Error(
      `source-finding cpu.max must impose a finite positive quota of at most ${
        boundedHost ? MAX_BOUNDED_HOST_CPU_COUNT : MAX_ISOLATED_CPU_COUNT
      } CPUs for the selected execution profile`,
    );
  }
  const cpuWeight = /^\d+$/.test(evidence.cpuWeight) ? Number.parseInt(evidence.cpuWeight, 10) : 0;
  if (
    boundedHost &&
    (!Number.isSafeInteger(cpuWeight) || cpuWeight <= 0 || cpuWeight > MAX_BOUNDED_HOST_CPU_WEIGHT)
  ) {
    throw new Error(
      `bounded-host source-finding cpu.weight must be between 1 and ${MAX_BOUNDED_HOST_CPU_WEIGHT}`,
    );
  }
  if (
    githubIsolated &&
    evidence.runnerEnvironment === 'self-hosted' &&
    (evidence.cpusetPartition !== 'isolated' ||
      !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(evidence.exclusiveCpus))
  ) {
    throw new Error(
      'self-hosted source-finding execution requires an isolated cgroup v2 partition with non-empty exclusive CPUs',
    );
  }

  const pidsMax = /^\d+$/.test(evidence.pidsMax) ? BigInt(evidence.pidsMax) : null;
  const maximumProcesses = boundedHost
    ? MAX_BOUNDED_HOST_PROCESS_COUNT
    : MAX_ISOLATED_PROCESS_COUNT;
  if (pidsMax === null || pidsMax <= 0n || pidsMax > maximumProcesses) {
    throw new Error(
      `source-finding pids.max must be finite and at most ${maximumProcesses.toString()} for the selected execution profile`,
    );
  }
}

function readKernelContract(path: string): string {
  const value = readFileSync(path, 'utf8').trim();
  if (value.length === 0 || value.length > 256) {
    throw new Error(`${path} returned an invalid kernel contract value`);
  }
  return value;
}

function readOptionalKernelContract(path: string): string {
  if (!existsSync(path)) {
    return '';
  }
  const value = readFileSync(path, 'utf8').trim();
  if (value.length > 256) {
    throw new Error(`${path} returned an invalid optional kernel contract value`);
  }
  return value;
}

function captureFullExecutionSafetyEvidence(): FullExecutionSafetyEvidence {
  const executionClass = process.env[ISOLATED_FULL_EXECUTION_ENV];
  const githubProfile =
    executionClass === ISOLATED_FULL_EXECUTION_VALUE &&
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    process.env.GITHUB_REPOSITORY === EXPECTED_GITHUB_REPOSITORY &&
    (process.env.RUNNER_ENVIRONMENT === 'github-hosted' ||
      process.env.RUNNER_ENVIRONMENT === 'self-hosted');
  const boundedHostProfile =
    executionClass === BOUNDED_HOST_EXECUTION_VALUE && process.env.GITHUB_ACTIONS !== 'true';
  if (!githubProfile && !boundedHostProfile) {
    throw new Error(
      'full source-finding discovery requires a repository workflow_dispatch runner or the bounded-production-evidence systemd profile',
    );
  }
  const cgroupLines = readKernelContract('/proc/self/cgroup').split(/\r?\n/);
  const unifiedEntries = cgroupLines.filter((line) => line.startsWith('0::'));
  if (unifiedEntries.length !== 1) {
    throw new Error('full source-finding discovery requires one cgroup v2 execution boundary');
  }
  const cgroupRelativePath = unifiedEntries[0]?.slice('0::'.length);
  if (
    !cgroupRelativePath ||
    !cgroupRelativePath.startsWith('/') ||
    cgroupRelativePath.split('/').includes('..') ||
    cgroupRelativePath.includes('\0')
  ) {
    throw new Error('full source-finding discovery resolved an unsafe cgroup v2 path');
  }
  const cgroupPath = join('/sys/fs/cgroup', cgroupRelativePath);
  return {
    executionClass,
    githubActions: process.env.GITHUB_ACTIONS,
    githubEventName: process.env.GITHUB_EVENT_NAME,
    githubRepository: process.env.GITHUB_REPOSITORY,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
    cgroupVersion: 2,
    cgroupPath: cgroupRelativePath,
    memoryMax: readKernelContract(join(cgroupPath, 'memory.max')),
    memorySwapMax: readKernelContract(join(cgroupPath, 'memory.swap.max')),
    cpuMax: readKernelContract(join(cgroupPath, 'cpu.max')),
    cpuWeight: readKernelContract(join(cgroupPath, 'cpu.weight')),
    exclusiveCpus: readOptionalKernelContract(join(cgroupPath, 'cpuset.cpus.exclusive.effective')),
    cpusetPartition: readOptionalKernelContract(join(cgroupPath, 'cpuset.cpus.partition')),
    pidsMax: readKernelContract(join(cgroupPath, 'pids.max')),
  };
}

function assertExecutionMainCompatibility(
  manifest: ParsedManifest,
  options: CliOptions,
  liveMain: LiveMainPin,
): void {
  const headSha = requireSha(
    runGit(['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim(),
    'checked-out HEAD',
  );
  if (
    options.mode !== 'check' ||
    options.scope !== 'remote' ||
    process.env.GITHUB_ACTIONS !== 'true'
  ) {
    assertLiveMainCompatible(liveMain, manifest.reconciledBaseSha, headSha, gitIsAncestor);
    return;
  }
  const inventory = manifest.findingInventory;
  if (!inventory) {
    throw new Error('GitHub source-finding validation requires main registry attestation');
  }
  assertGitHubMainTransition(
    {
      githubActions: process.env.GITHUB_ACTIONS,
      eventName: process.env.GITHUB_EVENT_NAME,
      githubRef: process.env.GITHUB_REF,
      githubBaseRef: process.env.GITHUB_BASE_REF,
      githubSha: process.env.GITHUB_SHA,
      pullRequestBaseSha: process.env.SOURCE_FINDING_EVENT_PR_BASE_SHA,
      pushBeforeSha: process.env.SOURCE_FINDING_EVENT_PUSH_BEFORE_SHA,
      pushAfterSha: process.env.SOURCE_FINDING_EVENT_PUSH_AFTER_SHA,
      checkoutSha: process.env.SOURCE_FINDING_EVENT_CHECKOUT_SHA,
      headSha,
      originMainSha: liveMain.commitSha,
      reconciledBaseSha: manifest.reconciledBaseSha,
      reconciledRegistryBlobSha: inventory.registry_authority.reconciled_base.registry_blob_sha,
      discoveryRegistryBlobSha: inventory.registry_authority.discovery_candidate.registry_blob_sha,
      reconciledRegistrySchemaBlobSha: inventory.registry_authority.reconciled_base.schema_blob_sha,
      discoveryRegistrySchemaBlobSha:
        inventory.registry_authority.discovery_candidate.schema_blob_sha,
    },
    {
      isAncestor: gitIsAncestor,
      registryBlobAt: registryBlobAtCommit,
      registrySchemaBlobAt: registrySchemaBlobAtCommit,
    },
  );
}

function parseFindingInventory(value: unknown): FindingInventoryManifest | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, 'capability_reconciliation.finding_inventory');
  requireExactKeys(
    record,
    [
      'schema_version',
      'artifact_path',
      'artifact_sha256',
      'occurrence_count',
      'occurrence_sha256',
      'audit_lineage',
      'discovery_contract',
      'registry_authority',
      'generation_attestation',
      'assignment_contract',
      'source_attestations',
      'unit_attestations',
    ],
    'capability_reconciliation.finding_inventory',
  );
  if (record.schema_version !== 3) {
    throw new Error('capability_reconciliation.finding_inventory.schema_version must be 3');
  }
  const registryAuthority = requireRecord(
    record.registry_authority,
    'capability_reconciliation.finding_inventory.registry_authority',
  );
  requireExactKeys(
    registryAuthority,
    ['reconciled_base', 'discovery_candidate', 'registry_snapshots', 'schema_snapshots'],
    'capability_reconciliation.finding_inventory.registry_authority',
  );
  const parseAuthorityCoordinate = (value: unknown, field: string): FindingAuthorityCoordinate => {
    const coordinate = requireRecord(value, field);
    requireExactKeys(coordinate, ['registry_blob_sha', 'schema_blob_sha'], field);
    return {
      registry_blob_sha: requireSha(coordinate.registry_blob_sha, `${field}.registry_blob_sha`),
      schema_blob_sha: requireSha(coordinate.schema_blob_sha, `${field}.schema_blob_sha`),
    };
  };
  const parseSourceAttestation = (
    entry: Record<string, unknown>,
    index: number,
  ): SourceAttestation => {
    requireExactKeys(
      entry,
      [
        'source_id',
        'source_kind',
        'source_head_sha',
        'source_content_sha256',
        'merge_base_sha',
        'source_adjudication_id',
        'occurrence_count',
        'untargeted_occurrence_count',
        'registry_backed_count',
        'registry_reference_count',
        'review_only_count',
        'collision_count',
        'occurrence_sha256',
      ],
      `source_attestations[${index}]`,
    );
    const sourceKind = requireSourceKind(
      entry.source_kind,
      `source_attestations[${index}].source_kind`,
    );
    return {
      source_id: requireString(entry.source_id, `source_attestations[${index}].source_id`),
      source_kind: sourceKind,
      source_head_sha: requireSha(
        entry.source_head_sha,
        `source_attestations[${index}].source_head_sha`,
      ),
      source_content_sha256:
        entry.source_content_sha256 === null
          ? null
          : requireSha256(
              entry.source_content_sha256,
              `source_attestations[${index}].source_content_sha256`,
            ),
      merge_base_sha: requireSha(
        entry.merge_base_sha,
        `source_attestations[${index}].merge_base_sha`,
      ),
      source_adjudication_id: requireString(
        entry.source_adjudication_id,
        `source_attestations[${index}].source_adjudication_id`,
      ),
      occurrence_count: requireInteger(
        entry.occurrence_count,
        `source_attestations[${index}].occurrence_count`,
      ),
      untargeted_occurrence_count: requireInteger(
        entry.untargeted_occurrence_count,
        `source_attestations[${index}].untargeted_occurrence_count`,
      ),
      registry_backed_count: requireInteger(
        entry.registry_backed_count,
        `source_attestations[${index}].registry_backed_count`,
      ),
      registry_reference_count: requireInteger(
        entry.registry_reference_count,
        `source_attestations[${index}].registry_reference_count`,
      ),
      review_only_count: requireInteger(
        entry.review_only_count,
        `source_attestations[${index}].review_only_count`,
      ),
      collision_count: requireInteger(
        entry.collision_count,
        `source_attestations[${index}].collision_count`,
      ),
      occurrence_sha256: requireSha256(
        entry.occurrence_sha256,
        `source_attestations[${index}].occurrence_sha256`,
      ),
    };
  };
  const parseUnitAttestation = (entry: Record<string, unknown>, index: number): UnitAttestation => {
    requireExactKeys(
      entry,
      [
        'integration_unit_id',
        'targeted_occurrence_count',
        'pending_targeted_count',
        'collision_count',
        'occurrence_sha256',
      ],
      `unit_attestations[${index}]`,
    );
    return {
      integration_unit_id: requireString(
        entry.integration_unit_id,
        `unit_attestations[${index}].integration_unit_id`,
      ),
      targeted_occurrence_count: requireInteger(
        entry.targeted_occurrence_count,
        `unit_attestations[${index}].targeted_occurrence_count`,
      ),
      pending_targeted_count: requireInteger(
        entry.pending_targeted_count,
        `unit_attestations[${index}].pending_targeted_count`,
      ),
      collision_count: requireInteger(
        entry.collision_count,
        `unit_attestations[${index}].collision_count`,
      ),
      occurrence_sha256: requireSha256(
        entry.occurrence_sha256,
        `unit_attestations[${index}].occurrence_sha256`,
      ),
    };
  };

  const discoveryContract = requireRecord(
    record.discovery_contract,
    'capability_reconciliation.finding_inventory.discovery_contract',
  );
  const auditLineage = requireRecord(
    record.audit_lineage,
    'capability_reconciliation.finding_inventory.audit_lineage',
  );
  const generationAttestation = requireRecord(
    record.generation_attestation,
    'capability_reconciliation.finding_inventory.generation_attestation',
  );
  requireExactKeys(
    discoveryContract,
    ['registry_delta', 'review_mentions', 'dirty_overlay', 'classification'],
    'capability_reconciliation.finding_inventory.discovery_contract',
  );
  requireExactKeys(
    auditLineage,
    [
      'preliminary_textual_occurrence_count',
      'preliminary_textual_occurrence_sha256',
      'intermediate_semantic_occurrence_count',
      'intermediate_semantic_occurrence_sha256',
      'excluded_rechain_only_count',
      'excluded_rechain_only_sha256',
      'excluded_source_refs',
      'rationale',
    ],
    'capability_reconciliation.finding_inventory.audit_lineage',
  );
  requireExactKeys(
    generationAttestation,
    [
      'algorithm_version',
      'remote_source_state',
      'host_source_state',
      'reconciled_at',
      'pending_isolated_regeneration',
    ],
    'capability_reconciliation.finding_inventory.generation_attestation',
  );
  const hostSourceState = generationAttestation.host_source_state;
  if (
    hostSourceState !== 'ISOLATED_FULL_REDISCOVERED' &&
    hostSourceState !== 'RETAINED_PENDING_ISOLATED_REDISCOVERY'
  ) {
    throw new Error('finding_inventory.generation_attestation.host_source_state is invalid');
  }
  const pendingRegeneration =
    generationAttestation.pending_isolated_regeneration === null
      ? null
      : requireRecord(
          generationAttestation.pending_isolated_regeneration,
          'finding_inventory.generation_attestation.pending_isolated_regeneration',
        );
  if (pendingRegeneration !== null) {
    requireExactKeys(
      pendingRegeneration,
      ['execution_owner', 'deadline', 'plan'],
      'capability_reconciliation.finding_inventory.generation_attestation.pending_isolated_regeneration',
    );
  }
  if (
    (hostSourceState === 'ISOLATED_FULL_REDISCOVERED' && pendingRegeneration !== null) ||
    (hostSourceState === 'RETAINED_PENDING_ISOLATED_REDISCOVERY' && pendingRegeneration === null)
  ) {
    throw new Error('finding_inventory generation state contradicts pending isolated regeneration');
  }
  if (generationAttestation.algorithm_version !== 'REGISTRY_SCHEMA_CAPABILITY_V3') {
    throw new Error(
      'finding_inventory.generation_attestation.algorithm_version must be REGISTRY_SCHEMA_CAPABILITY_V3',
    );
  }
  if (generationAttestation.remote_source_state !== 'LIVE_REDISCOVERED') {
    throw new Error(
      'finding_inventory.generation_attestation.remote_source_state must be LIVE_REDISCOVERED',
    );
  }
  const artifactPath = requireString(record.artifact_path, 'finding_inventory.artifact_path');
  const artifactSha256 = requireSha256(record.artifact_sha256, 'finding_inventory.artifact_sha256');
  const artifactPathMatch = ARTIFACT_PATH_PATTERN.exec(artifactPath);
  if (artifactPathMatch?.groups?.sha256 !== artifactSha256) {
    throw new Error(
      'finding_inventory.artifact_path must be the content-addressed path for artifact_sha256',
    );
  }
  const registrySnapshots = requireObjectArray(
    registryAuthority.registry_snapshots,
    'finding_inventory.registry_authority.registry_snapshots',
  ).map((snapshot, index): RegistryBlobAttestation => {
    const field = `finding_inventory.registry_authority.registry_snapshots[${index}]`;
    requireExactKeys(snapshot, ['blob_sha', 'sha256', 'row_count'], field);
    return {
      blob_sha: requireSha(snapshot.blob_sha, `${field}.blob_sha`),
      sha256: requireSha256(snapshot.sha256, `${field}.sha256`),
      row_count: requireInteger(snapshot.row_count, `${field}.row_count`),
    };
  });
  const schemaSnapshots = requireObjectArray(
    registryAuthority.schema_snapshots,
    'finding_inventory.registry_authority.schema_snapshots',
  ).map((snapshot, index): RegistrySchemaBlobAttestation => {
    const field = `finding_inventory.registry_authority.schema_snapshots[${index}]`;
    requireExactKeys(snapshot, ['blob_sha', 'sha256'], field);
    return {
      blob_sha: requireSha(snapshot.blob_sha, `${field}.blob_sha`),
      sha256: requireSha256(snapshot.sha256, `${field}.sha256`),
    };
  });
  return {
    schema_version: 3,
    artifact_path: artifactPath,
    artifact_sha256: artifactSha256,
    occurrence_count: requireInteger(record.occurrence_count, 'finding_inventory.occurrence_count'),
    occurrence_sha256: requireSha256(
      record.occurrence_sha256,
      'finding_inventory.occurrence_sha256',
    ),
    audit_lineage: {
      preliminary_textual_occurrence_count: requireInteger(
        auditLineage.preliminary_textual_occurrence_count,
        'finding_inventory.audit_lineage.preliminary_textual_occurrence_count',
      ),
      preliminary_textual_occurrence_sha256: requireSha256(
        auditLineage.preliminary_textual_occurrence_sha256,
        'finding_inventory.audit_lineage.preliminary_textual_occurrence_sha256',
      ),
      intermediate_semantic_occurrence_count: requireInteger(
        auditLineage.intermediate_semantic_occurrence_count,
        'finding_inventory.audit_lineage.intermediate_semantic_occurrence_count',
      ),
      intermediate_semantic_occurrence_sha256: requireSha256(
        auditLineage.intermediate_semantic_occurrence_sha256,
        'finding_inventory.audit_lineage.intermediate_semantic_occurrence_sha256',
      ),
      excluded_rechain_only_count: requireInteger(
        auditLineage.excluded_rechain_only_count,
        'finding_inventory.audit_lineage.excluded_rechain_only_count',
      ),
      excluded_rechain_only_sha256: requireSha256(
        auditLineage.excluded_rechain_only_sha256,
        'finding_inventory.audit_lineage.excluded_rechain_only_sha256',
      ),
      excluded_source_refs: requireStringArray(
        auditLineage.excluded_source_refs,
        'finding_inventory.audit_lineage.excluded_source_refs',
      ),
      rationale: requireString(auditLineage.rationale, 'finding_inventory.audit_lineage.rationale'),
    },
    discovery_contract: {
      registry_delta: requireString(
        discoveryContract.registry_delta,
        'finding_inventory.discovery_contract.registry_delta',
      ),
      review_mentions: requireString(
        discoveryContract.review_mentions,
        'finding_inventory.discovery_contract.review_mentions',
      ),
      dirty_overlay: requireString(
        discoveryContract.dirty_overlay,
        'finding_inventory.discovery_contract.dirty_overlay',
      ),
      classification: requireString(
        discoveryContract.classification,
        'finding_inventory.discovery_contract.classification',
      ),
    },
    registry_authority: {
      reconciled_base: parseAuthorityCoordinate(
        registryAuthority.reconciled_base,
        'finding_inventory.registry_authority.reconciled_base',
      ),
      discovery_candidate: parseAuthorityCoordinate(
        registryAuthority.discovery_candidate,
        'finding_inventory.registry_authority.discovery_candidate',
      ),
      registry_snapshots: registrySnapshots,
      schema_snapshots: schemaSnapshots,
    },
    generation_attestation: {
      algorithm_version: 'REGISTRY_SCHEMA_CAPABILITY_V3',
      remote_source_state: 'LIVE_REDISCOVERED',
      host_source_state: hostSourceState,
      reconciled_at: requireString(
        generationAttestation.reconciled_at,
        'finding_inventory.generation_attestation.reconciled_at',
      ),
      pending_isolated_regeneration:
        pendingRegeneration === null
          ? null
          : {
              execution_owner: requireString(
                pendingRegeneration.execution_owner,
                'finding_inventory.generation_attestation.pending_isolated_regeneration.execution_owner',
              ),
              deadline: requireString(
                pendingRegeneration.deadline,
                'finding_inventory.generation_attestation.pending_isolated_regeneration.deadline',
              ),
              plan: requireString(
                pendingRegeneration.plan,
                'finding_inventory.generation_attestation.pending_isolated_regeneration.plan',
              ),
            },
    },
    assignment_contract: requireString(
      record.assignment_contract,
      'finding_inventory.assignment_contract',
    ),
    source_attestations: requireObjectArray(
      record.source_attestations,
      'finding_inventory.source_attestations',
    ).map(parseSourceAttestation),
    unit_attestations: requireObjectArray(
      record.unit_attestations,
      'finding_inventory.unit_attestations',
    ).map(parseUnitAttestation),
  };
}

export function assertFindingInventoryClosedSchema(value: unknown): void {
  if (parseFindingInventory(value) === undefined) {
    throw new Error('finding inventory is required');
  }
}

function parseManifest(raw: unknown, includeFindingInventory: boolean = true): ParsedManifest {
  const manifest = requireRecord(raw, 'manifest');
  const reconciliation = requireRecord(
    manifest.capability_reconciliation,
    'manifest.capability_reconciliation',
  );
  const sources = requireObjectArray(
    reconciliation.sources,
    'capability_reconciliation.sources',
  ).map((entry, index): SourceRecord => {
    const kind = requireSourceKind(entry.kind, `sources[${index}].kind`);
    const locator = requireString(entry.locator, `sources[${index}].locator`);
    if (kind === 'DIRTY_WORKTREE' && !isAbsolute(locator)) {
      throw new Error(`sources[${index}].locator must be absolute for a dirty worktree`);
    }
    if (kind === 'REMOTE_BRANCH' && !locator.startsWith('refs/remotes/origin/')) {
      throw new Error(`sources[${index}].locator must be an origin remote ref for REMOTE_BRANCH`);
    }
    if (kind === 'LOCAL_BRANCH' && !locator.startsWith('refs/heads/')) {
      throw new Error(`sources[${index}].locator must be a local ref for LOCAL_BRANCH`);
    }
    return {
      id: requireString(entry.id, `sources[${index}].id`),
      kind,
      locator,
      headSha: requireSha(entry.head_sha, `sources[${index}].head_sha`),
      contentSha256:
        kind === 'DIRTY_WORKTREE'
          ? requireSha256(entry.content_sha256, `sources[${index}].content_sha256`)
          : null,
    };
  });
  const sourceAdjudications = requireObjectArray(
    reconciliation.source_adjudications,
    'capability_reconciliation.source_adjudications',
  ).map(
    (entry, index): SourceAdjudication => ({
      id: requireString(entry.id, `source_adjudications[${index}].id`),
      sourceId: requireString(entry.source_id, `source_adjudications[${index}].source_id`),
      status: requireString(entry.status, `source_adjudications[${index}].status`),
      executionOwner: requireString(
        entry.execution_owner,
        `source_adjudications[${index}].execution_owner`,
      ),
      deadline: requireString(entry.deadline, `source_adjudications[${index}].deadline`),
      plan: requireString(entry.plan, `source_adjudications[${index}].plan`),
    }),
  );
  const units = requireObjectArray(
    reconciliation.integration_units,
    'capability_reconciliation.integration_units',
  ).map((entry, index): IntegrationUnit => {
    const binding = requireRecord(
      entry.finding_binding,
      `integration_units[${index}].finding_binding`,
    );
    const canonicalPromotionRecord =
      binding.canonical_promotion === undefined
        ? null
        : requireRecord(
            binding.canonical_promotion,
            `integration_units[${index}].finding_binding.canonical_promotion`,
          );
    let canonicalPromotion: CanonicalPromotionEvidence | null = null;
    if (canonicalPromotionRecord !== null) {
      const field = `integration_units[${index}].finding_binding.canonical_promotion`;
      requireExactKeys(
        canonicalPromotionRecord,
        [
          'schema_version',
          'prior_artifact_sha256',
          'prior_occurrence_id',
          'prior_source_head_sha',
          'source_ref',
          'integration_unit_id',
          'canonical_finding_id',
          'candidate_registry_blob_sha',
          'semantic_sha256',
          'recorded_at',
          'recorded_by',
        ],
        field,
      );
      if (canonicalPromotionRecord.schema_version !== 1) {
        throw new Error(`${field}.schema_version must be 1`);
      }
      canonicalPromotion = {
        schemaVersion: 1,
        priorArtifactSha256: requireSha256(
          canonicalPromotionRecord.prior_artifact_sha256,
          `${field}.prior_artifact_sha256`,
        ),
        priorOccurrenceId: requireSha256(
          canonicalPromotionRecord.prior_occurrence_id,
          `${field}.prior_occurrence_id`,
        ),
        priorSourceHeadSha: requireSha(
          canonicalPromotionRecord.prior_source_head_sha,
          `${field}.prior_source_head_sha`,
        ),
        sourceRef: requireString(canonicalPromotionRecord.source_ref, `${field}.source_ref`),
        integrationUnitId: requireString(
          canonicalPromotionRecord.integration_unit_id,
          `${field}.integration_unit_id`,
        ),
        canonicalFindingId: requireString(
          canonicalPromotionRecord.canonical_finding_id,
          `${field}.canonical_finding_id`,
        ),
        candidateRegistryBlobSha: requireSha(
          canonicalPromotionRecord.candidate_registry_blob_sha,
          `${field}.candidate_registry_blob_sha`,
        ),
        semanticSha256: requireSha256(
          canonicalPromotionRecord.semantic_sha256,
          `${field}.semantic_sha256`,
        ),
        recordedAt: requireString(canonicalPromotionRecord.recorded_at, `${field}.recorded_at`),
        recordedBy: requireString(canonicalPromotionRecord.recorded_by, `${field}.recorded_by`),
      };
    }
    return {
      id: requireString(entry.id, `integration_units[${index}].id`),
      state: requireString(entry.state, `integration_units[${index}].state`),
      executionOwner: requireExecutionOwner(entry, `integration_units[${index}]`),
      findingBindingStatus: requireString(
        binding.status,
        `integration_units[${index}].finding_binding.status`,
      ),
      findingIds: requireStringArray(
        binding.finding_ids,
        `integration_units[${index}].finding_binding.finding_ids`,
      ),
      legacyFindingRefs: requireStringArray(
        binding.legacy_finding_refs,
        `integration_units[${index}].finding_binding.legacy_finding_refs`,
      ),
      canonicalPromotion,
    };
  });

  return {
    raw: manifest,
    reconciliation,
    reconciledAt: requireString(
      reconciliation.last_reconciled_at,
      'capability_reconciliation.last_reconciled_at',
    ),
    reconciledBaseSha: requireSha(
      reconciliation.reconciled_base_sha,
      'capability_reconciliation.reconciled_base_sha',
    ),
    sources,
    sourceAdjudications,
    units,
    findingInventory: includeFindingInventory
      ? parseFindingInventory(reconciliation.finding_inventory)
      : undefined,
  };
}

function parseArtifact(
  raw: string,
  artifactPath: string = 'source-finding artifact',
): SourceFindingOccurrence[] {
  const occurrences: SourceFindingOccurrence[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.length === 0) {
      continue;
    }
    const coordinate = `${artifactPath}:${index + 1}`;
    const record = requireRecord(JSON.parse(line), coordinate);
    requireExactKeys(
      record,
      [
        'occurrence_id',
        'source_ref',
        'source_id',
        'raw_id',
        'evidence_kind',
        'evidence_paths',
        'evidence_sha256',
        'semantic_sha256',
        'classification',
        'canonical_id',
        'main_record_sha256',
        'adjudication',
      ],
      coordinate,
    );
    const adjudication = requireRecord(record.adjudication, `${coordinate}.adjudication`);
    requireExactKeys(
      adjudication,
      ['status', 'source_adjudication_id', 'target_integration_unit_id'],
      `${coordinate}.adjudication`,
    );
    const classification = record.classification;
    if (
      classification !== 'LEGACY_UNREGISTERED' &&
      classification !== 'PENDING_ADJUDICATION' &&
      classification !== 'ID_COLLISION'
    ) {
      throw new Error(
        `${artifactPath}:${index + 1}.classification must be LEGACY_UNREGISTERED, PENDING_ADJUDICATION, or ID_COLLISION`,
      );
    }
    const evidenceKind = record.evidence_kind;
    if (
      evidenceKind !== 'REGISTRY_RECORD' &&
      evidenceKind !== 'REGISTRY_REFERENCE' &&
      evidenceKind !== 'REVIEW_MENTION'
    ) {
      throw new Error(
        `${artifactPath}:${index + 1}.evidence_kind must be REGISTRY_RECORD, REGISTRY_REFERENCE, or REVIEW_MENTION`,
      );
    }
    if (
      (evidenceKind === 'REGISTRY_RECORD' && classification === 'PENDING_ADJUDICATION') ||
      (evidenceKind !== 'REGISTRY_RECORD' && classification !== 'PENDING_ADJUDICATION')
    ) {
      throw new Error(
        `${artifactPath}:${index + 1} evidence/classification combination is impossible`,
      );
    }
    if (record.canonical_id !== null) {
      throw new Error(`${artifactPath}:${index + 1}.canonical_id must be null while pending`);
    }
    if (adjudication.status !== 'PENDING') {
      throw new Error(`${artifactPath}:${index + 1}.adjudication.status must be PENDING`);
    }
    const targetIntegrationUnitId =
      adjudication.target_integration_unit_id === null
        ? null
        : requireString(
            adjudication.target_integration_unit_id,
            `artifact[${index}].adjudication.target_integration_unit_id`,
          );
    const mainRecordSha =
      record.main_record_sha256 === null
        ? null
        : requireSha256(
            record.main_record_sha256,
            `${artifactPath}:${index + 1}.main_record_sha256`,
          );
    if (classification === 'ID_COLLISION' && mainRecordSha === null) {
      throw new Error(`${artifactPath}:${index + 1} ID_COLLISION requires main_record_sha256`);
    }
    if (classification !== 'ID_COLLISION' && mainRecordSha !== null) {
      throw new Error(`${artifactPath}:${index + 1} non-collision cannot claim a main record`);
    }
    const evidencePaths = requireStringArray(
      record.evidence_paths,
      `artifact[${index}].evidence_paths`,
    );
    if (evidencePaths.length === 0) {
      throw new Error(`${artifactPath}:${index + 1}.evidence_paths must not be empty`);
    }
    if (
      new Set(evidencePaths).size !== evidencePaths.length ||
      stableJson(evidencePaths) !== stableJson([...evidencePaths].sort(compareText))
    ) {
      throw new Error(`${artifactPath}:${index + 1}.evidence_paths must be unique and sorted`);
    }
    if (
      (evidenceKind === 'REGISTRY_RECORD' &&
        (evidencePaths.length !== 1 || evidencePaths[0] !== REGISTRY_PATH)) ||
      (evidenceKind === 'REGISTRY_REFERENCE' && !evidencePaths.includes(REGISTRY_PATH)) ||
      (evidenceKind === 'REVIEW_MENTION' && evidencePaths.includes(REGISTRY_PATH))
    ) {
      throw new Error(`${artifactPath}:${index + 1} evidence paths contradict evidence kind`);
    }
    const sourceId = requireString(record.source_id, `artifact[${index}].source_id`);
    const sourceAdjudicationId = requireString(
      adjudication.source_adjudication_id,
      `artifact[${index}].adjudication.source_adjudication_id`,
    );
    occurrences.push({
      occurrence_id: requireSha256(record.occurrence_id, `artifact[${index}].occurrence_id`),
      source_ref: requireString(record.source_ref, `artifact[${index}].source_ref`),
      source_id: sourceId,
      raw_id: requireString(record.raw_id, `artifact[${index}].raw_id`),
      evidence_kind: evidenceKind,
      evidence_paths: evidencePaths,
      evidence_sha256: requireSha256(record.evidence_sha256, `artifact[${index}].evidence_sha256`),
      semantic_sha256: requireSha256(record.semantic_sha256, `artifact[${index}].semantic_sha256`),
      classification,
      canonical_id: null,
      main_record_sha256: mainRecordSha,
      adjudication: {
        status: 'PENDING',
        source_adjudication_id: sourceAdjudicationId,
        target_integration_unit_id: targetIntegrationUnitId,
      },
    });
  }
  return occurrences;
}

function artifactText(occurrences: readonly SourceFindingOccurrence[]): string {
  return occurrences.length === 0
    ? ''
    : `${occurrences.map((occurrence) => JSON.stringify(occurrence)).join('\n')}\n`;
}

function assignedUnits(
  units: readonly IntegrationUnit[],
  occurrenceRefs: ReadonlySet<string>,
): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const unit of units) {
    for (const sourceRef of unit.legacyFindingRefs) {
      if (!occurrenceRefs.has(sourceRef)) {
        continue;
      }
      const previous = assignments.get(sourceRef);
      if (previous !== undefined && previous !== unit.id) {
        throw new Error(`${sourceRef} is bound to both ${previous} and ${unit.id}`);
      }
      assignments.set(sourceRef, unit.id);
    }
  }
  return assignments;
}

function sourceAdjudicationsBySource(
  sourceAdjudications: readonly SourceAdjudication[],
): Map<string, SourceAdjudication> {
  const bySource = new Map<string, SourceAdjudication>();
  for (const adjudication of sourceAdjudications) {
    if (adjudication.id !== `SA-${adjudication.sourceId}`) {
      throw new Error(
        `${adjudication.id} must use deterministic source adjudication ID SA-${adjudication.sourceId}`,
      );
    }
    const previous = bySource.get(adjudication.sourceId);
    if (previous !== undefined) {
      throw new Error(
        `${adjudication.sourceId} is assigned to both ${previous.id} and ${adjudication.id}`,
      );
    }
    bySource.set(adjudication.sourceId, adjudication);
  }
  return bySource;
}

function requireSourceAdjudication(
  bySource: ReadonlyMap<string, SourceAdjudication>,
  sourceId: string,
): SourceAdjudication {
  const adjudication = bySource.get(sourceId);
  if (adjudication === undefined) {
    throw new Error(`${sourceId} has no unique source-adjudication queue`);
  }
  return adjudication;
}

export function occurrenceId(sourceRef: string): string {
  return sha256(`source-finding-occurrence-v1\0${sourceRef}`);
}

export function materializeOccurrences(
  findings: readonly DiscoveredFinding[],
  sourceAdjudications: readonly SourceAdjudication[],
  units: readonly IntegrationUnit[],
): SourceFindingOccurrence[] {
  const unitIds = new Set(units.map((unit) => unit.id));
  const findingRefs = new Set(findings.map((finding) => finding.sourceRef));
  if (findingRefs.size !== findings.length) {
    throw new Error('discovered source finding refs are not unique');
  }
  const assignments = assignedUnits(units, findingRefs);
  const adjudicationsBySource = sourceAdjudicationsBySource(sourceAdjudications);
  return [...findings]
    .sort(
      (left, right) =>
        compareText(left.sourceId, right.sourceId) || compareText(left.rawId, right.rawId),
    )
    .map((finding): SourceFindingOccurrence => {
      const sourceAdjudication = requireSourceAdjudication(adjudicationsBySource, finding.sourceId);
      const targetIntegrationUnitId = assignments.get(finding.sourceRef) ?? null;
      if (finding.classification === 'ID_COLLISION' && targetIntegrationUnitId !== null) {
        throw new Error(
          `${finding.sourceRef} is an unresolved ID collision and cannot target ${targetIntegrationUnitId}; allocate a fresh canonical finding before capability assignment`,
        );
      }
      return {
        occurrence_id: occurrenceId(finding.sourceRef),
        source_ref: finding.sourceRef,
        source_id: finding.sourceId,
        raw_id: finding.rawId,
        evidence_kind: finding.evidenceKind,
        evidence_paths: [...finding.evidencePaths].sort(),
        evidence_sha256: finding.evidenceSha256,
        semantic_sha256: finding.semanticSha256,
        classification: finding.classification,
        canonical_id: null,
        main_record_sha256: finding.mainRecordSha256,
        adjudication: {
          status: 'PENDING',
          source_adjudication_id: sourceAdjudication.id,
          target_integration_unit_id: targetIntegrationUnitId,
        },
      };
    });
}

export function assertOccurrenceAssignments(
  occurrences: readonly SourceFindingOccurrence[],
  units: readonly Pick<IntegrationUnit, 'id' | 'legacyFindingRefs'>[],
): void {
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const occurrenceByRef = new Map(
    occurrences.map((occurrence) => [occurrence.source_ref, occurrence]),
  );

  for (const occurrence of occurrences) {
    const targetUnitId = occurrence.adjudication.target_integration_unit_id;
    if (targetUnitId === null) {
      continue;
    }
    const targetUnit = unitsById.get(targetUnitId);
    if (!targetUnit) {
      throw new Error(`${occurrence.source_ref} names an unknown target integration unit`);
    }
    if (!targetUnit.legacyFindingRefs.includes(occurrence.source_ref)) {
      throw new Error(
        `${occurrence.source_ref} targets ${targetUnit.id} without an evidence-backed legacy ref`,
      );
    }
  }

  for (const unit of units) {
    for (const sourceRef of unit.legacyFindingRefs) {
      const occurrence = occurrenceByRef.get(sourceRef);
      if (!occurrence) {
        throw new Error(`${unit.id} legacy ref ${sourceRef} has no artifact occurrence`);
      }
      if (occurrence.adjudication.target_integration_unit_id !== unit.id) {
        throw new Error(
          `${unit.id} legacy ref ${sourceRef} is targeted to ${String(
            occurrence.adjudication.target_integration_unit_id,
          )}`,
        );
      }
    }
  }
}

function isEvidenceBackedCanonicalRebind(
  occurrence: SourceFindingOccurrence,
  targetUnit: IntegrationUnit,
  canonicalEvidenceById: ReadonlyMap<string, CanonicalFindingEvidence>,
  context: RefreshAssignmentEvidenceContext,
): boolean {
  const canonicalEvidence = canonicalEvidenceById.get(occurrence.raw_id);
  const promotion = targetUnit.canonicalPromotion;
  return (
    occurrence.classification === 'LEGACY_UNREGISTERED' &&
    occurrence.evidence_kind === 'REGISTRY_RECORD' &&
    occurrence.main_record_sha256 === null &&
    targetUnit.findingBindingStatus === 'BOUND' &&
    targetUnit.findingIds.includes(occurrence.raw_id) &&
    !targetUnit.legacyFindingRefs.includes(occurrence.source_ref) &&
    promotion?.priorArtifactSha256 === context.priorArtifactSha256 &&
    promotion.priorOccurrenceId === occurrence.occurrence_id &&
    promotion.priorSourceHeadSha === context.priorSourceHeadShaById.get(occurrence.source_id) &&
    promotion.sourceRef === occurrence.source_ref &&
    promotion.integrationUnitId === targetUnit.id &&
    promotion.canonicalFindingId === occurrence.raw_id &&
    promotion.candidateRegistryBlobSha === context.candidateRegistryBlobSha &&
    promotion.semanticSha256 === occurrence.semantic_sha256 &&
    promotion.recordedBy === targetUnit.executionOwner &&
    canonicalEvidence?.semanticSha256 === occurrence.semantic_sha256 &&
    (canonicalEvidence.state === 'OPEN' || canonicalEvidence.state === 'IN-PROGRESS')
  );
}

export function assertRefreshAssignmentTransition(
  priorOccurrences: readonly SourceFindingOccurrence[],
  units: readonly IntegrationUnit[],
  canonicalEvidenceById: ReadonlyMap<string, CanonicalFindingEvidence>,
  context: RefreshAssignmentEvidenceContext,
): string[] {
  assertUnique(
    units.map((unit) => unit.id),
    'refresh integration unit IDs',
  );
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const canonicalFindingOwners = new Map<string, string>();
  for (const unit of units) {
    if (unit.canonicalPromotion !== null) {
      assertCanonicalUtcInstant(
        unit.canonicalPromotion.recordedAt,
        `${unit.id} canonical promotion recordedAt`,
      );
    }
    if (new Set(unit.findingIds).size !== unit.findingIds.length) {
      throw new Error(`${unit.id} contains duplicate canonical finding IDs`);
    }
    if (unit.findingBindingStatus !== 'BOUND') {
      continue;
    }
    for (const findingId of unit.findingIds) {
      const previousOwner = canonicalFindingOwners.get(findingId);
      if (previousOwner !== undefined && previousOwner !== unit.id) {
        throw new Error(
          `${findingId} canonical authority is bound to both ${previousOwner} and ${unit.id}`,
        );
      }
      canonicalFindingOwners.set(findingId, unit.id);
    }
  }
  const occurrenceByRef = new Map(
    priorOccurrences.map((occurrence) => [occurrence.source_ref, occurrence]),
  );
  const canonicalRebinds: string[] = [];

  for (const occurrence of priorOccurrences) {
    const targetUnitId = occurrence.adjudication.target_integration_unit_id;
    if (targetUnitId === null) {
      continue;
    }
    const targetUnit = unitsById.get(targetUnitId);
    if (!targetUnit) {
      throw new Error(
        `${occurrence.source_ref} prior target ${targetUnitId} is absent from the current manifest`,
      );
    }
    if (targetUnit.legacyFindingRefs.includes(occurrence.source_ref)) {
      continue;
    }
    if (!isEvidenceBackedCanonicalRebind(occurrence, targetUnit, canonicalEvidenceById, context)) {
      throw new Error(
        `${occurrence.source_ref} lost its legacy target without an exact canonical semantic rebind`,
      );
    }
    canonicalRebinds.push(occurrence.source_ref);
  }

  for (const unit of units) {
    for (const sourceRef of unit.legacyFindingRefs) {
      const occurrence = occurrenceByRef.get(sourceRef);
      if (!occurrence) {
        throw new Error(
          `${unit.id} introduces legacy ref ${sourceRef} without prior attested evidence`,
        );
      }
      if (occurrence.adjudication.target_integration_unit_id !== unit.id) {
        throw new Error(
          `${unit.id} legacy ref ${sourceRef} changes prior target ${String(
            occurrence.adjudication.target_integration_unit_id,
          )}`,
        );
      }
    }
  }
  return canonicalRebinds.sort(compareText);
}

export function assertCanonicalRebindsRetiredByRemoteDiscovery(
  canonicalRebinds: readonly string[],
  remoteOccurrences: readonly SourceFindingOccurrence[],
  remoteSourceIds: ReadonlySet<string>,
): void {
  const rediscoveredRefs = new Set(remoteOccurrences.map((occurrence) => occurrence.source_ref));
  for (const sourceRef of canonicalRebinds) {
    const separator = sourceRef.indexOf('#');
    const sourceId = separator === -1 ? '' : sourceRef.slice(0, separator);
    if (!remoteSourceIds.has(sourceId)) {
      throw new Error(
        `${sourceRef} canonical rebind belongs to a retained host source and requires isolated full regeneration`,
      );
    }
    if (rediscoveredRefs.has(sourceRef)) {
      throw new Error(
        `${sourceRef} canonical rebind remains in remote discovery and cannot retire legacy authority`,
      );
    }
  }
}

export function deriveReservedDomainFloors(
  occurrences: readonly Pick<SourceFindingOccurrence, 'raw_id'>[],
): Record<string, number> {
  return deriveRawFindingIdFloors(
    occurrences.map((occurrence) => occurrence.raw_id),
    FINDING_REGISTRY_SCHEMA_CONTRACT,
  );
}

function sourceOccurrenceAttestation(
  sourceId: string,
  occurrences: readonly SourceFindingOccurrence[],
): Pick<
  SourceAttestation,
  | 'occurrence_count'
  | 'untargeted_occurrence_count'
  | 'registry_backed_count'
  | 'registry_reference_count'
  | 'review_only_count'
  | 'collision_count'
  | 'occurrence_sha256'
> {
  const rows = occurrences.filter((occurrence) => occurrence.source_id === sourceId);
  return {
    occurrence_count: rows.length,
    untargeted_occurrence_count: rows.filter(
      (occurrence) => occurrence.adjudication.target_integration_unit_id === null,
    ).length,
    registry_backed_count: rows.filter(
      (occurrence) => occurrence.evidence_kind === 'REGISTRY_RECORD',
    ).length,
    registry_reference_count: rows.filter(
      (occurrence) => occurrence.evidence_kind === 'REGISTRY_REFERENCE',
    ).length,
    review_only_count: rows.filter((occurrence) => occurrence.evidence_kind === 'REVIEW_MENTION')
      .length,
    collision_count: rows.filter((occurrence) => occurrence.classification === 'ID_COLLISION')
      .length,
    occurrence_sha256: sourceRefDigest(rows.map((occurrence) => occurrence.source_ref)),
  };
}

function buildSourceAttestations(
  sources: readonly SourceRecord[],
  sourceAdjudications: readonly SourceAdjudication[],
  occurrences: readonly SourceFindingOccurrence[],
  reconciledBaseSha: string,
  resolveMergeBase: (source: SourceRecord, reconciledBaseSha: string) => string = (source, base) =>
    mergeBase(source.headSha, base),
): SourceAttestation[] {
  const adjudicationsBySource = sourceAdjudicationsBySource(sourceAdjudications);
  return [...sources]
    .sort((left, right) => compareText(left.id, right.id))
    .map((source) => ({
      source_id: source.id,
      source_kind: source.kind,
      source_head_sha: source.headSha,
      source_content_sha256: source.contentSha256,
      merge_base_sha: requireSha(
        resolveMergeBase(source, reconciledBaseSha),
        `${source.id} merge-base attestation`,
      ),
      source_adjudication_id: requireSourceAdjudication(adjudicationsBySource, source.id).id,
      ...sourceOccurrenceAttestation(source.id, occurrences),
    }));
}

function unitOccurrenceAttestation(
  unitId: string,
  occurrences: readonly SourceFindingOccurrence[],
): Omit<UnitAttestation, 'integration_unit_id'> {
  const targetedRows = occurrences.filter(
    (occurrence) => occurrence.adjudication.target_integration_unit_id === unitId,
  );
  return {
    targeted_occurrence_count: targetedRows.length,
    pending_targeted_count: targetedRows.filter(
      (occurrence) => occurrence.adjudication.status === 'PENDING',
    ).length,
    collision_count: targetedRows.filter(
      (occurrence) => occurrence.classification === 'ID_COLLISION',
    ).length,
    occurrence_sha256: sourceRefDigest(targetedRows.map((occurrence) => occurrence.source_ref)),
  };
}

function buildUnitAttestations(
  units: readonly Pick<IntegrationUnit, 'id'>[],
  occurrences: readonly SourceFindingOccurrence[],
): UnitAttestation[] {
  return [...units]
    .sort((left, right) => compareText(left.id, right.id))
    .map((unit) => ({
      integration_unit_id: unit.id,
      ...unitOccurrenceAttestation(unit.id, occurrences),
    }));
}

function registryBlobAttestation(blobSha: string): RegistryBlobAttestation {
  const registry = registryAtBlob(blobSha);
  return {
    blob_sha: requireSha(blobSha, 'registry authority blob SHA'),
    sha256: sha256(registry.raw),
    row_count: registry.snapshot.rowCount,
  };
}

function registrySchemaBlobAttestation(
  blobSha: string,
  discoverySchemaBlobSha: string,
): RegistrySchemaBlobAttestation {
  const checkedBlobSha = requireSha(blobSha, 'registry schema authority blob SHA');
  let raw: string;
  if (checkedBlobSha === discoverySchemaBlobSha) {
    if (effectiveRegistrySchemaBlobSha() !== discoverySchemaBlobSha) {
      throw new Error('effective registry schema differs from its discovery Git blob');
    }
    raw = REGISTRY_SCHEMA_RAW;
  } else {
    const objectType = runGit(['cat-file', '-t', checkedBlobSha]).stdout.trim();
    if (objectType !== 'blob') {
      throw new Error(
        `registry schema authority ${checkedBlobSha} is ${objectType}, not a Git blob`,
      );
    }
    raw = runGit(['cat-file', 'blob', checkedBlobSha]).stdout;
  }
  return {
    blob_sha: checkedBlobSha,
    sha256: sha256(raw),
  };
}

function registryAuthorityAttestation(
  reconciledBaseSha: string,
  discoveryRegistryBlobSha: string,
  discoverySchemaBlobSha: string,
): RegistryAuthority {
  const reconciledRegistryBlobSha = registryBlobAtCommit(reconciledBaseSha);
  const reconciledSchemaBlobSha = registrySchemaBlobAtCommit(reconciledBaseSha);
  const uniqueRegistryBlobShas = [
    ...new Set([reconciledRegistryBlobSha, discoveryRegistryBlobSha]),
  ].sort(compareText);
  const uniqueSchemaBlobShas = [...new Set([reconciledSchemaBlobSha, discoverySchemaBlobSha])].sort(
    compareText,
  );
  return {
    reconciled_base: {
      registry_blob_sha: reconciledRegistryBlobSha,
      schema_blob_sha: reconciledSchemaBlobSha,
    },
    discovery_candidate: {
      registry_blob_sha: requireSha(discoveryRegistryBlobSha, 'discovery registry blob SHA'),
      schema_blob_sha: requireSha(discoverySchemaBlobSha, 'discovery registry schema blob SHA'),
    },
    registry_snapshots: uniqueRegistryBlobShas.map(registryBlobAttestation),
    schema_snapshots: uniqueSchemaBlobShas.map((blobSha) =>
      registrySchemaBlobAttestation(blobSha, discoverySchemaBlobSha),
    ),
  };
}

function generationAttestationAt(
  reconciledAt: string,
  hostSourceState: FindingInventoryManifest['generation_attestation']['host_source_state'],
): FindingInventoryManifest['generation_attestation'] {
  return {
    algorithm_version: 'REGISTRY_SCHEMA_CAPABILITY_V3',
    remote_source_state: 'LIVE_REDISCOVERED',
    host_source_state: hostSourceState,
    reconciled_at: reconciledAt,
    pending_isolated_regeneration:
      hostSourceState === 'ISOLATED_FULL_REDISCOVERED'
        ? null
        : {
            execution_owner: 'infra-expert',
            deadline: '2026-07-30',
            plan: 'Run the full source-finding generator from a repository-owned workflow_dispatch job whose cgroup v2 proves finite memory/swap/CPU/PID limits and an exclusive isolated CPU partition; scan every pinned local branch and dirty worktree, and replace retained rows only after content digests and the start/end dirty snapshot pins agree.',
          },
  };
}

function generationAttestation(
  manifest: ParsedManifest,
  hostSourceState: FindingInventoryManifest['generation_attestation']['host_source_state'],
): FindingInventoryManifest['generation_attestation'] {
  return generationAttestationAt(manifest.reconciledAt, hostSourceState);
}

function buildFindingInventoryManifest(
  manifest: ParsedManifest,
  occurrences: readonly SourceFindingOccurrence[],
  artifact: string,
  discoveryRegistryBlobSha: string,
  discoverySchemaBlobSha: string,
  hostSourceState: FindingInventoryManifest['generation_attestation']['host_source_state'],
  sourceAttestations: readonly SourceAttestation[],
): FindingInventoryManifest {
  const artifactSha256 = sha256(artifact);
  return {
    schema_version: 3,
    artifact_path: `${PLAN_DIRECTORY}/source-findings.${artifactSha256}.jsonl`,
    artifact_sha256: artifactSha256,
    occurrence_count: occurrences.length,
    occurrence_sha256: sourceRefDigest(occurrences.map((occurrence) => occurrence.source_ref)),
    audit_lineage: auditLineage(),
    discovery_contract: discoveryContract(),
    registry_authority: registryAuthorityAttestation(
      manifest.reconciledBaseSha,
      discoveryRegistryBlobSha,
      discoverySchemaBlobSha,
    ),
    generation_attestation: generationAttestation(manifest, hostSourceState),
    assignment_contract: ASSIGNMENT_CONTRACT,
    source_attestations: [...sourceAttestations],
    unit_attestations: buildUnitAttestations(manifest.units, occurrences),
  };
}

async function discover(
  manifest: ParsedManifest,
  scope: InventoryScope,
): Promise<{
  findings: DiscoveredFinding[];
  discoveryHeadSha: string;
  discoveryRegistryBlobSha: string;
  discoveryRegistrySchemaBlobSha: string;
}> {
  const discoveryHeadSha = requireSha(
    runGit(['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim(),
    'source-finding discovery HEAD',
  );
  const discoveryRegistryBlobSha = registryBlobAtCommit(discoveryHeadSha);
  const discoveryRegistrySchemaBlobSha = effectiveRegistrySchemaBlobSha();
  if (
    readBoundedText(join(REPO_ROOT, REGISTRY_SCHEMA_PATH), MAX_REGISTRY_SCHEMA_BYTES) !==
    REGISTRY_SCHEMA_RAW
  ) {
    throw new Error('registry schema changed after source-finding tool initialization');
  }
  const discoveryRegistry = registryAtBlob(discoveryRegistryBlobSha).snapshot;
  const findings: DiscoveredFinding[] = [];
  for (const source of manifest.sources.filter(
    (candidate) => scope === 'full' || candidate.kind === 'REMOTE_BRANCH',
  )) {
    findings.push(
      ...(await discoverForSource(source, manifest.reconciledBaseSha, discoveryRegistry)),
    );
  }
  return {
    findings,
    discoveryHeadSha,
    discoveryRegistryBlobSha,
    discoveryRegistrySchemaBlobSha,
  };
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} contains duplicate ${value}`);
    }
    seen.add(value);
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${label} differs from deterministic source-finding inventory`);
  }
}

function sourceAttestationsBySource(
  attestations: readonly SourceAttestation[],
  sources: readonly SourceRecord[],
): Map<string, SourceAttestation> {
  assertUnique(
    attestations.map((attestation) => attestation.source_id),
    'finding inventory source attestation IDs',
  );
  const sourceIds = new Set(sources.map((source) => source.id));
  const bySource = new Map(attestations.map((attestation) => [attestation.source_id, attestation]));
  const missing = [...sourceIds].filter((sourceId) => !bySource.has(sourceId)).sort();
  const extra = [...bySource.keys()].filter((sourceId) => !sourceIds.has(sourceId)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `finding inventory source attestation coverage differs from manifest sources; missing=${
        missing.join(',') || '<none>'
      }; extra=${extra.join(',') || '<none>'}`,
    );
  }
  return bySource;
}

export function sourceAttestationsForRefresh(
  attestations: readonly SourceAttestation[],
  sources: readonly Pick<SourceRecord, 'id' | 'kind' | 'headSha' | 'contentSha256'>[],
): Map<string, SourceAttestation> {
  assertUnique(
    attestations.map((attestation) => attestation.source_id),
    'prior finding inventory source attestation IDs',
  );
  assertUnique(
    sources.map((source) => source.id),
    'current source IDs',
  );
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const bySource = new Map(attestations.map((attestation) => [attestation.source_id, attestation]));
  const removed = [...bySource.keys()].filter((sourceId) => !sourcesById.has(sourceId)).sort();
  const undiscoverableAdditions = sources
    .filter((source) => !bySource.has(source.id) && source.kind !== 'REMOTE_BRANCH')
    .map((source) => source.id)
    .sort();
  const kindChanges = attestations
    .filter((attestation) => {
      const current = sourcesById.get(attestation.source_id);
      return current !== undefined && current.kind !== attestation.source_kind;
    })
    .map((attestation) => attestation.source_id)
    .sort();
  const hostPinChanges = attestations
    .filter((attestation) => {
      const current = sourcesById.get(attestation.source_id);
      return (
        current !== undefined &&
        current.kind !== 'REMOTE_BRANCH' &&
        current.kind === attestation.source_kind &&
        (current.headSha !== attestation.source_head_sha ||
          current.contentSha256 !== attestation.source_content_sha256)
      );
    })
    .map((attestation) => attestation.source_id)
    .sort();
  if (
    removed.length > 0 ||
    undiscoverableAdditions.length > 0 ||
    kindChanges.length > 0 ||
    hostPinChanges.length > 0
  ) {
    throw new Error(
      `host-safe refresh source transition is invalid; removed=${
        removed.join(',') || '<none>'
      }; new_non_remote=${undiscoverableAdditions.join(',') || '<none>'}; kind_changed=${
        kindChanges.join(',') || '<none>'
      }; host_pin_changed=${hostPinChanges.join(',') || '<none>'}`,
    );
  }
  return bySource;
}

export function assertPendingAdjudicationStates(
  occurrences: readonly SourceFindingOccurrence[],
  sourceAdjudications: readonly SourceAdjudication[],
  units: readonly Pick<IntegrationUnit, 'id' | 'state'>[],
): void {
  const adjudicationsById = new Map(
    sourceAdjudications.map((adjudication) => [adjudication.id, adjudication]),
  );
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  for (const occurrence of occurrences) {
    const sourceAdjudication = adjudicationsById.get(
      occurrence.adjudication.source_adjudication_id,
    );
    if (!sourceAdjudication) {
      throw new Error(
        `${occurrence.source_ref} names unknown source adjudication ${occurrence.adjudication.source_adjudication_id}`,
      );
    }
    if (
      occurrence.adjudication.status === 'PENDING' &&
      BLOCKED_BY_PENDING_FINDING_STATES.has(sourceAdjudication.status)
    ) {
      throw new Error(
        `${sourceAdjudication.id} cannot be ${sourceAdjudication.status} while ${occurrence.source_ref} awaits adjudication`,
      );
    }

    const targetUnitId = occurrence.adjudication.target_integration_unit_id;
    if (targetUnitId !== null) {
      const unit = unitsById.get(targetUnitId);
      if (!unit) {
        throw new Error(`${occurrence.source_ref} names unknown target unit ${targetUnitId}`);
      }
      if (
        occurrence.adjudication.status === 'PENDING' &&
        BLOCKED_BY_PENDING_FINDING_STATES.has(unit.state)
      ) {
        throw new Error(
          `${unit.id} cannot be ${unit.state} while ${occurrence.source_ref} awaits adjudication`,
        );
      }
    }
  }
}

function validateArtifactEnvelope(
  inventory: FindingInventoryManifest,
  artifactRaw: string,
  occurrences: readonly SourceFindingOccurrence[],
): void {
  if (sha256(artifactRaw) !== inventory.artifact_sha256) {
    throw new Error('source finding artifact SHA-256 differs from the manifest');
  }
  if (occurrences.length !== inventory.occurrence_count) {
    throw new Error('source finding artifact row count differs from the manifest');
  }
  if (
    sourceRefDigest(occurrences.map((occurrence) => occurrence.source_ref)) !==
    inventory.occurrence_sha256
  ) {
    throw new Error('source finding occurrence-set digest differs from the manifest');
  }
  if (artifactText(occurrences) !== artifactRaw) {
    throw new Error('source finding artifact is not in canonical sorted JSONL form');
  }
  const orderedSourceRefs = [...occurrences]
    .sort(
      (left, right) =>
        compareText(left.source_id, right.source_id) || compareText(left.raw_id, right.raw_id),
    )
    .map((occurrence) => occurrence.source_ref);
  if (
    stableJson(occurrences.map((occurrence) => occurrence.source_ref)) !==
    stableJson(orderedSourceRefs)
  ) {
    throw new Error('source finding artifact rows are not sorted by source_id and raw_id');
  }
  assertJsonEqual(inventory.audit_lineage, auditLineage(), 'finding_inventory.audit_lineage');
  assertJsonEqual(
    inventory.discovery_contract,
    discoveryContract(),
    'finding_inventory.discovery_contract',
  );
  if (inventory.assignment_contract !== ASSIGNMENT_CONTRACT) {
    throw new Error('finding_inventory.assignment_contract differs from the queue/target SSoT');
  }
}

function assertOccurrenceIntrinsicShape(occurrence: SourceFindingOccurrence): void {
  if (occurrence.source_ref !== `${occurrence.source_id}#${occurrence.raw_id}`) {
    throw new Error(`${occurrence.source_ref} is not the canonical source-qualified raw ID`);
  }
  if (
    extractRawFindingIds(occurrence.raw_id).length !== 1 ||
    extractRawFindingIds(occurrence.raw_id)[0] !== occurrence.raw_id
  ) {
    throw new Error(`${occurrence.source_ref} does not preserve one valid raw finding ID`);
  }
  if (occurrence.occurrence_id !== occurrenceId(occurrence.source_ref)) {
    throw new Error(`${occurrence.source_ref} has a non-deterministic occurrence_id`);
  }
  if (
    occurrence.classification === 'ID_COLLISION' &&
    (occurrence.canonical_id !== null ||
      occurrence.adjudication.target_integration_unit_id !== null)
  ) {
    throw new Error(
      `${occurrence.source_ref} collision cannot claim a canonical ID or capability target`,
    );
  }
}

function validateInternalContract(
  manifest: ParsedManifest,
  artifactRaw: string,
  occurrences: readonly SourceFindingOccurrence[],
  scope: InventoryScope | null,
): void {
  const inventory = manifest.findingInventory;
  if (!inventory) {
    throw new Error('capability_reconciliation.finding_inventory is missing');
  }
  validateArtifactEnvelope(inventory, artifactRaw, occurrences);
  assertJsonEqual(
    inventory.generation_attestation,
    generationAttestation(manifest, inventory.generation_attestation.host_source_state),
    'finding_inventory.generation_attestation',
  );

  assertUnique(
    occurrences.map((occurrence) => occurrence.occurrence_id),
    'source finding occurrence IDs',
  );
  assertUnique(
    occurrences.map((occurrence) => occurrence.source_ref),
    'source finding source refs',
  );
  assertUnique(
    manifest.sources.map((source) => source.id),
    'manifest source IDs',
  );
  assertUnique(
    manifest.units.map((unit) => unit.id),
    'manifest integration unit IDs',
  );
  assertUnique(
    manifest.sourceAdjudications.map((adjudication) => adjudication.id),
    'manifest source adjudication IDs',
  );
  const sourceIds = new Set(manifest.sources.map((source) => source.id));
  const adjudicationsBySource = sourceAdjudicationsBySource(manifest.sourceAdjudications);
  const adjudicationsById = new Map(
    manifest.sourceAdjudications.map((adjudication) => [adjudication.id, adjudication]),
  );
  for (const source of manifest.sources) {
    requireSourceAdjudication(adjudicationsBySource, source.id);
  }
  for (const adjudication of manifest.sourceAdjudications) {
    if (!sourceIds.has(adjudication.sourceId)) {
      throw new Error(`${adjudication.id} names unknown source ${adjudication.sourceId}`);
    }
  }
  if (manifest.sourceAdjudications.length !== manifest.sources.length) {
    throw new Error('every source must have exactly one source-adjudication queue');
  }
  assertPendingAdjudicationStates(occurrences, manifest.sourceAdjudications, manifest.units);
  for (const occurrence of occurrences) {
    assertOccurrenceIntrinsicShape(occurrence);
    if (!sourceIds.has(occurrence.source_id)) {
      throw new Error(`${occurrence.source_ref} names an unknown source`);
    }
    const sourceAdjudication = adjudicationsById.get(
      occurrence.adjudication.source_adjudication_id,
    );
    if (!sourceAdjudication || sourceAdjudication.sourceId !== occurrence.source_id) {
      throw new Error(`${occurrence.source_ref} does not reference its source-adjudication queue`);
    }
  }
  assertOccurrenceAssignments(occurrences, manifest.units);

  const pinnedSourceAttestations = sourceAttestationsBySource(
    inventory.source_attestations,
    manifest.sources,
  );
  assertJsonEqual(
    inventory.source_attestations,
    buildSourceAttestations(
      manifest.sources,
      manifest.sourceAdjudications,
      occurrences,
      manifest.reconciledBaseSha,
      (source) => {
        const pinned = pinnedSourceAttestations.get(source.id);
        if (!pinned) {
          throw new Error(`${source.id} lost its pinned source attestation`);
        }
        return pinned.merge_base_sha;
      },
    ),
    'finding_inventory static source_attestations',
  );
  if (scope !== null) {
    const liveSources = manifest.sources.filter(
      (source) => scope === 'full' || source.kind === 'REMOTE_BRANCH',
    );
    const liveSourceIds = new Set(liveSources.map((source) => source.id));
    assertJsonEqual(
      inventory.source_attestations.filter((attestation) =>
        liveSourceIds.has(attestation.source_id),
      ),
      buildSourceAttestations(
        liveSources,
        manifest.sourceAdjudications,
        occurrences,
        manifest.reconciledBaseSha,
      ),
      `finding_inventory ${scope} live source_attestations`,
    );
  }
  assertJsonEqual(
    inventory.unit_attestations,
    buildUnitAttestations(manifest.units, occurrences),
    'finding_inventory.unit_attestations',
  );
  const allocationPolicy = requireRecord(
    manifest.reconciliation.finding_allocation_policy,
    'capability_reconciliation.finding_allocation_policy',
  );
  if (allocationPolicy.allocator !== 'tools/gates/finding-registry.ts') {
    throw new Error(
      'finding_allocation_policy.allocator must name the canonical tools/gates/finding-registry.ts',
    );
  }
  assertJsonEqual(
    allocationPolicy.reserved_domain_floors,
    deriveReservedDomainFloors(occurrences),
    'finding_allocation_policy.reserved_domain_floors',
  );
}

function assertCanonicalUtcInstant(value: string, field: string): void {
  const epoch = Date.parse(value);
  const normalized = Number.isFinite(epoch)
    ? new Date(epoch).toISOString().replace(/\.000Z$/, 'Z')
    : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || normalized !== value) {
    throw new Error(`${field} must be a canonical UTC instant`);
  }
}

function validateStoredRegistryAuthorityTopology(authority: RegistryAuthority): void {
  const expectedRegistryBlobs = [
    ...new Set([
      authority.reconciled_base.registry_blob_sha,
      authority.discovery_candidate.registry_blob_sha,
    ]),
  ].sort(compareText);
  const actualRegistryBlobs = authority.registry_snapshots.map((snapshot) => snapshot.blob_sha);
  assertUnique(actualRegistryBlobs, 'stored registry snapshot blob IDs');
  if (stableJson(actualRegistryBlobs) !== stableJson(expectedRegistryBlobs)) {
    throw new Error('stored registry snapshots differ from authority coordinates');
  }

  const expectedSchemaBlobs = [
    ...new Set([
      authority.reconciled_base.schema_blob_sha,
      authority.discovery_candidate.schema_blob_sha,
    ]),
  ].sort(compareText);
  const actualSchemaBlobs = authority.schema_snapshots.map((snapshot) => snapshot.blob_sha);
  assertUnique(actualSchemaBlobs, 'stored registry schema snapshot blob IDs');
  if (stableJson(actualSchemaBlobs) !== stableJson(expectedSchemaBlobs)) {
    throw new Error('stored registry schema snapshots differ from authority coordinates');
  }
}

function validatePriorAttestedContract(
  inventory: FindingInventoryManifest,
  artifactRaw: string,
  occurrences: readonly SourceFindingOccurrence[],
): void {
  validateArtifactEnvelope(inventory, artifactRaw, occurrences);
  assertCanonicalUtcInstant(
    inventory.generation_attestation.reconciled_at,
    'prior finding_inventory.generation_attestation.reconciled_at',
  );
  assertJsonEqual(
    inventory.generation_attestation,
    generationAttestationAt(
      inventory.generation_attestation.reconciled_at,
      inventory.generation_attestation.host_source_state,
    ),
    'prior finding_inventory.generation_attestation',
  );
  validateStoredRegistryAuthorityTopology(inventory.registry_authority);
  assertUnique(
    occurrences.map((occurrence) => occurrence.occurrence_id),
    'prior source finding occurrence IDs',
  );
  assertUnique(
    occurrences.map((occurrence) => occurrence.source_ref),
    'prior source finding source refs',
  );
  assertUnique(
    inventory.source_attestations.map((attestation) => attestation.source_id),
    'prior source attestation IDs',
  );
  assertUnique(
    inventory.unit_attestations.map((attestation) => attestation.integration_unit_id),
    'prior unit attestation IDs',
  );

  const sourceAttestationsById = new Map(
    inventory.source_attestations.map((attestation) => [attestation.source_id, attestation]),
  );
  const unitAttestationIds = new Set(
    inventory.unit_attestations.map((attestation) => attestation.integration_unit_id),
  );
  for (const attestation of inventory.source_attestations) {
    if (
      (attestation.source_kind === 'DIRTY_WORKTREE') !==
      (attestation.source_content_sha256 !== null)
    ) {
      throw new Error(
        `${attestation.source_id} prior source kind contradicts its content attestation`,
      );
    }
    if (attestation.source_adjudication_id !== `SA-${attestation.source_id}`) {
      throw new Error(
        `${attestation.source_id} prior source adjudication is not deterministically named`,
      );
    }
  }
  for (const occurrence of occurrences) {
    assertOccurrenceIntrinsicShape(occurrence);
    const sourceAttestation = sourceAttestationsById.get(occurrence.source_id);
    if (!sourceAttestation) {
      throw new Error(`${occurrence.source_ref} has no prior source attestation`);
    }
    if (
      occurrence.adjudication.source_adjudication_id !== sourceAttestation.source_adjudication_id
    ) {
      throw new Error(
        `${occurrence.source_ref} differs from its prior source-adjudication attestation`,
      );
    }
    const targetUnitId = occurrence.adjudication.target_integration_unit_id;
    if (targetUnitId !== null && !unitAttestationIds.has(targetUnitId)) {
      throw new Error(
        `${occurrence.source_ref} names unattested prior target integration unit ${targetUnitId}`,
      );
    }
  }

  const expectedSourceAttestations = [...inventory.source_attestations]
    .sort((left, right) => compareText(left.source_id, right.source_id))
    .map((attestation) => ({
      source_id: attestation.source_id,
      source_kind: attestation.source_kind,
      source_head_sha: attestation.source_head_sha,
      source_content_sha256: attestation.source_content_sha256,
      merge_base_sha: attestation.merge_base_sha,
      source_adjudication_id: attestation.source_adjudication_id,
      ...sourceOccurrenceAttestation(attestation.source_id, occurrences),
    }));
  assertJsonEqual(
    inventory.source_attestations,
    expectedSourceAttestations,
    'prior finding_inventory.source_attestations',
  );
  assertJsonEqual(
    inventory.unit_attestations,
    buildUnitAttestations(
      inventory.unit_attestations.map((attestation) => ({
        id: attestation.integration_unit_id,
      })),
      occurrences,
    ),
    'prior finding_inventory.unit_attestations',
  );
}

export function assertStoredFindingInventoryIntegrity(
  artifactRaw: string,
  inventoryValue: unknown,
): SourceFindingOccurrence[] {
  const inventory = parseFindingInventory(inventoryValue);
  if (!inventory) {
    throw new Error('stored finding inventory integrity requires an attestation');
  }
  const occurrences = parseArtifact(artifactRaw, inventory.artifact_path);
  validatePriorAttestedContract(inventory, artifactRaw, occurrences);
  return occurrences;
}

function validateRegistryAuthority(
  manifest: ParsedManifest,
  discoveryRegistryBlobSha: string,
  discoveryRegistrySchemaBlobSha: string,
): void {
  const expected = registryAuthorityAttestation(
    manifest.reconciledBaseSha,
    discoveryRegistryBlobSha,
    discoveryRegistrySchemaBlobSha,
  );
  assertJsonEqual(
    manifest.findingInventory?.registry_authority,
    expected,
    'finding_inventory.registry_authority',
  );
}

function validateStoredRegistryAuthority(manifest: ParsedManifest): void {
  const inventory = manifest.findingInventory;
  if (!inventory) {
    throw new Error('stored registry authority requires a finding inventory');
  }
  validateRegistryAuthority(
    manifest,
    inventory.registry_authority.discovery_candidate.registry_blob_sha,
    inventory.registry_authority.discovery_candidate.schema_blob_sha,
  );
}

export function assertLegacyFindingRefsResolvable(
  units: readonly Pick<IntegrationUnit, 'id' | 'legacyFindingRefs'>[],
  occurrenceRefs: ReadonlySet<string>,
): void {
  const missing: string[] = [];
  for (const unit of units) {
    for (const sourceRef of unit.legacyFindingRefs) {
      if (!occurrenceRefs.has(sourceRef)) {
        missing.push(`${unit.id}:${sourceRef}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `legacy finding provenance disappeared and cannot be pruned automatically: ${missing
        .sort()
        .join(
          ', ',
        )}; record an explicit dated/owned adjudication and update the binding intentionally`,
    );
  }
}

interface SourceInventoryInputSnapshot {
  manifestText: string;
  prettierConfigText: string;
  packageLockText: string;
  artifactPath: string | null;
  artifactText: string | null;
  governedArtifacts: ArtifactSnapshot[];
  legacyArtifactText: string | null;
}

interface ArtifactSnapshot {
  path: string;
  text: string;
}

interface PublicationFence {
  candidate: DiscoveryCandidatePin;
  liveMain: LiveMainPin;
  manifest: ParsedManifest;
  scope: InventoryScope;
}

function artifactAbsolutePath(artifactPath: string): string {
  if (artifactPath !== LEGACY_ARTIFACT_PATH && !ARTIFACT_PATH_PATTERN.test(artifactPath)) {
    throw new Error(`unsafe source-finding artifact path: ${artifactPath}`);
  }
  return join(REPO_ROOT, artifactPath);
}

function governedArtifactSnapshots(): ArtifactSnapshot[] {
  const planDirectory = join(REPO_ROOT, PLAN_DIRECTORY);
  return readdirSync(planDirectory, { withFileTypes: true })
    .filter((entry) => ARTIFACT_FILENAME_PATTERN.test(entry.name))
    .map((entry) => {
      if (!entry.isFile()) {
        throw new Error(
          `governed source-finding artifact namespace contains a non-regular entry: ${entry.name}`,
        );
      }
      const relativePath = `${PLAN_DIRECTORY}/${entry.name}`;
      const content = readBoundedText(artifactAbsolutePath(relativePath), MAX_GIT_OUTPUT_BYTES);
      const nameDigest = ARTIFACT_FILENAME_PATTERN.exec(entry.name)?.groups?.sha256;
      if (nameDigest !== sha256(content)) {
        throw new Error(
          `governed source-finding artifact ${relativePath} does not match its content address`,
        );
      }
      return { path: relativePath, text: content };
    })
    .sort((left, right) => compareText(left.path, right.path));
}

function governedArtifactPaths(): string[] {
  return governedArtifactSnapshots().map((artifact) => artifact.path);
}

function assertExclusiveArtifactAuthority(authoritativePath: string): void {
  const governedPaths = governedArtifactPaths();
  if (
    governedPaths.length !== 1 ||
    governedPaths[0] !== authoritativePath ||
    existsSync(artifactAbsolutePath(LEGACY_ARTIFACT_PATH))
  ) {
    throw new Error(
      `source-finding artifact namespace must contain only ${authoritativePath}; observed=${
        governedPaths.join(',') || '<none>'
      }; legacy=${existsSync(artifactAbsolutePath(LEGACY_ARTIFACT_PATH))}`,
    );
  }
}

function captureInputSnapshot(
  manifestText: string,
  manifest: ParsedManifest,
  requireCommittedFormattingContract: boolean,
): SourceInventoryInputSnapshot {
  const artifactPath = manifest.findingInventory?.artifact_path ?? null;
  const governedArtifacts = governedArtifactSnapshots();
  const governedByPath = new Map(
    governedArtifacts.map((artifact) => [artifact.path, artifact.text]),
  );
  const legacyAbsolutePath = artifactAbsolutePath(LEGACY_ARTIFACT_PATH);
  const legacyArtifactText = existsSync(legacyAbsolutePath)
    ? readBoundedText(legacyAbsolutePath, MAX_GIT_OUTPUT_BYTES)
    : null;
  let artifactText: string | null = null;
  if (artifactPath === LEGACY_ARTIFACT_PATH) {
    if (legacyArtifactText === null) {
      throw new Error(`source-finding manifest names missing legacy artifact ${artifactPath}`);
    }
    artifactText = legacyArtifactText;
  } else if (artifactPath !== null) {
    artifactText = governedByPath.get(artifactPath) ?? null;
    if (artifactText === null) {
      throw new Error(`source-finding manifest names missing governed artifact ${artifactPath}`);
    }
  }
  return {
    manifestText,
    prettierConfigText: requireCommittedFormattingContract
      ? readCommittedPrettierConfigText()
      : readPrettierConfigText(),
    packageLockText: requireCommittedFormattingContract
      ? readCommittedPackageLockText()
      : readPackageLockText(),
    artifactPath,
    artifactText,
    governedArtifacts,
    legacyArtifactText,
  };
}

function assertInputSnapshotStable(
  snapshot: SourceInventoryInputSnapshot,
  allowedAdditionalGovernedPaths: ReadonlySet<string> = new Set(),
): void {
  const currentManifest = readBoundedText(join(REPO_ROOT, MANIFEST_PATH));
  if (currentManifest !== snapshot.manifestText) {
    throw new Error('source-finding manifest changed while the publication lease was held');
  }
  assertFormattingContractSnapshotStable(snapshot);
  const expectedByPath = new Map(
    snapshot.governedArtifacts.map((artifact) => [artifact.path, artifact.text]),
  );
  const currentArtifacts = governedArtifactSnapshots();
  const unexpected = currentArtifacts
    .map((artifact) => artifact.path)
    .filter((path) => !expectedByPath.has(path) && !allowedAdditionalGovernedPaths.has(path));
  const missing = [...expectedByPath.keys()].filter(
    (path) => !currentArtifacts.some((artifact) => artifact.path === path),
  );
  const changed = currentArtifacts
    .filter((artifact) => {
      const expected = expectedByPath.get(artifact.path);
      return expected !== undefined && expected !== artifact.text;
    })
    .map((artifact) => artifact.path);
  if (unexpected.length > 0 || missing.length > 0 || changed.length > 0) {
    throw new Error(
      `source-finding artifact namespace changed while the publication lease was held; unexpected=${
        unexpected.join(',') || '<none>'
      }; missing=${missing.join(',') || '<none>'}; changed=${changed.join(',') || '<none>'}`,
    );
  }
  const legacyAbsolutePath = artifactAbsolutePath(LEGACY_ARTIFACT_PATH);
  const currentLegacyText = existsSync(legacyAbsolutePath)
    ? readBoundedText(legacyAbsolutePath, MAX_GIT_OUTPUT_BYTES)
    : null;
  if (currentLegacyText !== snapshot.legacyArtifactText) {
    throw new Error('legacy source-finding artifact changed while the publication lease was held');
  }
}

async function assertIncludedSourcesStable(
  manifest: ParsedManifest,
  scope: InventoryScope,
): Promise<void> {
  const includedSources = manifest.sources.filter(
    (source) => scope === 'full' || source.kind === 'REMOTE_BRANCH',
  );
  const dirtySources = includedSources.filter(
    (source): source is SourceRecord & { kind: 'DIRTY_WORKTREE' } =>
      source.kind === 'DIRTY_WORKTREE',
  );
  const assertDirtyContentPin = async (
    source: SourceRecord & { kind: 'DIRTY_WORKTREE' },
  ): Promise<void> => {
    const observedContentSha256 = await computeDirtyContentSha256(source.locator);
    if (source.contentSha256 === null || observedContentSha256 !== source.contentSha256) {
      throw new Error(`${source.id} dirty content differs from its capability source attestation`);
    }
  };
  for (const source of includedSources) {
    assertSourceHeadPin(source);
  }
  for (const source of dirtySources) {
    await assertDirtyContentPin(source);
  }
  for (const source of includedSources) {
    assertSourceHeadPin(source);
  }
  for (const source of [...dirtySources].reverse()) {
    await assertDirtyContentPin(source);
  }
  for (const source of includedSources) {
    assertSourceHeadPin(source);
  }
}

export function assertDiscoveryCandidateStable(
  start: DiscoveryCandidatePin,
  end: DiscoveryCandidatePin,
): void {
  if (start.headSha !== end.headSha) {
    throw new Error(
      `source-finding candidate moved during discovery from ${start.headSha} to ${end.headSha}`,
    );
  }
  if (start.registryBlobSha !== end.registryBlobSha) {
    throw new Error(
      `source-finding candidate registry moved during discovery from ${start.registryBlobSha} to ${end.registryBlobSha}`,
    );
  }
  if (start.registrySchemaBlobSha !== end.registrySchemaBlobSha) {
    throw new Error(
      `source-finding candidate registry schema moved during discovery from ${start.registrySchemaBlobSha} to ${end.registrySchemaBlobSha}`,
    );
  }
}

function assertDiscoveryCandidateUnchanged(
  discoveryHeadSha: string,
  discoveryRegistryBlobSha: string,
  discoveryRegistrySchemaBlobSha: string,
  requireCommittedRegistry: boolean,
): void {
  const currentHeadSha = requireSha(
    runGit(['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim(),
    'current source-finding HEAD',
  );
  const currentRegistryBlobSha = registryBlobAtCommit(currentHeadSha);
  const currentRegistrySchemaBlobSha = effectiveRegistrySchemaBlobSha();
  assertDiscoveryCandidateStable(
    {
      headSha: discoveryHeadSha,
      registryBlobSha: discoveryRegistryBlobSha,
      registrySchemaBlobSha: discoveryRegistrySchemaBlobSha,
    },
    {
      headSha: currentHeadSha,
      registryBlobSha: currentRegistryBlobSha,
      registrySchemaBlobSha: currentRegistrySchemaBlobSha,
    },
  );
  if (requireCommittedRegistry) {
    assertFindingAuthorityCommitted();
  }
}

function fsyncParentDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readHeadIdenticalText(relativePath: string, maxBytes: number, label: string): string {
  const worktreeText = readBoundedText(join(REPO_ROOT, relativePath), maxBytes);
  const committedText = runGit(['show', `HEAD:${relativePath}`]).stdout;
  if (worktreeText !== committedText) {
    throw new Error(`source-finding publication requires ${label} to be byte-identical to HEAD`);
  }
  return worktreeText;
}

function readCommittedPrettierConfigText(): string {
  return readHeadIdenticalText(
    PRETTIER_CONFIG_PATH,
    MAX_PRETTIER_CONFIG_BYTES,
    PRETTIER_CONFIG_PATH,
  );
}

function readPrettierConfigText(): string {
  return readBoundedText(join(REPO_ROOT, PRETTIER_CONFIG_PATH), MAX_PRETTIER_CONFIG_BYTES);
}

function readCommittedPackageLockText(): string {
  return readHeadIdenticalText(PACKAGE_LOCK_PATH, MAX_PACKAGE_LOCK_BYTES, PACKAGE_LOCK_PATH);
}

function readPackageLockText(): string {
  return readBoundedText(join(REPO_ROOT, PACKAGE_LOCK_PATH), MAX_PACKAGE_LOCK_BYTES);
}

function assertFormattingContractSnapshotStable(snapshot: SourceInventoryInputSnapshot): void {
  const currentPrettierConfigText = readBoundedText(
    join(REPO_ROOT, PRETTIER_CONFIG_PATH),
    MAX_PRETTIER_CONFIG_BYTES,
  );
  const currentPackageLockText = readBoundedText(
    join(REPO_ROOT, PACKAGE_LOCK_PATH),
    MAX_PACKAGE_LOCK_BYTES,
  );
  if (
    currentPrettierConfigText !== snapshot.prettierConfigText ||
    currentPackageLockText !== snapshot.packageLockText
  ) {
    throw new Error(
      'source-finding formatting contract changed while the publication lease was held',
    );
  }
}

export function parseSourceFindingPrettierConfig(prettierConfigText: string): PrettierOptions {
  const parsed: unknown = JSON.parse(prettierConfigText);
  const config = requireRecord(parsed, PRETTIER_CONFIG_PATH);
  const unsupportedKeys = ['overrides', 'plugins'].filter((key) => Object.hasOwn(config, key));
  if (unsupportedKeys.length > 0) {
    throw new Error(
      `source-finding publication requires one hermetic global .prettierrc contract; unsupported=${unsupportedKeys.join(
        ',',
      )}`,
    );
  }
  return config as PrettierOptions;
}

export function lockedPrettierVersion(packageLockText: string): string {
  const packageLock = requireRecord(JSON.parse(packageLockText) as unknown, PACKAGE_LOCK_PATH);
  const packages = requireRecord(packageLock.packages, `${PACKAGE_LOCK_PATH}.packages`);
  const prettierPackage = requireRecord(
    packages['node_modules/prettier'],
    `${PACKAGE_LOCK_PATH}.packages[node_modules/prettier]`,
  );
  return requireString(
    prettierPackage.version,
    `${PACKAGE_LOCK_PATH}.packages[node_modules/prettier].version`,
  );
}

export function assertPrettierVersionAuthority(
  observedVersion: string,
  expectedVersion: string,
): void {
  if (observedVersion !== expectedVersion) {
    throw new Error(
      `source-finding formatter version ${observedVersion} differs from package-lock authority ${expectedVersion}`,
    );
  }
}

export function assertFormattedManifestSemantics(
  formatted: string,
  manifest: Record<string, unknown>,
): void {
  let formattedValue: unknown;
  try {
    formattedValue = JSON.parse(formatted) as unknown;
  } catch {
    throw new Error('source-finding manifest formatter produced invalid JSON');
  }
  const formattedManifest = requireRecord(
    formattedValue,
    'source-finding formatter output.formatted',
  );
  if (stableJson(formattedManifest) !== stableJson(manifest)) {
    throw new Error('source-finding manifest formatter changed manifest semantics');
  }
}

async function formatSourceFindingManifestWithConfig(
  manifest: Record<string, unknown>,
  prettierConfigText: string,
  expectedPrettierVersion: string,
): Promise<string> {
  const manifestPath = join(REPO_ROOT, MANIFEST_PATH);
  const result = spawnSync(process.execPath, ['-e', PRETTIER_FORMATTER_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      manifest,
      options: parseSourceFindingPrettierConfig(prettierConfigText),
      filepath: manifestPath,
    }),
    maxBuffer: MAX_EVIDENCE_FILE_BYTES,
    timeout: PRETTIER_FORMAT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `source-finding manifest formatting failed with status ${String(result.status)}: ${
        result.stderr.trim() || 'no stderr'
      }`,
    );
  }
  if (result.stdout.length === 0) {
    throw new Error('source-finding manifest formatting produced no output');
  }
  let outputValue: unknown;
  try {
    outputValue = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error('source-finding manifest formatter returned a non-JSON envelope');
  }
  const output = requireRecord(outputValue, 'source-finding formatter output');
  requireExactKeys(output, ['formatted', 'prettierVersion'], 'source-finding formatter output');
  const prettierVersion = requireString(
    output.prettierVersion,
    'source-finding formatter output.prettierVersion',
  );
  assertPrettierVersionAuthority(prettierVersion, expectedPrettierVersion);
  const formatted = requireString(output.formatted, 'source-finding formatter output.formatted');
  assertFormattedManifestSemantics(formatted, manifest);
  return formatted;
}

export async function formatSourceFindingManifest(
  manifest: Record<string, unknown>,
): Promise<string> {
  const packageLockText = readPackageLockText();
  return formatSourceFindingManifestWithConfig(
    manifest,
    readPrettierConfigText(),
    lockedPrettierVersion(packageLockText),
  );
}

function assertPublicationIdentityStable(fence: PublicationFence): void {
  assertDiscoveryCandidateUnchanged(
    fence.candidate.headSha,
    fence.candidate.registryBlobSha,
    fence.candidate.registrySchemaBlobSha,
    true,
  );
  assertLiveMainStable(fence.liveMain, captureLiveMainPin());
}

async function assertPublicationFenceStable(fence: PublicationFence): Promise<void> {
  assertPublicationIdentityStable(fence);
  await assertIncludedSourcesStable(fence.manifest, fence.scope);
  assertPublicationIdentityStable(fence);
}

function restoreArtifactSnapshot(snapshot: ArtifactSnapshot, lease: RegistryLockLease): void {
  const absolutePath = artifactAbsolutePath(snapshot.path);
  if (
    existsSync(absolutePath) &&
    readBoundedText(absolutePath, MAX_GIT_OUTPUT_BYTES) === snapshot.text
  ) {
    return;
  }
  atomicWriteFileWithRegistryLease(absolutePath, snapshot.text, lease);
}

function rollbackPublishedState(
  inputSnapshot: SourceInventoryInputSnapshot,
  publishedArtifactPath: string,
  lease: RegistryLockLease,
): void {
  assertRegistryLockOwned(lease);
  for (const artifact of inputSnapshot.governedArtifacts) {
    restoreArtifactSnapshot(artifact, lease);
  }
  if (inputSnapshot.legacyArtifactText !== null) {
    const legacyPath = artifactAbsolutePath(LEGACY_ARTIFACT_PATH);
    if (
      !existsSync(legacyPath) ||
      readBoundedText(legacyPath, MAX_GIT_OUTPUT_BYTES) !== inputSnapshot.legacyArtifactText
    ) {
      atomicWriteFileWithRegistryLease(legacyPath, inputSnapshot.legacyArtifactText, lease);
    }
  }
  atomicWriteFileWithRegistryLease(
    join(REPO_ROOT, MANIFEST_PATH),
    inputSnapshot.manifestText,
    lease,
  );

  const originalPaths = new Set(inputSnapshot.governedArtifacts.map((artifact) => artifact.path));
  if (!originalPaths.has(publishedArtifactPath)) {
    const publishedAbsolutePath = artifactAbsolutePath(publishedArtifactPath);
    if (existsSync(publishedAbsolutePath)) {
      assertRegistryLockOwned(lease);
      unlinkSync(publishedAbsolutePath);
      fsyncParentDirectory(join(REPO_ROOT, PLAN_DIRECTORY));
    }
  }
  assertInputSnapshotStable(inputSnapshot);
}

async function publishGeneratedState(
  manifest: ParsedManifest,
  artifact: string,
  inputSnapshot: SourceInventoryInputSnapshot,
  fence: PublicationFence,
  lease: RegistryLockLease,
): Promise<void> {
  const inventory = manifest.findingInventory;
  if (!inventory) {
    throw new Error('source-finding publication lost its generated inventory');
  }
  const nextArtifactPath = inventory.artifact_path;
  const nextArtifactAbsolutePath = artifactAbsolutePath(nextArtifactPath);
  let mutationStarted = false;
  try {
    assertInputSnapshotStable(inputSnapshot);
    assertRegistryLockOwned(lease);
    await assertPublicationFenceStable(fence);
    assertInputSnapshotStable(inputSnapshot);

    if (existsSync(nextArtifactAbsolutePath)) {
      if (readBoundedText(nextArtifactAbsolutePath, MAX_GIT_OUTPUT_BYTES) !== artifact) {
        throw new Error(
          `content-addressed source-finding artifact collision at ${nextArtifactPath}`,
        );
      }
    } else {
      mutationStarted = true;
      atomicWriteFileWithRegistryLease(nextArtifactAbsolutePath, artifact, lease);
    }

    const allowedAdditionalArtifacts = new Set([nextArtifactPath]);
    assertInputSnapshotStable(inputSnapshot, allowedAdditionalArtifacts);
    await assertPublicationFenceStable(fence);
    assertInputSnapshotStable(inputSnapshot, allowedAdditionalArtifacts);

    const nextManifest = await formatSourceFindingManifestWithConfig(
      manifest.raw,
      inputSnapshot.prettierConfigText,
      lockedPrettierVersion(inputSnapshot.packageLockText),
    );
    assertInputSnapshotStable(inputSnapshot, allowedAdditionalArtifacts);
    assertPublicationIdentityStable(fence);
    assertFormattingContractSnapshotStable(inputSnapshot);
    mutationStarted = true;
    atomicWriteFileWithRegistryLease(join(REPO_ROOT, MANIFEST_PATH), nextManifest, lease);
    assertFormattingContractSnapshotStable(inputSnapshot);
    await assertPublicationFenceStable(fence);
    assertFormattingContractSnapshotStable(inputSnapshot);

    let removedArtifact = false;
    for (const governedArtifact of inputSnapshot.governedArtifacts) {
      if (governedArtifact.path === nextArtifactPath) continue;
      assertFormattingContractSnapshotStable(inputSnapshot);
      assertPublicationIdentityStable(fence);
      assertRegistryLockOwned(lease);
      const governedAbsolutePath = artifactAbsolutePath(governedArtifact.path);
      if (readBoundedText(governedAbsolutePath, MAX_GIT_OUTPUT_BYTES) !== governedArtifact.text) {
        throw new Error(`source-finding artifact changed before cleanup: ${governedArtifact.path}`);
      }
      unlinkSync(governedAbsolutePath);
      removedArtifact = true;
    }
    if (inputSnapshot.legacyArtifactText !== null) {
      assertFormattingContractSnapshotStable(inputSnapshot);
      assertPublicationIdentityStable(fence);
      assertRegistryLockOwned(lease);
      const legacyAbsolutePath = artifactAbsolutePath(LEGACY_ARTIFACT_PATH);
      if (
        readBoundedText(legacyAbsolutePath, MAX_GIT_OUTPUT_BYTES) !==
        inputSnapshot.legacyArtifactText
      ) {
        throw new Error('legacy source-finding artifact changed before cleanup');
      }
      unlinkSync(legacyAbsolutePath);
      removedArtifact = true;
    }
    if (removedArtifact) {
      fsyncParentDirectory(join(REPO_ROOT, PLAN_DIRECTORY));
    }
    assertExclusiveArtifactAuthority(nextArtifactPath);
    assertFormattingContractSnapshotStable(inputSnapshot);
    await assertPublicationFenceStable(fence);
    assertFormattingContractSnapshotStable(inputSnapshot);
  } catch (publicationError) {
    if (!mutationStarted) {
      throw publicationError;
    }
    try {
      rollbackPublishedState(inputSnapshot, nextArtifactPath, lease);
    } catch (rollbackError) {
      throw new AggregateError(
        [
          publicationError instanceof Error
            ? publicationError
            : new Error(String(publicationError)),
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
        ],
        'Source-finding publication and rollback both failed.',
      );
    }
    throw publicationError;
  }
}

async function writeGeneratedState(
  manifest: ParsedManifest,
  occurrences: readonly SourceFindingOccurrence[],
  fence: PublicationFence,
  inputSnapshot: SourceInventoryInputSnapshot,
  lease: RegistryLockLease,
): Promise<string> {
  const occurrenceRefs = new Set(occurrences.map((occurrence) => occurrence.source_ref));
  assertLegacyFindingRefsResolvable(manifest.units, occurrenceRefs);
  const reparsed = parseManifest(manifest.raw, false);
  const rematerialized = materializeOccurrences(
    occurrences.map(
      (occurrence): DiscoveredFinding => ({
        sourceId: occurrence.source_id,
        sourceRef: occurrence.source_ref,
        rawId: occurrence.raw_id,
        evidenceKind: occurrence.evidence_kind,
        evidencePaths: occurrence.evidence_paths,
        evidenceSha256: occurrence.evidence_sha256,
        semanticSha256: occurrence.semantic_sha256,
        classification: occurrence.classification,
        mainRecordSha256: occurrence.main_record_sha256,
      }),
    ),
    reparsed.sourceAdjudications,
    reparsed.units,
  );
  const finalArtifact = artifactText(rematerialized);
  const generatedInventory = buildFindingInventoryManifest(
    reparsed,
    rematerialized,
    finalArtifact,
    fence.candidate.registryBlobSha,
    fence.candidate.registrySchemaBlobSha,
    'ISOLATED_FULL_REDISCOVERED',
    buildSourceAttestations(
      reparsed.sources,
      reparsed.sourceAdjudications,
      rematerialized,
      reparsed.reconciledBaseSha,
    ),
  );
  reparsed.reconciliation.finding_inventory = generatedInventory;
  reparsed.findingInventory = generatedInventory;
  const allocationPolicy = requireRecord(
    reparsed.reconciliation.finding_allocation_policy,
    'capability_reconciliation.finding_allocation_policy',
  );
  allocationPolicy.reserved_domain_floors = deriveReservedDomainFloors(rematerialized);
  const publishedOccurrences = parseArtifact(finalArtifact, generatedInventory.artifact_path);
  validateInternalContract(reparsed, finalArtifact, publishedOccurrences, 'full');
  validateStoredRegistryAuthority(reparsed);

  await publishGeneratedState(
    reparsed,
    finalArtifact,
    inputSnapshot,
    { ...fence, manifest: reparsed },
    lease,
  );
  return generatedInventory.artifact_path;
}

async function refreshAttestedState(
  manifest: ParsedManifest,
  occurrences: readonly SourceFindingOccurrence[],
  remoteOccurrences: readonly SourceFindingOccurrence[],
  fence: PublicationFence,
  inputSnapshot: SourceInventoryInputSnapshot,
  lease: RegistryLockLease,
): Promise<string> {
  const remoteSourceIds = new Set(
    manifest.sources.filter((source) => source.kind === 'REMOTE_BRANCH').map((source) => source.id),
  );
  const retainedHostOccurrences = occurrences
    .filter((occurrence) => !remoteSourceIds.has(occurrence.source_id))
    .map((occurrence): SourceFindingOccurrence => {
      const evidenceKind =
        occurrence.evidence_kind === 'REVIEW_MENTION' &&
        occurrence.evidence_paths.includes(REGISTRY_PATH)
          ? 'REGISTRY_REFERENCE'
          : occurrence.evidence_kind;
      const classification =
        evidenceKind === 'REGISTRY_RECORD' && occurrence.classification !== 'ID_COLLISION'
          ? 'LEGACY_UNREGISTERED'
          : occurrence.classification;
      return {
        ...occurrence,
        evidence_kind: evidenceKind,
        classification,
      };
    });
  const refreshed = [...remoteOccurrences, ...retainedHostOccurrences].sort(
    (left, right) =>
      compareText(left.source_id, right.source_id) || compareText(left.raw_id, right.raw_id),
  );
  assertLegacyFindingRefsResolvable(
    manifest.units,
    new Set(refreshed.map((occurrence) => occurrence.source_ref)),
  );
  const artifact = artifactText(refreshed);
  const inventory = manifest.findingInventory;
  if (!inventory) {
    throw new Error('host-safe refresh requires the prior finding inventory attestation');
  }
  const priorSourceAttestations = sourceAttestationsForRefresh(
    inventory.source_attestations,
    manifest.sources,
  );
  const refreshedSourceAttestations = buildSourceAttestations(
    manifest.sources,
    manifest.sourceAdjudications,
    refreshed,
    manifest.reconciledBaseSha,
    (source, reconciledBaseSha) => {
      if (source.kind === 'REMOTE_BRANCH') {
        return mergeBase(source.headSha, reconciledBaseSha);
      }
      const prior = priorSourceAttestations.get(source.id);
      if (!prior) {
        throw new Error(`${source.id} lost its prior host-source attestation`);
      }
      return prior.merge_base_sha;
    },
  );
  const generatedInventory = buildFindingInventoryManifest(
    manifest,
    refreshed,
    artifact,
    fence.candidate.registryBlobSha,
    fence.candidate.registrySchemaBlobSha,
    'RETAINED_PENDING_ISOLATED_REDISCOVERY',
    refreshedSourceAttestations,
  );
  manifest.reconciliation.finding_inventory = generatedInventory;
  manifest.findingInventory = generatedInventory;
  const allocationPolicy = requireRecord(
    manifest.reconciliation.finding_allocation_policy,
    'capability_reconciliation.finding_allocation_policy',
  );
  allocationPolicy.reserved_domain_floors = deriveReservedDomainFloors(refreshed);
  const publishedOccurrences = parseArtifact(artifact, generatedInventory.artifact_path);
  validateInternalContract(manifest, artifact, publishedOccurrences, 'remote');
  validateStoredRegistryAuthority(manifest);
  await publishGeneratedState(manifest, artifact, inputSnapshot, fence, lease);
  return generatedInventory.artifact_path;
}

function assertFindingAuthorityCommitted(): void {
  const mutableAuthorityPaths = [REGISTRY_PATH, REGISTRY_SCHEMA_PATH];
  const status = runGit(
    ['diff', '--quiet', 'HEAD', '--', ...mutableAuthorityPaths],
    REPO_ROOT,
    [0, 1],
  ).status;
  if (status !== 0) {
    throw new Error(
      `${mutableAuthorityPaths.join(
        ' and ',
      )} must be committed before source-finding publication so canonical finding identities and parsing semantics are immutable`,
    );
  }
}

function sourceInventoryLockPath(): string {
  const authority = resolveGitFindingAllocationAuthority(REPO_ROOT);
  // Publication derives identity floors and source semantics from every
  // active worktree. An unfenced legacy writer can move those inputs without
  // observing this lease, so publication and canonical registry mutation must
  // share the same writer-protocol preflight.
  authority.assertCompatibleWriters();
  return authority.lockPath;
}

function isSourceInventoryGovernedBasename(basename: string): boolean {
  return (
    basename === 'manifest.json' ||
    basename === 'source-findings.jsonl' ||
    ARTIFACT_FILENAME_PATTERN.test(basename)
  );
}

async function executeWithSnapshot(
  options: CliOptions,
  lease: RegistryLockLease | null,
): Promise<void> {
  const planDirectory = join(REPO_ROOT, PLAN_DIRECTORY);
  if (lease) {
    recoverAtomicWriteStagingFiles(
      planDirectory,
      isSourceInventoryGovernedBasename,
      lease,
      SOURCE_INVENTORY_STAGING_STALE_MS,
    );
  } else {
    const stagingFiles = listAtomicWriteStagingFiles(
      planDirectory,
      isSourceInventoryGovernedBasename,
    );
    if (stagingFiles.length > 0) {
      throw new Error(
        `source-finding validation found unpublished atomic staging files: ${stagingFiles.join(
          ',',
        )}`,
      );
    }
  }
  const manifestText = readBoundedText(join(REPO_ROOT, MANIFEST_PATH));
  const manifestRaw: unknown = JSON.parse(manifestText);
  const manifest = parseManifest(manifestRaw, true);
  const inputSnapshot = captureInputSnapshot(manifestText, manifest, options.mode !== 'check');
  let priorOccurrences: SourceFindingOccurrence[] | null = null;
  let priorInventory: FindingInventoryManifest | null = null;
  if (options.mode !== 'check') {
    if (!lease) {
      throw new Error('source-finding writers require the repository-common publication lease');
    }
    assertFindingAuthorityCommitted();
    if (
      manifest.findingInventory !== undefined &&
      inputSnapshot.artifactPath !== null &&
      inputSnapshot.artifactText !== null
    ) {
      if (options.mode === 'refresh') {
        priorInventory = manifest.findingInventory;
        priorOccurrences = assertStoredFindingInventoryIntegrity(
          inputSnapshot.artifactText,
          manifest.reconciliation.finding_inventory,
        );
      } else {
        priorOccurrences = parseArtifact(inputSnapshot.artifactText, inputSnapshot.artifactPath);
        validateInternalContract(manifest, inputSnapshot.artifactText, priorOccurrences, null);
      }
      validateStoredRegistryAuthority(manifest);
    }
  }
  const liveMainStart = captureLiveMainPin();
  assertExecutionMainCompatibility(manifest, options, liveMainStart);

  if (options.mode === 'refresh') {
    if (
      inputSnapshot.artifactPath === null ||
      inputSnapshot.artifactText === null ||
      priorOccurrences === null ||
      priorInventory === null ||
      !lease
    ) {
      throw new Error('host-safe refresh requires a locked prior source-finding artifact');
    }
    const remoteDiscovery = await discover(manifest, 'remote');
    assertDiscoveryCandidateUnchanged(
      remoteDiscovery.discoveryHeadSha,
      remoteDiscovery.discoveryRegistryBlobSha,
      remoteDiscovery.discoveryRegistrySchemaBlobSha,
      true,
    );
    assertLiveMainStable(liveMainStart, captureLiveMainPin());
    const remoteOccurrences = materializeOccurrences(
      remoteDiscovery.findings,
      manifest.sourceAdjudications,
      manifest.units,
    );
    const canonicalEvidenceById = new Map(
      [...registryAtBlob(remoteDiscovery.discoveryRegistryBlobSha).snapshot.byId.entries()].map(
        ([findingId, record]) => [
          findingId,
          {
            semanticSha256: registrySemanticSha256(record),
            state: requireString(record.value.state, `${findingId} canonical finding state`),
          },
        ],
      ),
    );
    const canonicalRebinds = assertRefreshAssignmentTransition(
      priorOccurrences,
      manifest.units,
      canonicalEvidenceById,
      {
        priorArtifactSha256: priorInventory.artifact_sha256,
        priorSourceHeadShaById: new Map(
          priorInventory.source_attestations.map((attestation) => [
            attestation.source_id,
            attestation.source_head_sha,
          ]),
        ),
        candidateRegistryBlobSha: remoteDiscovery.discoveryRegistryBlobSha,
      },
    );
    assertCanonicalRebindsRetiredByRemoteDiscovery(
      canonicalRebinds,
      remoteOccurrences,
      new Set(
        manifest.sources
          .filter((source) => source.kind === 'REMOTE_BRANCH')
          .map((source) => source.id),
      ),
    );
    const artifactPath = await refreshAttestedState(
      manifest,
      priorOccurrences,
      remoteOccurrences,
      {
        candidate: {
          headSha: remoteDiscovery.discoveryHeadSha,
          registryBlobSha: remoteDiscovery.discoveryRegistryBlobSha,
          registrySchemaBlobSha: remoteDiscovery.discoveryRegistrySchemaBlobSha,
        },
        liveMain: liveMainStart,
        manifest,
        scope: 'remote',
      },
      inputSnapshot,
      lease,
    );
    process.stdout.write(`Refreshed static source finding attestations at ${artifactPath}.\n`);
    return;
  }

  const discovery = await discover(manifest, options.scope);
  assertDiscoveryCandidateUnchanged(
    discovery.discoveryHeadSha,
    discovery.discoveryRegistryBlobSha,
    discovery.discoveryRegistrySchemaBlobSha,
    options.mode === 'write',
  );
  const liveMainEnd = captureLiveMainPin();
  if (
    options.mode === 'check' &&
    options.scope === 'remote' &&
    process.env.GITHUB_ACTIONS === 'true'
  ) {
    assertExecutionMainCompatibility(manifest, options, liveMainEnd);
  } else {
    assertLiveMainStable(liveMainStart, liveMainEnd);
  }

  if (options.mode === 'write') {
    const occurrences = materializeOccurrences(
      discovery.findings,
      manifest.sourceAdjudications,
      manifest.units,
    );
    if (!lease) {
      throw new Error('full source-finding generation lost its publication lease');
    }
    const artifactPath = await writeGeneratedState(
      manifest,
      occurrences,
      {
        candidate: {
          headSha: discovery.discoveryHeadSha,
          registryBlobSha: discovery.discoveryRegistryBlobSha,
          registrySchemaBlobSha: discovery.discoveryRegistrySchemaBlobSha,
        },
        liveMain: liveMainStart,
        manifest,
        scope: 'full',
      },
      inputSnapshot,
      lease,
    );
    process.stdout.write(
      `Wrote ${occurrences.length} source finding occurrences to ${artifactPath}.\n`,
    );
    return;
  }

  if (inputSnapshot.artifactPath === null || inputSnapshot.artifactText === null) {
    throw new Error('source-finding validation requires the attested artifact');
  }
  const artifactRaw = inputSnapshot.artifactText;
  const artifactOccurrences = parseArtifact(artifactRaw, inputSnapshot.artifactPath);
  validateInternalContract(manifest, artifactRaw, artifactOccurrences, options.scope);
  assertExclusiveArtifactAuthority(inputSnapshot.artifactPath);
  if (
    options.scope === 'full' &&
    manifest.findingInventory?.generation_attestation.host_source_state !==
      'ISOLATED_FULL_REDISCOVERED'
  ) {
    throw new Error(
      'full validation requires an ISOLATED_FULL_REDISCOVERED host-source attestation',
    );
  }
  validateRegistryAuthority(
    manifest,
    discovery.discoveryRegistryBlobSha,
    discovery.discoveryRegistrySchemaBlobSha,
  );
  const includedSourceIds = new Set(
    manifest.sources
      .filter((source) => options.scope === 'full' || source.kind === 'REMOTE_BRANCH')
      .map((source) => source.id),
  );
  const expected = materializeOccurrences(
    discovery.findings,
    manifest.sourceAdjudications,
    manifest.units,
  );
  const actual = artifactOccurrences.filter((occurrence) =>
    includedSourceIds.has(occurrence.source_id),
  );
  if (artifactText(actual) !== artifactText(expected)) {
    const expectedByRef = new Map(
      expected.map((occurrence) => [occurrence.source_ref, occurrence]),
    );
    const actualByRef = new Map(actual.map((occurrence) => [occurrence.source_ref, occurrence]));
    const missing = [...expectedByRef.keys()].filter((sourceRef) => !actualByRef.has(sourceRef));
    const extra = [...actualByRef.keys()].filter((sourceRef) => !expectedByRef.has(sourceRef));
    const changed = [...expectedByRef.keys()].filter((sourceRef) => {
      const actualOccurrence = actualByRef.get(sourceRef);
      return (
        actualOccurrence !== undefined &&
        stableJson(expectedByRef.get(sourceRef)) !== stableJson(actualOccurrence)
      );
    });
    throw new Error(
      `${options.scope} source finding evidence differs from ${inputSnapshot.artifactPath}; missing=${
        missing.slice(0, 20).join(',') || '<none>'
      }; extra=${extra.slice(0, 20).join(',') || '<none>'}; changed=${
        changed.slice(0, 20).join(',') || '<none>'
      }; run the full generator only in the bounded isolated evidence runner`,
    );
  }
  await assertIncludedSourcesStable(manifest, options.scope);
  assertDiscoveryCandidateUnchanged(
    discovery.discoveryHeadSha,
    discovery.discoveryRegistryBlobSha,
    discovery.discoveryRegistrySchemaBlobSha,
    false,
  );
  const finalLiveMain = captureLiveMainPin();
  if (options.scope === 'remote' && process.env.GITHUB_ACTIONS === 'true') {
    assertExecutionMainCompatibility(manifest, options, finalLiveMain);
  } else {
    assertLiveMainStable(liveMainStart, finalLiveMain);
  }
  process.stdout.write(
    `Source finding inventory verified (${options.scope}, ${actual.length} live-attested rows, ${artifactOccurrences.length} total rows).\n`,
  );
}

async function execute(options: CliOptions): Promise<void> {
  assertExecutionSafety(
    options,
    options.scope === 'full' && options.mode !== 'refresh'
      ? captureFullExecutionSafetyEvidence()
      : undefined,
  );
  if (options.mode === 'check') {
    await executeWithSnapshot(options, null);
    return;
  }
  const manifestAbsolutePath = join(REPO_ROOT, MANIFEST_PATH);
  await withRegistryFileLockAsync(
    manifestAbsolutePath,
    async (lease) => executeWithSnapshot(options, lease),
    {
      lockPath: sourceInventoryLockPath(),
      timeoutMs: 30_000,
      staleAfterMs: 5 * 60_000,
      pollIntervalMs: 50,
    },
  );
}

if (require.main === module) {
  execute(parseCliOptions(process.argv.slice(2))).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`source-finding-inventory: validation failed: ${message}\n`);
    process.exit(1);
  });
}
