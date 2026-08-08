#!/usr/bin/env ts-node
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  computeCanonicalGitWorktreeEvidence,
  HERMETIC_GIT_RUNTIME,
  InventoryInspectionError,
} from './lib/hermetic-git-runtime';
import {
  REGISTERED_COMMON_DIR_LOCATOR_SCHEMA,
  WORKTREE_OWNER_CLASSES,
  discoverRegisteredCommonDirs,
  type RegisteredCommonDirLocatorV1,
  type WorktreeOwnerClassV1,
  type WorktreeCoordinate,
} from './lib/registered-common-dir-discovery';
import {
  SOURCE_INVENTORY_SCHEMA_V2,
  SOURCE_DISPOSITIONS,
  SOURCE_KINDS,
  SOURCE_ROLES,
  SOURCE_STATES,
  isSourceDisposition,
  isSourceState,
  isWorktreeSourceKind,
  type SourceDisposition,
  type SourceKind,
  type SourceRole,
  type SourceState,
} from './lib/capability-source-contract';
import { REPO_ROOT } from './lib/repo-root';

export { InventoryInspectionError } from './lib/hermetic-git-runtime';
export {
  SOURCE_INVENTORY_SCHEMA_V2,
  SOURCE_DISPOSITIONS,
  SOURCE_KINDS,
  SOURCE_ROLES,
  SOURCE_STATES,
  type SourceDisposition,
  type SourceKind,
  type SourceRole,
  type SourceState,
} from './lib/capability-source-contract';

const MANIFEST_PATH = 'docs/plans/2026-06-18-enterprise-grade-debt-closure/manifest.json';
const MAIN_REF = 'refs/remotes/origin/main';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const SOURCE_INVENTORY_RUNNER_PROFILE =
  'REPOSITORY_OWNED_INDEPENDENT_COMMON_DIR_V1' as const;
export const TRUSTED_REMOTE_INVENTORY_WORKFLOW =
  'Okan-wqm/aquaculture_platform/.github/workflows/ci-full.yml' as const;
export const TRUSTED_REMOTE_INVENTORY_JOB = 'deploy-ssot-gates' as const;
const SOURCE_KIND_ORDER: Readonly<Record<SourceKind, number>> = {
  REMOTE_BRANCH: 0,
  LOCAL_BRANCH: 1,
  CLEAN_WORKTREE: 2,
  DIRTY_WORKTREE: 3,
};

export type InventoryScope = 'full' | 'remote';
export type InventoryCliMode = 'static' | 'live';

export interface BranchSourceCoordinate {
  kind: 'REMOTE_BRANCH' | 'LOCAL_BRANCH';
  locator: string;
  headSha: string;
  role: Exclude<SourceRole, 'WORKTREE_PRESERVATION' | 'UNKNOWN'>;
}

export type UnclassifiedBranchSourceCoordinate = Omit<BranchSourceCoordinate, 'role'>;

interface WorktreeSourceCoordinate {
  kind: 'CLEAN_WORKTREE' | 'DIRTY_WORKTREE';
  locator: string;
  headSha: string;
  role: 'CAPABILITY_CANDIDATE' | 'WORKTREE_PRESERVATION';
  repositoryId: string;
  ownerClass: WorktreeOwnerClassV1;
  statusSha256: string;
  contentSha256: string;
}

export type SourceCoordinate = BranchSourceCoordinate | WorktreeSourceCoordinate;

export interface InventoryCliOptions {
  mode: InventoryCliMode;
  scope: InventoryScope;
}

export interface AncestorMainProof {
  kind: 'ANCESTOR';
  sourceCommitSha: string;
}

export interface TreeEquivalentMainProof {
  kind: 'TREE_EQUIVALENT';
  sourceCommitSha: string;
  sourceTreeSha: string;
  mainCommitSha: string;
  mainTreeSha: string;
}

export type MainProof = AncestorMainProof | TreeEquivalentMainProof;

interface ManifestSourceGovernance {
  id: string;
  state: SourceState;
  disposition: SourceDisposition;
  mainProof?: MainProof;
}

type ManifestBranchSourceCoordinate = Omit<BranchSourceCoordinate, 'role'> &
  ManifestSourceGovernance & {
    role: BranchSourceCoordinate['role'] | null;
  };

type ManifestWorktreeSourceCoordinate = Omit<
  WorktreeSourceCoordinate,
  'role' | 'repositoryId' | 'ownerClass' | 'statusSha256'
> &
  ManifestSourceGovernance & {
    role: WorktreeSourceCoordinate['role'] | null;
    repositoryId: string | null;
    ownerClass: WorktreeOwnerClassV1 | null;
    statusSha256: string | null;
  };

export type ManifestSourceCoordinate =
  | ManifestBranchSourceCoordinate
  | ManifestWorktreeSourceCoordinate;

export interface InventoryManifest {
  schemaVersion: 1 | 2;
  reconciledBaseSha: string;
  sources: ManifestSourceCoordinate[];
}

export interface RefCoordinate {
  locator: string;
  headSha: string;
}

export interface InspectedWorktree extends WorktreeCoordinate {
  dirty: boolean;
  repositoryId: string;
  ownerClass: WorktreeOwnerClassV1;
  statusSha256: string;
  contentSha256: string;
}

export interface ExecutionExclusionProofV1 {
  kind: 'INDEPENDENT_CLEAN_INVENTORY_RUNNER_V1';
  committed: true;
  clean: true;
}

export interface ExecutionIdentity {
  worktreePath: string;
  headSha: string;
  branchRef: string | null;
  originRef: string | null;
  exclusionProof: ExecutionExclusionProofV1 | null;
}

export interface ExecutionExclusionAdmissionInputV1 {
  identity: ExecutionIdentity;
  scope: InventoryScope;
  githubActions: string | undefined;
  workflowRef: string | undefined;
  jobId: string | undefined;
  localRunnerProfile: string | undefined;
  checkoutHeadSha: string;
  checkoutDirty: boolean;
  executionCommonDir: string;
  governedCommonDirs: readonly string[];
}

export interface GitHubActionsIdentityInput {
  githubActions: string | undefined;
  eventName: string | undefined;
  headRef: string | undefined;
  currentRef: string | undefined;
  currentSha: string | undefined;
  remoteRefs: readonly RefCoordinate[];
  worktreePath: string;
  isValidHeadRef: (headRef: string) => boolean;
}

export interface DiscoveryInput {
  mainSha: string;
  remoteRefs: readonly RefCoordinate[];
  localRefs: readonly RefCoordinate[];
  worktrees: readonly InspectedWorktree[];
  executionIdentity: ExecutionIdentity | null;
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean;
  classifyBranchSourceRole: (source: UnclassifiedBranchSourceCoordinate) => SourceRole;
  isReachableFromRemote?: (headSha: string) => boolean;
}

export interface SourceRoleClassificationInput {
  mainSha: string;
  sourceHeadSha: string;
  executionHeadSha: string | null;
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean;
  mergeBase: (leftSha: string, rightSha: string) => string;
  changedPaths: (baseSha: string, headSha: string) => readonly string[];
}

const INVENTORY_GOVERNANCE_ARTIFACT =
  /^docs\/plans\/2026-06-18-enterprise-grade-debt-closure\/source-findings\.[0-9a-f]{64}\.jsonl$/;
const INVENTORY_GOVERNANCE_PATHS = new Set([
  'docs/plans/2026-06-18-enterprise-grade-debt-closure/manifest.json',
  'tests/invariants/enterprise-grade-debt-plan-contract.spec.ts',
  'tests/invariants/source-finding-inventory-contract.spec.ts',
  'tools/gates/source-finding-inventory.ts',
]);
const PLAN_GOVERNANCE_DOCUMENT =
  'docs/plans/2026-07-30-enterprise-backup-restore-architecture/PLAN.md';
const PLAN_GOVERNANCE_PATHS = new Set([
  '.github/workflows/ci-affected.yml',
  PLAN_GOVERNANCE_DOCUMENT,
  'scripts/ci/markdownlint-changed.mjs',
  'tools/quality/format-scope.json',
]);

function isInventoryGovernancePath(path: string): boolean {
  return INVENTORY_GOVERNANCE_PATHS.has(path) || INVENTORY_GOVERNANCE_ARTIFACT.test(path);
}

function normalizeChangedPaths(paths: readonly string[]): string[] | null {
  const normalized = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  return normalized.length > 0 &&
    normalized.every((path) => path.length > 0 && !path.startsWith('/'))
    ? normalized
    : null;
}

function classifyChangedPathRole(
  changedPaths: readonly string[],
  inventoryGovernanceAllowed: boolean,
): SourceRole {
  if (changedPaths.some(isInventoryGovernancePath)) {
    return inventoryGovernanceAllowed && changedPaths.every(isInventoryGovernancePath)
      ? 'INVENTORY_GOVERNANCE'
      : 'CAPABILITY_CANDIDATE';
  }
  if (changedPaths.includes(PLAN_GOVERNANCE_DOCUMENT)) {
    return changedPaths.every((path) => PLAN_GOVERNANCE_PATHS.has(path))
      ? 'PLAN_GOVERNANCE'
      : 'CAPABILITY_CANDIDATE';
  }
  return 'CAPABILITY_CANDIDATE';
}

/**
 * Classifies branch purpose from governed paths and graph ancestry, never from a mutable branch
 * name. Governance branches are omitted from the capability inventory only when their complete
 * delta is inside one closed authority surface. Mixed deltas remain capability candidates, which
 * preserves them in both inventory and finding discovery; only malformed or ancestry-invalid
 * observations fail closed as UNKNOWN.
 */
export function classifySourceRole(input: SourceRoleClassificationInput): SourceRole {
  const mainSha = requireSha(input.mainSha, 'source-role main SHA');
  const sourceHeadSha = requireSha(input.sourceHeadSha, 'source-role head SHA');
  const executionHeadSha =
    input.executionHeadSha === null
      ? null
      : requireSha(input.executionHeadSha, 'source-role execution SHA');

  if (
    executionHeadSha !== null &&
    executionHeadSha !== sourceHeadSha &&
    input.isAncestor(executionHeadSha, sourceHeadSha)
  ) {
    const executionDelta = normalizeChangedPaths(
      input.changedPaths(executionHeadSha, sourceHeadSha),
    );
    return executionDelta === null ? 'UNKNOWN' : classifyChangedPathRole(executionDelta, true);
  }

  const commonBase = requireSha(
    input.mergeBase(mainSha, sourceHeadSha),
    'source-role merge-base SHA',
  );
  if (!input.isAncestor(commonBase, mainSha) || !input.isAncestor(commonBase, sourceHeadSha)) {
    return 'UNKNOWN';
  }
  const branchDelta = normalizeChangedPaths(input.changedPaths(commonBase, sourceHeadSha));
  if (branchDelta === null) {
    return 'UNKNOWN';
  }

  return classifyChangedPathRole(branchDelta, false);
}

export interface LiveInventory {
  mainSha: string;
  sources: SourceCoordinate[];
  observedRefs: RefCoordinate[];
}

export type InventoryDriftCode =
  | 'DUPLICATE_MANIFEST_LOCATOR'
  | 'DUPLICATE_LIVE_LOCATOR'
  | 'RECONCILED_BASE_NOT_ANCESTOR'
  | 'SOURCE_KIND_DRIFT'
  | 'SOURCE_HEAD_DRIFT'
  | 'SOURCE_ROLE_DRIFT'
  | 'SOURCE_REPOSITORY_DRIFT'
  | 'SOURCE_OWNER_DRIFT'
  | 'SOURCE_STATUS_DRIFT'
  | 'SOURCE_CONTENT_DRIFT'
  | 'SOURCE_MAIN_PROOF_INVALID'
  | 'SOURCE_UNDECLARED'
  | 'SOURCE_NO_LONGER_LIVE';

export interface InventoryDrift {
  code: InventoryDriftCode;
  message: string;
}

interface RawManifestSource {
  id: string;
  kind: SourceKind;
  locator: string;
  head_sha: string;
  role?: SourceRole;
  repository_id?: string;
  owner_class?: WorktreeOwnerClassV1;
  status_sha256?: string;
  content_sha256?: string;
  state: SourceState;
  disposition: SourceDisposition;
  main_proof?: MainProof;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireSha(value: unknown, field: string): string {
  const sha = requireString(value, field);
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${field} must be a lowercase 40-character Git SHA`);
  }
  return sha;
}

function requireSha256(value: unknown, field: string): string {
  const sha256 = requireString(value, field);
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`${field} must be a lowercase 64-character SHA-256 digest`);
  }
  return sha256;
}

function requireSourceKind(value: unknown, field: string): SourceKind {
  if (!SOURCE_KINDS.includes(value as SourceKind)) {
    throw new Error(
      `${field} must be REMOTE_BRANCH, LOCAL_BRANCH, CLEAN_WORKTREE, or DIRTY_WORKTREE`,
    );
  }
  return value as SourceKind;
}

function requireSourceRole(value: unknown, field: string): SourceRole {
  if (!SOURCE_ROLES.includes(value as SourceRole) || value === 'UNKNOWN') {
    throw new Error(`${field} must be one explicit non-UNKNOWN source role`);
  }
  return value as SourceRole;
}

function requireRepositoryId(value: unknown, field: string): string {
  const repositoryId = requireString(value, field);
  if (!REPOSITORY_ID_PATTERN.test(repositoryId)) {
    throw new Error(`${field} must be one stable lowercase repository identifier`);
  }
  return repositoryId;
}

function requireWorktreeOwnerClass(value: unknown, field: string): WorktreeOwnerClassV1 {
  if (!WORKTREE_OWNER_CLASSES.includes(value as WorktreeOwnerClassV1)) {
    throw new Error(`${field} must be one closed worktree owner class`);
  }
  return value as WorktreeOwnerClassV1;
}

function isWorktreeKind(kind: SourceKind): kind is WorktreeSourceCoordinate['kind'] {
  return isWorktreeSourceKind(kind);
}

function isWorktreeSource(source: SourceCoordinate): source is WorktreeSourceCoordinate {
  return isWorktreeKind(source.kind);
}

function isManifestWorktreeSource(
  source: ManifestSourceCoordinate,
): source is ManifestWorktreeSourceCoordinate {
  return isWorktreeKind(source.kind);
}

type StrictManifestWorktreeSourceCoordinate = ManifestWorktreeSourceCoordinate & {
  role: WorktreeSourceCoordinate['role'];
  repositoryId: string;
  ownerClass: WorktreeOwnerClassV1;
  statusSha256: string;
};

function isStrictManifestWorktreeSource(
  source: ManifestSourceCoordinate,
): source is StrictManifestWorktreeSourceCoordinate {
  return (
    isManifestWorktreeSource(source) &&
    source.role !== null &&
    source.repositoryId !== null &&
    source.ownerClass !== null &&
    source.statusSha256 !== null
  );
}

function requireSourceState(value: unknown, field: string): SourceState {
  if (!isSourceState(value)) {
    throw new Error(`${field} must be one of ${SOURCE_STATES.join(', ')}`);
  }
  return value;
}

function requireSourceDisposition(value: unknown, field: string): SourceDisposition {
  if (!isSourceDisposition(value)) {
    throw new Error(`${field} must be one of ${SOURCE_DISPOSITIONS.join(', ')}`);
  }
  return value;
}

function isTerminalSourceState(state: SourceState): boolean {
  return state === 'SUPERSEDED' || state === 'INTEGRATED';
}

function requireRecordArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${field} must be an object array`);
  }
  return value;
}

function compareSources(left: SourceCoordinate, right: SourceCoordinate): number {
  return (
    SOURCE_KIND_ORDER[left.kind] - SOURCE_KIND_ORDER[right.kind] ||
    left.locator.localeCompare(right.locator) ||
    left.headSha.localeCompare(right.headSha)
  );
}

function isOriginMainAlias(locator: string): boolean {
  return locator === MAIN_REF || locator === 'refs/remotes/origin/HEAD';
}

function parseMainProof(
  value: unknown,
  field: string,
  sourceKind: SourceKind,
  sourceHeadSha: string,
  disposition: SourceDisposition,
): MainProof | undefined {
  if (disposition !== 'ALREADY_ON_MAIN') {
    if (value !== undefined) {
      throw new Error(`${field} is allowed only for disposition ALREADY_ON_MAIN`);
    }
    return undefined;
  }
  if (sourceKind !== 'REMOTE_BRANCH') {
    throw new Error(
      `${field} is allowed only for a REMOTE_BRANCH source with disposition ALREADY_ON_MAIN`,
    );
  }
  if (!isRecord(value)) {
    throw new Error(`${field} is required for disposition ALREADY_ON_MAIN`);
  }

  const sourceCommitSha = requireSha(value.source_commit_sha, `${field}.source_commit_sha`);
  if (sourceCommitSha !== sourceHeadSha) {
    throw new Error(`${field}.source_commit_sha must equal source head_sha`);
  }
  if (value.kind === 'ANCESTOR') {
    return {
      kind: value.kind,
      sourceCommitSha,
    };
  }
  if (value.kind === 'TREE_EQUIVALENT') {
    return {
      kind: value.kind,
      sourceCommitSha,
      sourceTreeSha: requireSha(value.source_tree_sha, `${field}.source_tree_sha`),
      mainCommitSha: requireSha(value.main_commit_sha, `${field}.main_commit_sha`),
      mainTreeSha: requireSha(value.main_tree_sha, `${field}.main_tree_sha`),
    };
  }
  throw new Error(`${field}.kind must be ANCESTOR or TREE_EQUIVALENT`);
}

function parseRawManifestSource(
  source: Record<string, unknown>,
  index: number,
  schemaVersion: 1 | 2,
): RawManifestSource {
  const field = `capability_reconciliation.sources[${index}]`;
  const kind = requireSourceKind(source.kind, `${field}.kind`);
  const locator = requireString(source.locator, `${field}.locator`);
  const state = requireSourceState(source.state, `${field}.state`);
  const disposition = requireSourceDisposition(source.disposition, `${field}.disposition`);
  const headSha = requireSha(source.head_sha, `${field}.head_sha`);
  const role = schemaVersion === 2 ? requireSourceRole(source.role, `${field}.role`) : undefined;
  if (schemaVersion === 1) {
    if (source.role !== undefined) {
      throw new Error(`${field}.role requires source_inventory_schema v2`);
    }
    if (kind === 'CLEAN_WORKTREE') {
      throw new Error(`${field}.kind CLEAN_WORKTREE requires source_inventory_schema v2`);
    }
    for (const migratedField of ['repository_id', 'owner_class', 'status_sha256'] as const) {
      if (source[migratedField] !== undefined) {
        throw new Error(`${field}.${migratedField} requires source_inventory_schema v2`);
      }
    }
  }
  const contentSha256 = isWorktreeKind(kind)
    ? requireSha256(source.content_sha256, `${field}.content_sha256`)
    : undefined;

  if (schemaVersion === 2 && isWorktreeKind(kind)) {
    const expectedRole =
      kind === 'CLEAN_WORKTREE' ? 'WORKTREE_PRESERVATION' : 'CAPABILITY_CANDIDATE';
    if (role !== expectedRole) {
      throw new Error(`${field}.role must be ${expectedRole} for ${kind}`);
    }
  } else if (schemaVersion === 2 && role === 'WORKTREE_PRESERVATION') {
    throw new Error(`${field}.role WORKTREE_PRESERVATION is allowed only for a worktree`);
  }

  if (kind === 'REMOTE_BRANCH' && !locator.startsWith('refs/remotes/origin/')) {
    throw new Error(`${field}.locator must be an origin remote ref`);
  }
  if (kind === 'LOCAL_BRANCH' && !locator.startsWith('refs/heads/')) {
    throw new Error(`${field}.locator must be a local branch ref`);
  }
  if (isWorktreeKind(kind) && !isAbsolute(locator)) {
    throw new Error(`${field}.locator must be an absolute worktree path`);
  }
  if (source.retirement !== undefined) {
    throw new Error(
      `${field}.retirement is forbidden: source retirement remains fail-closed until a durable governed preservation authority exists`,
    );
  }

  return {
    id: requireString(source.id, `${field}.id`),
    kind,
    locator,
    head_sha: headSha,
    ...(role !== undefined ? { role } : {}),
    ...(isWorktreeKind(kind) ? { content_sha256: contentSha256 } : {}),
    ...(schemaVersion === 2 && isWorktreeKind(kind)
      ? {
          repository_id: requireRepositoryId(source.repository_id, `${field}.repository_id`),
          owner_class: requireWorktreeOwnerClass(source.owner_class, `${field}.owner_class`),
          status_sha256: requireSha256(source.status_sha256, `${field}.status_sha256`),
        }
      : {}),
    state,
    disposition,
    main_proof: parseMainProof(
      source.main_proof,
      `${field}.main_proof`,
      kind,
      headSha,
      disposition,
    ),
  };
}

export function parseInventoryManifest(raw: unknown): InventoryManifest {
  if (!isRecord(raw)) {
    throw new Error('manifest must be a JSON object');
  }
  if (!isRecord(raw.capability_reconciliation)) {
    throw new Error('manifest.capability_reconciliation must be an object');
  }

  const reconciliation = raw.capability_reconciliation;
  const schemaVersion: 1 | 2 =
    reconciliation.source_inventory_schema === undefined
      ? 1
      : reconciliation.source_inventory_schema === SOURCE_INVENTORY_SCHEMA_V2
        ? 2
        : (() => {
            throw new Error(
              `capability_reconciliation.source_inventory_schema must be ${SOURCE_INVENTORY_SCHEMA_V2}`,
            );
          })();
  if (schemaVersion === 2 && reconciliation.source_retirement_policy !== undefined) {
    throw new Error(
      'capability_reconciliation.source_retirement_policy is forbidden in source inventory v2',
    );
  }
  const sources = requireRecordArray(
    reconciliation.sources,
    'capability_reconciliation.sources',
  ).map((source, index) => parseRawManifestSource(source, index, schemaVersion));
  const duplicateIds = sources
    .map((source) => source.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  const duplicateLocators = sources
    .map((source) => source.locator)
    .filter((locator, index, locators) => locators.indexOf(locator) !== index);
  if (duplicateIds.length > 0 || duplicateLocators.length > 0) {
    throw new Error(
      `capability_reconciliation.sources must have unique IDs and locators; duplicate_ids=${[
        ...new Set(duplicateIds),
      ]
        .sort()
        .join(',')}; duplicate_locators=${[...new Set(duplicateLocators)].sort().join(',')}`,
    );
  }

  return {
    schemaVersion,
    reconciledBaseSha: requireSha(
      reconciliation.reconciled_base_sha,
      'capability_reconciliation.reconciled_base_sha',
    ),
    sources: sources.map((source): ManifestSourceCoordinate => {
      const governance = {
        id: source.id,
        state: source.state,
        disposition: source.disposition,
        ...(source.main_proof ? { mainProof: source.main_proof } : {}),
      };
      if (isWorktreeKind(source.kind)) {
        if (!source.content_sha256) {
          throw new Error(
            `capability_reconciliation source ${source.id} lost its worktree content digest`,
          );
        }
        if (
          schemaVersion === 2 &&
          (!source.repository_id || !source.owner_class || !source.status_sha256 || !source.role)
        ) {
          throw new Error(
            `capability_reconciliation source ${source.id} lost its v2 authority fields`,
          );
        }
        return {
          ...governance,
          kind: source.kind,
          locator: source.locator,
          headSha: source.head_sha,
          role: (source.role ?? null) as WorktreeSourceCoordinate['role'] | null,
          repositoryId: source.repository_id ?? null,
          ownerClass: source.owner_class ?? null,
          statusSha256: source.status_sha256 ?? null,
          contentSha256: source.content_sha256,
        };
      }
      return {
        ...governance,
        kind: source.kind,
        locator: source.locator,
        headSha: source.head_sha,
        role: (source.role ?? null) as BranchSourceCoordinate['role'] | null,
      };
    }),
  };
}

export function parseRefList(raw: string): RefCoordinate[] {
  const refs: RefCoordinate[] = [];

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf('\t');
    if (separator <= 0 || line.indexOf('\t', separator + 1) !== -1) {
      throw new Error(`git ref record ${index + 1} is malformed`);
    }
    const locator = line.slice(0, separator);
    const headSha = line.slice(separator + 1);
    refs.push({
      locator: requireString(locator, `git ref record ${index + 1}.locator`),
      headSha: requireSha(headSha, `git ref record ${index + 1}.head`),
    });
  }

  return refs;
}

export function discoverInventory(
  input: DiscoveryInput,
  scope: InventoryScope = 'full',
): LiveInventory {
  requireSha(input.mainSha, 'live main SHA');

  const sources: SourceCoordinate[] = [];
  const remoteRefs = [...input.remoteRefs].sort((left, right) =>
    left.locator.localeCompare(right.locator),
  );
  const isExecutionRef = (ref: RefCoordinate): boolean =>
    input.executionIdentity !== null &&
    ref.headSha === input.executionIdentity.headSha &&
    ((input.executionIdentity.branchRef !== null &&
      ref.locator === input.executionIdentity.branchRef) ||
      (input.executionIdentity.originRef !== null &&
        ref.locator === input.executionIdentity.originRef));
  const admitBranchSource = (source: UnclassifiedBranchSourceCoordinate): void => {
    const role = input.classifyBranchSourceRole(source);
    if (!SOURCE_ROLES.includes(role)) {
      throw new Error(`source-role classifier returned an unsupported role for ${source.locator}`);
    }
    if (role === 'UNKNOWN') {
      throw new Error(
        `source-role classifier could not safely classify ${source.locator} at ${source.headSha}`,
      );
    }
    if (role === 'WORKTREE_PRESERVATION') {
      throw new Error(`branch source ${source.locator} cannot have a worktree-only role`);
    }
    if (
      isExecutionRef(source) &&
      input.executionIdentity?.exclusionProof !== null &&
      role === 'INVENTORY_GOVERNANCE'
    ) {
      return;
    }
    sources.push({ ...source, role });
  };

  for (const remote of remoteRefs) {
    if (isOriginMainAlias(remote.locator)) {
      continue;
    }
    if (!remote.locator.startsWith('refs/remotes/origin/')) {
      throw new Error(`unexpected non-origin remote ref: ${remote.locator}`);
    }
    if (!input.isAncestor(remote.headSha, input.mainSha)) {
      admitBranchSource({
        kind: 'REMOTE_BRANCH',
        locator: remote.locator,
        headSha: remote.headSha,
      });
    }
  }

  if (scope === 'full') {
    const remoteContains = (headSha: string): boolean => {
      if (input.isReachableFromRemote) {
        return input.isReachableFromRemote(headSha);
      }
      return remoteRefs.some((remote) => input.isAncestor(headSha, remote.headSha));
    };

    for (const local of input.localRefs) {
      if (local.locator === 'refs/heads/main') {
        continue;
      }
      if (!local.locator.startsWith('refs/heads/')) {
        throw new Error(`unexpected non-local branch ref: ${local.locator}`);
      }
      if (!input.isAncestor(local.headSha, input.mainSha) && !remoteContains(local.headSha)) {
        admitBranchSource({
          kind: 'LOCAL_BRANCH',
          locator: local.locator,
          headSha: local.headSha,
        });
      }
    }

    for (const worktree of input.worktrees) {
      const contentSha256 = requireSha256(
        worktree.contentSha256,
        `worktree ${worktree.path}.contentSha256`,
      );
      const statusSha256 = requireSha256(
        worktree.statusSha256,
        `worktree ${worktree.path}.statusSha256`,
      );
      sources.push({
        kind: worktree.dirty ? 'DIRTY_WORKTREE' : 'CLEAN_WORKTREE',
        locator: worktree.path,
        headSha: worktree.headSha,
        role: worktree.dirty ? 'CAPABILITY_CANDIDATE' : 'WORKTREE_PRESERVATION',
        repositoryId: requireRepositoryId(
          worktree.repositoryId,
          `worktree ${worktree.path}.repositoryId`,
        ),
        ownerClass: requireWorktreeOwnerClass(
          worktree.ownerClass,
          `worktree ${worktree.path}.ownerClass`,
        ),
        statusSha256,
        contentSha256,
      });
    }
  }

  return {
    mainSha: input.mainSha,
    sources: sources.sort(compareSources),
    observedRefs: [...remoteRefs, ...(scope === 'full' ? input.localRefs : [])].sort(
      (left, right) =>
        left.locator.localeCompare(right.locator) || left.headSha.localeCompare(right.headSha),
    ),
  };
}

function groupedByLocator<T extends { locator: string }>(sources: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const source of sources) {
    const entries = grouped.get(source.locator) ?? [];
    entries.push(source);
    grouped.set(source.locator, entries);
  }
  return grouped;
}

function sourcesForScope<T extends { kind: SourceKind }>(
  sources: readonly T[],
  scope: InventoryScope,
): T[] {
  return scope === 'full'
    ? [...sources]
    : sources.filter((source) => source.kind === 'REMOTE_BRANCH');
}

export function compareInventory(
  manifest: InventoryManifest,
  live: LiveInventory,
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean,
  scope: InventoryScope = 'full',
): InventoryDrift[] {
  const drifts: InventoryDrift[] = [];
  const manifestGroups = groupedByLocator(sourcesForScope(manifest.sources, scope));
  const liveGroups = groupedByLocator(sourcesForScope(live.sources, scope));

  for (const [locator, sources] of [...manifestGroups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (sources.length > 1) {
      drifts.push({
        code: 'DUPLICATE_MANIFEST_LOCATOR',
        message: `manifest locator ${locator} is declared by ${sources
          .map((source) => source.id)
          .sort()
          .join(', ')}`,
      });
    }
  }
  for (const [locator, sources] of [...liveGroups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (sources.length > 1) {
      drifts.push({
        code: 'DUPLICATE_LIVE_LOCATOR',
        message: `live locator ${locator} was discovered ${sources.length} times`,
      });
    }
  }

  if (!isAncestor(manifest.reconciledBaseSha, live.mainSha)) {
    drifts.push({
      code: 'RECONCILED_BASE_NOT_ANCESTOR',
      message: `manifest reconciled base ${manifest.reconciledBaseSha} is not an ancestor of live ${MAIN_REF} ${live.mainSha}`,
    });
  }

  const sharedLocators = [...manifestGroups.keys()]
    .filter((locator) => liveGroups.has(locator))
    .sort();
  for (const locator of sharedLocators) {
    const expected = manifestGroups.get(locator)?.[0];
    const actual = liveGroups.get(locator)?.[0];
    if (!expected || !actual) {
      throw new Error(`inventory comparison lost shared locator ${locator}`);
    }
    if (expected.kind !== actual.kind) {
      drifts.push({
        code: 'SOURCE_KIND_DRIFT',
        message: `${locator} changed kind from ${expected.kind} to ${actual.kind}`,
      });
    }
    if (expected.headSha !== actual.headSha) {
      drifts.push({
        code: 'SOURCE_HEAD_DRIFT',
        message: `${locator} changed head from ${expected.headSha} to ${actual.headSha}`,
      });
    }
    if (manifest.schemaVersion === 2 && expected.role !== actual.role) {
      drifts.push({
        code: 'SOURCE_ROLE_DRIFT',
        message: `${locator} changed role from ${expected.role} to ${actual.role}`,
      });
    }
    if (
      manifest.schemaVersion === 2 &&
      isManifestWorktreeSource(expected) &&
      !isStrictManifestWorktreeSource(expected)
    ) {
      throw new Error(`${locator} lost strict v2 worktree authority fields`);
    }
    if (
      manifest.schemaVersion === 2 &&
      isStrictManifestWorktreeSource(expected) &&
      isWorktreeSource(actual)
    ) {
      if (expected.repositoryId !== actual.repositoryId) {
        drifts.push({
          code: 'SOURCE_REPOSITORY_DRIFT',
          message: `${locator} changed repository from ${expected.repositoryId} to ${actual.repositoryId}`,
        });
      }
      if (expected.ownerClass !== actual.ownerClass) {
        drifts.push({
          code: 'SOURCE_OWNER_DRIFT',
          message: `${locator} changed owner from ${expected.ownerClass} to ${actual.ownerClass}`,
        });
      }
      if (expected.statusSha256 !== actual.statusSha256) {
        drifts.push({
          code: 'SOURCE_STATUS_DRIFT',
          message: `${locator} changed status from ${expected.statusSha256} to ${actual.statusSha256}`,
        });
      }
      if (expected.contentSha256 !== actual.contentSha256) {
        drifts.push({
          code: 'SOURCE_CONTENT_DRIFT',
          message: `${locator} changed content from ${expected.contentSha256} to ${actual.contentSha256}`,
        });
      }
    }
  }

  for (const locator of [...liveGroups.keys()]
    .filter((candidate) => !manifestGroups.has(candidate))
    .sort()) {
    const actual = liveGroups.get(locator)?.[0];
    if (!actual) {
      throw new Error(`inventory comparison lost live locator ${locator}`);
    }
    drifts.push({
      code: 'SOURCE_UNDECLARED',
      message: `${actual.kind} ${locator} at ${actual.headSha} is absent from the manifest`,
    });
  }

  for (const locator of [...manifestGroups.keys()]
    .filter((candidate) => !liveGroups.has(candidate))
    .sort()) {
    const expected = manifestGroups.get(locator)?.[0];
    if (!expected) {
      throw new Error(`inventory comparison lost manifest locator ${locator}`);
    }
    if (expected.kind === 'REMOTE_BRANCH' || expected.kind === 'LOCAL_BRANCH') {
      const observed = live.observedRefs.find((ref) => ref.locator === locator);
      if (observed && observed.headSha !== expected.headSha) {
        drifts.push({
          code: 'SOURCE_HEAD_DRIFT',
          message: `${locator} changed head from ${expected.headSha} to ${observed.headSha}`,
        });
        continue;
      }
      if (observed && isTerminalSourceState(expected.state)) {
        continue;
      }
    }
    drifts.push({
      code: 'SOURCE_NO_LONGER_LIVE',
      message: `${expected.id} ${expected.kind} ${locator} at ${expected.headSha} is no longer an unmerged or dirty source`,
    });
  }

  return drifts;
}

export function validateMainProofs(
  manifest: InventoryManifest,
  liveMainSha: string,
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean,
  resolveTreeSha: (commitSha: string) => string | null,
  validationMode: 'LIVE_ANCESTRY' | 'COMMITTED_OBJECTS' = 'LIVE_ANCESTRY',
): InventoryDrift[] {
  requireSha(liveMainSha, 'live main SHA');
  const drifts: InventoryDrift[] = [];

  for (const source of [...manifest.sources].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const reasons: string[] = [];
    if (source.disposition !== 'ALREADY_ON_MAIN') {
      if (source.mainProof) {
        reasons.push('main proof is present without disposition ALREADY_ON_MAIN');
      }
    } else if (source.kind !== 'REMOTE_BRANCH') {
      reasons.push('only REMOTE_BRANCH may declare an already-main proof');
    } else if (!source.mainProof) {
      reasons.push('disposition ALREADY_ON_MAIN requires main proof');
    } else if (source.mainProof.sourceCommitSha !== source.headSha) {
      reasons.push('proof source commit differs from source head');
    } else if (source.mainProof.kind === 'ANCESTOR') {
      try {
        if (validationMode === 'COMMITTED_OBJECTS') {
          const sourceTree = resolveTreeSha(source.mainProof.sourceCommitSha);
          if (sourceTree === null || !SHA_PATTERN.test(sourceTree)) {
            reasons.push('legacy ancestor source commit does not resolve to a commit tree');
          }
        } else if (!isAncestor(source.mainProof.sourceCommitSha, liveMainSha)) {
          reasons.push('source commit is not an ancestor of live main');
        }
      } catch (error) {
        reasons.push(
          `source ancestry could not be verified: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      let actualSourceTree: string | null = null;
      let actualMainTree: string | null = null;
      try {
        actualSourceTree = resolveTreeSha(source.mainProof.sourceCommitSha);
      } catch (error) {
        reasons.push(
          `source commit tree could not be resolved: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      try {
        actualMainTree = resolveTreeSha(source.mainProof.mainCommitSha);
      } catch (error) {
        reasons.push(
          `main commit tree could not be resolved: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (actualSourceTree === null) {
        reasons.push('source commit does not resolve to a commit tree');
      } else if (
        !SHA_PATTERN.test(actualSourceTree) ||
        actualSourceTree !== source.mainProof.sourceTreeSha
      ) {
        reasons.push('claimed source tree differs from the source commit tree');
      }
      if (actualMainTree === null) {
        reasons.push('main commit does not resolve to a commit tree');
      } else if (
        !SHA_PATTERN.test(actualMainTree) ||
        actualMainTree !== source.mainProof.mainTreeSha
      ) {
        reasons.push('claimed main tree differs from the main commit tree');
      }
      if (source.mainProof.sourceTreeSha !== source.mainProof.mainTreeSha) {
        reasons.push('claimed source and main trees differ');
      }
      if (
        actualSourceTree !== null &&
        actualMainTree !== null &&
        actualSourceTree !== actualMainTree
      ) {
        reasons.push('resolved source and main trees differ');
      }
      try {
        if (!isAncestor(source.mainProof.mainCommitSha, liveMainSha)) {
          reasons.push('proof main commit is not an ancestor of live main');
        }
      } catch (error) {
        reasons.push(
          `main ancestry could not be verified: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (reasons.length > 0) {
      drifts.push({
        code: 'SOURCE_MAIN_PROOF_INVALID',
        message: `${source.id} ${source.locator}: ${reasons.join('; ')}`,
      });
    }
  }

  return drifts;
}

interface GitTextResult {
  stdout: string;
  status: number;
}

function runGit(
  args: readonly string[],
  acceptedStatuses: readonly number[] = [0],
  worktreePath: string = REPO_ROOT,
): GitTextResult {
  const result = HERMETIC_GIT_RUNTIME.runText(worktreePath, args, acceptedStatuses);
  return { stdout: result.stdout, status: result.status };
}

function gitIsAncestor(ancestorSha: string, descendantSha: string): boolean {
  return runGit(['merge-base', '--is-ancestor', ancestorSha, descendantSha], [0, 1]).status === 0;
}

function gitMergeBase(leftSha: string, rightSha: string): string {
  return requireSha(
    runGit(['merge-base', leftSha, rightSha]).stdout.trim(),
    `merge-base(${leftSha}, ${rightSha})`,
  );
}

function gitChangedPaths(baseSha: string, headSha: string): string[] {
  const raw = runGit(['diff', '--name-only', '--no-renames', '-z', baseSha, headSha, '--']).stdout;
  if (raw.length === 0) {
    return [];
  }
  if (!raw.endsWith('\0')) {
    throw new Error(`git diff path stream for ${baseSha}..${headSha} is not NUL-terminated`);
  }
  return raw.slice(0, -1).split('\0');
}

function gitResolveCommitTreeSha(commitSha: string): string | null {
  const commit = runGit(['rev-parse', '--verify', '--quiet', `${commitSha}^{commit}`], [0, 1]);
  if (commit.status === 1) {
    return null;
  }
  return requireSha(
    runGit(['rev-parse', '--verify', `${commitSha}^{tree}`]).stdout.trim(),
    `${commitSha} tree`,
  );
}

function gitRemoteContains(headSha: string): boolean {
  const refs = parseRefList(
    runGit([
      'for-each-ref',
      `--contains=${headSha}`,
      '--format=%(refname)%09%(objectname)',
      'refs/remotes/origin',
    ]).stdout,
  );
  return refs.length > 0;
}

export function resolveGitHubActionsExecutionIdentity(
  input: GitHubActionsIdentityInput,
): ExecutionIdentity | null {
  if (input.githubActions !== 'true') {
    return null;
  }
  if (!input.eventName) {
    throw new InventoryInspectionError(
      'CI_EXECUTION_IDENTITY_INVALID',
      'GITHUB_EVENT_NAME is required when GITHUB_ACTIONS=true',
    );
  }

  const headRef = input.headRef ?? '';
  if (input.eventName !== 'pull_request') {
    if (
      headRef.length > 0 ||
      (input.currentRef ?? '').length > 0 ||
      (input.currentSha ?? '').length > 0
    ) {
      throw new InventoryInspectionError(
        'CI_EXECUTION_IDENTITY_MISMATCH',
        `pull-request execution identity is set for ${input.eventName}`,
      );
    }
    return null;
  }
  if (
    headRef.length === 0 ||
    headRef.trim() !== headRef ||
    headRef.startsWith('refs/') ||
    !input.isValidHeadRef(headRef)
  ) {
    throw new InventoryInspectionError(
      'CI_EXECUTION_IDENTITY_INVALID',
      'GITHUB_HEAD_REF is not a valid short Git branch name',
    );
  }
  const currentRef = input.currentRef ?? '';
  const currentSha = input.currentSha ?? '';
  if (currentRef !== headRef) {
    throw new InventoryInspectionError(
      'CI_EXECUTION_IDENTITY_MISMATCH',
      'CAPABILITY_INVENTORY_CURRENT_REF differs from GITHUB_HEAD_REF',
    );
  }
  if (!SHA_PATTERN.test(currentSha)) {
    throw new InventoryInspectionError(
      'CI_EXECUTION_IDENTITY_INVALID',
      'CAPABILITY_INVENTORY_CURRENT_SHA must be a lowercase 40-character Git SHA',
    );
  }

  const originRef = `refs/remotes/origin/${currentRef}`;
  const matchingRefs = input.remoteRefs.filter((remote) => remote.locator === originRef);
  if (matchingRefs.length === 0) {
    // Fork PR heads are not origin refs. Nothing host-local may be inferred or excluded.
    return null;
  }
  if (matchingRefs.length !== 1) {
    throw new InventoryInspectionError(
      'CI_EXECUTION_IDENTITY_MISMATCH',
      `${originRef} resolved ${matchingRefs.length} times`,
    );
  }
  const remote = matchingRefs[0];
  if (!remote) {
    throw new Error(`exact GitHub Actions ref resolution lost ${originRef}`);
  }
  if (remote.headSha !== currentSha) {
    throw new InventoryInspectionError(
      'CI_EXECUTION_IDENTITY_MISMATCH',
      `${originRef} resolved to ${remote.headSha}, expected event head ${currentSha}`,
    );
  }

  return {
    worktreePath: input.worktreePath,
    headSha: currentSha,
    branchRef: null,
    originRef,
    exclusionProof: null,
  };
}

export function selectExecutionIdentity(
  githubActions: string | undefined,
  resolveGitHubActionsIdentity: () => ExecutionIdentity | null,
  resolveLocalIdentity: () => ExecutionIdentity | null,
): ExecutionIdentity | null {
  return githubActions === 'true' ? resolveGitHubActionsIdentity() : resolveLocalIdentity();
}

export function admitExecutionExclusionProof(
  input: ExecutionExclusionAdmissionInputV1,
): ExecutionIdentity {
  const checkoutHeadSha = requireSha(input.checkoutHeadSha, 'inventory runner checkout HEAD');
  const identityHeadSha = requireSha(input.identity.headSha, 'inventory runner execution identity');
  if (checkoutHeadSha !== identityHeadSha) {
    throw new InventoryInspectionError(
      'CI_EXECUTION_IDENTITY_MISMATCH',
      `inventory runner checkout HEAD ${checkoutHeadSha} differs from execution identity ${identityHeadSha}`,
    );
  }
  if (input.checkoutDirty) return { ...input.identity, exclusionProof: null };

  const trustedHostedRunner =
    input.scope === 'remote' &&
    input.githubActions === 'true' &&
    input.jobId === TRUSTED_REMOTE_INVENTORY_JOB &&
    input.workflowRef !== undefined &&
    input.workflowRef.startsWith(`${TRUSTED_REMOTE_INVENTORY_WORKFLOW}@`) &&
    input.workflowRef.length > TRUSTED_REMOTE_INVENTORY_WORKFLOW.length + 1 &&
    !/[\0\r\n]/.test(input.workflowRef);
  const trustedRepositoryRunner =
    input.scope === 'full' &&
    input.githubActions !== 'true' &&
    input.localRunnerProfile === SOURCE_INVENTORY_RUNNER_PROFILE;

  if (!trustedHostedRunner && !trustedRepositoryRunner) {
    return { ...input.identity, exclusionProof: null };
  }
  if (
    trustedRepositoryRunner &&
    (input.governedCommonDirs.length === 0 ||
      input.governedCommonDirs.includes(input.executionCommonDir))
  ) {
    throw new InventoryInspectionError(
      'CI_EXECUTION_IDENTITY_MISMATCH',
      'full inventory runner does not have an independent Git common-dir',
    );
  }
  return {
    ...input.identity,
    exclusionProof: {
      kind: 'INDEPENDENT_CLEAN_INVENTORY_RUNNER_V1',
      committed: true,
      clean: true,
    },
  };
}

export function assertOriginMainStable(startSha: string, endSha: string): void {
  requireSha(startSha, 'origin main start SHA');
  requireSha(endSha, 'origin main end SHA');
  if (startSha !== endSha) {
    throw new InventoryInspectionError(
      'ORIGIN_MAIN_MOVED',
      `${MAIN_REF} moved from ${startSha} to ${endSha} during inventory discovery`,
    );
  }
}

function resolveOriginMain(): string {
  return requireSha(
    runGit(['rev-parse', '--verify', `${MAIN_REF}^{commit}`]).stdout.trim(),
    MAIN_REF,
  );
}

function gitIsValidHeadRef(headRef: string): boolean {
  if (headRef.startsWith('-')) {
    return false;
  }
  return runGit(['check-ref-format', `refs/heads/${headRef}`], [0, 1]).status === 0;
}

function resolveLocalExecutionIdentity(): ExecutionIdentity | null {
  const branch = runGit(['symbolic-ref', '-q', 'HEAD'], [0, 1]);
  if (branch.status === 1) {
    return null;
  }
  const branchRef = requireString(branch.stdout.trim(), 'current branch ref');
  if (!branchRef.startsWith('refs/heads/')) {
    throw new Error(`current branch is not a local branch ref: ${branchRef}`);
  }
  if (branchRef === 'refs/heads/main') {
    return null;
  }

  const headSha = requireSha(
    runGit(['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim(),
    'current HEAD',
  );
  const currentWorktreePath = realpathSync(runGit(['rev-parse', '--show-toplevel']).stdout.trim());

  return {
    worktreePath: currentWorktreePath,
    headSha,
    branchRef,
    originRef: `refs/remotes/origin/${branchRef.slice('refs/heads/'.length)}`,
    exclusionProof: null,
  };
}

function resolveExecutionIdentity(remoteRefs: readonly RefCoordinate[]): ExecutionIdentity | null {
  return selectExecutionIdentity(
    process.env.GITHUB_ACTIONS,
    () =>
      resolveGitHubActionsExecutionIdentity({
        githubActions: process.env.GITHUB_ACTIONS,
        eventName: process.env.GITHUB_EVENT_NAME,
        headRef: process.env.GITHUB_HEAD_REF,
        currentRef: process.env.CAPABILITY_INVENTORY_CURRENT_REF,
        currentSha: process.env.CAPABILITY_INVENTORY_CURRENT_SHA,
        remoteRefs,
        worktreePath: realpathSync(runGit(['rev-parse', '--show-toplevel']).stdout.trim()),
        isValidHeadRef: gitIsValidHeadRef,
      }),
    resolveLocalExecutionIdentity,
  );
}

/**
 * Compiles the only worktree locator authority directly from capability_reconciliation.sources.
 * No path-prefix owner inference or second locator manifest is permitted.
 */
export function compileRegisteredCommonDirLocators(
  manifest: InventoryManifest,
): readonly RegisteredCommonDirLocatorV1[] {
  if (manifest.schemaVersion !== 2) {
    throw new InventoryInspectionError(
      'WORKTREE_AUTHORITY_MIGRATION_REQUIRED',
      `full inventory requires ${SOURCE_INVENTORY_SCHEMA_V2}; v1 remains readable only in remote scope`,
    );
  }
  const declaredWorktrees = manifest.sources.filter(isManifestWorktreeSource);
  if (declaredWorktrees.some((source) => !isStrictManifestWorktreeSource(source))) {
    throw new Error('source inventory v2 contains an incomplete worktree authority');
  }
  const worktreeSources = declaredWorktrees.filter(isStrictManifestWorktreeSource);
  if (worktreeSources.length === 0) {
    throw new Error('full inventory requires governed worktree sources');
  }
  const byRepository = new Map<string, typeof worktreeSources>();
  for (const source of worktreeSources) {
    const entries = byRepository.get(source.repositoryId) ?? [];
    entries.push(source);
    byRepository.set(source.repositoryId, entries);
  }
  if (byRepository.size !== 1) {
    throw new Error(
      `capability source inventory requires exactly one governed repository/common-dir authority, received ${byRepository.size}`,
    );
  }

  return Object.freeze(
    [...byRepository.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([repositoryId, sources]): RegisteredCommonDirLocatorV1 => {
        const ordered = [...sources].sort((left, right) =>
          left.locator.localeCompare(right.locator),
        );
        const querySource = ordered[0];
        if (!querySource) {
          throw new Error(`repository ${repositoryId} lost its query worktree`);
        }
        const queryWorktreePath = realpathSync(querySource.locator);
        if (queryWorktreePath !== querySource.locator) {
          throw new Error(`${querySource.locator} is not one canonical governed worktree path`);
        }
        const commonDirPath = realpathSync(
          runGit(
            ['rev-parse', '--path-format=absolute', '--git-common-dir'],
            [0],
            queryWorktreePath,
          ).stdout.trim(),
        );
        return Object.freeze({
          schema: REGISTERED_COMMON_DIR_LOCATOR_SCHEMA,
          locatorId: repositoryId,
          repositoryId,
          queryWorktreePath,
          commonDirPath,
          worktrees: Object.freeze(
            ordered.map((source) =>
              Object.freeze({
                worktreePath: source.locator,
                ownerClass: source.ownerClass,
              }),
            ),
          ),
        });
      }),
  );
}

async function inspectLiveRepository(
  manifest: InventoryManifest,
  scope: InventoryScope,
): Promise<LiveInventory> {
  const locators = scope === 'full' ? compileRegisteredCommonDirLocators(manifest) : [];
  const fullAuthority = scope === 'full' ? locators[0] : undefined;
  if (scope === 'full' && fullAuthority === undefined) {
    throw new Error('full inventory lost its single governed repository authority');
  }
  const authorityWorktreePath = fullAuthority?.queryWorktreePath ?? REPO_ROOT;
  const resolveAuthorityOriginMain = (): string =>
    requireSha(
      runGit(
        ['rev-parse', '--verify', `${MAIN_REF}^{commit}`],
        [0],
        authorityWorktreePath,
      ).stdout.trim(),
      MAIN_REF,
    );
  const mainSha = resolveAuthorityOriginMain();
  const remoteRefs = parseRefList(
    runGit(
      ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/remotes/origin'],
      [0],
      authorityWorktreePath,
    ).stdout,
  );
  let executionIdentity = resolveExecutionIdentity(remoteRefs);
  const shouldAttestExecutionRunner = scope === 'full' || executionIdentity !== null;
  if (shouldAttestExecutionRunner) {
    const executionWorktreePath = executionIdentity?.worktreePath ?? REPO_ROOT;
    const executionEvidence = await computeCanonicalGitWorktreeEvidence(executionWorktreePath);
    const executionCommonDir = realpathSync(
      runGit(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        [0],
        executionWorktreePath,
      ).stdout.trim(),
    );
    const governedCommonDirs = locators.map((locator) => locator.commonDirPath);
    if (
      scope === 'full' &&
      (process.env.GITHUB_ACTIONS === 'true' ||
        process.env.CAPABILITY_INVENTORY_RUNNER_PROFILE !== SOURCE_INVENTORY_RUNNER_PROFILE ||
        executionEvidence.dirty ||
        governedCommonDirs.includes(executionCommonDir))
    ) {
      throw new InventoryInspectionError(
        'INVENTORY_RUNNER_PROFILE_INVALID',
        'full inventory requires the clean repository-owned runner profile on an independent Git common-dir',
      );
    }
    if (executionIdentity !== null) {
      executionIdentity = admitExecutionExclusionProof({
        identity: executionIdentity,
        scope,
        githubActions: process.env.GITHUB_ACTIONS,
        workflowRef: process.env.GITHUB_WORKFLOW_REF,
        jobId: process.env.GITHUB_JOB,
        localRunnerProfile: process.env.CAPABILITY_INVENTORY_RUNNER_PROFILE,
        checkoutHeadSha: executionEvidence.headSha,
        checkoutDirty: executionEvidence.dirty,
        executionCommonDir,
        governedCommonDirs,
      });
    }
  }
  const localRefs =
    scope === 'full'
      ? parseRefList(
          runGit(
            ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads'],
            [0],
            authorityWorktreePath,
          ).stdout,
        )
      : [];
  const worktrees: InspectedWorktree[] = [];
  if (scope === 'full') {
    const observations = await discoverRegisteredCommonDirs(locators);
    for (const observation of observations) {
      for (const worktree of observation.worktrees) {
        worktrees.push({
          path: worktree.worktreePath,
          headSha: worktree.headSha,
          branchRef: worktree.branchRef,
          lockReason: worktree.lockReason,
          dirty: worktree.dirty,
          repositoryId: observation.repository.repositoryId,
          ownerClass: worktree.ownerClass,
          statusSha256: worktree.statusSha256,
          contentSha256: worktree.contentSha256,
        });
      }
    }
  }

  const isAncestorAtAuthority = (ancestorSha: string, descendantSha: string): boolean =>
    runGit(
      ['merge-base', '--is-ancestor', ancestorSha, descendantSha],
      [0, 1],
      authorityWorktreePath,
    ).status === 0;
  const mergeBaseAtAuthority = (leftSha: string, rightSha: string): string =>
    requireSha(
      runGit(['merge-base', leftSha, rightSha], [0], authorityWorktreePath).stdout.trim(),
      `merge-base(${leftSha}, ${rightSha})`,
    );
  const changedPathsAtAuthority = (baseSha: string, headSha: string): string[] => {
    const raw = runGit(
      ['diff', '--name-only', '--no-renames', '-z', baseSha, headSha, '--'],
      [0],
      authorityWorktreePath,
    ).stdout;
    if (raw.length === 0) return [];
    if (!raw.endsWith('\0')) {
      throw new Error(`git diff path stream for ${baseSha}..${headSha} is not NUL-terminated`);
    }
    return raw.slice(0, -1).split('\0');
  };
  const remoteContainsAtAuthority = (headSha: string): boolean =>
    parseRefList(
      runGit(
        [
          'for-each-ref',
          `--contains=${headSha}`,
          '--format=%(refname)%09%(objectname)',
          'refs/remotes/origin',
        ],
        [0],
        authorityWorktreePath,
      ).stdout,
    ).length > 0;

  const inventory = discoverInventory(
    {
      mainSha,
      remoteRefs,
      localRefs,
      worktrees,
      executionIdentity,
      isAncestor: isAncestorAtAuthority,
      classifyBranchSourceRole: (source) =>
        classifySourceRole({
          mainSha,
          sourceHeadSha: source.headSha,
          executionHeadSha: executionIdentity?.headSha ?? null,
          isAncestor: isAncestorAtAuthority,
          mergeBase: mergeBaseAtAuthority,
          changedPaths: changedPathsAtAuthority,
        }),
      isReachableFromRemote: remoteContainsAtAuthority,
    },
    scope,
  );
  assertOriginMainStable(mainSha, resolveAuthorityOriginMain());
  return inventory;
}

function readManifest(): InventoryManifest {
  const raw: unknown = JSON.parse(readFileSync(join(REPO_ROOT, MANIFEST_PATH), 'utf8'));
  return parseInventoryManifest(raw);
}

export function parseInventoryCliOptions(args: readonly string[]): InventoryCliOptions {
  const staticArguments = args.filter((argument) => argument === '--static');
  const liveArguments = args.filter((argument) => argument === '--live');
  const scopeArguments = args.filter((argument) => argument === '--scope=remote');
  const recognizedCount = staticArguments.length + liveArguments.length + scopeArguments.length;
  if (
    staticArguments.length + liveArguments.length !== 1 ||
    scopeArguments.length > 1 ||
    (staticArguments.length === 1 && scopeArguments.length !== 0) ||
    recognizedCount !== args.length
  ) {
    throw new Error('expected --static or --live [--scope=remote]');
  }

  return {
    mode: staticArguments.length === 1 ? 'static' : 'live',
    scope: scopeArguments.length === 1 ? 'remote' : 'full',
  };
}

export function parseInventoryCliArgs(args: readonly string[]): InventoryScope {
  return parseInventoryCliOptions(args).scope;
}

export function compareInventoryForCli(
  manifest: InventoryManifest,
  live: LiveInventory,
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean,
  options: InventoryCliOptions,
): InventoryDrift[] {
  return compareInventory(manifest, live, isAncestor, options.scope);
}

export async function runCapabilitySourceInventoryCli(args: readonly string[]): Promise<void> {
  let options: InventoryCliOptions;
  try {
    options = parseInventoryCliOptions(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`capability-source-inventory: ${message}\n`);
    process.exit(2);
    return;
  }

  try {
    const manifest = readManifest();
    if (options.mode === 'static') {
      const proofDrifts = validateMainProofs(
        manifest,
        manifest.reconciledBaseSha,
        gitIsAncestor,
        gitResolveCommitTreeSha,
        'COMMITTED_OBJECTS',
      );
      if (proofDrifts.length > 0) {
        throw new Error(
          `committed main proofs are invalid: ${proofDrifts
            .map((drift) => `[${drift.code}] ${drift.message}`)
            .join('; ')}`,
        );
      }
      process.stdout.write(
        `capability-source-inventory: committed contract exact at ${manifest.reconciledBaseSha} (${manifest.sources.length} sources)\n`,
      );
      return;
    }
    const live = await inspectLiveRepository(manifest, options.scope);
    const drifts = [
      ...compareInventoryForCli(manifest, live, gitIsAncestor, options),
      ...validateMainProofs(manifest, live.mainSha, gitIsAncestor, gitResolveCommitTreeSha),
    ];

    if (drifts.length > 0) {
      process.stderr.write(
        [
          `capability-source-inventory: live contract failed with ${drifts.length} drift(s)`,
          ...drifts.map((drift) => `[${drift.code}] ${drift.message}`),
          'Fetch origin, then reconcile capability_reconciliation.sources on a fresh-main worktree; this gate never mutates the manifest.',
          '',
        ].join('\n'),
      );
      process.exit(1);
    }

    process.stdout.write(
      `capability-source-inventory: ${options.scope} scope exact at ${live.mainSha} (${live.sources.length} sources)\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof InventoryInspectionError ? `[${error.code}] ` : '';
    process.stderr.write(`capability-source-inventory: inspection failed: ${code}${message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  runCapabilitySourceInventoryCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`capability-source-inventory: unexpected failure: ${message}\n`);
    process.exit(1);
  });
}
