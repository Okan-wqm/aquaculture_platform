#!/usr/bin/env ts-node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { lstat, open, readlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { type Readable } from 'node:stream';

import { REPO_ROOT } from './lib/repo-root';

const MANIFEST_PATH = 'docs/plans/2026-06-18-enterprise-grade-debt-closure/manifest.json';
const MAIN_REF = 'refs/remotes/origin/main';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_STREAMED_GIT_STDERR_BYTES = 64 * 1024;
const MAX_BOUNDED_GIT_TEXT_BYTES = 4 * 1024;
const MAX_RETIREMENT_STATEMENT_BYTES = 64 * 1024;
const MAX_RETIREMENT_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_RETIREMENT_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_COSIGN_OUTPUT_BYTES = 64 * 1024;
const MINIMUM_COSIGN_VERSION = [3, 0, 4] as const;
const RETIREMENT_STATEMENT_SCHEMA =
  'https://app.suderra.com/schemas/capability-source-retirement-authorization/v1';
const CONTENT_ADDRESSED_ARTIFACT_URI =
  /^artifact:\/\/sha256\/([0-9a-f]{64})\/([A-Za-z0-9][A-Za-z0-9._/-]{0,511})$/;
export const TRUSTED_RETIREMENT_ISSUER = 'https://token.actions.githubusercontent.com';
export const TRUSTED_RETIREMENT_WORKFLOW_IDENTITY =
  'https://github.com/Okan-wqm/aquaculture_platform/.github/workflows/source-retirement.yml@refs/heads/main';
const GIT_OBJECT_MODE_REGULAR = '100644';
const GIT_OBJECT_MODE_EXECUTABLE = '100755';
const GIT_OBJECT_MODE_SYMLINK = '120000';
const SOURCE_KIND_ORDER: Readonly<Record<SourceKind, number>> = {
  REMOTE_BRANCH: 0,
  LOCAL_BRANCH: 1,
  DIRTY_WORKTREE: 2,
};

export type SourceKind = 'REMOTE_BRANCH' | 'LOCAL_BRANCH' | 'DIRTY_WORKTREE';
export type InventoryScope = 'full' | 'remote';
export type SourceDisposition =
  | 'ALREADY_ON_MAIN'
  | 'EXACT_HEAD_PR'
  | 'FORENSIC_ONLY'
  | 'PRESERVE_PENDING'
  | 'REIMPLEMENT'
  | 'SELECTIVE_EXTRACT'
  | 'SUPERSEDE';
export type SourceState =
  | 'UNASSESSED'
  | 'ASSESSING'
  | 'PRESERVED_DIRTY'
  | 'SUPERSEDED'
  | 'INTEGRATED';

interface BranchSourceCoordinate {
  kind: 'REMOTE_BRANCH' | 'LOCAL_BRANCH';
  locator: string;
  headSha: string;
}

interface DirtyWorktreeSourceCoordinate {
  kind: 'DIRTY_WORKTREE';
  locator: string;
  headSha: string;
  contentSha256: string;
}

export type SourceCoordinate = BranchSourceCoordinate | DirtyWorktreeSourceCoordinate;

export interface RetirementApproval {
  status: 'RETIRE_APPROVED';
  approvedAt: string;
  approvedBy: string;
  snapshotSha256: string;
  snapshotUri: string;
  capturedContentSha256?: string;
  evidence: string[];
  authorization: RetirementAuthorization;
}

export interface RetirementAuthorization {
  kind: 'SIGSTORE_BUNDLE_V1';
  issuer: string;
  signerIdentity: string;
  statementSha256: string;
  statementUri: string;
  subjectSha256: string;
  bundleSha256: string;
  bundleUri: string;
}

export interface RetirementAuthorizationDecision {
  authorized: boolean;
  reason: string;
  verifiedSubjectSha256: string;
  verifiedSnapshotSha256: string;
  verifiedBundleSha256: string;
  verifiedIssuer: string;
  verifiedSignerIdentity: string;
  verifiedSourceId: string;
  verifiedSourceKind: SourceKind;
  verifiedSourceLocator: string;
  verifiedSourceHeadSha: string;
  verifiedApprovedBy: string;
  verifiedApprovedAt: string;
  verifiedCapturedContentSha256?: string;
}

export interface RetirementAuthorizationContext {
  source: ManifestSourceCoordinate;
  approval: RetirementApproval;
}

export type RetirementAuthorizationVerifier = (
  context: RetirementAuthorizationContext,
) => RetirementAuthorizationDecision;

export interface CosignCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface RetirementVerifierDependencies {
  invokeCosign?: (args: readonly string[]) => CosignCommandResult;
}

export interface InventoryCliOptions {
  scope: InventoryScope;
  retirementEvidenceRoot?: string;
}

export interface DirtyContentHashObserver {
  beforeSnapshotVerification?: () => Promise<void> | void;
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

export type ManifestSourceCoordinate = SourceCoordinate & {
  id: string;
  state: SourceState;
  disposition: SourceDisposition;
  mainProof?: MainProof;
  retirement?: RetirementApproval;
};

export interface InventoryManifest {
  reconciledBaseSha: string;
  sources: ManifestSourceCoordinate[];
}

export interface RefCoordinate {
  locator: string;
  headSha: string;
}

export interface WorktreeCoordinate {
  path: string;
  headSha: string;
  branchRef: string | null;
}

export interface InspectedWorktree extends WorktreeCoordinate {
  dirty: boolean;
  contentSha256?: string;
}

export interface ExecutionIdentity {
  worktreePath: string;
  headSha: string;
  branchRef: string | null;
  originRef: string | null;
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
  isReachableFromRemote?: (headSha: string) => boolean;
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
  | 'SOURCE_CONTENT_DRIFT'
  | 'SOURCE_MAIN_PROOF_INVALID'
  | 'SOURCE_RETIREMENT_INVALID'
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
  content_sha256?: string;
  state: SourceState;
  disposition: SourceDisposition;
  main_proof?: MainProof;
  retirement?: RetirementApproval;
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
  if (value !== 'REMOTE_BRANCH' && value !== 'LOCAL_BRANCH' && value !== 'DIRTY_WORKTREE') {
    throw new Error(`${field} must be REMOTE_BRANCH, LOCAL_BRANCH, or DIRTY_WORKTREE`);
  }
  return value;
}

function requireSourceState(value: unknown, field: string): SourceState {
  if (
    value !== 'UNASSESSED' &&
    value !== 'ASSESSING' &&
    value !== 'PRESERVED_DIRTY' &&
    value !== 'SUPERSEDED' &&
    value !== 'INTEGRATED'
  ) {
    throw new Error(
      `${field} must be UNASSESSED, ASSESSING, PRESERVED_DIRTY, SUPERSEDED, or INTEGRATED`,
    );
  }
  return value;
}

function requireSourceDisposition(value: unknown, field: string): SourceDisposition {
  if (
    value !== 'ALREADY_ON_MAIN' &&
    value !== 'EXACT_HEAD_PR' &&
    value !== 'FORENSIC_ONLY' &&
    value !== 'PRESERVE_PENDING' &&
    value !== 'REIMPLEMENT' &&
    value !== 'SELECTIVE_EXTRACT' &&
    value !== 'SUPERSEDE'
  ) {
    throw new Error(
      `${field} must be ALREADY_ON_MAIN, EXACT_HEAD_PR, FORENSIC_ONLY, PRESERVE_PENDING, REIMPLEMENT, SELECTIVE_EXTRACT, or SUPERSEDE`,
    );
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

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${field} must be a canonical ISO-8601 UTC timestamp`);
  }
  return timestamp;
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

interface ContentAddressedArtifactCoordinate {
  relativePath: string;
  sha256: string;
}

function parseContentAddressedArtifactUri(
  uri: string,
  expectedSha256: string,
  field: string,
): ContentAddressedArtifactCoordinate {
  const match = CONTENT_ADDRESSED_ARTIFACT_URI.exec(uri);
  if (!match) {
    throw new Error(`${field} must use artifact://sha256/<digest>/<safe-relative-name>`);
  }
  const [, uriSha256, suffix] = match;
  if (!uriSha256 || !suffix) {
    throw new Error(`${field} lost its content-addressed coordinate`);
  }
  if (uriSha256 !== expectedSha256) {
    throw new Error(`${field} digest must equal its declared SHA-256`);
  }
  const components = suffix.split('/');
  if (
    components.some(
      (component) =>
        component.length === 0 ||
        component === '.' ||
        component === '..' ||
        component.includes('\\'),
    )
  ) {
    throw new Error(`${field} contains an unsafe path component`);
  }
  return {
    relativePath: join('sha256', uriSha256, ...components),
    sha256: uriSha256,
  };
}

function parseRetirement(
  value: unknown,
  field: string,
  sourceState: SourceState,
  sourceKind: SourceKind,
  sourceContentSha256: string | undefined,
): RetirementApproval | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  if (value.status !== 'RETIRE_APPROVED') {
    throw new Error(`${field}.status must be RETIRE_APPROVED`);
  }
  if (!isTerminalSourceState(sourceState)) {
    throw new Error(`${field} is allowed only for a terminal source`);
  }

  const snapshotSha256 = requireSha256(value.snapshot_sha256, `${field}.snapshot_sha256`);
  const snapshotUri = requireString(value.snapshot_uri, `${field}.snapshot_uri`);
  parseContentAddressedArtifactUri(snapshotUri, snapshotSha256, `${field}.snapshot_uri`);
  const capturedContentSha256 =
    value.captured_content_sha256 === undefined
      ? undefined
      : requireSha256(value.captured_content_sha256, `${field}.captured_content_sha256`);
  if (sourceKind === 'DIRTY_WORKTREE') {
    if (capturedContentSha256 === undefined) {
      throw new Error(`${field}.captured_content_sha256 is required for a dirty worktree`);
    }
    if (capturedContentSha256 !== sourceContentSha256) {
      throw new Error(`${field}.captured_content_sha256 must equal source content_sha256`);
    }
  } else if (capturedContentSha256 !== undefined) {
    throw new Error(`${field}.captured_content_sha256 is allowed only for a dirty worktree`);
  }

  if (!isRecord(value.authorization)) {
    throw new Error(`${field}.authorization must be an object`);
  }
  const authorizationField = `${field}.authorization`;
  if (value.authorization.kind !== 'SIGSTORE_BUNDLE_V1') {
    throw new Error(`${authorizationField}.kind must be SIGSTORE_BUNDLE_V1`);
  }
  const subjectSha256 = requireSha256(
    value.authorization.subject_sha256,
    `${authorizationField}.subject_sha256`,
  );
  const bundleUri = requireString(
    value.authorization.bundle_uri,
    `${authorizationField}.bundle_uri`,
  );
  const bundleSha256 = requireSha256(
    value.authorization.bundle_sha256,
    `${authorizationField}.bundle_sha256`,
  );
  parseContentAddressedArtifactUri(bundleUri, bundleSha256, `${authorizationField}.bundle_uri`);
  const statementSha256 = requireSha256(
    value.authorization.statement_sha256,
    `${authorizationField}.statement_sha256`,
  );
  const statementUri = requireString(
    value.authorization.statement_uri,
    `${authorizationField}.statement_uri`,
  );
  parseContentAddressedArtifactUri(
    statementUri,
    statementSha256,
    `${authorizationField}.statement_uri`,
  );
  if (subjectSha256 !== statementSha256) {
    throw new Error(`${authorizationField}.subject_sha256 must equal statement_sha256`);
  }
  const evidence = requireStringArray(value.evidence, `${field}.evidence`);
  if (evidence.length !== 3) {
    throw new Error(`${field}.evidence must contain exactly three retirement artifacts`);
  }
  if (new Set(evidence).size !== evidence.length) {
    throw new Error(`${field}.evidence must not contain duplicate artifact URIs`);
  }
  for (const requiredUri of [snapshotUri, statementUri, bundleUri]) {
    if (!evidence.includes(requiredUri)) {
      throw new Error(
        `${field}.evidence must include snapshot, authorization statement, and signature bundle URIs`,
      );
    }
  }
  if (new Set([snapshotUri, statementUri, bundleUri]).size !== 3) {
    throw new Error(`${field} artifact URIs must be distinct`);
  }

  return {
    status: value.status,
    approvedAt: requireIsoTimestamp(value.approved_at, `${field}.approved_at`),
    approvedBy: requireString(value.approved_by, `${field}.approved_by`),
    snapshotSha256,
    snapshotUri,
    ...(capturedContentSha256 ? { capturedContentSha256 } : {}),
    evidence,
    authorization: {
      kind: value.authorization.kind,
      issuer: requireString(value.authorization.issuer, `${authorizationField}.issuer`),
      signerIdentity: requireString(
        value.authorization.signer_identity,
        `${authorizationField}.signer_identity`,
      ),
      statementSha256,
      statementUri,
      subjectSha256,
      bundleSha256,
      bundleUri,
    },
  };
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

function parseRawManifestSource(source: Record<string, unknown>, index: number): RawManifestSource {
  const field = `capability_reconciliation.sources[${index}]`;
  const kind = requireSourceKind(source.kind, `${field}.kind`);
  const locator = requireString(source.locator, `${field}.locator`);
  const state = requireSourceState(source.state, `${field}.state`);
  const disposition = requireSourceDisposition(source.disposition, `${field}.disposition`);
  const headSha = requireSha(source.head_sha, `${field}.head_sha`);
  const contentSha256 =
    kind === 'DIRTY_WORKTREE'
      ? requireSha256(source.content_sha256, `${field}.content_sha256`)
      : undefined;

  if (kind === 'REMOTE_BRANCH' && !locator.startsWith('refs/remotes/origin/')) {
    throw new Error(`${field}.locator must be an origin remote ref`);
  }
  if (kind === 'LOCAL_BRANCH' && !locator.startsWith('refs/heads/')) {
    throw new Error(`${field}.locator must be a local branch ref`);
  }
  if (kind === 'DIRTY_WORKTREE' && !isAbsolute(locator)) {
    throw new Error(`${field}.locator must be an absolute worktree path`);
  }

  return {
    id: requireString(source.id, `${field}.id`),
    kind,
    locator,
    head_sha: headSha,
    ...(kind === 'DIRTY_WORKTREE'
      ? {
          content_sha256: contentSha256,
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
    retirement: parseRetirement(
      source.retirement,
      `${field}.retirement`,
      state,
      kind,
      contentSha256,
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
  const sources = requireRecordArray(
    reconciliation.sources,
    'capability_reconciliation.sources',
  ).map(parseRawManifestSource);

  return {
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
        ...(source.retirement ? { retirement: source.retirement } : {}),
      };
      if (source.kind === 'DIRTY_WORKTREE') {
        if (!source.content_sha256) {
          throw new Error(`capability_reconciliation source ${source.id} lost its content SHA-256`);
        }
        return {
          ...governance,
          kind: source.kind,
          locator: source.locator,
          headSha: source.head_sha,
          contentSha256: source.content_sha256,
        };
      }
      return {
        ...governance,
        kind: source.kind,
        locator: source.locator,
        headSha: source.head_sha,
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

export function parseWorktreeList(raw: string): WorktreeCoordinate[] {
  const worktrees: WorktreeCoordinate[] = [];
  let path: string | null = null;
  let headSha: string | null = null;
  let branchRef: string | null = null;

  const flush = (): void => {
    if (path === null) {
      return;
    }
    if (headSha === null) {
      throw new Error(`registered worktree ${path} has no HEAD`);
    }
    worktrees.push({ path, headSha, branchRef });
    path = null;
    headSha = null;
    branchRef = null;
  };

  for (const field of raw.split('\0')) {
    if (field.length === 0) {
      continue;
    }
    if (field.startsWith('worktree ')) {
      flush();
      path = field.slice('worktree '.length);
      if (!isAbsolute(path)) {
        throw new Error(`registered worktree path must be absolute: ${path}`);
      }
      continue;
    }
    if (field.startsWith('HEAD ')) {
      headSha = requireSha(field.slice('HEAD '.length), `worktree ${path ?? '<unknown>'}.HEAD`);
      continue;
    }
    if (field.startsWith('branch ')) {
      branchRef = requireString(
        field.slice('branch '.length),
        `worktree ${path ?? '<unknown>'}.branch`,
      );
    }
  }
  flush();

  return worktrees;
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

  for (const remote of remoteRefs) {
    if (isOriginMainAlias(remote.locator) || isExecutionRef(remote)) {
      continue;
    }
    if (!remote.locator.startsWith('refs/remotes/origin/')) {
      throw new Error(`unexpected non-origin remote ref: ${remote.locator}`);
    }
    if (!input.isAncestor(remote.headSha, input.mainSha)) {
      sources.push({
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
      if (local.locator === 'refs/heads/main' || isExecutionRef(local)) {
        continue;
      }
      if (!local.locator.startsWith('refs/heads/')) {
        throw new Error(`unexpected non-local branch ref: ${local.locator}`);
      }
      if (!input.isAncestor(local.headSha, input.mainSha) && !remoteContains(local.headSha)) {
        sources.push({
          kind: 'LOCAL_BRANCH',
          locator: local.locator,
          headSha: local.headSha,
        });
      }
    }

    for (const worktree of input.worktrees) {
      if (
        !worktree.dirty ||
        (input.executionIdentity !== null &&
          worktree.path === input.executionIdentity.worktreePath &&
          worktree.headSha === input.executionIdentity.headSha &&
          worktree.branchRef === input.executionIdentity.branchRef)
      ) {
        continue;
      }
      const contentSha256 = requireSha256(
        worktree.contentSha256,
        `dirty worktree ${worktree.path}.contentSha256`,
      );
      sources.push({
        kind: 'DIRTY_WORKTREE',
        locator: worktree.path,
        headSha: worktree.headSha,
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

function groupedByLocator<T extends SourceCoordinate>(sources: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const source of sources) {
    const entries = grouped.get(source.locator) ?? [];
    entries.push(source);
    grouped.set(source.locator, entries);
  }
  return grouped;
}

function sourcesForScope<T extends SourceCoordinate>(
  sources: readonly T[],
  scope: InventoryScope,
): T[] {
  return scope === 'full'
    ? [...sources]
    : sources.filter((source) => source.kind === 'REMOTE_BRANCH');
}

interface ReadEvidenceArtifact {
  bytes?: Buffer;
  sha256: string;
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  return candidatePath.startsWith(rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`);
}

function readEvidenceArtifact(
  evidenceRoot: string | undefined,
  uri: string,
  expectedSha256: string,
  maxBytes: number,
  captureBytes: boolean,
): ReadEvidenceArtifact {
  if (!evidenceRoot || !isAbsolute(evidenceRoot)) {
    throw new Error('an absolute retirement evidence root is required');
  }
  const rootObservation = lstatSync(evidenceRoot, { bigint: true });
  if (rootObservation.isSymbolicLink() || !rootObservation.isDirectory()) {
    throw new Error('retirement evidence root must be a non-symlink directory');
  }
  const canonicalRoot = realpathSync(evidenceRoot);
  if (canonicalRoot !== evidenceRoot) {
    throw new Error('retirement evidence root must already be canonical');
  }

  const coordinate = parseContentAddressedArtifactUri(
    uri,
    expectedSha256,
    'retirement artifact URI',
  );
  const components = coordinate.relativePath.split(sep);
  const parentObservations: Array<{ path: string; stat: BigIntStats }> = [];
  let parentPath = canonicalRoot;
  for (const component of components.slice(0, -1)) {
    parentPath = join(parentPath, component);
    const observation = lstatSync(parentPath, { bigint: true });
    if (observation.isSymbolicLink() || !observation.isDirectory()) {
      throw new Error(
        `retirement evidence path component is not a trusted directory: ${component}`,
      );
    }
    parentObservations.push({ path: parentPath, stat: observation });
  }

  const artifactPath = join(canonicalRoot, coordinate.relativePath);
  if (!isPathWithinRoot(canonicalRoot, artifactPath)) {
    throw new Error('retirement artifact escaped its evidence root');
  }
  const pathBefore = lstatSync(artifactPath, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new Error('retirement artifact must be a non-symlink regular file');
  }

  const descriptor = openSync(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    if (!descriptorBefore.isFile() || !sameFileObservation(pathBefore, descriptorBefore)) {
      throw new Error('retirement artifact changed before its evidence descriptor opened');
    }
    if (descriptorBefore.size > BigInt(maxBytes)) {
      throw new Error(`retirement artifact exceeds its ${maxBytes}-byte read contract`);
    }

    const descriptorPath = realpathSync(`/proc/self/fd/${descriptor}`);
    if (descriptorPath !== artifactPath || !isPathWithinRoot(canonicalRoot, descriptorPath)) {
      throw new Error('retirement artifact descriptor resolved outside its evidence root');
    }

    const digest = createHash('sha256');
    const chunks: Buffer[] = [];
    const readBuffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (BigInt(position) < descriptorBefore.size) {
      const remaining = Number(descriptorBefore.size - BigInt(position));
      const requested = Math.min(readBuffer.length, remaining);
      const bytesRead = readSync(descriptor, readBuffer, 0, requested, position);
      if (bytesRead === 0) {
        throw new Error('retirement artifact ended before its observed size');
      }
      const bytes = Buffer.from(readBuffer.subarray(0, bytesRead));
      digest.update(bytes);
      if (captureBytes) {
        chunks.push(bytes);
      }
      position += bytesRead;
    }

    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(artifactPath, { bigint: true });
    if (
      !sameFileObservation(descriptorBefore, descriptorAfter) ||
      !sameFileObservation(pathBefore, pathAfter) ||
      BigInt(position) !== descriptorBefore.size
    ) {
      throw new Error('retirement artifact changed during bounded evidence reading');
    }
    for (const parent of parentObservations) {
      const current = lstatSync(parent.path, { bigint: true });
      if (!sameFileObservation(parent.stat, current)) {
        throw new Error('retirement evidence path changed during artifact reading');
      }
    }
    const rootAfter = lstatSync(evidenceRoot, { bigint: true });
    if (!sameFileObservation(rootObservation, rootAfter)) {
      throw new Error('retirement evidence root changed during artifact reading');
    }

    const sha256 = digest.digest('hex');
    if (sha256 !== coordinate.sha256) {
      throw new Error(`retirement artifact digest ${sha256} differs from ${coordinate.sha256}`);
    }
    return {
      sha256,
      ...(captureBytes ? { bytes: Buffer.concat(chunks, position) } : {}),
    };
  } finally {
    closeSync(descriptor);
  }
}

export function serializeRetirementAuthorizationStatement(
  context: RetirementAuthorizationContext,
): string {
  const { source, approval } = context;
  return `${JSON.stringify({
    schema: RETIREMENT_STATEMENT_SCHEMA,
    issuer: TRUSTED_RETIREMENT_ISSUER,
    signer_identity: TRUSTED_RETIREMENT_WORKFLOW_IDENTITY,
    source: {
      id: source.id,
      kind: source.kind,
      locator: source.locator,
      head_sha: source.headSha,
      content_sha256: source.kind === 'DIRTY_WORKTREE' ? source.contentSha256 : null,
      state: source.state,
      disposition: source.disposition,
    },
    approval: {
      status: approval.status,
      approved_by: approval.approvedBy,
      approved_at: approval.approvedAt,
    },
    snapshot: {
      uri: approval.snapshotUri,
      sha256: approval.snapshotSha256,
    },
  })}\n`;
}

function invokeCosign(args: readonly string[]): CosignCommandResult {
  const result = spawnSync('cosign', [...args], {
    encoding: 'utf8',
    maxBuffer: MAX_COSIGN_OUTPUT_BYTES,
    shell: false,
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

function assertCosignCommandSucceeded(result: CosignCommandResult, operation: string): void {
  if (result.error) {
    throw new Error(`${operation} could not execute: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${operation} failed with status ${String(result.status)}: ${
        result.stderr.trim() || 'no stderr'
      }`,
    );
  }
}

function assertSupportedCosignVersion(
  invoke: (args: readonly string[]) => CosignCommandResult,
): void {
  const result = invoke(['version', '--json']);
  assertCosignCommandSucceeded(result, 'cosign version preflight');

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error('cosign version preflight returned non-JSON output');
  }
  if (!isRecord(payload) || typeof payload.gitVersion !== 'string') {
    throw new Error('cosign version preflight omitted gitVersion');
  }
  const match = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:\+[0-9A-Za-z.-]+)?$/.exec(payload.gitVersion);
  if (!match) {
    throw new Error(`cosign gitVersion ${payload.gitVersion} is not a stable semantic version`);
  }
  const version = match.slice(1).map(Number);
  const supported = MINIMUM_COSIGN_VERSION.every((minimum, index) => {
    const actual = version[index];
    if (actual === undefined) {
      return false;
    }
    const previousEqual = version
      .slice(0, index)
      .every((component, previousIndex) => component === MINIMUM_COSIGN_VERSION[previousIndex]);
    return !previousEqual || actual >= minimum;
  });
  if (!supported) {
    throw new Error(
      `cosign ${payload.gitVersion} is below required v${MINIMUM_COSIGN_VERSION.join('.')}`,
    );
  }
}

function verifyStatementWithCosign(
  statement: Buffer,
  bundle: Buffer,
  invoke: (args: readonly string[]) => CosignCommandResult,
): void {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aqua-retirement-cosign-'));
  const statementPath = join(temporaryDirectory, 'authorization-statement.json');
  const bundlePath = join(temporaryDirectory, 'sigstore-bundle.json');
  try {
    writeFileSync(statementPath, statement, { flag: 'wx', mode: 0o600 });
    writeFileSync(bundlePath, bundle, { flag: 'wx', mode: 0o600 });
    const result = invoke([
      'verify-blob',
      '--bundle',
      bundlePath,
      '--certificate-identity',
      TRUSTED_RETIREMENT_WORKFLOW_IDENTITY,
      '--certificate-oidc-issuer',
      TRUSTED_RETIREMENT_ISSUER,
      statementPath,
    ]);
    assertCosignCommandSucceeded(result, 'cosign retirement statement verification');
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function createTrustedRetirementAuthorizationVerifier(
  evidenceRoot: string | undefined,
  dependencies: RetirementVerifierDependencies = {},
): RetirementAuthorizationVerifier {
  const trustedCosign = dependencies.invokeCosign ?? invokeCosign;
  let versionVerified = false;

  return (context): RetirementAuthorizationDecision => {
    const { source, approval } = context;
    requireIsoTimestamp(approval.approvedAt, 'retirement.approved_at');
    requireString(approval.approvedBy, 'retirement.approved_by');
    if (
      approval.authorization.issuer !== TRUSTED_RETIREMENT_ISSUER ||
      approval.authorization.signerIdentity !== TRUSTED_RETIREMENT_WORKFLOW_IDENTITY
    ) {
      throw new Error('retirement authorization is not signed by the trusted main workflow');
    }
    if (approval.authorization.subjectSha256 !== approval.authorization.statementSha256) {
      throw new Error('retirement authorization subject differs from the signed statement digest');
    }

    parseContentAddressedArtifactUri(
      approval.snapshotUri,
      requireSha256(approval.snapshotSha256, 'retirement.snapshot_sha256'),
      'retirement.snapshot_uri',
    );
    parseContentAddressedArtifactUri(
      approval.authorization.statementUri,
      requireSha256(
        approval.authorization.statementSha256,
        'retirement.authorization.statement_sha256',
      ),
      'retirement.authorization.statement_uri',
    );
    parseContentAddressedArtifactUri(
      approval.authorization.bundleUri,
      requireSha256(approval.authorization.bundleSha256, 'retirement.authorization.bundle_sha256'),
      'retirement.authorization.bundle_uri',
    );

    const statementArtifact = readEvidenceArtifact(
      evidenceRoot,
      approval.authorization.statementUri,
      approval.authorization.statementSha256,
      MAX_RETIREMENT_STATEMENT_BYTES,
      true,
    );
    const statement = statementArtifact.bytes;
    if (!statement) {
      throw new Error('retirement authorization statement bytes were not captured');
    }
    const expectedStatement = Buffer.from(
      serializeRetirementAuthorizationStatement(context),
      'utf8',
    );
    if (!statement.equals(expectedStatement)) {
      throw new Error(
        'signed retirement statement does not exactly bind the manifest source, approval, and snapshot',
      );
    }

    readEvidenceArtifact(
      evidenceRoot,
      approval.snapshotUri,
      approval.snapshotSha256,
      MAX_RETIREMENT_SNAPSHOT_BYTES,
      false,
    );
    const bundleArtifact = readEvidenceArtifact(
      evidenceRoot,
      approval.authorization.bundleUri,
      approval.authorization.bundleSha256,
      MAX_RETIREMENT_BUNDLE_BYTES,
      true,
    );
    const bundle = bundleArtifact.bytes;
    if (!bundle) {
      throw new Error('Sigstore bundle bytes were not captured');
    }

    if (!versionVerified) {
      assertSupportedCosignVersion(trustedCosign);
      versionVerified = true;
    }
    verifyStatementWithCosign(statement, bundle, trustedCosign);

    return {
      authorized: true,
      reason: 'trusted main workflow Sigstore authorization verified',
      verifiedSubjectSha256: approval.authorization.statementSha256,
      verifiedSnapshotSha256: approval.snapshotSha256,
      verifiedBundleSha256: approval.authorization.bundleSha256,
      verifiedIssuer: TRUSTED_RETIREMENT_ISSUER,
      verifiedSignerIdentity: TRUSTED_RETIREMENT_WORKFLOW_IDENTITY,
      verifiedSourceId: source.id,
      verifiedSourceKind: source.kind,
      verifiedSourceLocator: source.locator,
      verifiedSourceHeadSha: source.headSha,
      verifiedApprovedBy: approval.approvedBy,
      verifiedApprovedAt: approval.approvedAt,
      ...(source.kind === 'DIRTY_WORKTREE'
        ? { verifiedCapturedContentSha256: source.contentSha256 }
        : {}),
    };
  };
}

function retirementAuthorizationFailure(
  source: ManifestSourceCoordinate,
  verifier: RetirementAuthorizationVerifier | undefined,
): string | null {
  const approval = source.retirement;
  if (!approval || approval.status !== 'RETIRE_APPROVED') {
    return 'typed retirement approval is absent';
  }
  if (
    approval.authorization.kind !== 'SIGSTORE_BUNDLE_V1' ||
    !SHA256_PATTERN.test(approval.authorization.subjectSha256) ||
    approval.authorization.subjectSha256 !== approval.authorization.statementSha256 ||
    !SHA256_PATTERN.test(approval.authorization.statementSha256) ||
    !SHA256_PATTERN.test(approval.authorization.bundleSha256) ||
    !approval.evidence.includes(approval.snapshotUri) ||
    !approval.evidence.includes(approval.authorization.statementUri) ||
    !approval.evidence.includes(approval.authorization.bundleUri)
  ) {
    return 'retirement authorization is not bound to its snapshot and signature bundle';
  }
  if (source.kind === 'DIRTY_WORKTREE') {
    if (approval.capturedContentSha256 !== source.contentSha256) {
      return 'dirty retirement is not bound to the observed content SHA-256';
    }
  } else if (approval.capturedContentSha256 !== undefined) {
    return 'branch retirement declares a dirty-worktree content binding';
  }
  if (!verifier) {
    return 'no trusted retirement authorization verifier is configured';
  }

  let decision: RetirementAuthorizationDecision;
  try {
    decision = verifier({ source, approval });
  } catch (error) {
    return `authorization verifier failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  if (
    !isRecord(decision) ||
    typeof decision.authorized !== 'boolean' ||
    typeof decision.reason !== 'string' ||
    decision.reason.length === 0
  ) {
    return 'authorization verifier returned a malformed decision';
  }
  if (!decision.authorized) {
    return decision.reason;
  }
  if (
    decision.verifiedSubjectSha256 !== approval.authorization.statementSha256 ||
    decision.verifiedSnapshotSha256 !== approval.snapshotSha256 ||
    decision.verifiedBundleSha256 !== approval.authorization.bundleSha256 ||
    decision.verifiedIssuer !== approval.authorization.issuer ||
    decision.verifiedSignerIdentity !== approval.authorization.signerIdentity ||
    decision.verifiedSourceId !== source.id ||
    decision.verifiedSourceKind !== source.kind ||
    decision.verifiedSourceLocator !== source.locator ||
    decision.verifiedSourceHeadSha !== source.headSha ||
    decision.verifiedApprovedBy !== approval.approvedBy ||
    decision.verifiedApprovedAt !== approval.approvedAt ||
    decision.verifiedCapturedContentSha256 !== approval.capturedContentSha256
  ) {
    return 'verified signature claims do not match the retirement source and snapshot';
  }
  return null;
}

export function compareInventory(
  manifest: InventoryManifest,
  live: LiveInventory,
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean,
  scope: InventoryScope = 'full',
  verifyRetirementAuthorization?: RetirementAuthorizationVerifier,
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
    if (
      expected.kind === 'DIRTY_WORKTREE' &&
      actual.kind === 'DIRTY_WORKTREE' &&
      expected.contentSha256 !== actual.contentSha256
    ) {
      drifts.push({
        code: 'SOURCE_CONTENT_DRIFT',
        message: `${locator} changed content from ${expected.contentSha256} to ${actual.contentSha256}`,
      });
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
    if (isTerminalSourceState(expected.state) && expected.retirement) {
      const authorizationFailure = retirementAuthorizationFailure(
        expected,
        verifyRetirementAuthorization,
      );
      if (authorizationFailure === null) {
        continue;
      }
      drifts.push({
        code: 'SOURCE_RETIREMENT_INVALID',
        message: `${expected.id} ${expected.locator}: ${authorizationFailure}`,
      });
      continue;
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
        if (!isAncestor(source.mainProof.sourceCommitSha, liveMainSha)) {
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
  const result = spawnSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.error) {
    throw result.error;
  }
  const status = result.status;
  if (status === null || !acceptedStatuses.includes(status)) {
    throw new Error(
      `git ${args.join(' ')} failed with status ${String(status)}: ${
        result.stderr.trim() || 'no stderr'
      }`,
    );
  }
  return { stdout: result.stdout, status };
}

function gitIsAncestor(ancestorSha: string, descendantSha: string): boolean {
  return runGit(['merge-base', '--is-ancestor', ancestorSha, descendantSha], [0, 1]).status === 0;
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

function updateDigestFrame(digest: Hash, label: string, payload: Buffer): void {
  const labelBytes = Buffer.from(label, 'utf8');
  const lengths = Buffer.alloc(16);
  lengths.writeBigUInt64BE(BigInt(labelBytes.length), 0);
  lengths.writeBigUInt64BE(BigInt(payload.length), 8);
  digest.update(lengths);
  digest.update(labelBytes);
  digest.update(payload);
}

interface StreamFingerprint {
  byteLength: bigint;
  sha256: string;
}

interface DirtySnapshotAnchor {
  headSha: string;
  status: StreamFingerprint;
}

interface GitProcessCompletion {
  status: number | null;
  signal: NodeJS.Signals | null;
}

function bufferFromUnknownChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new Error('stream emitted a non-byte chunk');
}

async function collectBoundedStderr(stream: Readable): Promise<string> {
  let captured = '';
  let capturedBytes = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const bytes = bufferFromUnknownChunk(chunk);
    if (capturedBytes >= MAX_STREAMED_GIT_STDERR_BYTES) {
      truncated = true;
      continue;
    }
    const remaining = MAX_STREAMED_GIT_STDERR_BYTES - capturedBytes;
    const accepted = bytes.subarray(0, remaining);
    captured += accepted.toString('utf8');
    capturedBytes += accepted.length;
    truncated ||= accepted.length !== bytes.length;
  }
  return `${captured.trim()}${truncated ? ' [stderr truncated]' : ''}`;
}

async function consumeGitStdout(
  args: readonly string[],
  worktreePath: string,
  consumeChunk: (chunk: Buffer) => Promise<void> | void,
  acceptedStatuses: readonly number[] = [0],
): Promise<number> {
  const child = spawn('git', ['--no-optional-locks', '-C', worktreePath, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completion = new Promise<GitProcessCompletion>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  const stderrPromise = collectBoundedStderr(child.stderr);

  try {
    for await (const chunk of child.stdout) {
      await consumeChunk(bufferFromUnknownChunk(chunk));
    }
    const [result, stderr] = await Promise.all([completion, stderrPromise]);
    if (result.status === null || !acceptedStatuses.includes(result.status)) {
      throw new Error(
        `git ${args.join(' ')} failed in ${worktreePath} with status ${String(
          result.status,
        )}${result.signal ? ` (${result.signal})` : ''}: ${stderr || 'no stderr'}`,
      );
    }
    return result.status;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    await Promise.allSettled([completion, stderrPromise]);
    throw error;
  }
}

async function fingerprintGitStdout(
  args: readonly string[],
  worktreePath: string,
): Promise<StreamFingerprint> {
  const digest = createHash('sha256');
  let byteLength = 0n;
  await consumeGitStdout(args, worktreePath, (chunk) => {
    byteLength += BigInt(chunk.length);
    digest.update(chunk);
  });
  return { byteLength, sha256: digest.digest('hex') };
}

async function readBoundedGitText(args: readonly string[], worktreePath: string): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  await consumeGitStdout(args, worktreePath, (chunk) => {
    byteLength += chunk.length;
    if (byteLength > MAX_BOUNDED_GIT_TEXT_BYTES) {
      throw new Error(
        `git ${args.join(' ')} exceeded the ${MAX_BOUNDED_GIT_TEXT_BYTES}-byte text contract`,
      );
    }
    chunks.push(Buffer.from(chunk));
  });
  return Buffer.concat(chunks, byteLength).toString('utf8');
}

async function consumeGitNulRecords(
  args: readonly string[],
  worktreePath: string,
  label: string,
  consumeRecord: (record: Buffer) => Promise<void>,
): Promise<void> {
  let remainder = Buffer.alloc(0);
  await consumeGitStdout(args, worktreePath, async (chunk) => {
    const bytes =
      remainder.length === 0
        ? chunk
        : Buffer.concat([remainder, chunk], remainder.length + chunk.length);
    let offset = 0;
    for (;;) {
      const terminator = bytes.indexOf(0, offset);
      if (terminator === -1) {
        break;
      }
      if (terminator === offset) {
        throw new Error(`${label} contains an empty record`);
      }
      await consumeRecord(Buffer.from(bytes.subarray(offset, terminator)));
      offset = terminator + 1;
    }
    remainder = Buffer.from(bytes.subarray(offset));
  });
  if (remainder.length !== 0) {
    throw new Error(`${label} is not NUL terminated`);
  }
}

function updateDigestFingerprintFrame(
  digest: Hash,
  label: string,
  fingerprint: StreamFingerprint,
): void {
  if (fingerprint.byteLength > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`${label} exceeds the canonical 64-bit length frame`);
  }
  const payload = Buffer.alloc(40);
  payload.writeBigUInt64BE(fingerprint.byteLength, 0);
  Buffer.from(requireSha256(fingerprint.sha256, `${label}.sha256`), 'hex').copy(payload, 8);
  updateDigestFrame(digest, label, payload);
}

function fingerprintBuffer(payload: Buffer): StreamFingerprint {
  return {
    byteLength: BigInt(payload.length),
    sha256: createHash('sha256').update(payload).digest('hex'),
  };
}

async function fingerprintFileHandle(handle: FileHandle): Promise<StreamFingerprint> {
  const digest = createHash('sha256');
  let byteLength = 0n;
  for await (const chunk of handle.createReadStream({
    autoClose: false,
    highWaterMark: 64 * 1024,
  })) {
    const bytes = bufferFromUnknownChunk(chunk);
    byteLength += BigInt(bytes.length);
    digest.update(bytes);
  }
  return { byteLength, sha256: digest.digest('hex') };
}

async function fingerprintRegularFile(
  path: Buffer,
  pathObservation: BigIntStats,
  worktreePath: string,
  relativePath: Buffer,
): Promise<StreamFingerprint> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (!descriptorBefore.isFile() || !sameFileObservation(pathObservation, descriptorBefore)) {
      throw new InventoryInspectionError(
        'DIRTY_SNAPSHOT_MOVED',
        `${worktreePath}/${relativePath.toString('utf8')} changed before its evidence stream opened`,
      );
    }
    const fingerprint = await fingerprintFileHandle(handle);
    const descriptorAfter = await handle.stat({ bigint: true });
    if (
      !sameFileObservation(descriptorBefore, descriptorAfter) ||
      fingerprint.byteLength !== descriptorBefore.size
    ) {
      throw new InventoryInspectionError(
        'DIRTY_SNAPSHOT_MOVED',
        `${worktreePath}/${relativePath.toString('utf8')} changed during evidence hashing`,
      );
    }
    return fingerprint;
  } finally {
    await handle.close();
  }
}

function validateRelativeGitPath(pathBytes: Buffer): void {
  if (pathBytes.length === 0 || pathBytes[0] === 0x2f) {
    throw new Error('git returned an empty or absolute untracked path');
  }
  for (const component of pathBytes.toString('binary').split('/')) {
    if (component.length === 0 || component === '.' || component === '..') {
      throw new Error('git returned an unsafe untracked path');
    }
  }
}

function absoluteBufferPath(worktreePath: string, relativePath: Buffer): Buffer {
  validateRelativeGitPath(relativePath);
  const prefix = Buffer.from(worktreePath.endsWith(sep) ? worktreePath : `${worktreePath}${sep}`);
  return Buffer.concat([prefix, relativePath]);
}

function sameFileObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.rdev === right.rdev &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function resolveGitObjectMode(stat: BigIntStats): string {
  if (stat.isSymbolicLink()) {
    return GIT_OBJECT_MODE_SYMLINK;
  }
  if (!stat.isFile()) {
    throw new Error('unsupported untracked filesystem object');
  }
  return (stat.mode & 0o100n) === 0n ? GIT_OBJECT_MODE_REGULAR : GIT_OBJECT_MODE_EXECUTABLE;
}

const DIRTY_STATUS_ARGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'status.renames=false',
  'status',
  '--porcelain=v2',
  '-z',
  '--untracked-files=all',
  '--ignore-submodules=none',
  '--',
] as const;

async function captureDirtySnapshotAnchor(worktreePath: string): Promise<DirtySnapshotAnchor> {
  const startHead = requireSha(
    (await readBoundedGitText(['rev-parse', '--verify', 'HEAD^{commit}'], worktreePath)).trim(),
    `${worktreePath}.HEAD`,
  );
  const status = await fingerprintGitStdout(DIRTY_STATUS_ARGS, worktreePath);
  const endHead = requireSha(
    (await readBoundedGitText(['rev-parse', '--verify', 'HEAD^{commit}'], worktreePath)).trim(),
    `${worktreePath}.HEAD`,
  );
  if (startHead !== endHead) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${worktreePath} HEAD moved from ${startHead} to ${endHead} while pinning dirty status`,
    );
  }
  return { headSha: startHead, status };
}

function sameFingerprint(left: StreamFingerprint, right: StreamFingerprint): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}

function assertSameDirtySnapshot(
  worktreePath: string,
  expected: DirtySnapshotAnchor,
  actual: DirtySnapshotAnchor,
): void {
  if (expected.headSha !== actual.headSha || !sameFingerprint(expected.status, actual.status)) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${worktreePath} HEAD or exact index/worktree status changed during evidence hashing`,
    );
  }
}

async function hashDirtyEvidence(
  worktreePath: string,
  anchor: DirtySnapshotAnchor,
): Promise<string> {
  const digest = createHash('sha256');
  updateDigestFrame(digest, 'FORMAT', Buffer.from('DIRTY_CONTENT_V2', 'ascii'));
  updateDigestFrame(digest, 'HEAD', Buffer.from(anchor.headSha, 'ascii'));
  updateDigestFingerprintFrame(digest, 'STATUS', anchor.status);
  updateDigestFingerprintFrame(
    digest,
    'INDEX_STAGE_RECORDS',
    await fingerprintGitStdout(['ls-files', '--stage', '--full-name', '-z', '--'], worktreePath),
  );
  updateDigestFingerprintFrame(
    digest,
    'STAGED_BINARY_DIFF',
    await fingerprintGitStdout(
      [
        '-c',
        'diff.algorithm=myers',
        'diff',
        '--cached',
        '--binary',
        '--full-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--',
      ],
      worktreePath,
    ),
  );
  updateDigestFingerprintFrame(
    digest,
    'UNSTAGED_BINARY_DIFF',
    await fingerprintGitStdout(
      [
        '-c',
        'diff.algorithm=myers',
        'diff',
        '--binary',
        '--full-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--',
      ],
      worktreePath,
    ),
  );

  let previousPath: Buffer | null = null;
  let untrackedCount = 0n;
  await consumeGitNulRecords(
    ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--'],
    worktreePath,
    `${worktreePath} untracked path list`,
    async (untrackedPath) => {
      validateRelativeGitPath(untrackedPath);
      if (previousPath !== null && Buffer.compare(previousPath, untrackedPath) >= 0) {
        throw new Error(`${worktreePath} untracked path list is not strictly ordered`);
      }
      previousPath = Buffer.from(untrackedPath);

      const absolutePath = absoluteBufferPath(worktreePath, untrackedPath);
      const before = await lstat(absolutePath, { bigint: true });
      let mode: string;
      try {
        mode = resolveGitObjectMode(before);
      } catch (error) {
        throw new Error(
          `unsupported untracked filesystem object ${untrackedPath.toString('utf8')}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const content =
        mode === GIT_OBJECT_MODE_SYMLINK
          ? fingerprintBuffer(await readlink(absolutePath, { encoding: 'buffer' }))
          : await fingerprintRegularFile(absolutePath, before, worktreePath, untrackedPath);
      const after = await lstat(absolutePath, { bigint: true });
      if (!sameFileObservation(before, after) || content.byteLength !== before.size) {
        throw new InventoryInspectionError(
          'DIRTY_SNAPSHOT_MOVED',
          `${worktreePath}/${untrackedPath.toString('utf8')} changed during evidence hashing`,
        );
      }

      updateDigestFrame(digest, 'UNTRACKED_PATH', untrackedPath);
      updateDigestFrame(digest, 'UNTRACKED_GIT_MODE', Buffer.from(mode, 'ascii'));
      updateDigestFingerprintFrame(digest, 'UNTRACKED_CONTENT', content);
      untrackedCount += 1n;
    },
  );
  const countFrame = Buffer.alloc(8);
  countFrame.writeBigUInt64BE(untrackedCount);
  updateDigestFrame(digest, 'UNTRACKED_COUNT', countFrame);
  return digest.digest('hex');
}

/**
 * Streams the complete non-ignored dirty evidence through a domain-separated Merkle-style digest.
 * A second evidence pass plus exact HEAD/status anchors rejects torn worktree or index snapshots.
 */
export async function computeDirtyContentSha256(
  worktreePath: string,
  observer: DirtyContentHashObserver = {},
): Promise<string> {
  const absoluteWorktreePath = realpathSync(worktreePath);
  const start = await captureDirtySnapshotAnchor(absoluteWorktreePath);
  const digest = await hashDirtyEvidence(absoluteWorktreePath, start);
  if (observer.beforeSnapshotVerification) {
    await observer.beforeSnapshotVerification();
  }
  const verificationStart = await captureDirtySnapshotAnchor(absoluteWorktreePath);
  assertSameDirtySnapshot(absoluteWorktreePath, start, verificationStart);
  const verificationDigest = await hashDirtyEvidence(absoluteWorktreePath, verificationStart);
  const verificationEnd = await captureDirtySnapshotAnchor(absoluteWorktreePath);
  assertSameDirtySnapshot(absoluteWorktreePath, start, verificationEnd);
  if (verificationDigest !== digest) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${absoluteWorktreePath} evidence changed between the primary and verification scans`,
    );
  }
  return digest;
}

export class InventoryInspectionError extends Error {
  public constructor(
    public readonly code:
      | 'CI_EXECUTION_IDENTITY_INVALID'
      | 'CI_EXECUTION_IDENTITY_MISMATCH'
      | 'DIRTY_SNAPSHOT_MOVED'
      | 'ORIGIN_MAIN_MOVED',
    message: string,
  ) {
    super(message);
    this.name = 'InventoryInspectionError';
  }
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
  };
}

export function selectExecutionIdentity(
  githubActions: string | undefined,
  resolveGitHubActionsIdentity: () => ExecutionIdentity | null,
  resolveLocalIdentity: () => ExecutionIdentity | null,
): ExecutionIdentity | null {
  return githubActions === 'true' ? resolveGitHubActionsIdentity() : resolveLocalIdentity();
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

async function inspectLiveRepository(scope: InventoryScope): Promise<LiveInventory> {
  const mainSha = resolveOriginMain();
  const remoteRefs = parseRefList(
    runGit(['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/remotes/origin']).stdout,
  );
  const executionIdentity = resolveExecutionIdentity(remoteRefs);
  const localRefs =
    scope === 'full'
      ? parseRefList(
          runGit(['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads']).stdout,
        )
      : [];
  const worktrees: InspectedWorktree[] = [];
  if (scope === 'full') {
    const registeredWorktrees = parseWorktreeList(
      runGit(['worktree', 'list', '--porcelain', '-z']).stdout,
    );
    for (const worktree of registeredWorktrees) {
      const status = await fingerprintGitStdout(DIRTY_STATUS_ARGS, worktree.path);
      if (status.byteLength === 0n) {
        worktrees.push({ ...worktree, dirty: false });
        continue;
      }
      if (
        executionIdentity !== null &&
        realpathSync(worktree.path) === executionIdentity.worktreePath &&
        worktree.branchRef === executionIdentity.branchRef &&
        worktree.headSha === executionIdentity.headSha
      ) {
        worktrees.push({
          ...worktree,
          path: executionIdentity.worktreePath,
          dirty: true,
        });
        continue;
      }
      worktrees.push({
        ...worktree,
        dirty: true,
        contentSha256: await computeDirtyContentSha256(worktree.path),
      });
    }
  }

  const inventory = discoverInventory(
    {
      mainSha,
      remoteRefs,
      localRefs,
      worktrees,
      executionIdentity,
      isAncestor: gitIsAncestor,
      isReachableFromRemote: gitRemoteContains,
    },
    scope,
  );
  assertOriginMainStable(mainSha, resolveOriginMain());
  return inventory;
}

function readManifest(): InventoryManifest {
  const raw: unknown = JSON.parse(readFileSync(join(REPO_ROOT, MANIFEST_PATH), 'utf8'));
  return parseInventoryManifest(raw);
}

export function parseInventoryCliOptions(args: readonly string[]): InventoryCliOptions {
  const liveArguments = args.filter((argument) => argument === '--live');
  const scopeArguments = args.filter((argument) => argument === '--scope=remote');
  const evidenceRootArguments = args.filter((argument) =>
    argument.startsWith('--retirement-evidence-root='),
  );
  const recognizedCount =
    liveArguments.length + scopeArguments.length + evidenceRootArguments.length;
  if (
    liveArguments.length !== 1 ||
    scopeArguments.length > 1 ||
    evidenceRootArguments.length > 1 ||
    recognizedCount !== args.length
  ) {
    throw new Error(
      'expected --live [--scope=remote] [--retirement-evidence-root=<absolute-path>]',
    );
  }

  const retirementEvidenceRoot = evidenceRootArguments[0]?.slice(
    '--retirement-evidence-root='.length,
  );
  return {
    scope: scopeArguments.length === 1 ? 'remote' : 'full',
    ...(retirementEvidenceRoot !== undefined ? { retirementEvidenceRoot } : {}),
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
  dependencies: RetirementVerifierDependencies = {},
): InventoryDrift[] {
  return compareInventory(
    manifest,
    live,
    isAncestor,
    options.scope,
    createTrustedRetirementAuthorizationVerifier(options.retirementEvidenceRoot, dependencies),
  );
}

async function main(): Promise<void> {
  let options: InventoryCliOptions;
  try {
    options = parseInventoryCliOptions(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`capability-source-inventory: ${message}\n`);
    process.exit(2);
    return;
  }

  try {
    const manifest = readManifest();
    const live = await inspectLiveRepository(options.scope);
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
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`capability-source-inventory: unexpected failure: ${message}\n`);
    process.exit(1);
  });
}
