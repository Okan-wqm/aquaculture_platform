#!/usr/bin/env ts-node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { hasOwn } from './lib/json-contract';
import { HERMETIC_GIT_RUNTIME } from './lib/hermetic-git-runtime';
import { REPO_ROOT } from './lib/repo-root';
import { type SourceKind, type SourceRole } from './lib/capability-source-contract';
import { parseInventoryManifest } from './capability-source-inventory';

const DEFAULT_MANIFEST_PATH = 'docs/plans/2026-06-18-enterprise-grade-debt-closure/manifest.json';
const ORIGIN_MAIN_REF = 'refs/remotes/origin/main';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ATTEMPT_ID_PATTERN = /^attempt-sha256:[0-9a-f]{64}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
const MAX_GIT_STDOUT_BYTES = 16 * 1024;
const MAX_GIT_STDERR_BYTES = 16 * 1024;
const ALL_GIT_EXIT_STATUSES = Object.freeze(
  Array.from({ length: 256 }, (_unused, status) => status),
);
const MAX_GITHUB_API_RESPONSE_BYTES = 1024 * 1024;
const GITHUB_API_TIMEOUT_MS = 15_000;
const MAX_SOURCE_SELECTOR_ITEMS = 512;
const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_ACTIONS_APP_SLUG = 'github-actions';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

export type IntegrationUnitState =
  | 'ASSESSING'
  | 'READY'
  | 'INTEGRATING'
  | 'BLOCKED_EXTERNAL'
  | 'VERIFIED';

export type AuthorityTargetResolution = 'RESOLVED' | 'UNRESOLVED';

interface AuthorityTargetBase {
  resolution: AuthorityTargetResolution;
}

export interface FilePathAuthorityTarget extends AuthorityTargetBase {
  kind: 'FILE_PATH';
  path: string;
}

export interface FileGlobAuthorityTarget extends AuthorityTargetBase {
  kind: 'FILE_GLOB';
  pattern: string;
}

export interface SymbolAuthorityTarget extends AuthorityTargetBase {
  kind: 'SYMBOL';
  filePath: string;
  symbol: string;
}

export interface DbTableAuthorityTarget extends AuthorityTargetBase {
  kind: 'DB_TABLE';
  schema: string;
  table: string;
}

export interface HttpRouteAuthorityTarget extends AuthorityTargetBase {
  kind: 'HTTP_ROUTE';
  method: string;
  route: string;
}

export interface WorkflowJobAuthorityTarget extends AuthorityTargetBase {
  kind: 'WORKFLOW_JOB';
  workflowPath: string;
  jobId: string;
}

export interface RuntimeResourceAuthorityTarget extends AuthorityTargetBase {
  kind: 'RUNTIME_RESOURCE';
  resourceType: string;
  resourceId: string;
}

export interface PolicyAuthorityTarget extends AuthorityTargetBase {
  kind: 'POLICY';
  policyId: string;
}

export type AuthorityTarget =
  | FilePathAuthorityTarget
  | FileGlobAuthorityTarget
  | SymbolAuthorityTarget
  | DbTableAuthorityTarget
  | HttpRouteAuthorityTarget
  | WorkflowJobAuthorityTarget
  | RuntimeResourceAuthorityTarget
  | PolicyAuthorityTarget;

export type SourceSliceResolution = 'RESOLVED' | 'UNRESOLVED';
export type SourceSlicePurpose =
  | 'IMPLEMENTATION_CANDIDATE'
  | 'MAIN_EQUIVALENCE'
  | 'FORENSIC_EVIDENCE';

interface SourceSliceBase {
  id: string;
  sourceId: string;
  purpose: SourceSlicePurpose;
  authorityRole: 'PROVENANCE_ONLY';
  resolution: SourceSliceResolution;
  selectorSha256: string;
  computedSelectorSha256: string;
}

export interface CommitSetSelector {
  kind: 'COMMIT_SET';
  commitShas: string[];
}

export interface CommitPathSetSelector {
  kind: 'COMMIT_PATH_SET';
  baseSha: string;
  headSha: string;
  commitShas: string[];
  paths: string[];
}

export interface PathBlobSelectorEntry {
  lineage: 'SOURCE' | 'MAIN';
  commitSha: string;
  path: string;
  blobSha: string;
}

export interface PathBlobSetSelector {
  kind: 'PATH_BLOB_SET';
  entries: PathBlobSelectorEntry[];
}

export interface DirtyPatchSelector {
  kind: 'DIRTY_PATCH';
  capturedContentSha256: string;
  patchSha256: string;
  paths: string[];
}

export interface WholeTreeProofSelector {
  kind: 'WHOLE_TREE_PROOF';
  sourceCommitSha: string;
  sourceTreeSha: string;
  mainCommitSha: string;
  mainTreeSha: string;
}

export type SourceSliceSelector =
  | CommitSetSelector
  | CommitPathSetSelector
  | PathBlobSetSelector
  | DirtyPatchSelector
  | WholeTreeProofSelector;

export interface SourceSlice extends SourceSliceBase {
  selector: SourceSliceSelector;
}

export interface AncestorSourceMainProof {
  kind: 'ANCESTOR';
  sourceCommitSha: string;
}

export interface TreeEquivalentSourceMainProof {
  kind: 'TREE_EQUIVALENT';
  sourceCommitSha: string;
  sourceTreeSha: string;
  mainCommitSha: string;
  mainTreeSha: string;
}

export type SourceMainProof = AncestorSourceMainProof | TreeEquivalentSourceMainProof;

export interface ManifestSource {
  id: string;
  kind: SourceKind;
  role: Exclude<SourceRole, 'UNKNOWN'> | null;
  headSha: string;
  contentSha256: string | null;
  mainProof: SourceMainProof | null;
}

function isCapabilityIntegrationSource(source: ManifestSource): boolean {
  return source.role === null || source.role === 'CAPABILITY_CANDIDATE';
}

export interface MainCommitEvidence {
  kind: 'MAIN_COMMIT';
  commitSha: string;
}

export interface SourceMainProofEvidence {
  kind: 'SOURCE_MAIN_PROOF';
  sourceSliceId: string | null;
  legacySourceId: string | null;
  legacyProofKind: SourceMainProof['kind'] | null;
}

export interface SliceBlobEqualityEvidence {
  kind: 'SLICE_BLOB_EQ';
  sourceSliceId: string | null;
}

export interface ChainedTreeEquivalentEvidence {
  kind: 'CHAINED_TREE_EQUIVALENT';
  sourceSliceId: string | null;
  legacySourceId: string | null;
  legacyStackHeadSha: string | null;
  legacyStackTreeSha: string | null;
  legacyMainCommitSha: string | null;
  legacyMainTreeSha: string | null;
}

export type MainEvidence =
  | MainCommitEvidence
  | SourceMainProofEvidence
  | SliceBlobEqualityEvidence
  | ChainedTreeEquivalentEvidence;

export interface MergeEvidence {
  kind: 'MERGE_COMMIT';
  mergeCommitSha: string;
  baseRef: 'refs/heads/main';
  mergedAt: string;
}

export interface ExecutionAttempt {
  attemptId: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  requiredStatusManifestSha256: string;
  workflowRunId: number;
  workflowRunAttempt: number;
  startedAt: string;
  mergeEvidence: MergeEvidence | null;
}

export type GateResultStatus = 'PASS' | 'FAIL' | 'PENDING';

interface GateEvidenceBase {
  kind: string;
  headSha: string;
}

export interface GitHubActionsArtifactTrust {
  kind: 'GITHUB_ACTIONS_ARTIFACT';
  repository: string;
  headSha: string;
  workflowRunId: number;
  workflowRunAttempt: number;
  workflowPath: string;
  artifactId: number;
  artifactName: string;
  artifactSha256: string;
}

export interface SigstoreBundleTrust {
  kind: 'SIGSTORE_BUNDLE';
  repository: string;
  headSha: string;
  subjectSha256: string;
  bundleUri: string;
  bundleSha256: string;
  issuer: string;
  signerIdentity: string;
}

export type EvidenceTrustBinding = GitHubActionsArtifactTrust | SigstoreBundleTrust;

export interface GitHubCheckEvidence extends GateEvidenceBase {
  kind: 'GITHUB_CHECK';
  checkRunId: number;
  workflowRunId: number;
  workflowRunAttempt: number;
  repository: string;
  context: string;
  conclusion: 'SUCCESS';
  detailsUrl: string;
  completedAt: string;
}

export interface CommandResultEvidence extends GateEvidenceBase {
  kind: 'COMMAND_RESULT';
  command: string;
  exitCode: number;
  artifactSha256: string;
  completedAt: string;
  trust: EvidenceTrustBinding;
}

export interface FindingStateEvidence extends GateEvidenceBase {
  kind: 'FINDING_STATE';
  findingIds: string[];
  state: 'RESOLVED';
  registryTipSha256: string;
  completedAt: string;
  trust: EvidenceTrustBinding;
}

export interface GateEvidenceOpaque extends GateEvidenceBase {
  kind: 'CAPABILITY_ASSERTION';
  assertionId: string;
  artifactSha256: string;
  completedAt: string;
  trust: EvidenceTrustBinding;
}

export type GateEvidence =
  | GitHubCheckEvidence
  | CommandResultEvidence
  | FindingStateEvidence
  | GateEvidenceOpaque;
export type GateEvidenceKind = GateEvidence['kind'];

export interface GateResult {
  gateId: string;
  status: GateResultStatus;
  headSha: string;
  evidence: GateEvidence[];
}

export interface TwoProtectedMainParityCyclesRequirement {
  id: string;
  kind: 'TWO_PROTECTED_MAIN_PARITY_CYCLES';
  minimumCycles: 2;
  distinctProtectedMainShas: true;
}

export interface LedgerPreproductionCutoverRequirement {
  id: string;
  kind: 'LEDGER_PREPRODUCTION_CUTOVER_ROLLBACK';
  environment: 'PRE_PRODUCTION_ONLY';
  productionCutover: 'FORBIDDEN';
  requiredEvidenceKinds: [
    'ENCRYPTED_RESTORE',
    'SHADOW_PARITY',
    'PRE_PRODUCTION_CUTOVER',
    'ROLLBACK',
  ];
}

export interface ArtifactAssertionRequirement {
  id: string;
  kind: 'ARTIFACT_ASSERTION';
  assertionId: string;
  minimumEvidence: number;
}

export type AcceptanceRequirement =
  | TwoProtectedMainParityCyclesRequirement
  | LedgerPreproductionCutoverRequirement
  | ArtifactAssertionRequirement;

interface AcceptanceEvidenceBase {
  requirementId: string;
  headSha: string;
  result: 'PASS';
  artifactUri: string;
  artifactSha256: string;
  observedAt: string;
  trust: EvidenceTrustBinding;
}

export interface ProtectedMainParityCycleEvidence extends AcceptanceEvidenceBase {
  kind: 'PROTECTED_MAIN_PARITY_CYCLE';
  protectedMainSha: string;
  jsonlProjectionSha256: string;
  postgresProjectionSha256: string;
  commandLogSha256: string;
  zeroDiff: true;
  requiredChecksArtifactSha256: string;
}

export interface EncryptedRestoreEvidence extends AcceptanceEvidenceBase {
  kind: 'ENCRYPTED_RESTORE';
  ciphertextSha256: string;
  restoreLogSha256: string;
  schemaCheckSha256: string;
  rowCountCheckSha256: string;
  isolatedRunner: true;
}

export interface ShadowParityEvidence extends AcceptanceEvidenceBase {
  kind: 'SHADOW_PARITY';
  protectedMainSha: string;
  jsonlProjectionSha256: string;
  postgresProjectionSha256: string;
  zeroDiff: true;
}

export interface PreproductionCutoverEvidence extends AcceptanceEvidenceBase {
  kind: 'PRE_PRODUCTION_CUTOVER';
  environment: 'PRE_PRODUCTION';
  productionMutation: false;
  selectorBefore: 'JSONL_PRIMARY';
  selectorDuring: 'POSTGRES_PRIMARY';
}

export interface RollbackEvidence extends AcceptanceEvidenceBase {
  kind: 'ROLLBACK';
  environment: 'PRE_PRODUCTION';
  productionMutation: false;
  restoredAuthority: 'JSONL_PRIMARY';
}

export interface ArtifactAssertionEvidence extends AcceptanceEvidenceBase {
  kind: 'ARTIFACT_ASSERTION';
  assertionId: string;
}

export type AcceptanceEvidence =
  | ProtectedMainParityCycleEvidence
  | EncryptedRestoreEvidence
  | ShadowParityEvidence
  | PreproductionCutoverEvidence
  | RollbackEvidence
  | ArtifactAssertionEvidence;

export interface ExternalBlocker {
  blockerId: string;
  owner: string;
  evidenceUri: string;
  observedAt: string;
  resolutionCondition: string;
}

export interface UnitOwnership {
  accountableRegistryOwner: string | null;
  executionOwner: string;
  mandatoryReviewers: string[];
}

export interface SameRootCauseCoClosure {
  kind: 'SAME_ROOT_CAUSE';
  rootCauseKey: string;
  evidenceRefs: string[];
}

export interface AuthorityBoundary {
  primaryAuthority: string;
  postgresRole: string;
  postgresPrimaryPolicy: string;
  productionCutover: boolean;
}

interface EnhancedFieldPresence {
  authorityTargets: boolean;
  sourceSliceIds: boolean;
  executionAttempt: boolean;
  externalBlocker: boolean;
  acceptanceRequirements: boolean;
  acceptanceEvidence: boolean;
  ownership: boolean;
  coClosureContract: boolean;
}

export interface IntegrationUnit {
  id: string;
  state: IntegrationUnitState;
  legacySourceIds: string[];
  legacyDerivedFrom: string[];
  dependsOn: string[];
  authorityTargets: AuthorityTarget[];
  sourceSliceIds: string[];
  executionAttempt: ExecutionAttempt | null;
  externalBlocker: ExternalBlocker | null;
  acceptanceRequirements: AcceptanceRequirement[];
  acceptanceEvidence: AcceptanceEvidence[];
  findingIds: string[];
  findingBindingStatus: 'BOUND' | 'CREATE_REQUIRED' | 'NOT_REQUIRED';
  ownership: UnitOwnership | null;
  coClosureContract: SameRootCauseCoClosure | null;
  mainEvidence: MainEvidence[];
  gateProfile: string;
  gateResults: GateResult[];
  authorityBoundary: AuthorityBoundary | null;
  enhancedFieldPresence: EnhancedFieldPresence;
  legacyOwnerPresent: boolean;
}

export interface GateProfile {
  id: string;
  requiredGateIds: string[];
  evidenceContracts: Readonly<Record<string, GateEvidenceKind>>;
}

export interface IntegrationEvidenceManifest {
  sourceSchemaVersion: 1 | 2;
  requiredStatusManifestPath: string;
  integrationOrder: string[];
  units: IntegrationUnit[];
  sources: ManifestSource[];
  sourceSlices: SourceSlice[];
  gateProfiles: GateProfile[];
}

export interface RequiredStatusContract {
  digestSha256: string;
  repository: string;
  contexts: string[];
}

export interface GitEvidenceReader {
  resolveRef(ref: string): Promise<string>;
  objectExists(oid: string, kind: 'commit' | 'tree' | 'blob'): Promise<boolean>;
  isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean>;
  commitTree(commitSha: string): Promise<string | null>;
  pathBlob(commitSha: string, path: string): Promise<string | null>;
  pathChangedBetween(baseSha: string, headSha: string, path: string): Promise<boolean>;
}

export interface GitHubPullRequestRecord {
  repository: string;
  number: number;
  headRepository: string;
  headSha: string;
  state: 'OPEN' | 'CLOSED';
  merged: boolean;
  mergeCommitSha: string | null;
}

export interface GitHubWorkflowRunRecord {
  repository: string;
  id: number;
  headRepository: string;
  headSha: string;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  event: string;
  path: string;
  detailsUrl: string;
  pullRequestNumbers: number[];
}

export interface GitHubCheckRunRecord {
  repository: string;
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string;
  appSlug: string;
  workflowRunId: number | null;
}

export interface GitHubArtifactRecord {
  repository: string;
  id: number;
  name: string;
  workflowRunId: number;
  expired: boolean;
  digestSha256: string | null;
}

export interface GitHubActionsEvidenceReader {
  isAuthenticated(): Promise<boolean>;
  getPullRequest(repository: string, pullRequestNumber: number): Promise<GitHubPullRequestRecord>;
  getWorkflowRun(repository: string, workflowRunId: number): Promise<GitHubWorkflowRunRecord>;
  getCheckRun(repository: string, checkRunId: number): Promise<GitHubCheckRunRecord>;
  getArtifact(repository: string, artifactId: number): Promise<GitHubArtifactRecord>;
}

export interface SigstoreVerificationResult {
  verified: boolean;
  repository: string;
  headSha: string;
  subjectSha256: string;
  bundleSha256: string;
  issuer: string;
  signerIdentity: string;
}

export interface SigstoreEvidenceVerifier {
  verify(binding: SigstoreBundleTrust): Promise<SigstoreVerificationResult>;
}

export interface LiveEvidenceTrustContext {
  github: GitHubActionsEvidenceReader;
  sigstore?: SigstoreEvidenceVerifier;
}

export interface DispatchIdentityDefinition {
  name: string;
  path: string;
}

export interface DispatchIdentityCatalog {
  definitions(): readonly DispatchIdentityDefinition[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  unitId?: string;
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

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireOptionalNullableRecord(
  record: Record<string, unknown>,
  key: string,
  field: string,
): Record<string, unknown> | null {
  if (!hasOwn(record, key) || record[key] === null) {
    return null;
  }
  return requireRecord(record[key], field);
}

function requireStringArray(value: unknown, field: string): string[] {
  return requireArray(value, field).map((entry, index) =>
    requireString(entry, `${field}[${index}]`),
  );
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function requireInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum) {
    throw new Error(`${field} must be an integer >= ${minimum}`);
  }
  return value;
}

function requireLiteral<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function requireSha(value: unknown, field: string): string {
  const sha = requireString(value, field);
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${field} must be a lowercase 40-character Git SHA`);
  }
  return sha;
}

function requireSha256(value: unknown, field: string): string {
  const digest = requireString(value, field);
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`${field} must be a lowercase 64-character SHA-256 digest`);
  }
  return digest;
}

function requireInstant(value: unknown, field: string): string {
  const instant = requireString(value, field);
  if (!ISO_INSTANT_PATTERN.test(instant) || Number.isNaN(Date.parse(instant))) {
    throw new Error(`${field} must be an ISO-8601 UTC instant`);
  }
  return instant;
}

function requireIdentifier(value: unknown, field: string): string {
  const identifier = requireString(value, field);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`${field} contains unsupported characters`);
  }
  return identifier;
}

function requireNullableIdentifier(value: unknown, field: string): string | null {
  return value === null ? null : requireIdentifier(value, field);
}

function requireRepository(value: unknown, field: string): string {
  const repository = requireString(value, field);
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`${field} must be an owner/repository identity`);
  }
  return repository;
}

function requireRepoPath(value: unknown, field: string): string {
  const path = requireString(value, field);
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`${field} must be a normalized repository-relative POSIX path`);
  }
  return path;
}

function parseEvidenceTrustBinding(value: unknown, field: string): EvidenceTrustBinding {
  const record = requireRecord(value, field);
  const kind = requireLiteral(
    record.kind,
    ['GITHUB_ACTIONS_ARTIFACT', 'SIGSTORE_BUNDLE'] as const,
    `${field}.kind`,
  );
  if (kind === 'GITHUB_ACTIONS_ARTIFACT') {
    requireExactKeys(
      record,
      [
        'kind',
        'repository',
        'head_sha',
        'workflow_run_id',
        'workflow_run_attempt',
        'workflow_path',
        'artifact_id',
        'artifact_name',
        'artifact_sha256',
      ],
      field,
    );
    return {
      kind,
      repository: requireRepository(record.repository, `${field}.repository`),
      headSha: requireSha(record.head_sha, `${field}.head_sha`),
      workflowRunId: requireInteger(record.workflow_run_id, `${field}.workflow_run_id`, 1),
      workflowRunAttempt: requireInteger(
        record.workflow_run_attempt,
        `${field}.workflow_run_attempt`,
        1,
      ),
      workflowPath: requireRepoPath(record.workflow_path, `${field}.workflow_path`),
      artifactId: requireInteger(record.artifact_id, `${field}.artifact_id`, 1),
      artifactName: requireString(record.artifact_name, `${field}.artifact_name`),
      artifactSha256: requireSha256(record.artifact_sha256, `${field}.artifact_sha256`),
    };
  }
  requireExactKeys(
    record,
    [
      'kind',
      'repository',
      'head_sha',
      'subject_sha256',
      'bundle_uri',
      'bundle_sha256',
      'issuer',
      'signer_identity',
    ],
    field,
  );
  return {
    kind,
    repository: requireRepository(record.repository, `${field}.repository`),
    headSha: requireSha(record.head_sha, `${field}.head_sha`),
    subjectSha256: requireSha256(record.subject_sha256, `${field}.subject_sha256`),
    bundleUri: requireString(record.bundle_uri, `${field}.bundle_uri`),
    bundleSha256: requireSha256(record.bundle_sha256, `${field}.bundle_sha256`),
    issuer: requireString(record.issuer, `${field}.issuer`),
    signerIdentity: requireString(record.signer_identity, `${field}.signer_identity`),
  };
}

function requireFileGlob(value: unknown, field: string): string {
  const pattern = requireString(value, field);
  const wildcardIndex = pattern.indexOf('*');
  if (wildcardIndex < 0) {
    throw new Error(`${field} must end in /* or /**`);
  }
  if (
    (!pattern.endsWith('/*') && !pattern.endsWith('/**')) ||
    wildcardIndex !== pattern.length - (pattern.endsWith('/**') ? 2 : 1)
  ) {
    throw new Error(`${field} only supports a terminal /* or /** wildcard`);
  }
  requireRepoPath(pattern.slice(0, pattern.lastIndexOf('/')), `${field} prefix`);
  return pattern;
}

function requireHttpRoute(value: unknown, field: string): string {
  const route = requireString(value, field);
  const validSegments =
    route === '/' ||
    route
      .split('/')
      .slice(1)
      .every(
        (segment) =>
          segment.length > 0 &&
          (!segment.includes('{') && !segment.includes('}')
            ? true
            : /^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(segment)),
      );
  if (
    !route.startsWith('/') ||
    (route.length > 1 && route.endsWith('/')) ||
    route.includes('//') ||
    route.includes('?') ||
    route.includes('#') ||
    route.includes(':') ||
    !validSegments
  ) {
    throw new Error(`${field} must be a canonical absolute route using {parameter} placeholders`);
  }
  return route;
}

function requireUniqueStrings(values: string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${field} contains duplicate value ${value}`);
    }
    seen.add(value);
  }
}

function requireSortedUniqueStrings(values: string[], field: string): void {
  requireUniqueStrings(values, field);
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  if (values.some((value, index) => value !== sorted[index])) {
    throw new Error(`${field} must be lexicographically sorted`);
  }
}

function requireExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right));
  const expected = [...expectedKeys].sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} keys must exactly equal ${expected.join(', ')}`);
  }
}

function canonicalJson(value: unknown, field: string): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${field} contains a non-finite number`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => canonicalJson(entry, `${field}[${index}]`)).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], `${field}.${key}`)}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`${field} contains a non-JSON value`);
}

export function computeSourceSliceSelectorSha256(selector: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(selector, 'source slice selector'))
    .digest('hex');
}

function parseAuthorityTarget(value: unknown, field: string): AuthorityTarget {
  const record = requireRecord(value, field);
  const kind = requireLiteral(
    record.kind,
    [
      'FILE_PATH',
      'FILE_GLOB',
      'SYMBOL',
      'DB_TABLE',
      'HTTP_ROUTE',
      'WORKFLOW_JOB',
      'RUNTIME_RESOURCE',
      'POLICY',
    ] as const,
    `${field}.kind`,
  );
  const resolution = requireLiteral(
    record.resolution,
    ['RESOLVED', 'UNRESOLVED'] as const,
    `${field}.resolution`,
  );
  switch (kind) {
    case 'FILE_PATH':
      return { kind, resolution, path: requireRepoPath(record.path, `${field}.path`) };
    case 'FILE_GLOB':
      return {
        kind,
        resolution,
        pattern: requireFileGlob(record.pattern, `${field}.pattern`),
      };
    case 'SYMBOL':
      return {
        kind,
        resolution,
        filePath: requireRepoPath(record.file_path, `${field}.file_path`),
        symbol: requireString(record.symbol, `${field}.symbol`),
      };
    case 'DB_TABLE':
      return {
        kind,
        resolution,
        schema: requireIdentifier(record.schema, `${field}.schema`).toLowerCase(),
        table: requireIdentifier(record.table, `${field}.table`).toLowerCase(),
      };
    case 'HTTP_ROUTE':
      return {
        kind,
        resolution,
        method: requireLiteral(
          record.method,
          ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'] as const,
          `${field}.method`,
        ),
        route: requireHttpRoute(record.route, `${field}.route`),
      };
    case 'WORKFLOW_JOB':
      return {
        kind,
        resolution,
        workflowPath: requireRepoPath(record.workflow_path, `${field}.workflow_path`),
        jobId: requireIdentifier(record.job_id, `${field}.job_id`),
      };
    case 'RUNTIME_RESOURCE':
      return {
        kind,
        resolution,
        resourceType: requireIdentifier(record.resource_type, `${field}.resource_type`),
        resourceId: requireString(record.resource_id, `${field}.resource_id`),
      };
    case 'POLICY':
      return {
        kind,
        resolution,
        policyId: requireIdentifier(record.policy_id, `${field}.policy_id`),
      };
  }
}

function parseSourceSliceSelector(value: unknown, field: string): SourceSliceSelector {
  const record = requireRecord(value, field);
  const kind = requireLiteral(
    record.kind,
    ['COMMIT_SET', 'COMMIT_PATH_SET', 'PATH_BLOB_SET', 'DIRTY_PATCH', 'WHOLE_TREE_PROOF'] as const,
    `${field}.kind`,
  );
  if (kind === 'COMMIT_SET') {
    requireExactKeys(record, ['kind', 'commit_shas'], field);
    const commitShas = requireStringArray(record.commit_shas, `${field}.commit_shas`).map(
      (sha, index) => requireSha(sha, `${field}.commit_shas[${index}]`),
    );
    requireSortedUniqueStrings(commitShas, `${field}.commit_shas`);
    if (commitShas.length === 0 || commitShas.length > MAX_SOURCE_SELECTOR_ITEMS) {
      throw new Error(
        `${field}.commit_shas must contain 1-${String(MAX_SOURCE_SELECTOR_ITEMS)} entries`,
      );
    }
    return { kind, commitShas };
  }
  if (kind === 'COMMIT_PATH_SET') {
    requireExactKeys(record, ['kind', 'base_sha', 'head_sha', 'commit_shas', 'paths'], field);
    const commitShas = requireStringArray(record.commit_shas, `${field}.commit_shas`).map(
      (sha, index) => requireSha(sha, `${field}.commit_shas[${index}]`),
    );
    const paths = requireStringArray(record.paths, `${field}.paths`).map((path, index) =>
      requireRepoPath(path, `${field}.paths[${index}]`),
    );
    requireSortedUniqueStrings(commitShas, `${field}.commit_shas`);
    requireSortedUniqueStrings(paths, `${field}.paths`);
    if (
      commitShas.length === 0 ||
      paths.length === 0 ||
      commitShas.length > MAX_SOURCE_SELECTOR_ITEMS ||
      paths.length > MAX_SOURCE_SELECTOR_ITEMS
    ) {
      throw new Error(
        `${field}.commit_shas and paths must each contain 1-${String(MAX_SOURCE_SELECTOR_ITEMS)} entries`,
      );
    }
    return {
      kind,
      baseSha: requireSha(record.base_sha, `${field}.base_sha`),
      headSha: requireSha(record.head_sha, `${field}.head_sha`),
      commitShas,
      paths,
    };
  }
  if (kind === 'PATH_BLOB_SET') {
    requireExactKeys(record, ['kind', 'entries'], field);
    const entries = requireArray(record.entries, `${field}.entries`).map(
      (entry, index): PathBlobSelectorEntry => {
        const entryField = `${field}.entries[${index}]`;
        const entryRecord = requireRecord(entry, entryField);
        requireExactKeys(entryRecord, ['lineage', 'commit_sha', 'path', 'blob_sha'], entryField);
        return {
          lineage: requireLiteral(
            entryRecord.lineage,
            ['SOURCE', 'MAIN'] as const,
            `${entryField}.lineage`,
          ),
          commitSha: requireSha(entryRecord.commit_sha, `${entryField}.commit_sha`),
          path: requireRepoPath(entryRecord.path, `${entryField}.path`),
          blobSha: requireSha(entryRecord.blob_sha, `${entryField}.blob_sha`),
        };
      },
    );
    if (entries.length === 0 || entries.length > MAX_SOURCE_SELECTOR_ITEMS) {
      throw new Error(
        `${field}.entries must contain 1-${String(MAX_SOURCE_SELECTOR_ITEMS)} entries`,
      );
    }
    const entryKeys = entries.map(
      (entry) => `${entry.lineage}\0${entry.commitSha}\0${entry.path}\0${entry.blobSha}`,
    );
    requireSortedUniqueStrings(entryKeys, `${field}.entries`);
    return { kind, entries };
  }
  if (kind === 'DIRTY_PATCH') {
    requireExactKeys(record, ['kind', 'captured_content_sha256', 'patch_sha256', 'paths'], field);
    const paths = requireStringArray(record.paths, `${field}.paths`).map((path, index) =>
      requireRepoPath(path, `${field}.paths[${index}]`),
    );
    requireSortedUniqueStrings(paths, `${field}.paths`);
    if (paths.length === 0 || paths.length > MAX_SOURCE_SELECTOR_ITEMS) {
      throw new Error(`${field}.paths must contain 1-${String(MAX_SOURCE_SELECTOR_ITEMS)} entries`);
    }
    return {
      kind,
      capturedContentSha256: requireSha256(
        record.captured_content_sha256,
        `${field}.captured_content_sha256`,
      ),
      patchSha256: requireSha256(record.patch_sha256, `${field}.patch_sha256`),
      paths,
    };
  }
  requireExactKeys(
    record,
    ['kind', 'source_commit_sha', 'source_tree_sha', 'main_commit_sha', 'main_tree_sha'],
    field,
  );
  return {
    kind,
    sourceCommitSha: requireSha(record.source_commit_sha, `${field}.source_commit_sha`),
    sourceTreeSha: requireSha(record.source_tree_sha, `${field}.source_tree_sha`),
    mainCommitSha: requireSha(record.main_commit_sha, `${field}.main_commit_sha`),
    mainTreeSha: requireSha(record.main_tree_sha, `${field}.main_tree_sha`),
  };
}

function parseSourceSlice(value: unknown, index: number): SourceSlice {
  const field = `capability_reconciliation.source_slices[${index}]`;
  const record = requireRecord(value, field);
  requireExactKeys(
    record,
    ['id', 'source_id', 'purpose', 'authority_role', 'resolution', 'selector', 'selector_sha256'],
    field,
  );
  const selectorSha256 = requireSha256(record.selector_sha256, `${field}.selector_sha256`);
  return {
    id: requireIdentifier(record.id, `${field}.id`),
    sourceId: requireIdentifier(record.source_id, `${field}.source_id`),
    purpose: requireLiteral(
      record.purpose,
      ['IMPLEMENTATION_CANDIDATE', 'MAIN_EQUIVALENCE', 'FORENSIC_EVIDENCE'] as const,
      `${field}.purpose`,
    ),
    authorityRole: requireLiteral(
      record.authority_role,
      ['PROVENANCE_ONLY'] as const,
      `${field}.authority_role`,
    ),
    resolution: requireLiteral(
      record.resolution,
      ['RESOLVED', 'UNRESOLVED'] as const,
      `${field}.resolution`,
    ),
    selectorSha256,
    computedSelectorSha256: computeSourceSliceSelectorSha256(record.selector),
    selector: parseSourceSliceSelector(record.selector, `${field}.selector`),
  };
}

function parseMainEvidence(value: unknown, field: string): MainEvidence {
  const record = requireRecord(value, field);
  const kind = requireLiteral(
    record.kind,
    ['MAIN_COMMIT', 'SOURCE_MAIN_PROOF', 'SLICE_BLOB_EQ', 'CHAINED_TREE_EQUIVALENT'] as const,
    `${field}.kind`,
  );
  if (kind === 'MAIN_COMMIT') {
    return { kind, commitSha: requireSha(record.commit_sha, `${field}.commit_sha`) };
  }
  if (kind === 'SOURCE_MAIN_PROOF') {
    return {
      kind,
      sourceSliceId: hasOwn(record, 'source_slice_id')
        ? requireIdentifier(record.source_slice_id, `${field}.source_slice_id`)
        : null,
      legacySourceId: hasOwn(record, 'source_id')
        ? requireIdentifier(record.source_id, `${field}.source_id`)
        : null,
      legacyProofKind: hasOwn(record, 'proof_kind')
        ? requireLiteral(
            record.proof_kind,
            ['ANCESTOR', 'TREE_EQUIVALENT'] as const,
            `${field}.proof_kind`,
          )
        : null,
    };
  }
  if (kind === 'SLICE_BLOB_EQ') {
    return {
      kind,
      sourceSliceId: hasOwn(record, 'source_slice_id')
        ? requireIdentifier(record.source_slice_id, `${field}.source_slice_id`)
        : null,
    };
  }
  return {
    kind,
    sourceSliceId: hasOwn(record, 'source_slice_id')
      ? requireIdentifier(record.source_slice_id, `${field}.source_slice_id`)
      : null,
    legacySourceId: hasOwn(record, 'source_id')
      ? requireIdentifier(record.source_id, `${field}.source_id`)
      : null,
    legacyStackHeadSha: hasOwn(record, 'stack_head_sha')
      ? requireSha(record.stack_head_sha, `${field}.stack_head_sha`)
      : null,
    legacyStackTreeSha: hasOwn(record, 'stack_tree_sha')
      ? requireSha(record.stack_tree_sha, `${field}.stack_tree_sha`)
      : null,
    legacyMainCommitSha: hasOwn(record, 'main_commit_sha')
      ? requireSha(record.main_commit_sha, `${field}.main_commit_sha`)
      : null,
    legacyMainTreeSha: hasOwn(record, 'main_tree_sha')
      ? requireSha(record.main_tree_sha, `${field}.main_tree_sha`)
      : null,
  };
}

function parseMergeEvidence(value: unknown, field: string): MergeEvidence {
  const record = requireRecord(value, field);
  return {
    kind: requireLiteral(record.kind, ['MERGE_COMMIT'] as const, `${field}.kind`),
    mergeCommitSha: requireSha(record.merge_commit_sha, `${field}.merge_commit_sha`),
    baseRef: requireLiteral(record.base_ref, ['refs/heads/main'] as const, `${field}.base_ref`),
    mergedAt: requireInstant(record.merged_at, `${field}.merged_at`),
  };
}

function parseExecutionAttempt(value: unknown, field: string): ExecutionAttempt {
  const record = requireRecord(value, field);
  const mergeEvidence = requireOptionalNullableRecord(
    record,
    'merge_evidence',
    `${field}.merge_evidence`,
  );
  const attemptId = requireString(record.attempt_id, `${field}.attempt_id`);
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new Error(`${field}.attempt_id must be attempt-sha256:<64 lowercase hex>`);
  }
  return {
    attemptId,
    repository: requireRepository(record.repository, `${field}.repository`),
    pullRequestNumber: requireInteger(
      record.pull_request_number,
      `${field}.pull_request_number`,
      1,
    ),
    headSha: requireSha(record.head_sha, `${field}.head_sha`),
    requiredStatusManifestSha256: requireSha256(
      record.required_status_manifest_sha256,
      `${field}.required_status_manifest_sha256`,
    ),
    workflowRunId: requireInteger(record.workflow_run_id, `${field}.workflow_run_id`, 1),
    workflowRunAttempt: requireInteger(
      record.workflow_run_attempt,
      `${field}.workflow_run_attempt`,
      1,
    ),
    startedAt: requireInstant(record.started_at, `${field}.started_at`),
    mergeEvidence:
      mergeEvidence === null ? null : parseMergeEvidence(mergeEvidence, `${field}.merge_evidence`),
  };
}

function parseGateEvidence(value: unknown, field: string): GateEvidence {
  const record = requireRecord(value, field);
  const kind = requireLiteral(
    record.kind,
    ['GITHUB_CHECK', 'COMMAND_RESULT', 'FINDING_STATE', 'CAPABILITY_ASSERTION'] as const,
    `${field}.kind`,
  );
  const headSha = requireSha(record.head_sha, `${field}.head_sha`);
  if (kind === 'GITHUB_CHECK') {
    return {
      kind,
      headSha,
      checkRunId: requireInteger(record.check_run_id, `${field}.check_run_id`, 1),
      workflowRunId: requireInteger(record.workflow_run_id, `${field}.workflow_run_id`, 1),
      workflowRunAttempt: requireInteger(
        record.workflow_run_attempt,
        `${field}.workflow_run_attempt`,
        1,
      ),
      repository: requireRepository(record.repository, `${field}.repository`),
      context: requireString(record.context, `${field}.context`),
      conclusion: requireLiteral(record.conclusion, ['SUCCESS'] as const, `${field}.conclusion`),
      detailsUrl: requireString(record.details_url, `${field}.details_url`),
      completedAt: requireInstant(record.completed_at, `${field}.completed_at`),
    };
  }
  if (kind === 'COMMAND_RESULT') {
    return {
      kind,
      headSha,
      command: requireString(record.command, `${field}.command`),
      exitCode: requireInteger(record.exit_code, `${field}.exit_code`),
      artifactSha256: requireSha256(record.artifact_sha256, `${field}.artifact_sha256`),
      completedAt: requireInstant(record.completed_at, `${field}.completed_at`),
      trust: parseEvidenceTrustBinding(record.trust, `${field}.trust`),
    };
  }
  if (kind === 'FINDING_STATE') {
    const findingIds = requireStringArray(record.finding_ids, `${field}.finding_ids`);
    requireUniqueStrings(findingIds, `${field}.finding_ids`);
    if (findingIds.length === 0) {
      throw new Error(`${field}.finding_ids must not be empty`);
    }
    return {
      kind,
      headSha,
      findingIds,
      state: requireLiteral(record.state, ['RESOLVED'] as const, `${field}.state`),
      registryTipSha256: requireSha256(record.registry_tip_sha256, `${field}.registry_tip_sha256`),
      completedAt: requireInstant(record.completed_at, `${field}.completed_at`),
      trust: parseEvidenceTrustBinding(record.trust, `${field}.trust`),
    };
  }
  return {
    kind,
    headSha,
    assertionId: requireIdentifier(record.assertion_id, `${field}.assertion_id`),
    artifactSha256: requireSha256(record.artifact_sha256, `${field}.artifact_sha256`),
    completedAt: requireInstant(record.completed_at, `${field}.completed_at`),
    trust: parseEvidenceTrustBinding(record.trust, `${field}.trust`),
  };
}

function parseGateResult(value: unknown, field: string): GateResult {
  const record = requireRecord(value, field);
  return {
    gateId: requireIdentifier(record.gate_id, `${field}.gate_id`),
    status: requireLiteral(record.status, ['PASS', 'FAIL', 'PENDING'] as const, `${field}.status`),
    headSha: requireSha(record.head_sha, `${field}.head_sha`),
    evidence: requireArray(record.evidence, `${field}.evidence`).map((entry, index) =>
      parseGateEvidence(entry, `${field}.evidence[${index}]`),
    ),
  };
}

function parseAcceptanceRequirement(value: unknown, field: string): AcceptanceRequirement {
  const record = requireRecord(value, field);
  const common = { id: requireIdentifier(record.id, `${field}.id`) };
  const kind = requireLiteral(
    record.kind,
    [
      'TWO_PROTECTED_MAIN_PARITY_CYCLES',
      'LEDGER_PREPRODUCTION_CUTOVER_ROLLBACK',
      'ARTIFACT_ASSERTION',
    ] as const,
    `${field}.kind`,
  );
  if (kind === 'TWO_PROTECTED_MAIN_PARITY_CYCLES') {
    const minimumCycles = requireInteger(record.minimum_cycles, `${field}.minimum_cycles`, 2);
    if (minimumCycles !== 2) {
      throw new Error(`${field}.minimum_cycles must equal 2`);
    }
    if (
      requireBoolean(
        record.distinct_protected_main_shas,
        `${field}.distinct_protected_main_shas`,
      ) !== true
    ) {
      throw new Error(`${field}.distinct_protected_main_shas must be true`);
    }
    return { ...common, kind, minimumCycles: 2, distinctProtectedMainShas: true };
  }
  if (kind === 'LEDGER_PREPRODUCTION_CUTOVER_ROLLBACK') {
    const requiredEvidenceKinds = requireStringArray(
      record.required_evidence_kinds,
      `${field}.required_evidence_kinds`,
    );
    const expected = [
      'ENCRYPTED_RESTORE',
      'SHADOW_PARITY',
      'PRE_PRODUCTION_CUTOVER',
      'ROLLBACK',
    ] as const;
    if (
      requiredEvidenceKinds.length !== expected.length ||
      expected.some((entry, index) => requiredEvidenceKinds[index] !== entry)
    ) {
      throw new Error(`${field}.required_evidence_kinds must equal ${expected.join(', ')}`);
    }
    return {
      ...common,
      kind,
      environment: requireLiteral(
        record.environment,
        ['PRE_PRODUCTION_ONLY'] as const,
        `${field}.environment`,
      ),
      productionCutover: requireLiteral(
        record.production_cutover,
        ['FORBIDDEN'] as const,
        `${field}.production_cutover`,
      ),
      requiredEvidenceKinds: [...expected],
    };
  }
  return {
    ...common,
    kind,
    assertionId: requireIdentifier(record.assertion_id, `${field}.assertion_id`),
    minimumEvidence: requireInteger(record.minimum_evidence, `${field}.minimum_evidence`, 1),
  };
}

function parseAcceptanceEvidence(value: unknown, field: string): AcceptanceEvidence {
  const record = requireRecord(value, field);
  const common = {
    requirementId: requireIdentifier(record.requirement_id, `${field}.requirement_id`),
    headSha: requireSha(record.head_sha, `${field}.head_sha`),
    result: requireLiteral(record.result, ['PASS'] as const, `${field}.result`),
    artifactUri: requireString(record.artifact_uri, `${field}.artifact_uri`),
    artifactSha256: requireSha256(record.artifact_sha256, `${field}.artifact_sha256`),
    observedAt: requireInstant(record.observed_at, `${field}.observed_at`),
    trust: parseEvidenceTrustBinding(record.trust, `${field}.trust`),
  };
  const kind = requireLiteral(
    record.kind,
    [
      'PROTECTED_MAIN_PARITY_CYCLE',
      'ENCRYPTED_RESTORE',
      'SHADOW_PARITY',
      'PRE_PRODUCTION_CUTOVER',
      'ROLLBACK',
      'ARTIFACT_ASSERTION',
    ] as const,
    `${field}.kind`,
  );
  if (kind === 'PROTECTED_MAIN_PARITY_CYCLE') {
    if (requireBoolean(record.zero_diff, `${field}.zero_diff`) !== true) {
      throw new Error(`${field}.zero_diff must be true`);
    }
    return {
      ...common,
      kind,
      protectedMainSha: requireSha(record.protected_main_sha, `${field}.protected_main_sha`),
      jsonlProjectionSha256: requireSha256(
        record.jsonl_projection_sha256,
        `${field}.jsonl_projection_sha256`,
      ),
      postgresProjectionSha256: requireSha256(
        record.postgres_projection_sha256,
        `${field}.postgres_projection_sha256`,
      ),
      commandLogSha256: requireSha256(record.command_log_sha256, `${field}.command_log_sha256`),
      zeroDiff: true,
      requiredChecksArtifactSha256: requireSha256(
        record.required_checks_artifact_sha256,
        `${field}.required_checks_artifact_sha256`,
      ),
    };
  }
  if (kind === 'ENCRYPTED_RESTORE') {
    if (requireBoolean(record.isolated_runner, `${field}.isolated_runner`) !== true) {
      throw new Error(`${field}.isolated_runner must be true`);
    }
    return {
      ...common,
      kind,
      ciphertextSha256: requireSha256(record.ciphertext_sha256, `${field}.ciphertext_sha256`),
      restoreLogSha256: requireSha256(record.restore_log_sha256, `${field}.restore_log_sha256`),
      schemaCheckSha256: requireSha256(record.schema_check_sha256, `${field}.schema_check_sha256`),
      rowCountCheckSha256: requireSha256(
        record.row_count_check_sha256,
        `${field}.row_count_check_sha256`,
      ),
      isolatedRunner: true,
    };
  }
  if (kind === 'SHADOW_PARITY') {
    if (requireBoolean(record.zero_diff, `${field}.zero_diff`) !== true) {
      throw new Error(`${field}.zero_diff must be true`);
    }
    return {
      ...common,
      kind,
      protectedMainSha: requireSha(record.protected_main_sha, `${field}.protected_main_sha`),
      jsonlProjectionSha256: requireSha256(
        record.jsonl_projection_sha256,
        `${field}.jsonl_projection_sha256`,
      ),
      postgresProjectionSha256: requireSha256(
        record.postgres_projection_sha256,
        `${field}.postgres_projection_sha256`,
      ),
      zeroDiff: true,
    };
  }
  if (kind === 'PRE_PRODUCTION_CUTOVER') {
    if (requireBoolean(record.production_mutation, `${field}.production_mutation`) !== false) {
      throw new Error(`${field}.production_mutation must be false`);
    }
    return {
      ...common,
      kind,
      environment: requireLiteral(
        record.environment,
        ['PRE_PRODUCTION'] as const,
        `${field}.environment`,
      ),
      productionMutation: false,
      selectorBefore: requireLiteral(
        record.selector_before,
        ['JSONL_PRIMARY'] as const,
        `${field}.selector_before`,
      ),
      selectorDuring: requireLiteral(
        record.selector_during,
        ['POSTGRES_PRIMARY'] as const,
        `${field}.selector_during`,
      ),
    };
  }
  if (kind === 'ROLLBACK') {
    if (requireBoolean(record.production_mutation, `${field}.production_mutation`) !== false) {
      throw new Error(`${field}.production_mutation must be false`);
    }
    return {
      ...common,
      kind,
      environment: requireLiteral(
        record.environment,
        ['PRE_PRODUCTION'] as const,
        `${field}.environment`,
      ),
      productionMutation: false,
      restoredAuthority: requireLiteral(
        record.restored_authority,
        ['JSONL_PRIMARY'] as const,
        `${field}.restored_authority`,
      ),
    };
  }
  return {
    ...common,
    kind,
    assertionId: requireIdentifier(record.assertion_id, `${field}.assertion_id`),
  };
}

function parseExternalBlocker(value: unknown, field: string): ExternalBlocker {
  const record = requireRecord(value, field);
  return {
    blockerId: requireIdentifier(record.blocker_id, `${field}.blocker_id`),
    owner: requireIdentifier(record.owner, `${field}.owner`),
    evidenceUri: requireString(record.evidence_uri, `${field}.evidence_uri`),
    observedAt: requireInstant(record.observed_at, `${field}.observed_at`),
    resolutionCondition: requireString(
      record.resolution_condition,
      `${field}.resolution_condition`,
    ),
  };
}

function parseAuthorityBoundary(value: unknown, field: string): AuthorityBoundary {
  const record = requireRecord(value, field);
  return {
    primaryAuthority: requireString(record.primary_authority, `${field}.primary_authority`),
    postgresRole: requireString(record.postgres_role, `${field}.postgres_role`),
    postgresPrimaryPolicy: requireString(
      record.postgres_primary_policy,
      `${field}.postgres_primary_policy`,
    ),
    productionCutover: requireBoolean(record.production_cutover, `${field}.production_cutover`),
  };
}

function parseOwnership(value: unknown, field: string): UnitOwnership {
  const record = requireRecord(value, field);
  const mandatoryReviewers = requireStringArray(
    record.mandatory_reviewers,
    `${field}.mandatory_reviewers`,
  );
  requireUniqueStrings(mandatoryReviewers, `${field}.mandatory_reviewers`);
  return {
    accountableRegistryOwner: requireNullableIdentifier(
      record.accountable_registry_owner,
      `${field}.accountable_registry_owner`,
    ),
    executionOwner: requireIdentifier(record.execution_owner, `${field}.execution_owner`),
    mandatoryReviewers,
  };
}

function parseCoClosureContract(value: unknown, field: string): SameRootCauseCoClosure {
  const record = requireRecord(value, field);
  const evidenceRefs = requireStringArray(record.evidence_refs, `${field}.evidence_refs`);
  requireUniqueStrings(evidenceRefs, `${field}.evidence_refs`);
  if (evidenceRefs.length === 0) {
    throw new Error(`${field}.evidence_refs must not be empty`);
  }
  return {
    kind: requireLiteral(record.kind, ['SAME_ROOT_CAUSE'] as const, `${field}.kind`),
    rootCauseKey: requireIdentifier(record.root_cause_key, `${field}.root_cause_key`),
    evidenceRefs,
  };
}

function parseIntegrationUnit(value: unknown, index: number): IntegrationUnit {
  const field = `capability_reconciliation.integration_units[${index}]`;
  const record = requireRecord(value, field);
  const state = requireLiteral(
    record.state,
    ['ASSESSING', 'READY', 'INTEGRATING', 'BLOCKED_EXTERNAL', 'VERIFIED'] as const,
    `${field}.state`,
  );
  const presence: EnhancedFieldPresence = {
    authorityTargets: hasOwn(record, 'authority_targets'),
    sourceSliceIds: hasOwn(record, 'source_slice_ids'),
    executionAttempt: hasOwn(record, 'execution_attempt'),
    externalBlocker: hasOwn(record, 'external_blocker'),
    acceptanceRequirements: hasOwn(record, 'acceptance_requirements'),
    acceptanceEvidence: hasOwn(record, 'acceptance_evidence'),
    ownership: hasOwn(record, 'ownership'),
    coClosureContract: hasOwn(record, 'co_closure_contract'),
  };
  const executionAttemptRecord = requireOptionalNullableRecord(
    record,
    'execution_attempt',
    `${field}.execution_attempt`,
  );
  const externalBlockerRecord = requireOptionalNullableRecord(
    record,
    'external_blocker',
    `${field}.external_blocker`,
  );
  const authorityBoundaryRecord = requireOptionalNullableRecord(
    record,
    'authority_boundary',
    `${field}.authority_boundary`,
  );
  const ownershipRecord = requireOptionalNullableRecord(record, 'ownership', `${field}.ownership`);
  const coClosureRecord = requireOptionalNullableRecord(
    record,
    'co_closure_contract',
    `${field}.co_closure_contract`,
  );
  const findingBinding = requireRecord(record.finding_binding, `${field}.finding_binding`);
  const legacySourceIds = hasOwn(record, 'source_ids')
    ? requireStringArray(record.source_ids, `${field}.source_ids`)
    : [];
  const legacyDerivedFrom = hasOwn(record, 'derived_from')
    ? requireStringArray(record.derived_from, `${field}.derived_from`)
    : [];
  const dependsOn = requireStringArray(record.depends_on, `${field}.depends_on`);
  const findingIds = requireStringArray(
    findingBinding.finding_ids,
    `${field}.finding_binding.finding_ids`,
  );
  const findingBindingStatus = requireLiteral(
    findingBinding.status,
    ['BOUND', 'CREATE_REQUIRED', 'NOT_REQUIRED'] as const,
    `${field}.finding_binding.status`,
  );
  requireUniqueStrings(legacySourceIds, `${field}.source_ids`);
  requireUniqueStrings(legacyDerivedFrom, `${field}.derived_from`);
  requireUniqueStrings(dependsOn, `${field}.depends_on`);
  requireUniqueStrings(findingIds, `${field}.finding_binding.finding_ids`);
  return {
    id: requireIdentifier(record.id, `${field}.id`),
    state,
    legacySourceIds,
    legacyDerivedFrom,
    dependsOn,
    authorityTargets: presence.authorityTargets
      ? requireArray(record.authority_targets, `${field}.authority_targets`).map(
          (entry, targetIndex) =>
            parseAuthorityTarget(entry, `${field}.authority_targets[${targetIndex}]`),
        )
      : [],
    sourceSliceIds: presence.sourceSliceIds
      ? requireStringArray(record.source_slice_ids, `${field}.source_slice_ids`)
      : [],
    executionAttempt:
      executionAttemptRecord === null
        ? null
        : parseExecutionAttempt(executionAttemptRecord, `${field}.execution_attempt`),
    externalBlocker:
      externalBlockerRecord === null
        ? null
        : parseExternalBlocker(externalBlockerRecord, `${field}.external_blocker`),
    acceptanceRequirements: presence.acceptanceRequirements
      ? requireArray(record.acceptance_requirements, `${field}.acceptance_requirements`).map(
          (entry, requirementIndex) =>
            parseAcceptanceRequirement(
              entry,
              `${field}.acceptance_requirements[${requirementIndex}]`,
            ),
        )
      : [],
    acceptanceEvidence: presence.acceptanceEvidence
      ? requireArray(record.acceptance_evidence, `${field}.acceptance_evidence`).map(
          (entry, evidenceIndex) =>
            parseAcceptanceEvidence(entry, `${field}.acceptance_evidence[${evidenceIndex}]`),
        )
      : [],
    findingIds,
    findingBindingStatus,
    ownership:
      ownershipRecord === null ? null : parseOwnership(ownershipRecord, `${field}.ownership`),
    coClosureContract:
      coClosureRecord === null
        ? null
        : parseCoClosureContract(coClosureRecord, `${field}.co_closure_contract`),
    mainEvidence: requireArray(record.main_evidence, `${field}.main_evidence`).map(
      (entry, evidenceIndex) =>
        parseMainEvidence(entry, `${field}.main_evidence[${evidenceIndex}]`),
    ),
    gateProfile: requireIdentifier(record.gate_profile, `${field}.gate_profile`),
    gateResults: requireArray(record.gate_results, `${field}.gate_results`).map(
      (entry, resultIndex) => parseGateResult(entry, `${field}.gate_results[${resultIndex}]`),
    ),
    authorityBoundary:
      authorityBoundaryRecord === null
        ? null
        : parseAuthorityBoundary(authorityBoundaryRecord, `${field}.authority_boundary`),
    enhancedFieldPresence: presence,
    legacyOwnerPresent: hasOwn(record, 'owner'),
  };
}

function parseGateProfiles(value: unknown): GateProfile[] {
  const profiles = requireRecord(value, 'capability_reconciliation.gate_profiles');
  return Object.entries(profiles).map(([id, rawProfile]) => {
    const profile = requireRecord(rawProfile, `capability_reconciliation.gate_profiles.${id}`);
    const requiredGateIds = requireStringArray(
      profile.required_gate_ids,
      `capability_reconciliation.gate_profiles.${id}.required_gate_ids`,
    );
    requireUniqueStrings(
      requiredGateIds,
      `capability_reconciliation.gate_profiles.${id}.required_gate_ids`,
    );
    const rawContracts = requireRecord(
      profile.evidence_contracts,
      `capability_reconciliation.gate_profiles.${id}.evidence_contracts`,
    );
    if (!sameStringSet(Object.keys(rawContracts), requiredGateIds)) {
      throw new Error(
        `capability_reconciliation.gate_profiles.${id}.evidence_contracts must exactly cover required_gate_ids`,
      );
    }
    const evidenceContracts: Record<string, GateEvidenceKind> = {};
    for (const gateId of requiredGateIds) {
      evidenceContracts[gateId] = requireLiteral(
        rawContracts[gateId],
        ['GITHUB_CHECK', 'COMMAND_RESULT', 'FINDING_STATE', 'CAPABILITY_ASSERTION'] as const,
        `capability_reconciliation.gate_profiles.${id}.evidence_contracts.${gateId}`,
      );
    }
    return {
      id: requireIdentifier(id, 'gate profile id'),
      requiredGateIds,
      evidenceContracts,
    };
  });
}

export function parseIntegrationEvidenceManifest(value: unknown): IntegrationEvidenceManifest {
  const root = requireRecord(value, 'manifest');
  const reconciliation = requireRecord(root.capability_reconciliation, 'capability_reconciliation');
  const sourceInventory = parseInventoryManifest(value);
  const integrationOrder = requireStringArray(
    reconciliation.integration_order,
    'capability_reconciliation.integration_order',
  );
  requireUniqueStrings(integrationOrder, 'capability_reconciliation.integration_order');
  return {
    sourceSchemaVersion: sourceInventory.schemaVersion,
    requiredStatusManifestPath: requireRepoPath(
      root.required_status_checks_manifest,
      'required_status_checks_manifest',
    ),
    integrationOrder,
    units: requireArray(
      reconciliation.integration_units,
      'capability_reconciliation.integration_units',
    ).map(parseIntegrationUnit),
    sources: sourceInventory.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      role: source.role,
      headSha: source.headSha,
      contentSha256: 'contentSha256' in source ? source.contentSha256 : null,
      mainProof: source.mainProof ?? null,
    })),
    sourceSlices: hasOwn(reconciliation, 'source_slices')
      ? requireArray(reconciliation.source_slices, 'capability_reconciliation.source_slices').map(
          parseSourceSlice,
        )
      : [],
    gateProfiles: parseGateProfiles(reconciliation.gate_profiles),
  };
}

export function parseRequiredStatusContract(raw: Buffer | string): RequiredStatusContract {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  const root = requireRecord(parsed, 'required status manifest');
  const checks = requireRecord(
    root.required_status_checks,
    'required status manifest.required_status_checks',
  );
  const contexts = requireStringArray(
    checks.contexts,
    'required status manifest.required_status_checks.contexts',
  );
  requireUniqueStrings(contexts, 'required status manifest.required_status_checks.contexts');
  if (contexts.length === 0) {
    throw new Error('required status manifest contexts must not be empty');
  }
  return {
    digestSha256: createHash('sha256').update(bytes).digest('hex'),
    repository: requireRepository(root.repository, 'required status manifest.repository'),
    contexts,
  };
}

export function computeExecutionAttemptId(input: {
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  requiredStatusManifestSha256: string;
  workflowRunId: number;
  workflowRunAttempt: number;
}): string {
  const canonical = [
    'aqua-capability-integration-attempt/v2',
    input.repository,
    String(input.pullRequestNumber),
    input.headSha,
    input.requiredStatusManifestSha256,
    String(input.workflowRunId),
    String(input.workflowRunAttempt),
  ].join('\0');
  return `attempt-sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function addIssue(issues: ValidationIssue[], code: string, message: string, unitId?: string): void {
  issues.push(unitId === undefined ? { code, message } : { code, message, unitId });
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((entry) => rightSet.has(entry));
}

function isGitHubWorkflowPath(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/.test(path);
}

function isTrustedGitHubWorkflowIdentity(identity: string, repository: string): boolean {
  const prefix = `https://github.com/${repository}/.github/workflows/`;
  const suffix = '@refs/heads/main';
  if (!identity.startsWith(prefix) || !identity.endsWith(suffix)) {
    return false;
  }
  const workflowName = identity.slice(prefix.length, -suffix.length);
  return /^[^/]+\.(?:yml|yaml)$/.test(workflowName);
}

function validateTrustBindingStatic(
  trust: EvidenceTrustBinding,
  expectedDigest: string,
  expectedHeadSha: string,
  requiredStatus: RequiredStatusContract,
  issues: ValidationIssue[],
  unitId: string,
  evidenceCoordinate: string,
): void {
  if (trust.repository !== requiredStatus.repository || trust.headSha !== expectedHeadSha) {
    addIssue(
      issues,
      'EVIDENCE_TRUST_IDENTITY_MISMATCH',
      `${evidenceCoordinate} trust must bind repository ${requiredStatus.repository} and head ${expectedHeadSha}`,
      unitId,
    );
  }
  if (trust.kind === 'GITHUB_ACTIONS_ARTIFACT') {
    if (trust.artifactSha256 !== expectedDigest) {
      addIssue(
        issues,
        'EVIDENCE_TRUST_DIGEST_MISMATCH',
        `${evidenceCoordinate} Actions artifact digest does not bind the claimed evidence`,
        unitId,
      );
    }
    if (!isGitHubWorkflowPath(trust.workflowPath)) {
      addIssue(
        issues,
        'EVIDENCE_TRUST_WORKFLOW_INVALID',
        `${evidenceCoordinate} Actions artifact must name a root .github/workflows/*.yml workflow`,
        unitId,
      );
    }
    return;
  }
  if (trust.subjectSha256 !== expectedDigest) {
    addIssue(
      issues,
      'EVIDENCE_TRUST_DIGEST_MISMATCH',
      `${evidenceCoordinate} Sigstore subject digest does not bind the claimed evidence`,
      unitId,
    );
  }
  if (
    trust.issuer !== GITHUB_OIDC_ISSUER ||
    !isTrustedGitHubWorkflowIdentity(trust.signerIdentity, requiredStatus.repository)
  ) {
    addIssue(
      issues,
      'SIGSTORE_GITHUB_IDENTITY_INVALID',
      `${evidenceCoordinate} Sigstore bundle must use the GitHub OIDC issuer and an exact main workflow identity`,
      unitId,
    );
  }
}

function validateEvidenceTrustBindings(
  manifest: IntegrationEvidenceManifest,
  requiredStatus: RequiredStatusContract,
  issues: ValidationIssue[],
): void {
  for (const unit of manifest.units) {
    for (const result of unit.gateResults) {
      for (const evidence of result.evidence) {
        if (evidence.kind === 'GITHUB_CHECK') {
          continue;
        }
        const expectedDigest =
          evidence.kind === 'FINDING_STATE' ? evidence.registryTipSha256 : evidence.artifactSha256;
        validateTrustBindingStatic(
          evidence.trust,
          expectedDigest,
          evidence.headSha,
          requiredStatus,
          issues,
          unit.id,
          `${unit.id}/${result.gateId}`,
        );
      }
    }
    for (const evidence of unit.acceptanceEvidence) {
      validateTrustBindingStatic(
        evidence.trust,
        evidence.artifactSha256,
        evidence.headSha,
        requiredStatus,
        issues,
        unit.id,
        `${unit.id}/${evidence.requirementId}/${evidence.kind}`,
      );
    }
  }
}

function targetCanonicalKey(target: AuthorityTarget): string {
  switch (target.kind) {
    case 'FILE_PATH':
      return `FILE_PATH:${target.path}`;
    case 'FILE_GLOB':
      return `FILE_GLOB:${target.pattern}`;
    case 'SYMBOL':
      return `SYMBOL:${target.filePath}#${target.symbol}`;
    case 'DB_TABLE':
      return `DB_TABLE:${target.schema}.${target.table}`;
    case 'HTTP_ROUTE':
      return `HTTP_ROUTE:${target.method} ${target.route.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, '{}')}`;
    case 'WORKFLOW_JOB':
      return `WORKFLOW_JOB:${target.workflowPath}#${target.jobId}`;
    case 'RUNTIME_RESOURCE':
      return `RUNTIME_RESOURCE:${target.resourceType}:${target.resourceId}`;
    case 'POLICY':
      return `POLICY:${target.policyId}`;
  }
}

function targetFileCoordinate(
  target: AuthorityTarget,
): { kind: 'PATH' | 'GLOB' | 'PART'; value: string } | null {
  switch (target.kind) {
    case 'FILE_PATH':
      return { kind: 'PATH', value: target.path };
    case 'FILE_GLOB':
      return { kind: 'GLOB', value: target.pattern };
    case 'SYMBOL':
      return { kind: 'PART', value: target.filePath };
    case 'WORKFLOW_JOB':
      return { kind: 'PART', value: target.workflowPath };
    default:
      return null;
  }
}

function globMatchesPath(glob: string, path: string): boolean {
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  const prefix = glob.slice(0, -2);
  if (!path.startsWith(`${prefix}/`)) {
    return false;
  }
  return !path.slice(prefix.length + 1).includes('/');
}

function globsOverlap(left: string, right: string): boolean {
  const leftPrefix = left.slice(0, left.endsWith('/**') ? -3 : -2);
  const rightPrefix = right.slice(0, right.endsWith('/**') ? -3 : -2);
  if (left === right) {
    return true;
  }
  return globMatchesPath(left, rightPrefix) || globMatchesPath(right, leftPrefix);
}

function authorityTargetsCollide(left: AuthorityTarget, right: AuthorityTarget): boolean {
  if (targetCanonicalKey(left) === targetCanonicalKey(right)) {
    return true;
  }
  const leftFile = targetFileCoordinate(left);
  const rightFile = targetFileCoordinate(right);
  if (leftFile === null || rightFile === null) {
    return false;
  }
  if (leftFile.kind === 'GLOB' && rightFile.kind === 'GLOB') {
    return globsOverlap(leftFile.value, rightFile.value);
  }
  if (leftFile.kind === 'GLOB') {
    return globMatchesPath(leftFile.value, rightFile.value);
  }
  if (rightFile.kind === 'GLOB') {
    return globMatchesPath(rightFile.value, leftFile.value);
  }
  if (leftFile.value !== rightFile.value) {
    return false;
  }
  return leftFile.kind === 'PATH' || rightFile.kind === 'PATH';
}

function validateTopology(
  manifest: IntegrationEvidenceManifest,
  issues: ValidationIssue[],
): Map<string, IntegrationUnit> {
  const unitsById = new Map<string, IntegrationUnit>();
  for (const unit of manifest.units) {
    if (unitsById.has(unit.id)) {
      addIssue(issues, 'DUPLICATE_UNIT_ID', `integration unit ${unit.id} is duplicated`, unit.id);
    }
    unitsById.set(unit.id, unit);
  }
  if (!sameStringSet(manifest.integrationOrder, [...unitsById.keys()])) {
    addIssue(
      issues,
      'INTEGRATION_ORDER_SET_MISMATCH',
      'integration_order must contain every integration unit exactly once and no other IDs',
    );
  }
  const orderIndex = new Map(manifest.integrationOrder.map((id, index) => [id, index]));
  for (const unit of manifest.units) {
    for (const dependencyId of unit.dependsOn) {
      const dependency = unitsById.get(dependencyId);
      if (dependency === undefined) {
        addIssue(
          issues,
          'UNKNOWN_DEPENDENCY_UNIT',
          `${unit.id} depends_on references unknown unit ${dependencyId}`,
          unit.id,
        );
        continue;
      }
      const dependencyIndex = orderIndex.get(dependencyId);
      const unitIndex = orderIndex.get(unit.id);
      if (
        dependencyIndex !== undefined &&
        unitIndex !== undefined &&
        dependencyIndex >= unitIndex
      ) {
        addIssue(
          issues,
          'DEPENDENCY_ORDER_VIOLATION',
          `${dependencyId} must precede ${unit.id} in integration_order`,
          unit.id,
        );
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (unitId: string): void => {
    if (visiting.has(unitId)) {
      addIssue(issues, 'DEPENDENCY_CYCLE', `depends_on cycle includes ${unitId}`, unitId);
      return;
    }
    if (visited.has(unitId)) {
      return;
    }
    visiting.add(unitId);
    const unit = unitsById.get(unitId);
    if (unit !== undefined) {
      for (const dependencyId of unit.dependsOn) {
        if (unitsById.has(dependencyId)) {
          visit(dependencyId);
        }
      }
    }
    visiting.delete(unitId);
    visited.add(unitId);
  };
  for (const unitId of unitsById.keys()) {
    visit(unitId);
  }
  return unitsById;
}

function validateAuthorityTargets(
  manifest: IntegrationEvidenceManifest,
  issues: ValidationIssue[],
): void {
  const claimed: Array<{ unitId: string; target: AuthorityTarget }> = [];
  for (const unit of manifest.units) {
    if (unit.state !== 'ASSESSING') {
      if (!unit.enhancedFieldPresence.authorityTargets || unit.authorityTargets.length === 0) {
        addIssue(
          issues,
          'AUTHORITY_TARGETS_REQUIRED',
          `${unit.id} must declare at least one typed authority target before ${unit.state}`,
          unit.id,
        );
      }
      if (unit.authorityTargets.some((target) => target.resolution !== 'RESOLVED')) {
        addIssue(
          issues,
          'AUTHORITY_TARGET_UNRESOLVED',
          `${unit.id} has an unresolved authority target`,
          unit.id,
        );
      }
    }
    for (const target of unit.authorityTargets) {
      const canonicalTarget = targetCanonicalKey(target);
      if (
        /(?:^|[:/])SRC-[A-Z0-9-]+/.test(canonicalTarget) ||
        canonicalTarget.includes('refs/heads/') ||
        canonicalTarget.includes('refs/remotes/') ||
        canonicalTarget.includes('/tmp/')
      ) {
        addIssue(
          issues,
          'SOURCE_CANNOT_BE_BEHAVIOR_AUTHORITY',
          `${unit.id} authority target ${canonicalTarget} names source provenance instead of behavior`,
          unit.id,
        );
      }
      for (const prior of claimed) {
        if (authorityTargetsCollide(prior.target, target)) {
          addIssue(
            issues,
            'AUTHORITY_TARGET_COLLISION',
            `${unit.id} target ${targetCanonicalKey(target)} collides with ${prior.unitId} target ${targetCanonicalKey(prior.target)}`,
            unit.id,
          );
        }
      }
      claimed.push({ unitId: unit.id, target });
    }
  }
}

function validateSourceSlices(
  manifest: IntegrationEvidenceManifest,
  issues: ValidationIssue[],
): Map<string, SourceSlice> {
  const sourcesById = new Map(manifest.sources.map((source) => [source.id, source]));
  const slicesById = new Map<string, SourceSlice>();
  for (const slice of manifest.sourceSlices) {
    if (slicesById.has(slice.id)) {
      addIssue(issues, 'DUPLICATE_SOURCE_SLICE', `source slice ${slice.id} is duplicated`);
    }
    slicesById.set(slice.id, slice);
    if (!sourcesById.has(slice.sourceId)) {
      addIssue(
        issues,
        'SOURCE_SLICE_UNKNOWN_SOURCE',
        `${slice.id} references unknown source ${slice.sourceId}`,
      );
    }
    const source = sourcesById.get(slice.sourceId);
    if (source !== undefined && !isCapabilityIntegrationSource(source)) {
      addIssue(
        issues,
        'SOURCE_ROLE_NOT_INTEGRATION_CANDIDATE',
        `${slice.id} references ${source.role} source ${source.id}, outside the capability-integration lane`,
      );
    }
    if (
      source !== undefined &&
      slice.selector.kind === 'WHOLE_TREE_PROOF' &&
      slice.selector.sourceCommitSha !== source.headSha
    ) {
      addIssue(
        issues,
        'WHOLE_TREE_SOURCE_HEAD_MISMATCH',
        `${slice.id} WHOLE_TREE_PROOF must attest exact source head ${source.headSha}`,
      );
    }
    if (slice.selectorSha256 !== slice.computedSelectorSha256) {
      addIssue(
        issues,
        'SOURCE_SLICE_SELECTOR_DIGEST_MISMATCH',
        `${slice.id}.selector_sha256 does not match its canonical selector`,
      );
    }
  }
  const owners = new Map<string, string>();
  for (const unit of manifest.units) {
    for (const sourceId of unit.legacySourceIds) {
      const source = sourcesById.get(sourceId);
      if (source === undefined) {
        addIssue(
          issues,
          'LEGACY_UNKNOWN_SOURCE_ID',
          `${unit.id}.source_ids references unknown source ${sourceId}`,
          unit.id,
        );
      } else if (!isCapabilityIntegrationSource(source)) {
        addIssue(
          issues,
          'SOURCE_ROLE_NOT_INTEGRATION_CANDIDATE',
          `${unit.id}.source_ids references ${source.role} source ${source.id}, outside the capability-integration lane`,
          unit.id,
        );
      }
    }
    const refs = unit.sourceSliceIds;
    if (new Set(refs).size !== refs.length) {
      addIssue(
        issues,
        'DUPLICATE_UNIT_SOURCE_SLICE_ID',
        `${unit.id} repeats a source_slice_id`,
        unit.id,
      );
    }
    for (const sliceId of refs) {
      const slice = slicesById.get(sliceId);
      if (slice === undefined) {
        addIssue(
          issues,
          'UNKNOWN_SOURCE_SLICE_ID',
          `${unit.id} references unknown source slice ${sliceId}`,
          unit.id,
        );
        continue;
      }
      const priorOwner = owners.get(sliceId);
      if (priorOwner !== undefined && priorOwner !== unit.id) {
        addIssue(
          issues,
          'SOURCE_SLICE_AUTHORITY_COLLISION',
          `${sliceId} is claimed by both ${priorOwner} and ${unit.id}`,
          unit.id,
        );
      }
      owners.set(sliceId, unit.id);
      if (unit.state !== 'ASSESSING' && slice.resolution !== 'RESOLVED') {
        addIssue(
          issues,
          'SOURCE_SLICE_UNRESOLVED',
          `${unit.id} cannot advance with unresolved source slice ${sliceId}`,
          unit.id,
        );
      }
    }
    if (unit.state !== 'ASSESSING') {
      if (!unit.enhancedFieldPresence.sourceSliceIds) {
        addIssue(
          issues,
          'SOURCE_SLICE_IDS_REQUIRED',
          `${unit.id} must explicitly declare source_slice_ids before ${unit.state}`,
          unit.id,
        );
      }
      if (unit.legacySourceIds.length > 0) {
        addIssue(
          issues,
          'LEGACY_SOURCE_IDS_FORBIDDEN',
          `${unit.id}.source_ids is branch-level provenance and must be replaced by source_slice_ids`,
          unit.id,
        );
      }
      if (unit.legacyDerivedFrom.length > 0) {
        addIssue(
          issues,
          'LEGACY_DERIVED_FROM_FORBIDDEN',
          `${unit.id}.derived_from duplicates depends_on and must be removed`,
          unit.id,
        );
      }
    }
    for (const evidence of unit.mainEvidence) {
      if (evidence.kind === 'MAIN_COMMIT') {
        continue;
      }
      const sliceId = evidence.sourceSliceId;
      if (unit.state !== 'ASSESSING' && sliceId === null) {
        addIssue(
          issues,
          'TYPED_MAIN_SOURCE_SLICE_REQUIRED',
          `${unit.id}/${evidence.kind} must bind source_slice_id before ${unit.state}`,
          unit.id,
        );
      }
      if (
        unit.state !== 'ASSESSING' &&
        ((evidence.kind === 'SOURCE_MAIN_PROOF' &&
          (evidence.legacySourceId !== null || evidence.legacyProofKind !== null)) ||
          (evidence.kind === 'CHAINED_TREE_EQUIVALENT' &&
            (evidence.legacySourceId !== null ||
              evidence.legacyStackHeadSha !== null ||
              evidence.legacyStackTreeSha !== null ||
              evidence.legacyMainCommitSha !== null ||
              evidence.legacyMainTreeSha !== null)))
      ) {
        addIssue(
          issues,
          'LEGACY_MAIN_SOURCE_EVIDENCE_FORBIDDEN',
          `${unit.id}/${evidence.kind} duplicates typed source-slice provenance`,
          unit.id,
        );
      }
      if (sliceId === null) {
        continue;
      }
      const slice = slicesById.get(sliceId);
      if (slice === undefined || !unit.sourceSliceIds.includes(sliceId)) {
        addIssue(
          issues,
          'MAIN_EVIDENCE_SOURCE_SLICE_NOT_OWNED',
          `${unit.id}/${evidence.kind} references a slice outside source_slice_ids`,
          unit.id,
        );
        continue;
      }
      if (
        (evidence.kind === 'SOURCE_MAIN_PROOF' || evidence.kind === 'CHAINED_TREE_EQUIVALENT') &&
        slice.selector.kind !== 'WHOLE_TREE_PROOF'
      ) {
        addIssue(
          issues,
          'MAIN_TREE_EVIDENCE_SELECTOR_INVALID',
          `${unit.id}/${evidence.kind} requires a WHOLE_TREE_PROOF selector`,
          unit.id,
        );
      }
      if (evidence.kind === 'SLICE_BLOB_EQ') {
        if (slice.selector.kind !== 'PATH_BLOB_SET') {
          addIssue(
            issues,
            'SLICE_BLOB_SELECTOR_INVALID',
            `${unit.id}/SLICE_BLOB_EQ requires a PATH_BLOB_SET selector`,
            unit.id,
          );
          continue;
        }
        const sourceBlobsByPath = new Map<string, string>();
        const mainBlobsByPath = new Map<string, string>();
        let duplicatePath = false;
        for (const entry of slice.selector.entries) {
          const blobsByPath = entry.lineage === 'SOURCE' ? sourceBlobsByPath : mainBlobsByPath;
          if (blobsByPath.has(entry.path)) {
            duplicatePath = true;
          }
          blobsByPath.set(entry.path, entry.blobSha);
        }
        const exactPathAlignedEquality =
          !duplicatePath &&
          sourceBlobsByPath.size > 0 &&
          sourceBlobsByPath.size === mainBlobsByPath.size &&
          [...sourceBlobsByPath].every(([path, blobSha]) => mainBlobsByPath.get(path) === blobSha);
        if (!exactPathAlignedEquality) {
          addIssue(
            issues,
            'SLICE_BLOB_EQUIVALENCE_MISSING',
            `${unit.id}/SLICE_BLOB_EQ selector must contain one exact SOURCE and MAIN blob for every identical path`,
            unit.id,
          );
        }
      }
    }
  }
  for (const slice of manifest.sourceSlices) {
    if (slice.purpose === 'IMPLEMENTATION_CANDIDATE' && !owners.has(slice.id)) {
      addIssue(
        issues,
        'IMPLEMENTATION_SOURCE_SLICE_UNOWNED',
        `${slice.id} is an implementation candidate but no integration unit references it`,
      );
    }
  }
  return slicesById;
}

function validateExecutionState(
  manifest: IntegrationEvidenceManifest,
  requiredStatus: RequiredStatusContract,
  unitsById: ReadonlyMap<string, IntegrationUnit>,
  issues: ValidationIssue[],
): void {
  const profiles = new Map(manifest.gateProfiles.map((profile) => [profile.id, profile]));
  for (const unit of manifest.units) {
    const profile = profiles.get(unit.gateProfile);
    if (profile === undefined) {
      addIssue(
        issues,
        'UNKNOWN_GATE_PROFILE',
        `${unit.id} uses unknown gate profile ${unit.gateProfile}`,
        unit.id,
      );
      continue;
    }
    const advanced = unit.state !== 'ASSESSING';
    if (advanced) {
      for (const [field, present] of Object.entries(unit.enhancedFieldPresence)) {
        if (!present) {
          addIssue(
            issues,
            'ADVANCED_FIELD_MISSING',
            `${unit.id}.${field} must be explicit before ${unit.state}`,
            unit.id,
          );
        }
      }
      for (const dependencyId of unit.dependsOn) {
        const dependency = unitsById.get(dependencyId);
        if (dependency !== undefined && dependency.state !== 'VERIFIED') {
          addIssue(
            issues,
            'DEPENDENCY_NOT_VERIFIED',
            `${unit.id} cannot be ${unit.state} while ${dependencyId} is ${dependency.state}`,
            unit.id,
          );
        }
      }
    }
    if (unit.state === 'ASSESSING' || unit.state === 'READY') {
      if (unit.executionAttempt !== null) {
        addIssue(
          issues,
          'EXECUTION_ATTEMPT_FORBIDDEN',
          `${unit.id}.execution_attempt must be null while ${unit.state}`,
          unit.id,
        );
      }
      if (unit.gateResults.length > 0 || unit.acceptanceEvidence.length > 0) {
        addIssue(
          issues,
          'PRE_ATTEMPT_EVIDENCE_FORBIDDEN',
          `${unit.id} cannot retain gate or acceptance evidence without an execution attempt`,
          unit.id,
        );
      }
    } else if (unit.executionAttempt === null) {
      addIssue(
        issues,
        'EXECUTION_ATTEMPT_REQUIRED',
        `${unit.id}.execution_attempt is mandatory while ${unit.state}`,
        unit.id,
      );
    }
    if (unit.state === 'BLOCKED_EXTERNAL') {
      if (unit.externalBlocker === null) {
        addIssue(
          issues,
          'EXTERNAL_BLOCKER_REQUIRED',
          `${unit.id}.external_blocker is mandatory while BLOCKED_EXTERNAL`,
          unit.id,
        );
      }
    } else if (unit.externalBlocker !== null) {
      addIssue(
        issues,
        'EXTERNAL_BLOCKER_FORBIDDEN',
        `${unit.id}.external_blocker is only valid while BLOCKED_EXTERNAL`,
        unit.id,
      );
    }
    const attempt = unit.executionAttempt;
    if (attempt !== null) {
      const expectedId = computeExecutionAttemptId({
        repository: attempt.repository,
        pullRequestNumber: attempt.pullRequestNumber,
        headSha: attempt.headSha,
        requiredStatusManifestSha256: attempt.requiredStatusManifestSha256,
        workflowRunId: attempt.workflowRunId,
        workflowRunAttempt: attempt.workflowRunAttempt,
      });
      if (attempt.attemptId !== expectedId) {
        addIssue(
          issues,
          'EXECUTION_ATTEMPT_ID_INVALID',
          `${unit.id}.execution_attempt.attempt_id is not the content address of its immutable identity`,
          unit.id,
        );
      }
      if (attempt.repository !== requiredStatus.repository) {
        addIssue(
          issues,
          'EXECUTION_REPOSITORY_MISMATCH',
          `${unit.id} attempt repository ${attempt.repository} does not match ${requiredStatus.repository}`,
          unit.id,
        );
      }
      if (attempt.requiredStatusManifestSha256 !== requiredStatus.digestSha256) {
        addIssue(
          issues,
          'REQUIRED_STATUS_DIGEST_MISMATCH',
          `${unit.id} attempt is not bound to the current required-status manifest`,
          unit.id,
        );
      }
      for (const result of unit.gateResults) {
        if (result.headSha !== attempt.headSha) {
          addIssue(
            issues,
            'GATE_RESULT_HEAD_MISMATCH',
            `${unit.id}/${result.gateId} is for ${result.headSha}, not ${attempt.headSha}`,
            unit.id,
          );
        }
        for (const evidence of result.evidence) {
          if (evidence.headSha !== attempt.headSha) {
            addIssue(
              issues,
              'GATE_EVIDENCE_HEAD_MISMATCH',
              `${unit.id}/${result.gateId} evidence is for ${evidence.headSha}, not ${attempt.headSha}`,
              unit.id,
            );
          }
        }
      }
      for (const evidence of unit.acceptanceEvidence) {
        if (evidence.headSha !== attempt.headSha) {
          addIssue(
            issues,
            'ACCEPTANCE_EVIDENCE_HEAD_MISMATCH',
            `${unit.id} acceptance evidence is for ${evidence.headSha}, not ${attempt.headSha}`,
            unit.id,
          );
        }
      }
    }
    const resultIds = unit.gateResults.map((result) => result.gateId);
    if (new Set(resultIds).size !== resultIds.length) {
      addIssue(issues, 'DUPLICATE_GATE_RESULT', `${unit.id} has duplicate gate_results`, unit.id);
    }
    for (const result of unit.gateResults) {
      if (!profile.requiredGateIds.includes(result.gateId)) {
        addIssue(
          issues,
          'UNDECLARED_GATE_RESULT',
          `${unit.id} records undeclared gate ${result.gateId}`,
          unit.id,
        );
        continue;
      }
      const expectedEvidenceKind = profile.evidenceContracts[result.gateId];
      if (
        result.status === 'PASS' &&
        (result.evidence.length === 0 ||
          result.evidence.some((evidence) => evidence.kind !== expectedEvidenceKind))
      ) {
        addIssue(
          issues,
          'GATE_EVIDENCE_CONTRACT_MISMATCH',
          `${unit.id}/${result.gateId} PASS evidence must use ${String(expectedEvidenceKind)}`,
          unit.id,
        );
      }
      if (
        result.status === 'PASS' &&
        result.evidence.some(
          (evidence) => evidence.kind === 'COMMAND_RESULT' && evidence.exitCode !== 0,
        )
      ) {
        addIssue(
          issues,
          'PASS_COMMAND_EXIT_NONZERO',
          `${unit.id}/${result.gateId} cannot PASS with a non-zero command result`,
          unit.id,
        );
      }
    }
    if (unit.state === 'VERIFIED') {
      if (!sameStringSet(resultIds, profile.requiredGateIds)) {
        addIssue(
          issues,
          'VERIFIED_GATE_SET_INCOMPLETE',
          `${unit.id} must have exactly one result for every required gate`,
          unit.id,
        );
      }
      if (unit.gateResults.some((result) => result.status !== 'PASS')) {
        addIssue(
          issues,
          'VERIFIED_GATE_NOT_PASSING',
          `${unit.id} has a non-PASS required gate`,
          unit.id,
        );
      }
      const exactHeadResult = unit.gateResults.find(
        (result) => result.gateId === 'exact-head-actions-green',
      );
      const checkEvidence =
        exactHeadResult?.evidence.filter(
          (evidence): evidence is GitHubCheckEvidence => evidence.kind === 'GITHUB_CHECK',
        ) ?? [];
      const checkContexts = checkEvidence.map((evidence) => evidence.context);
      if (
        new Set(checkContexts).size !== checkContexts.length ||
        !sameStringSet(checkContexts, requiredStatus.contexts)
      ) {
        addIssue(
          issues,
          'REQUIRED_CHECK_CONTEXT_MISMATCH',
          `${unit.id} exact-head check identities must exactly equal the required-status manifest contexts`,
          unit.id,
        );
      }
      if (
        checkEvidence.some(
          (evidence) =>
            evidence.repository !== requiredStatus.repository || evidence.conclusion !== 'SUCCESS',
        )
      ) {
        addIssue(
          issues,
          'REQUIRED_CHECK_IDENTITY_INVALID',
          `${unit.id} has required-check evidence for a different repository or conclusion`,
          unit.id,
        );
      }
      if (attempt?.mergeEvidence === null || attempt === null) {
        addIssue(
          issues,
          'VERIFIED_MERGE_EVIDENCE_REQUIRED',
          `${unit.id} requires merge evidence before VERIFIED`,
          unit.id,
        );
      }
    }
  }
}

function validateOwnershipAndCoClosure(
  manifest: IntegrationEvidenceManifest,
  issues: ValidationIssue[],
): void {
  for (const unit of manifest.units) {
    if (
      (unit.findingBindingStatus === 'BOUND' && unit.findingIds.length === 0) ||
      (unit.findingBindingStatus !== 'BOUND' && unit.findingIds.length > 0)
    ) {
      addIssue(
        issues,
        'FINDING_BINDING_STATE_INVALID',
        `${unit.id} finding IDs must be non-empty exactly when finding_binding.status is BOUND`,
        unit.id,
      );
    }
    if (unit.state !== 'ASSESSING' && unit.ownership === null) {
      addIssue(
        issues,
        'EXECUTION_OWNERSHIP_REQUIRED',
        `${unit.id} must bind its accountable owner to a dispatchable execution identity`,
        unit.id,
      );
    }
    if (unit.state !== 'ASSESSING' && unit.legacyOwnerPresent) {
      addIssue(
        issues,
        'LEGACY_OWNER_AUTHORITY_DUPLICATE',
        `${unit.id} must remove legacy owner after ownership becomes authoritative`,
        unit.id,
      );
    }
    const ownership = unit.ownership;
    if (ownership !== null) {
      if (unit.findingBindingStatus === 'BOUND' && ownership.accountableRegistryOwner === null) {
        addIssue(
          issues,
          'ACCOUNTABLE_REGISTRY_OWNER_REQUIRED',
          `${unit.id} is BOUND and must preserve its immutable registry accountability`,
          unit.id,
        );
      }
      if (unit.findingBindingStatus !== 'BOUND' && ownership.accountableRegistryOwner !== null) {
        addIssue(
          issues,
          'ACCOUNTABLE_REGISTRY_OWNER_FORBIDDEN',
          `${unit.id} may set accountable_registry_owner only after binding canonical findings`,
          unit.id,
        );
      }
      if (ownership.mandatoryReviewers.includes(ownership.executionOwner)) {
        addIssue(
          issues,
          'EXECUTION_OWNER_REPEATED_AS_REVIEWER',
          `${unit.id} execution_owner must not also be a mandatory reviewer`,
          unit.id,
        );
      }
    }
    const coClosure = unit.coClosureContract;
    if (coClosure !== null && unit.findingIds.length < 2) {
      addIssue(
        issues,
        'CO_CLOSURE_WITHOUT_MULTIPLE_FINDINGS',
        `${unit.id} may declare SAME_ROOT_CAUSE only for a multi-finding closure`,
        unit.id,
      );
    }
    if (unit.state !== 'ASSESSING' && unit.findingIds.length > 1 && coClosure === null) {
      addIssue(
        issues,
        'MULTI_FINDING_CO_CLOSURE_REQUIRED',
        `${unit.id} closes multiple findings and must be split or prove SAME_ROOT_CAUSE`,
        unit.id,
      );
    }
  }
}

function validateAcceptanceRequirements(
  manifest: IntegrationEvidenceManifest,
  issues: ValidationIssue[],
): void {
  for (const unit of manifest.units) {
    const requirementIds = unit.acceptanceRequirements.map((requirement) => requirement.id);
    if (new Set(requirementIds).size !== requirementIds.length) {
      addIssue(
        issues,
        'DUPLICATE_ACCEPTANCE_REQUIREMENT',
        `${unit.id} has duplicate acceptance requirement IDs`,
        unit.id,
      );
    }
    for (const evidence of unit.acceptanceEvidence) {
      if (!requirementIds.includes(evidence.requirementId)) {
        addIssue(
          issues,
          'UNKNOWN_ACCEPTANCE_REQUIREMENT',
          `${unit.id} evidence references unknown requirement ${evidence.requirementId}`,
          unit.id,
        );
      }
      if (
        (evidence.kind === 'PROTECTED_MAIN_PARITY_CYCLE' || evidence.kind === 'SHADOW_PARITY') &&
        evidence.jsonlProjectionSha256 !== evidence.postgresProjectionSha256
      ) {
        addIssue(
          issues,
          'LEDGER_PARITY_DIGEST_MISMATCH',
          `${unit.id} claims zero diff but JSONL and PostgreSQL projection digests differ`,
          unit.id,
        );
      }
    }
    const parityRequirement = unit.acceptanceRequirements.find(
      (requirement) => requirement.kind === 'TWO_PROTECTED_MAIN_PARITY_CYCLES',
    );
    const cutoverRequirement = unit.acceptanceRequirements.find(
      (requirement) => requirement.kind === 'LEDGER_PREPRODUCTION_CUTOVER_ROLLBACK',
    );
    if (
      unit.id === 'IU-LEDGER-006' &&
      unit.state !== 'ASSESSING' &&
      parityRequirement === undefined
    ) {
      addIssue(
        issues,
        'LEDGER_PARITY_REQUIREMENT_REQUIRED',
        'IU-LEDGER-006 must require two distinct protected-main parity cycles',
        unit.id,
      );
    }
    if (
      unit.id === 'IU-LEDGER-007' &&
      unit.state !== 'ASSESSING' &&
      cutoverRequirement === undefined
    ) {
      addIssue(
        issues,
        'LEDGER_CUTOVER_REQUIREMENT_REQUIRED',
        'IU-LEDGER-007 must require encrypted restore, parity, pre-production cutover, and rollback',
        unit.id,
      );
    }
    if (unit.id === 'IU-LEDGER-006') {
      const boundary = unit.authorityBoundary;
      if (
        boundary === null ||
        boundary.primaryAuthority !== 'JSONL_PRIMARY' ||
        boundary.postgresRole !== 'POSTGRES_SHADOW' ||
        boundary.postgresPrimaryPolicy !== 'FORBIDDEN' ||
        boundary.productionCutover
      ) {
        addIssue(
          issues,
          'LEDGER_SHADOW_BOUNDARY_INVALID',
          'IU-LEDGER-006 must keep JSONL primary, PostgreSQL shadow, and production cutover forbidden',
          unit.id,
        );
      }
    }
    if (unit.id === 'IU-LEDGER-007') {
      const boundary = unit.authorityBoundary;
      if (
        boundary === null ||
        boundary.primaryAuthority !== 'JSONL_PRIMARY' ||
        boundary.postgresRole !== 'POSTGRES_SHADOW' ||
        boundary.postgresPrimaryPolicy !== 'PRE_PRODUCTION_ONLY' ||
        boundary.productionCutover
      ) {
        addIssue(
          issues,
          'LEDGER_CUTOVER_BOUNDARY_INVALID',
          'IU-LEDGER-007 must remain JSONL primary with PRE_PRODUCTION_ONLY PostgreSQL cutover and no production cutover',
          unit.id,
        );
      }
    }
    if (unit.state !== 'VERIFIED') {
      continue;
    }
    for (const requirement of unit.acceptanceRequirements) {
      const evidence = unit.acceptanceEvidence.filter(
        (entry) => entry.requirementId === requirement.id,
      );
      if (requirement.kind === 'TWO_PROTECTED_MAIN_PARITY_CYCLES') {
        const cycles = evidence.filter(
          (entry): entry is ProtectedMainParityCycleEvidence =>
            entry.kind === 'PROTECTED_MAIN_PARITY_CYCLE',
        );
        if (
          cycles.length < requirement.minimumCycles ||
          new Set(cycles.map((cycle) => cycle.protectedMainSha)).size < requirement.minimumCycles
        ) {
          addIssue(
            issues,
            'LEDGER_PARITY_CYCLES_INCOMPLETE',
            `${unit.id} requires two distinct protected-main parity cycle SHAs`,
            unit.id,
          );
        }
      } else if (requirement.kind === 'LEDGER_PREPRODUCTION_CUTOVER_ROLLBACK') {
        const evidenceKinds = evidence.map((entry) => entry.kind);
        if (
          !requirement.requiredEvidenceKinds.every(
            (kind) => evidenceKinds.filter((entry) => entry === kind).length === 1,
          ) ||
          evidenceKinds.length !== requirement.requiredEvidenceKinds.length
        ) {
          addIssue(
            issues,
            'LEDGER_CUTOVER_EVIDENCE_INCOMPLETE',
            `${unit.id} requires exactly one encrypted restore, shadow parity, pre-production cutover, and rollback proof`,
            unit.id,
          );
        }
      } else {
        const assertions = evidence.filter(
          (entry): entry is ArtifactAssertionEvidence =>
            entry.kind === 'ARTIFACT_ASSERTION' && entry.assertionId === requirement.assertionId,
        );
        if (assertions.length < requirement.minimumEvidence) {
          addIssue(
            issues,
            'CAPABILITY_ASSERTION_INCOMPLETE',
            `${unit.id}/${requirement.id} has insufficient artifact assertions`,
            unit.id,
          );
        }
      }
    }
  }
}

export function validateIntegrationEvidenceStatic(
  manifest: IntegrationEvidenceManifest,
  requiredStatus: RequiredStatusContract,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sourceIds = manifest.sources.map((source) => source.id);
  if (new Set(sourceIds).size !== sourceIds.length) {
    addIssue(issues, 'DUPLICATE_SOURCE_ID', 'capability sources contain duplicate IDs');
  }
  const profileIds = manifest.gateProfiles.map((profile) => profile.id);
  if (new Set(profileIds).size !== profileIds.length) {
    addIssue(issues, 'DUPLICATE_GATE_PROFILE', 'gate profiles contain duplicate IDs');
  }
  const unitsById = validateTopology(manifest, issues);
  validateAuthorityTargets(manifest, issues);
  validateSourceSlices(manifest, issues);
  validateExecutionState(manifest, requiredStatus, unitsById, issues);
  validateEvidenceTrustBindings(manifest, requiredStatus, issues);
  validateOwnershipAndCoClosure(manifest, issues);
  validateAcceptanceRequirements(manifest, issues);
  return issues;
}

function agentFrontmatterName(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '---') {
      return null;
    }
    if (line?.startsWith('name: ')) {
      const name = line.slice('name: '.length).trim();
      return name.length === 0 ? null : name;
    }
  }
  return null;
}

export function validateExecutionIdentityDefinitions(
  manifest: IntegrationEvidenceManifest,
  catalog: DispatchIdentityCatalog,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definitionsByName = new Map<string, DispatchIdentityDefinition[]>();
  for (const definition of catalog.definitions()) {
    const definitions = definitionsByName.get(definition.name) ?? [];
    definitions.push(definition);
    definitionsByName.set(definition.name, definitions);
  }
  const validateIdentity = (identity: string, unitId: string): void => {
    const definitions = definitionsByName.get(identity) ?? [];
    if (definitions.length !== 1) {
      addIssue(
        issues,
        'EXECUTION_IDENTITY_NOT_UNIQUE',
        `${unitId} dispatch identity ${identity} resolves to ${String(definitions.length)} agent definitions`,
        unitId,
      );
    }
  };
  for (const unit of manifest.units) {
    const ownership = unit.ownership;
    if (ownership !== null) {
      validateIdentity(ownership.executionOwner, unit.id);
      for (const reviewer of ownership.mandatoryReviewers) {
        validateIdentity(reviewer, unit.id);
      }
    }
    if (unit.externalBlocker !== null) {
      validateIdentity(unit.externalBlocker.owner, unit.id);
    }
  }
  return issues;
}

async function validateCommitOnMain(
  git: GitEvidenceReader,
  commitSha: string,
  mainSha: string,
): Promise<boolean> {
  return (
    (await git.objectExists(commitSha, 'commit')) && (await git.isAncestor(commitSha, mainSha))
  );
}

async function validateSourceProofLive(
  source: ManifestSource,
  proof: SourceMainProof,
  mainSha: string,
  git: GitEvidenceReader,
): Promise<boolean> {
  if (proof.sourceCommitSha !== source.headSha) {
    return false;
  }
  if (!(await git.objectExists(proof.sourceCommitSha, 'commit'))) {
    return false;
  }
  if (proof.kind === 'ANCESTOR') {
    return git.isAncestor(proof.sourceCommitSha, mainSha);
  }
  if (
    !(await validateCommitOnMain(git, proof.mainCommitSha, mainSha)) ||
    !(await git.objectExists(proof.sourceTreeSha, 'tree')) ||
    !(await git.objectExists(proof.mainTreeSha, 'tree'))
  ) {
    return false;
  }
  const sourceTree = await git.commitTree(proof.sourceCommitSha);
  const mainTree = await git.commitTree(proof.mainCommitSha);
  return (
    sourceTree === proof.sourceTreeSha &&
    mainTree === proof.mainTreeSha &&
    proof.sourceTreeSha === proof.mainTreeSha
  );
}

async function everyAsync<T>(
  values: readonly T[],
  predicate: (value: T) => Promise<boolean>,
): Promise<boolean> {
  for (const value of values) {
    if (!(await predicate(value))) {
      return false;
    }
  }
  return true;
}

async function validateSourceSlicesLive(
  manifest: IntegrationEvidenceManifest,
  mainSha: string,
  git: GitEvidenceReader,
  issues: ValidationIssue[],
): Promise<Map<string, SourceSlice>> {
  const sources = new Map(manifest.sources.map((source) => [source.id, source]));
  const slices = new Map(manifest.sourceSlices.map((slice) => [slice.id, slice]));
  for (const slice of manifest.sourceSlices) {
    const source = sources.get(slice.sourceId);
    if (source === undefined) {
      continue;
    }
    const selector = slice.selector;
    const sourceCommitAtOrBeforeHead = async (commitSha: string): Promise<boolean> =>
      source.kind !== 'DIRTY_WORKTREE' &&
      (await git.objectExists(commitSha, 'commit')) &&
      (commitSha === source.headSha || (await git.isAncestor(commitSha, source.headSha)));
    let valid = false;
    if (selector.kind === 'COMMIT_SET') {
      valid =
        source.kind !== 'DIRTY_WORKTREE' &&
        (await everyAsync(selector.commitShas, sourceCommitAtOrBeforeHead));
    } else if (selector.kind === 'COMMIT_PATH_SET') {
      const rangeValid =
        source.kind !== 'DIRTY_WORKTREE' &&
        (await git.objectExists(selector.baseSha, 'commit')) &&
        (await sourceCommitAtOrBeforeHead(selector.headSha)) &&
        selector.baseSha !== selector.headSha &&
        (await git.isAncestor(selector.baseSha, selector.headSha));
      const commitsValid =
        rangeValid &&
        (await everyAsync(
          selector.commitShas,
          async (commitSha): Promise<boolean> =>
            commitSha !== selector.baseSha &&
            (await git.objectExists(commitSha, 'commit')) &&
            (await git.isAncestor(selector.baseSha, commitSha)) &&
            (await git.isAncestor(commitSha, selector.headSha)),
        ));
      const pathsValid =
        commitsValid &&
        (await everyAsync(selector.paths, (path) =>
          git.pathChangedBetween(selector.baseSha, selector.headSha, path),
        ));
      valid = rangeValid && commitsValid && pathsValid;
    } else if (selector.kind === 'PATH_BLOB_SET') {
      valid = await everyAsync(selector.entries, async (entry): Promise<boolean> => {
        const commitValid =
          entry.lineage === 'SOURCE'
            ? await sourceCommitAtOrBeforeHead(entry.commitSha)
            : await validateCommitOnMain(git, entry.commitSha, mainSha);
        return (
          commitValid &&
          (await git.objectExists(entry.blobSha, 'blob')) &&
          (await git.pathBlob(entry.commitSha, entry.path)) === entry.blobSha
        );
      });
    } else if (selector.kind === 'DIRTY_PATCH') {
      valid =
        source.kind === 'DIRTY_WORKTREE' && source.contentSha256 === selector.capturedContentSha256;
    } else {
      const sourceCommitValid =
        source.kind !== 'DIRTY_WORKTREE' &&
        selector.sourceCommitSha === source.headSha &&
        (await git.objectExists(selector.sourceCommitSha, 'commit'));
      valid =
        sourceCommitValid &&
        (await git.objectExists(selector.sourceTreeSha, 'tree')) &&
        (await git.commitTree(selector.sourceCommitSha)) === selector.sourceTreeSha &&
        (await validateCommitOnMain(git, selector.mainCommitSha, mainSha)) &&
        (await git.objectExists(selector.mainTreeSha, 'tree')) &&
        (await git.commitTree(selector.mainCommitSha)) === selector.mainTreeSha &&
        selector.sourceTreeSha === selector.mainTreeSha;
    }
    if (!valid) {
      addIssue(
        issues,
        'SOURCE_SLICE_LIVE_PROOF_INVALID',
        `${slice.id} does not match its live Git/source lineage`,
      );
    }
  }
  return slices;
}

async function validateMainEvidenceLive(
  manifest: IntegrationEvidenceManifest,
  mainSha: string,
  git: GitEvidenceReader,
  slices: ReadonlyMap<string, SourceSlice>,
  issues: ValidationIssue[],
): Promise<void> {
  const sources = new Map(manifest.sources.map((source) => [source.id, source]));
  for (const unit of manifest.units) {
    for (const evidence of unit.mainEvidence) {
      if (evidence.kind === 'MAIN_COMMIT') {
        if (!(await validateCommitOnMain(git, evidence.commitSha, mainSha))) {
          addIssue(
            issues,
            'MAIN_COMMIT_EVIDENCE_INVALID',
            `${evidence.commitSha} is not an existing commit reachable from pinned origin/main`,
            unit.id,
          );
        }
      } else if (evidence.kind === 'SOURCE_MAIN_PROOF') {
        if (evidence.sourceSliceId !== null) {
          const slice = slices.get(evidence.sourceSliceId);
          if (
            slice === undefined ||
            slice.selector.kind !== 'WHOLE_TREE_PROOF' ||
            !unit.sourceSliceIds.includes(evidence.sourceSliceId)
          ) {
            addIssue(
              issues,
              'SOURCE_MAIN_PROOF_EVIDENCE_INVALID',
              `${unit.id} typed source-main proof does not resolve to its owned WHOLE_TREE_PROOF slice`,
              unit.id,
            );
          }
          continue;
        }
        if (
          unit.state === 'ASSESSING' &&
          evidence.legacySourceId !== null &&
          evidence.legacyProofKind !== null
        ) {
          const source = sources.get(evidence.legacySourceId);
          if (
            source === undefined ||
            !isCapabilityIntegrationSource(source) ||
            source.mainProof === null ||
            source.mainProof.kind !== evidence.legacyProofKind ||
            !(await validateSourceProofLive(source, source.mainProof, mainSha, git))
          ) {
            addIssue(
              issues,
              'SOURCE_MAIN_PROOF_EVIDENCE_INVALID',
              `${unit.id} legacy source-main candidate does not match live lineage`,
              unit.id,
            );
          }
        } else if (unit.state !== 'ASSESSING') {
          addIssue(
            issues,
            'SOURCE_MAIN_PROOF_EVIDENCE_INVALID',
            `${unit.id} source-main proof lacks typed source-slice provenance`,
            unit.id,
          );
        }
      } else if (evidence.kind === 'SLICE_BLOB_EQ') {
        if (evidence.sourceSliceId === null) {
          if (unit.state !== 'ASSESSING') {
            addIssue(
              issues,
              'SLICE_BLOB_ID_REQUIRED',
              `${unit.id} SLICE_BLOB_EQ must reference a typed source slice`,
              unit.id,
            );
          }
          continue;
        }
        const slice = slices.get(evidence.sourceSliceId);
        if (
          slice === undefined ||
          slice.selector.kind !== 'PATH_BLOB_SET' ||
          !unit.sourceSliceIds.includes(evidence.sourceSliceId)
        ) {
          addIssue(
            issues,
            'SLICE_BLOB_EVIDENCE_INVALID',
            `${unit.id} SLICE_BLOB_EQ does not resolve to an owned path/blob equivalence`,
            unit.id,
          );
        }
      } else {
        if (evidence.sourceSliceId !== null) {
          const slice = slices.get(evidence.sourceSliceId);
          if (
            slice === undefined ||
            slice.selector.kind !== 'WHOLE_TREE_PROOF' ||
            !unit.sourceSliceIds.includes(evidence.sourceSliceId)
          ) {
            addIssue(
              issues,
              'CHAINED_TREE_EQUIVALENT_INVALID',
              `${unit.id} typed chained proof does not resolve to its owned WHOLE_TREE_PROOF slice`,
              unit.id,
            );
          }
          continue;
        }
        if (
          unit.state === 'ASSESSING' &&
          evidence.legacySourceId !== null &&
          evidence.legacyStackHeadSha !== null &&
          evidence.legacyStackTreeSha !== null &&
          evidence.legacyMainCommitSha !== null &&
          evidence.legacyMainTreeSha !== null
        ) {
          const source = sources.get(evidence.legacySourceId);
          const valid =
            source !== undefined &&
            isCapabilityIntegrationSource(source) &&
            (await git.objectExists(source.headSha, 'commit')) &&
            (await git.objectExists(evidence.legacyStackHeadSha, 'commit')) &&
            (await git.isAncestor(source.headSha, evidence.legacyStackHeadSha)) &&
            (await git.commitTree(evidence.legacyStackHeadSha)) === evidence.legacyStackTreeSha &&
            (await git.objectExists(evidence.legacyStackTreeSha, 'tree')) &&
            (await validateCommitOnMain(git, evidence.legacyMainCommitSha, mainSha)) &&
            (await git.commitTree(evidence.legacyMainCommitSha)) === evidence.legacyMainTreeSha &&
            (await git.objectExists(evidence.legacyMainTreeSha, 'tree')) &&
            evidence.legacyStackTreeSha === evidence.legacyMainTreeSha;
          if (!valid) {
            addIssue(
              issues,
              'CHAINED_TREE_EQUIVALENT_INVALID',
              `${unit.id} legacy chained candidate does not match source ancestry, trees, and pinned main`,
              unit.id,
            );
          }
        } else if (unit.state !== 'ASSESSING') {
          addIssue(
            issues,
            'CHAINED_TREE_EQUIVALENT_INVALID',
            `${unit.id} chained tree proof lacks typed source-slice provenance`,
            unit.id,
          );
        }
      }
    }
  }
}

async function validateExecutionLive(
  manifest: IntegrationEvidenceManifest,
  mainSha: string,
  git: GitEvidenceReader,
  issues: ValidationIssue[],
): Promise<void> {
  for (const unit of manifest.units) {
    const attempt = unit.executionAttempt;
    if (attempt !== null && !(await git.objectExists(attempt.headSha, 'commit'))) {
      addIssue(
        issues,
        'ATTEMPT_HEAD_OBJECT_MISSING',
        `${unit.id} attempt head ${attempt.headSha} is not an existing Git commit`,
        unit.id,
      );
    }
    if (unit.state === 'VERIFIED' && attempt !== null && attempt.mergeEvidence !== null) {
      const mergeSha = attempt.mergeEvidence.mergeCommitSha;
      const valid =
        (await validateCommitOnMain(git, attempt.headSha, mainSha)) &&
        (await validateCommitOnMain(git, mergeSha, mainSha)) &&
        (await git.isAncestor(attempt.headSha, mergeSha));
      if (!valid) {
        addIssue(
          issues,
          'VERIFIED_MERGE_NOT_MAIN_REACHABLE',
          `${unit.id} exact attempt head and merge commit must both be reachable from pinned origin/main`,
          unit.id,
        );
      }
    }
    for (const evidence of unit.acceptanceEvidence) {
      if (evidence.kind === 'PROTECTED_MAIN_PARITY_CYCLE' || evidence.kind === 'SHADOW_PARITY') {
        if (!(await validateCommitOnMain(git, evidence.protectedMainSha, mainSha))) {
          addIssue(
            issues,
            'PROTECTED_MAIN_EVIDENCE_INVALID',
            `${unit.id} parity SHA ${evidence.protectedMainSha} is not reachable from pinned origin/main`,
            unit.id,
          );
        }
      }
    }
  }
}

interface LiveGitHubReadCache {
  pullRequests: Map<string, Promise<GitHubPullRequestRecord>>;
  workflowRuns: Map<string, Promise<GitHubWorkflowRunRecord>>;
  checkRuns: Map<string, Promise<GitHubCheckRunRecord>>;
  artifacts: Map<string, Promise<GitHubArtifactRecord>>;
}

function createLiveGitHubReadCache(): LiveGitHubReadCache {
  return {
    pullRequests: new Map(),
    workflowRuns: new Map(),
    checkRuns: new Map(),
    artifacts: new Map(),
  };
}

function cachedGitHubRead<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const pending = read();
  cache.set(key, pending);
  return pending;
}

async function readTrustedGitHubRecord<T>(
  issues: ValidationIssue[],
  unitId: string,
  coordinate: string,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch {
    addIssue(
      issues,
      'GITHUB_LIVE_READ_FAILED',
      `${coordinate} could not be read from the authenticated GitHub API`,
      unitId,
    );
    return null;
  }
}

function workflowRunMatchesAttempt(
  run: GitHubWorkflowRunRecord,
  attempt: ExecutionAttempt,
  expectedRunId: number,
  expectedRunAttempt: number,
  expectedWorkflowPath?: string,
): boolean {
  return (
    run.repository === attempt.repository &&
    run.id === expectedRunId &&
    run.headRepository === attempt.repository &&
    run.headSha === attempt.headSha &&
    run.runAttempt === expectedRunAttempt &&
    run.pullRequestNumbers.includes(attempt.pullRequestNumber) &&
    isGitHubWorkflowPath(run.path) &&
    (expectedWorkflowPath === undefined || run.path === expectedWorkflowPath)
  );
}

function workflowRunSucceeded(run: GitHubWorkflowRunRecord): boolean {
  return run.status === 'COMPLETED' && run.conclusion === 'SUCCESS';
}

async function validatePullRequestTrustLive(
  unit: IntegrationUnit,
  attempt: ExecutionAttempt,
  github: GitHubActionsEvidenceReader,
  cache: LiveGitHubReadCache,
  issues: ValidationIssue[],
): Promise<void> {
  const key = `${attempt.repository}#${String(attempt.pullRequestNumber)}`;
  const pullRequest = await readTrustedGitHubRecord(
    issues,
    unit.id,
    `${unit.id} pull request`,
    () =>
      cachedGitHubRead(cache.pullRequests, key, () =>
        github.getPullRequest(attempt.repository, attempt.pullRequestNumber),
      ),
  );
  if (pullRequest === null) {
    return;
  }
  const exactIdentity =
    pullRequest.repository === attempt.repository &&
    pullRequest.number === attempt.pullRequestNumber &&
    pullRequest.headRepository === attempt.repository &&
    pullRequest.headSha === attempt.headSha;
  const validLifecycle =
    unit.state === 'VERIFIED'
      ? pullRequest.state === 'CLOSED' &&
        pullRequest.merged &&
        attempt.mergeEvidence !== null &&
        pullRequest.mergeCommitSha === attempt.mergeEvidence.mergeCommitSha
      : pullRequest.state === 'OPEN' || pullRequest.merged;
  if (!exactIdentity || !validLifecycle) {
    addIssue(
      issues,
      'GITHUB_PULL_REQUEST_BINDING_INVALID',
      `${unit.id} execution attempt is not the authenticated repository/PR/head lifecycle`,
      unit.id,
    );
  }
}

async function validateAttemptRunTrustLive(
  unit: IntegrationUnit,
  attempt: ExecutionAttempt,
  github: GitHubActionsEvidenceReader,
  cache: LiveGitHubReadCache,
  issues: ValidationIssue[],
): Promise<void> {
  const key = `${attempt.repository}#${String(attempt.workflowRunId)}`;
  const run = await readTrustedGitHubRecord(
    issues,
    unit.id,
    `${unit.id} execution workflow run`,
    () =>
      cachedGitHubRead(cache.workflowRuns, key, () =>
        github.getWorkflowRun(attempt.repository, attempt.workflowRunId),
      ),
  );
  if (run === null) {
    return;
  }
  const exactIdentity = workflowRunMatchesAttempt(
    run,
    attempt,
    attempt.workflowRunId,
    attempt.workflowRunAttempt,
  );
  const validConclusion = unit.state !== 'VERIFIED' || workflowRunSucceeded(run);
  if (!exactIdentity || !validConclusion) {
    addIssue(
      issues,
      'GITHUB_ATTEMPT_RUN_BINDING_INVALID',
      `${unit.id} execution attempt is not bound to its authenticated exact-head workflow run and attempt`,
      unit.id,
    );
  }
}

async function validateCheckTrustLive(
  unit: IntegrationUnit,
  attempt: ExecutionAttempt,
  evidence: GitHubCheckEvidence,
  github: GitHubActionsEvidenceReader,
  cache: LiveGitHubReadCache,
  issues: ValidationIssue[],
): Promise<void> {
  const checkKey = `${evidence.repository}#${String(evidence.checkRunId)}`;
  const check = await readTrustedGitHubRecord(
    issues,
    unit.id,
    `${unit.id}/${evidence.context} check run`,
    () =>
      cachedGitHubRead(cache.checkRuns, checkKey, () =>
        github.getCheckRun(evidence.repository, evidence.checkRunId),
      ),
  );
  if (check === null) {
    return;
  }
  if (
    check.repository !== evidence.repository ||
    check.id !== evidence.checkRunId ||
    check.name !== evidence.context ||
    check.headSha !== attempt.headSha ||
    check.status !== 'COMPLETED' ||
    check.conclusion !== 'SUCCESS' ||
    check.detailsUrl !== evidence.detailsUrl ||
    check.appSlug !== GITHUB_ACTIONS_APP_SLUG ||
    check.workflowRunId !== evidence.workflowRunId
  ) {
    addIssue(
      issues,
      'GITHUB_CHECK_RUN_BINDING_INVALID',
      `${unit.id}/${evidence.context} does not match the authenticated GitHub Actions check run`,
      unit.id,
    );
    return;
  }
  const runKey = `${evidence.repository}#${String(evidence.workflowRunId)}`;
  const run = await readTrustedGitHubRecord(
    issues,
    unit.id,
    `${unit.id}/${evidence.context} workflow run`,
    () =>
      cachedGitHubRead(cache.workflowRuns, runKey, () =>
        github.getWorkflowRun(evidence.repository, evidence.workflowRunId),
      ),
  );
  if (
    run !== null &&
    (!workflowRunMatchesAttempt(
      run,
      attempt,
      evidence.workflowRunId,
      evidence.workflowRunAttempt,
    ) ||
      !workflowRunSucceeded(run))
  ) {
    addIssue(
      issues,
      'GITHUB_CHECK_RUN_BINDING_INVALID',
      `${unit.id}/${evidence.context} check does not belong to a successful exact-head PR workflow attempt`,
      unit.id,
    );
  }
}

async function validateActionsArtifactTrustLive(
  unit: IntegrationUnit,
  attempt: ExecutionAttempt,
  trust: GitHubActionsArtifactTrust,
  github: GitHubActionsEvidenceReader,
  cache: LiveGitHubReadCache,
  issues: ValidationIssue[],
  coordinate: string,
): Promise<void> {
  const runKey = `${trust.repository}#${String(trust.workflowRunId)}`;
  const run = await readTrustedGitHubRecord(
    issues,
    unit.id,
    `${coordinate} artifact workflow run`,
    () =>
      cachedGitHubRead(cache.workflowRuns, runKey, () =>
        github.getWorkflowRun(trust.repository, trust.workflowRunId),
      ),
  );
  if (
    run !== null &&
    (!workflowRunMatchesAttempt(
      run,
      attempt,
      trust.workflowRunId,
      trust.workflowRunAttempt,
      trust.workflowPath,
    ) ||
      !workflowRunSucceeded(run))
  ) {
    addIssue(
      issues,
      'GITHUB_ARTIFACT_RUN_BINDING_INVALID',
      `${coordinate} artifact does not belong to a successful exact-head PR workflow attempt`,
      unit.id,
    );
  }
  const artifactKey = `${trust.repository}#${String(trust.artifactId)}`;
  const artifact = await readTrustedGitHubRecord(
    issues,
    unit.id,
    `${coordinate} Actions artifact`,
    () =>
      cachedGitHubRead(cache.artifacts, artifactKey, () =>
        github.getArtifact(trust.repository, trust.artifactId),
      ),
  );
  if (
    artifact !== null &&
    (artifact.repository !== trust.repository ||
      artifact.id !== trust.artifactId ||
      artifact.name !== trust.artifactName ||
      artifact.workflowRunId !== trust.workflowRunId ||
      artifact.expired ||
      artifact.digestSha256 !== trust.artifactSha256)
  ) {
    addIssue(
      issues,
      'GITHUB_ARTIFACT_BINDING_INVALID',
      `${coordinate} does not match the authenticated, retained Actions artifact digest`,
      unit.id,
    );
  }
}

async function validateSigstoreTrustLive(
  unit: IntegrationUnit,
  trust: SigstoreBundleTrust,
  verifier: SigstoreEvidenceVerifier | undefined,
  issues: ValidationIssue[],
  coordinate: string,
): Promise<void> {
  if (verifier === undefined) {
    addIssue(
      issues,
      'SIGSTORE_VERIFIER_REQUIRED',
      `${coordinate} requires a trusted Sigstore bundle verifier`,
      unit.id,
    );
    return;
  }
  let result: SigstoreVerificationResult;
  try {
    result = await verifier.verify(trust);
  } catch {
    addIssue(
      issues,
      'SIGSTORE_BUNDLE_VERIFICATION_INVALID',
      `${coordinate} Sigstore bundle verification failed closed`,
      unit.id,
    );
    return;
  }
  if (
    !result.verified ||
    result.repository !== trust.repository ||
    result.headSha !== trust.headSha ||
    result.subjectSha256 !== trust.subjectSha256 ||
    result.bundleSha256 !== trust.bundleSha256 ||
    result.issuer !== trust.issuer ||
    result.signerIdentity !== trust.signerIdentity
  ) {
    addIssue(
      issues,
      'SIGSTORE_BUNDLE_VERIFICATION_INVALID',
      `${coordinate} is not backed by the exact GitHub OIDC/Sigstore subject and bundle`,
      unit.id,
    );
  }
}

async function validateEvidenceTrustLive(
  unit: IntegrationUnit,
  attempt: ExecutionAttempt,
  trust: EvidenceTrustBinding,
  context: LiveEvidenceTrustContext,
  cache: LiveGitHubReadCache,
  issues: ValidationIssue[],
  coordinate: string,
): Promise<void> {
  if (trust.kind === 'GITHUB_ACTIONS_ARTIFACT') {
    await validateActionsArtifactTrustLive(
      unit,
      attempt,
      trust,
      context.github,
      cache,
      issues,
      coordinate,
    );
    return;
  }
  await validateSigstoreTrustLive(unit, trust, context.sigstore, issues, coordinate);
}

async function validatePromotedEvidenceTrustLive(
  manifest: IntegrationEvidenceManifest,
  context: LiveEvidenceTrustContext | undefined,
  issues: ValidationIssue[],
): Promise<void> {
  const promotedUnits = manifest.units.filter((unit) => unit.state !== 'ASSESSING');
  if (promotedUnits.length === 0) {
    return;
  }
  let authenticated = false;
  if (context !== undefined) {
    try {
      authenticated = await context.github.isAuthenticated();
    } catch {
      authenticated = false;
    }
  }
  if (context === undefined || !authenticated) {
    addIssue(
      issues,
      'GITHUB_LIVE_AUTH_REQUIRED',
      'promoted integration evidence requires authenticated, live GitHub API verification',
    );
    return;
  }
  const cache = createLiveGitHubReadCache();
  for (const unit of promotedUnits) {
    const attempt = unit.executionAttempt;
    if (attempt === null) {
      continue;
    }
    await validatePullRequestTrustLive(unit, attempt, context.github, cache, issues);
    await validateAttemptRunTrustLive(unit, attempt, context.github, cache, issues);
    for (const result of unit.gateResults) {
      for (const evidence of result.evidence) {
        if (evidence.kind === 'GITHUB_CHECK') {
          await validateCheckTrustLive(unit, attempt, evidence, context.github, cache, issues);
        } else {
          await validateEvidenceTrustLive(
            unit,
            attempt,
            evidence.trust,
            context,
            cache,
            issues,
            `${unit.id}/${result.gateId}`,
          );
        }
      }
    }
    for (const evidence of unit.acceptanceEvidence) {
      await validateEvidenceTrustLive(
        unit,
        attempt,
        evidence.trust,
        context,
        cache,
        issues,
        `${unit.id}/${evidence.requirementId}/${evidence.kind}`,
      );
    }
  }
}

export async function validateIntegrationEvidenceLive(
  manifest: IntegrationEvidenceManifest,
  requiredStatus: RequiredStatusContract,
  mainSha: string,
  git: GitEvidenceReader,
  trustContext?: LiveEvidenceTrustContext,
): Promise<ValidationIssue[]> {
  const issues = validateIntegrationEvidenceStatic(manifest, requiredStatus);
  const slices = await validateSourceSlicesLive(manifest, mainSha, git, issues);
  await validateMainEvidenceLive(manifest, mainSha, git, slices, issues);
  await validateExecutionLive(manifest, mainSha, git, issues);
  await validatePromotedEvidenceTrustLive(manifest, trustContext, issues);
  return issues;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runBoundedGit(args: readonly string[]): Promise<GitResult> {
  const result = HERMETIC_GIT_RUNTIME.runBuffer(
    REPO_ROOT,
    args,
    ALL_GIT_EXIT_STATUSES,
    undefined,
    MAX_GIT_STDOUT_BYTES + MAX_GIT_STDERR_BYTES,
  );
  if (result.stdout.length > MAX_GIT_STDOUT_BYTES) {
    throw new Error(
      `bounded git stdout exceeded ${String(MAX_GIT_STDOUT_BYTES)} bytes: git ${args.join(' ')}`,
    );
  }
  if (result.stderr.length > MAX_GIT_STDERR_BYTES) {
    throw new Error(
      `bounded git stderr exceeded ${String(MAX_GIT_STDERR_BYTES)} bytes: git ${args.join(' ')}`,
    );
  }
  return Promise.resolve({
    code: result.status,
    stdout: result.stdout.toString('utf8').trim(),
    stderr: result.stderr.toString('utf8').trim(),
  });
}

async function runGitValue(args: readonly string[], description: string): Promise<string> {
  const result = await runBoundedGit(args);
  if (result.code !== 0) {
    throw new Error(`${description} failed (${String(result.code)}): ${result.stderr}`);
  }
  return result.stdout;
}

export class BoundedGitEvidenceReader implements GitEvidenceReader {
  public async resolveRef(ref: string): Promise<string> {
    const value = await runGitValue(['rev-parse', '--verify', `${ref}^{commit}`], `resolve ${ref}`);
    return requireSha(value, ref);
  }

  public async objectExists(oid: string, kind: 'commit' | 'tree' | 'blob'): Promise<boolean> {
    requireSha(oid, 'Git object ID');
    const result = await runBoundedGit(['cat-file', '-e', `${oid}^{${kind}}`]);
    if (result.code === 0) {
      return true;
    }
    if (result.code === 1 || result.code === 128) {
      return false;
    }
    throw new Error(`git cat-file failed (${String(result.code)}): ${result.stderr}`);
  }

  public async isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean> {
    requireSha(ancestorSha, 'ancestor SHA');
    requireSha(descendantSha, 'descendant SHA');
    const result = await runBoundedGit(['merge-base', '--is-ancestor', ancestorSha, descendantSha]);
    if (result.code === 0) {
      return true;
    }
    if (result.code === 1) {
      return false;
    }
    throw new Error(`git merge-base failed (${String(result.code)}): ${result.stderr}`);
  }

  public async commitTree(commitSha: string): Promise<string | null> {
    requireSha(commitSha, 'commit SHA');
    const result = await runBoundedGit(['rev-parse', '--verify', `${commitSha}^{tree}`]);
    if (result.code === 0) {
      return requireSha(result.stdout, `${commitSha} tree`);
    }
    if (result.code === 1 || result.code === 128) {
      return null;
    }
    throw new Error(`git rev-parse tree failed (${String(result.code)}): ${result.stderr}`);
  }

  public async pathBlob(commitSha: string, path: string): Promise<string | null> {
    requireSha(commitSha, 'commit SHA');
    requireRepoPath(path, 'Git path');
    const result = await runBoundedGit(['rev-parse', '--verify', `${commitSha}:${path}`]);
    if (result.code === 1 || result.code === 128) {
      return null;
    }
    if (result.code !== 0) {
      throw new Error(`git rev-parse path failed (${String(result.code)}): ${result.stderr}`);
    }
    const oid = requireSha(result.stdout, `${commitSha}:${path} object`);
    return (await this.objectExists(oid, 'blob')) ? oid : null;
  }

  public async pathChangedBetween(
    baseSha: string,
    headSha: string,
    path: string,
  ): Promise<boolean> {
    requireSha(baseSha, 'base SHA');
    requireSha(headSha, 'head SHA');
    requireRepoPath(path, 'Git path');
    const result = await runBoundedGit(['diff', '--quiet', baseSha, headSha, '--', path]);
    if (result.code === 1) {
      return true;
    }
    if (result.code === 0) {
      return false;
    }
    throw new Error(`git diff --quiet failed (${String(result.code)}): ${result.stderr}`);
  }
}

function githubRepositoryApiPath(repository: string): string {
  const [owner, name] = requireRepository(repository, 'GitHub repository').split('/');
  if (owner === undefined || name === undefined) {
    throw new Error('GitHub repository must contain an owner and name');
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function normalizeGitHubApiEnum(value: unknown, field: string): string {
  return requireString(value, field).toUpperCase();
}

function nullableGitHubApiEnum(value: unknown, field: string): string | null {
  return value === null ? null : normalizeGitHubApiEnum(value, field);
}

function nullableGitSha(value: unknown, field: string): string | null {
  return value === null ? null : requireSha(value, field);
}

function parseGitHubArtifactDigest(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  const raw = requireString(value, field);
  return requireSha256(raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw, field);
}

function workflowRunIdFromDetailsUrl(detailsUrl: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(detailsUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    return null;
  }
  const match = /\/actions\/runs\/([1-9][0-9]*)(?:\/|$)/.exec(parsed.pathname);
  if (match?.[1] === undefined) {
    return null;
  }
  const runId = Number(match[1]);
  return Number.isSafeInteger(runId) ? runId : null;
}

export class BoundedGitHubActionsEvidenceReader implements GitHubActionsEvidenceReader {
  private readonly token: string | null;
  private authenticationResult: Promise<boolean> | null = null;

  public constructor(
    private readonly expectedRepository: string,
    token: string | undefined = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  ) {
    requireRepository(expectedRepository, 'expected GitHub repository');
    const normalizedToken = token?.trim() ?? '';
    this.token = normalizedToken.length === 0 ? null : normalizedToken;
  }

  private async readBoundedJson(response: Response, coordinate: string): Promise<unknown> {
    if (response.body === null) {
      throw new Error(`${coordinate} returned no response body`);
    }
    const contentLength = response.headers.get('content-length');
    if (
      contentLength !== null &&
      Number.isSafeInteger(Number(contentLength)) &&
      Number(contentLength) > MAX_GITHUB_API_RESPONSE_BYTES
    ) {
      throw new Error(`${coordinate} exceeded the bounded API response limit`);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        break;
      }
      totalBytes += item.value.byteLength;
      if (totalBytes > MAX_GITHUB_API_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`${coordinate} exceeded the bounded API response limit`);
      }
      chunks.push(Buffer.from(item.value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new Error(`${coordinate} returned invalid JSON`);
    }
  }

  private async getJson(path: string, coordinate: string): Promise<unknown> {
    if (this.token === null) {
      throw new Error('authenticated GitHub API token is unavailable');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    timeout.unref();
    try {
      const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'aqua-capability-integration-evidence',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`${coordinate} returned HTTP ${String(response.status)}`);
      }
      return await this.readBoundedJson(response, coordinate);
    } finally {
      clearTimeout(timeout);
    }
  }

  public async isAuthenticated(): Promise<boolean> {
    if (this.token === null) {
      return false;
    }
    if (this.authenticationResult === null) {
      const repositoryPath = githubRepositoryApiPath(this.expectedRepository);
      this.authenticationResult = this.getJson(repositoryPath, 'GitHub authentication probe')
        .then((value): boolean => {
          const record = requireRecord(value, 'GitHub authentication probe');
          return (
            requireRepository(
              record.full_name,
              'GitHub authentication probe.full_name',
            ).toLowerCase() === this.expectedRepository.toLowerCase()
          );
        })
        .catch((): boolean => false);
    }
    return this.authenticationResult;
  }

  public async getPullRequest(
    repository: string,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestRecord> {
    const value = await this.getJson(
      `${githubRepositoryApiPath(repository)}/pulls/${String(
        requireInteger(pullRequestNumber, 'pull request number', 1),
      )}`,
      'GitHub pull request',
    );
    const record = requireRecord(value, 'GitHub pull request');
    const head = requireRecord(record.head, 'GitHub pull request.head');
    const headRepository = requireRecord(head.repo, 'GitHub pull request.head.repo');
    const state = normalizeGitHubApiEnum(record.state, 'GitHub pull request.state');
    if (state !== 'OPEN' && state !== 'CLOSED') {
      throw new Error('GitHub pull request.state must be OPEN or CLOSED');
    }
    return {
      repository,
      number: requireInteger(record.number, 'GitHub pull request.number', 1),
      headRepository: requireRepository(
        headRepository.full_name,
        'GitHub pull request.head.repo.full_name',
      ),
      headSha: requireSha(head.sha, 'GitHub pull request.head.sha'),
      state,
      merged: requireBoolean(record.merged, 'GitHub pull request.merged'),
      mergeCommitSha: nullableGitSha(
        record.merge_commit_sha,
        'GitHub pull request.merge_commit_sha',
      ),
    };
  }

  public async getWorkflowRun(
    repository: string,
    workflowRunId: number,
  ): Promise<GitHubWorkflowRunRecord> {
    const value = await this.getJson(
      `${githubRepositoryApiPath(repository)}/actions/runs/${String(
        requireInteger(workflowRunId, 'workflow run ID', 1),
      )}`,
      'GitHub workflow run',
    );
    const record = requireRecord(value, 'GitHub workflow run');
    const headRepository = requireRecord(
      record.head_repository,
      'GitHub workflow run.head_repository',
    );
    const pullRequestNumbers = requireArray(
      record.pull_requests,
      'GitHub workflow run.pull_requests',
    ).map((value, index) => {
      const pullRequest = requireRecord(value, `GitHub workflow run.pull_requests[${index}]`);
      return requireInteger(
        pullRequest.number,
        `GitHub workflow run.pull_requests[${index}].number`,
        1,
      );
    });
    requireUniqueStrings(pullRequestNumbers.map(String), 'GitHub workflow run.pull_requests');
    return {
      repository,
      id: requireInteger(record.id, 'GitHub workflow run.id', 1),
      headRepository: requireRepository(
        headRepository.full_name,
        'GitHub workflow run.head_repository.full_name',
      ),
      headSha: requireSha(record.head_sha, 'GitHub workflow run.head_sha'),
      runAttempt: requireInteger(record.run_attempt, 'GitHub workflow run.run_attempt', 1),
      status: normalizeGitHubApiEnum(record.status, 'GitHub workflow run.status'),
      conclusion: nullableGitHubApiEnum(record.conclusion, 'GitHub workflow run.conclusion'),
      event: requireString(record.event, 'GitHub workflow run.event'),
      path: requireRepoPath(record.path, 'GitHub workflow run.path'),
      detailsUrl: requireString(record.html_url, 'GitHub workflow run.html_url'),
      pullRequestNumbers,
    };
  }

  public async getCheckRun(repository: string, checkRunId: number): Promise<GitHubCheckRunRecord> {
    const value = await this.getJson(
      `${githubRepositoryApiPath(repository)}/check-runs/${String(
        requireInteger(checkRunId, 'check run ID', 1),
      )}`,
      'GitHub check run',
    );
    const record = requireRecord(value, 'GitHub check run');
    const app = requireRecord(record.app, 'GitHub check run.app');
    const detailsUrl = requireString(record.details_url, 'GitHub check run.details_url');
    return {
      repository,
      id: requireInteger(record.id, 'GitHub check run.id', 1),
      name: requireString(record.name, 'GitHub check run.name'),
      headSha: requireSha(record.head_sha, 'GitHub check run.head_sha'),
      status: normalizeGitHubApiEnum(record.status, 'GitHub check run.status'),
      conclusion: nullableGitHubApiEnum(record.conclusion, 'GitHub check run.conclusion'),
      detailsUrl,
      appSlug: requireString(app.slug, 'GitHub check run.app.slug'),
      workflowRunId: workflowRunIdFromDetailsUrl(detailsUrl),
    };
  }

  public async getArtifact(repository: string, artifactId: number): Promise<GitHubArtifactRecord> {
    const value = await this.getJson(
      `${githubRepositoryApiPath(repository)}/actions/artifacts/${String(
        requireInteger(artifactId, 'artifact ID', 1),
      )}`,
      'GitHub Actions artifact',
    );
    const record = requireRecord(value, 'GitHub Actions artifact');
    const workflowRun = requireRecord(record.workflow_run, 'GitHub Actions artifact.workflow_run');
    return {
      repository,
      id: requireInteger(record.id, 'GitHub Actions artifact.id', 1),
      name: requireString(record.name, 'GitHub Actions artifact.name'),
      workflowRunId: requireInteger(workflowRun.id, 'GitHub Actions artifact.workflow_run.id', 1),
      expired: requireBoolean(record.expired, 'GitHub Actions artifact.expired'),
      digestSha256: parseGitHubArtifactDigest(record.digest, 'GitHub Actions artifact.digest'),
    };
  }
}

function discoverDispatchIdentityDefinitions(
  absoluteDirectory: string,
  relativeDirectory: string,
): DispatchIdentityDefinition[] {
  const definitions: DispatchIdentityDefinition[] = [];
  const entries = readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = resolve(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      definitions.push(...discoverDispatchIdentityDefinitions(absolutePath, relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const name = agentFrontmatterName(readFileSync(absolutePath));
      if (name !== null) {
        definitions.push({ name, path: relativePath });
      }
    }
  }
  return definitions;
}

export class LocalDispatchIdentityCatalog implements DispatchIdentityCatalog {
  public definitions(): readonly DispatchIdentityDefinition[] {
    return discoverDispatchIdentityDefinitions(
      resolveRepositoryFile('.claude/agents'),
      '.claude/agents',
    );
  }
}

export function assertOriginMainStable(startSha: string, endSha: string): ValidationIssue[] {
  if (startSha === endSha) {
    return [];
  }
  return [
    {
      code: 'ORIGIN_MAIN_MOVED',
      message: `origin/main moved from ${startSha} to ${endSha} during evidence validation`,
    },
  ];
}

function resolveRepositoryFile(path: string): string {
  const absolute = resolve(REPO_ROOT, path);
  const relativePath = relative(REPO_ROOT, absolute);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('..\\')
  ) {
    throw new Error(`${path} must resolve to a file below the repository root`);
  }
  return absolute;
}

export async function runIntegrationEvidenceGate(
  mode: 'static' | 'live',
): Promise<ValidationIssue[]> {
  const manifestBytes = readFileSync(resolveRepositoryFile(DEFAULT_MANIFEST_PATH));
  const manifest = parseIntegrationEvidenceManifest(JSON.parse(manifestBytes.toString('utf8')));
  const requiredStatusBytes = readFileSync(
    resolveRepositoryFile(manifest.requiredStatusManifestPath),
  );
  const requiredStatus = parseRequiredStatusContract(requiredStatusBytes);
  const identityIssues = validateExecutionIdentityDefinitions(
    manifest,
    new LocalDispatchIdentityCatalog(),
  );
  if (mode === 'static') {
    return [...validateIntegrationEvidenceStatic(manifest, requiredStatus), ...identityIssues];
  }
  const git = new BoundedGitEvidenceReader();
  const startMainSha = await git.resolveRef(ORIGIN_MAIN_REF);
  const issues = await validateIntegrationEvidenceLive(
    manifest,
    requiredStatus,
    startMainSha,
    git,
    {
      github: new BoundedGitHubActionsEvidenceReader(requiredStatus.repository),
    },
  );
  const endMainSha = await git.resolveRef(ORIGIN_MAIN_REF);
  return [...issues, ...identityIssues, ...assertOriginMainStable(startMainSha, endMainSha)];
}

function parseCliMode(args: readonly string[]): 'static' | 'live' {
  if (args.length !== 1 || (args[0] !== '--static' && args[0] !== '--live')) {
    throw new Error('usage: capability-integration-evidence.ts --static|--live');
  }
  return args[0] === '--live' ? 'live' : 'static';
}

async function main(): Promise<void> {
  const mode = parseCliMode(process.argv.slice(2));
  const issues = await runIntegrationEvidenceGate(mode);
  if (issues.length > 0) {
    for (const issue of issues) {
      process.stderr.write(
        `[${issue.code}]${issue.unitId === undefined ? '' : ` ${issue.unitId}`}: ${issue.message}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`capability integration evidence (${mode}): ok\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`capability integration evidence: ${message}\n`);
    process.exitCode = 1;
  });
}
