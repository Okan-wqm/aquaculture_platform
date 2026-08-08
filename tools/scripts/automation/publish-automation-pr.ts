#!/usr/bin/env ts-node

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  AUTOMATION_BASE_BRANCH,
  AUTOMATION_BASE_REF,
  AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS,
  AUTOMATION_REPOSITORY,
  AUTOMATION_REPOSITORY_ID,
  AUTOMATION_REPOSITORY_IDENTITY,
  AUTOMATION_REPOSITORY_OWNER,
  AUTOMATION_REPOSITORY_OWNER_ID,
  automationPublicationBranch,
  automationPublicationEvidenceArtifactName,
  automationPublicationResultBasename,
  automationPublicationRetryIdentityHash,
  isAutomationPublicationResultBasename,
  resolveAutomationPublicationPolicy,
  type AutomationPublicationOperation,
  type ResolvedAutomationPublicationPolicy,
} from '../../gates/lib/automation-publication-policy';

const API_ROOT = 'https://api.github.com';
export const AUTOMATION_PUBLICATION_NETWORK_BUDGET = {
  perCallTimeoutMs: 5_000,
  maxApiCalls: 48,
  maximumSequentialWaitMs: 240_000,
} as const;
const API_TIMEOUT_MS = AUTOMATION_PUBLICATION_NETWORK_BUDGET.perCallTimeoutMs;
const MAX_API_CALLS = AUTOMATION_PUBLICATION_NETWORK_BUDGET.maxApiCalls;
const MAX_API_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PULL_REQUEST_PAGES = 4;
const PULL_REQUEST_PAGE_SIZE = 100;
const MAX_CHANGED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_ENV_BYTES = 16 * 1024;
const MAX_GIT_OUTPUT_BYTES = 128 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]{0,19}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,199}$/;
const APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;
const REPOSITORY_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const RETRY_MARKER_PATTERN = /<!-- aqua-automation-retry-identity:([0-9a-f]{64}) -->/g;

export type AutomationPublicationStatus = 'PUBLISHED' | 'RECOVERED' | 'NO_CHANGE' | 'FAILED';

export interface JsonRecord {
  readonly [key: string]: unknown;
}

export interface ImmutableFileSnapshot {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly gitBlobOid: string;
}

export interface MutationEvidence {
  readonly artifactId: number;
  readonly artifactName: string;
  readonly artifactSha256: string;
}

export interface AutomationPublicationRequest {
  readonly policy: ResolvedAutomationPublicationPolicy;
  readonly repositoryRoot: string;
  readonly baseSha: string;
  readonly commandId: string;
  readonly operation: AutomationPublicationOperation;
  readonly inputSha256: string;
  readonly changedFile: ImmutableFileSnapshot;
  readonly pullRequestBody: string;
  readonly pullRequestBodySha256: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly workflowEvent: string;
  readonly workflowRunId: number;
  readonly workflowRunAttempt: number;
  readonly appSlug: string;
  readonly appInstallationId: number;
  readonly evidence: MutationEvidence | null;
}

export interface AutomationPublicationResult {
  readonly $schema: 'aqua/automation-publication-result/v3';
  readonly status: AutomationPublicationStatus;
  readonly repository: string;
  readonly repository_id: string;
  readonly base_sha: string | null;
  readonly branch: string | null;
  readonly command_id: string | null;
  readonly operation: AutomationPublicationOperation | null;
  readonly input_sha256: string | null;
  readonly retry_identity: string | null;
  readonly changed_path: string | null;
  readonly changed_path_sha256: string | null;
  readonly commit_sha: string | null;
  readonly observed_branch_sha: string | null;
  readonly pr_number: number | null;
  readonly pr_url: string | null;
  readonly workflow: {
    readonly ref: string | null;
    readonly sha: string | null;
    readonly run_id: number | null;
    readonly run_attempt: number | null;
  };
  readonly github_app: {
    readonly slug: string | null;
    readonly installation_id: number | null;
  };
  readonly mutation_evidence: {
    readonly artifact_id: number;
    readonly artifact_name: string;
    readonly artifact_sha256: string;
  } | null;
  readonly error: string | null;
}

export interface RemoteCommitEvidence {
  readonly sha: string;
  readonly message: string;
  readonly parentShas: readonly string[];
  readonly signatureValid: boolean;
  readonly signatureReason: string;
  readonly signatureWasSignedByGitHub: boolean;
  readonly signatureState: string;
  readonly authorLogin: string;
  readonly changedPaths: readonly string[];
  readonly changedBlobOid: string;
}

export interface RemotePullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly headRepository: string;
  readonly authorLogin: string;
  readonly draft: boolean;
  readonly title: string;
  readonly body: string;
}

export interface RemotePullRequestSummary {
  readonly number: number;
  readonly headSha: string;
  readonly title: string;
  readonly body: string;
}

export interface CreatedCommit {
  readonly oid: string;
  readonly refOid: string;
  readonly clientMutationId: string;
  readonly signatureValid: boolean;
  readonly wasSignedByGitHub: boolean;
  readonly signatureState: string;
}

export interface AutomationPublicationRemote {
  assertInstallationIdentity(
    expectedAppSlug: string,
    expectedInstallationId: number,
  ): Promise<void>;
  getBranchOid(branch: string): Promise<string | null>;
  getFileBlobOid(path: string, ref: string): Promise<string | null>;
  getCommit(sha: string, changedPath: string): Promise<RemoteCommitEvidence>;
  listPullRequests(branch: string): Promise<readonly RemotePullRequestSummary[]>;
  getPullRequest(number: number): Promise<RemotePullRequest>;
  isCommitReachableFrom(commitSha: string, mainSha: string): Promise<boolean>;
  createBranch(branch: string, sha: string): Promise<void>;
  createCommit(input: {
    readonly branch: string;
    readonly expectedHeadOid: string;
    readonly headline: string;
    readonly body: string;
    readonly path: string;
    readonly contentsBase64: string;
    readonly clientMutationId: string;
  }): Promise<CreatedCommit>;
  createPullRequest(input: {
    readonly branch: string;
    readonly title: string;
    readonly body: string;
  }): Promise<RemotePullRequest>;
}

export interface PublicationFailureProgress {
  readonly stage: 'VALIDATED' | 'BRANCH_OBSERVED' | 'COMMIT_CREATED' | 'PULL_REQUEST_CREATED';
  readonly retryIdentity: string | null;
  readonly observedBranchSha: string | null;
  readonly commitSha: string | null;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
}

export class PublicationFailure extends Error {
  public constructor(
    message: string,
    public readonly progress: PublicationFailureProgress,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PublicationFailure';
  }
}

export class GitHubApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

class StablePublicationMismatch extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StablePublicationMismatch';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireString(value, field);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function requireSha(value: unknown, field: string): string {
  const sha = requireString(value, field);
  if (!SHA_PATTERN.test(sha)) throw new Error(`${field} must be a full lowercase Git SHA`);
  return sha;
}

function requireSha256(value: string, field: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertExactStrings(
  actual: readonly string[],
  expected: readonly string[],
  field: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(`${field} must equal ${expected.join(', ')}`);
  }
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobOid(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
}

function exactTrailer(message: string, name: string): string {
  const prefix = `${name}: `;
  const values = message
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  if (values.length !== 1 || !values[0]) {
    throw new Error(`${name} must appear exactly once`);
  }
  return values[0];
}

function optionalTrailer(message: string, name: string): string | null {
  const prefix = `${name}: `;
  const values = message
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  if (values.length > 1) throw new Error(`${name} must not be duplicated`);
  return values[0] ?? null;
}

function assertSnapshotMetadataStable(before: Stats, after: Stats, path: string): void {
  const fields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const;
  for (const field of fields) {
    if (before[field] !== after[field]) {
      throw new Error(`Immutable snapshot changed during its only read: ${path}`);
    }
  }
}

function assertPathMatchesDescriptor(
  pathMetadata: Stats,
  descriptorMetadata: Stats,
  path: string,
): void {
  if (
    pathMetadata.isSymbolicLink() ||
    !pathMetadata.isFile() ||
    pathMetadata.dev !== descriptorMetadata.dev ||
    pathMetadata.ino !== descriptorMetadata.ino
  ) {
    throw new Error(`Immutable snapshot path identity changed: ${path}`);
  }
}

export function readImmutableFileSnapshot(
  repositoryRoot: string,
  repositoryRelativePath: string,
  maxBytes = MAX_CHANGED_FILE_BYTES,
): ImmutableFileSnapshot {
  if (
    repositoryRelativePath.length === 0 ||
    repositoryRelativePath.length > 512 ||
    isAbsolute(repositoryRelativePath) ||
    !REPOSITORY_PATH_PATTERN.test(repositoryRelativePath) ||
    repositoryRelativePath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Publication path must be one canonical repository-relative path');
  }
  const canonicalRoot = realpathSync(repositoryRoot);
  const rootPathMetadata = lstatSync(canonicalRoot);
  if (rootPathMetadata.isSymbolicLink() || !rootPathMetadata.isDirectory()) {
    throw new Error('Canonical repository root is not a non-symlink directory');
  }
  const segments = repositoryRelativePath.split('/');
  const fileName = segments.pop();
  if (!fileName) throw new Error('Publication path has no file component');
  const directoryDescriptors: number[] = [];
  let descriptor: number | null = null;
  try {
    let parentDescriptor = openSync(
      canonicalRoot,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    directoryDescriptors.push(parentDescriptor);
    const rootDescriptorMetadata = fstatSync(parentDescriptor);
    if (
      !rootDescriptorMetadata.isDirectory() ||
      rootDescriptorMetadata.dev !== rootPathMetadata.dev ||
      rootDescriptorMetadata.ino !== rootPathMetadata.ino
    ) {
      throw new Error('Canonical repository root identity changed before descriptor anchoring');
    }
    for (const segment of segments) {
      const anchoredComponent = `/proc/self/fd/${String(parentDescriptor)}/${segment}`;
      try {
        parentDescriptor = openSync(
          anchoredComponent,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        );
      } catch (error) {
        throw new Error(`Publication path component is not a non-symlink directory: ${segment}`, {
          cause: error,
        });
      }
      directoryDescriptors.push(parentDescriptor);
      if (!fstatSync(parentDescriptor).isDirectory()) {
        throw new Error(`Publication path component is not a directory: ${segment}`);
      }
    }

    const anchoredPath = `/proc/self/fd/${String(parentDescriptor)}/${fileName}`;
    const pathBefore = lstatSync(anchoredPath);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
      throw new Error(
        `Publication input is not a non-symlink regular file: ${repositoryRelativePath}`,
      );
    }
    descriptor = openSync(anchoredPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile())
      throw new Error(`Publication input is not a regular file: ${repositoryRelativePath}`);
    assertPathMatchesDescriptor(pathBefore, before, repositoryRelativePath);
    if (before.size < 0 || before.size > maxBytes) {
      throw new Error(`Publication input exceeds its ${String(maxBytes)} byte bound`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(anchoredPath);
    assertSnapshotMetadataStable(before, after, repositoryRelativePath);
    assertSnapshotMetadataStable(pathBefore, pathAfter, repositoryRelativePath);
    assertPathMatchesDescriptor(pathAfter, after, repositoryRelativePath);
    if (bytes.length !== before.size) {
      throw new Error(`Publication input read length changed: ${repositoryRelativePath}`);
    }
    return {
      path: repositoryRelativePath,
      bytes,
      sha256: sha256(bytes),
      gitBlobOid: gitBlobOid(bytes),
    };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    for (const directoryDescriptor of directoryDescriptors.reverse()) {
      closeSync(directoryDescriptor);
    }
  }
}

function decodeUtf8(snapshot: ImmutableFileSnapshot, field: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes);
  } catch {
    throw new Error(`${field} must contain valid UTF-8`);
  }
}

export function assertAutomationPublicationInputDigest(
  policy: ResolvedAutomationPublicationPolicy,
  changedFile: ImmutableFileSnapshot,
  inputSha256: string,
): void {
  requireSha256(inputSha256, 'AUTOMATION_INPUT_SHA256');
  if (policy.inputDigestKind === 'content' && inputSha256 !== changedFile.sha256) {
    throw new Error('Report input digest must equal the immutable report content digest');
  }
}

function requiredEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
  maxBytes = MAX_ENV_BYTES,
): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${name} exceeds its input-size bound`);
  }
  return value;
}

function positiveIntegerEnvironment(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredEnvironment(env, name, 32);
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} exceeds the safe integer range`);
  return value;
}

function localHead(repositoryRoot: string): string {
  const output = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: API_TIMEOUT_MS,
  }).trim();
  if (!SHA_PATTERN.test(output)) throw new Error('Local checkout HEAD is not a full Git SHA');
  return output;
}

export function publicationRequestFromEnvironment(
  env: NodeJS.ProcessEnv,
  repositoryRoot = process.cwd(),
): AutomationPublicationRequest {
  const repository = requiredEnvironment(env, 'GITHUB_REPOSITORY', 128);
  const repositoryId = requiredEnvironment(env, 'GITHUB_REPOSITORY_ID', 32);
  const repositoryOwner = requiredEnvironment(env, 'GITHUB_REPOSITORY_OWNER', 128);
  const repositoryOwnerId = requiredEnvironment(env, 'GITHUB_REPOSITORY_OWNER_ID', 32);
  const baseBranch = env['BASE_BRANCH'] ?? AUTOMATION_BASE_BRANCH;
  if (
    repository !== AUTOMATION_REPOSITORY ||
    repositoryId !== AUTOMATION_REPOSITORY_ID ||
    repositoryOwner !== AUTOMATION_REPOSITORY_OWNER ||
    repositoryOwnerId !== AUTOMATION_REPOSITORY_OWNER_ID ||
    baseBranch !== AUTOMATION_BASE_BRANCH
  ) {
    throw new Error('Publication is not bound to the canonical repository and main branch');
  }
  if (
    env['GITHUB_ACTIONS'] !== 'true' ||
    env['GITHUB_REF'] !== AUTOMATION_BASE_REF ||
    env['GITHUB_REF_PROTECTED'] !== 'true'
  ) {
    throw new Error('Publication requires a protected-main GitHub Actions execution');
  }

  const baseSha = requireSha(requiredEnvironment(env, 'EXPECTED_BASE_SHA', 40), 'base SHA');
  const workflowSha = requireSha(
    requiredEnvironment(env, 'GITHUB_WORKFLOW_SHA', 40),
    'workflow SHA',
  );
  const githubSha = requireSha(requiredEnvironment(env, 'GITHUB_SHA', 40), 'GitHub SHA');
  if (workflowSha !== baseSha || githubSha !== baseSha || localHead(repositoryRoot) !== baseSha) {
    throw new Error('Workflow, event, and local checkout must equal the exact protected-main base');
  }

  const commandId = requiredEnvironment(env, 'AUTOMATION_COMMAND_ID', 200);
  if (!COMMAND_ID_PATTERN.test(commandId)) {
    throw new Error('AUTOMATION_COMMAND_ID has an invalid canonical shape');
  }
  const operationValue = requiredEnvironment(env, 'AUTOMATION_OPERATION', 16);
  if (!['add', 'close', 'sweep', 'report'].includes(operationValue)) {
    throw new Error('AUTOMATION_OPERATION is invalid');
  }
  const operation = operationValue as AutomationPublicationOperation;
  const changedPath = requiredEnvironment(env, 'CHANGED_PATHS', 512);
  if (
    changedPath.trim() !== changedPath ||
    changedPath.includes('\n') ||
    changedPath.includes('\r')
  ) {
    throw new Error('CHANGED_PATHS must contain exactly one path');
  }
  const branch = requiredEnvironment(env, 'PR_BRANCH', 256);
  const pullRequestTitle = requiredEnvironment(env, 'PR_TITLE', 256);
  const commitHeadline = requiredEnvironment(env, 'COMMIT_MESSAGE', 256);
  if (commitHeadline.includes('\n') || commitHeadline.includes('\r')) {
    throw new Error('COMMIT_MESSAGE must be exactly one line');
  }
  const workflowRef = requiredEnvironment(env, 'GITHUB_WORKFLOW_REF', 512);
  const workflowEvent = requiredEnvironment(env, 'GITHUB_EVENT_NAME', 64);
  const policy = resolveAutomationPublicationPolicy({
    operation,
    commandId,
    baseSha,
    workflowRef,
    branch,
    changedPath,
    commitHeadline,
    pullRequestTitle,
  });
  if (!policy.workflowEvents.includes(workflowEvent)) {
    throw new Error('Workflow event is not trusted by the selected publication policy');
  }

  const changedFile = readImmutableFileSnapshot(repositoryRoot, changedPath);
  const inputSha256 = requireSha256(
    requiredEnvironment(env, 'AUTOMATION_INPUT_SHA256', 64),
    'AUTOMATION_INPUT_SHA256',
  );
  assertAutomationPublicationInputDigest(policy, changedFile, inputSha256);

  const bodyPath = requiredEnvironment(env, 'PR_BODY_FILE', 1024);
  const canonicalRunnerTemp = realpathSync(requiredEnvironment(env, 'RUNNER_TEMP', 1024));
  if (
    !isAbsolute(bodyPath) ||
    resolve(bodyPath) !== bodyPath ||
    dirname(bodyPath) !== canonicalRunnerTemp ||
    realpathSync(bodyPath) !== bodyPath
  ) {
    throw new Error('PR_BODY_FILE must be one non-symlink direct child of canonical RUNNER_TEMP');
  }
  const bodySnapshot = readImmutableFileSnapshot(
    canonicalRunnerTemp,
    basename(bodyPath),
    MAX_BODY_BYTES,
  );
  const pullRequestBody = decodeUtf8(bodySnapshot, 'PR_BODY_FILE').trimEnd();
  if (pullRequestBody.length === 0 || pullRequestBody.includes('\0')) {
    throw new Error('PR_BODY_FILE must contain a non-empty text body');
  }

  const workflowRunId = positiveIntegerEnvironment(env, 'GITHUB_RUN_ID');
  const workflowRunAttempt = positiveIntegerEnvironment(env, 'GITHUB_RUN_ATTEMPT');
  const appSlug = requiredEnvironment(env, 'GH_APP_SLUG', 100);
  if (!APP_SLUG_PATTERN.test(appSlug)) throw new Error('GH_APP_SLUG is invalid');
  const appInstallationId = positiveIntegerEnvironment(env, 'GH_APP_INSTALLATION_ID');
  let evidence: MutationEvidence | null = null;
  if (policy.evidenceArtifactPrefix !== null) {
    const artifactId = positiveIntegerEnvironment(env, 'AUTOMATION_EVIDENCE_ARTIFACT_ID');
    const artifactName = requiredEnvironment(env, 'AUTOMATION_EVIDENCE_ARTIFACT', 256);
    const artifactSha256 = requireSha256(
      requiredEnvironment(env, 'AUTOMATION_EVIDENCE_SHA256', 64),
      'AUTOMATION_EVIDENCE_SHA256',
    );
    const expectedName = automationPublicationEvidenceArtifactName(
      policy,
      workflowRunId,
      workflowRunAttempt,
    );
    if (artifactName !== expectedName) {
      throw new Error(`Mutation evidence artifact must equal ${expectedName}`);
    }
    evidence = { artifactId, artifactName, artifactSha256 };
  } else if (
    env['AUTOMATION_EVIDENCE_ARTIFACT_ID'] ||
    env['AUTOMATION_EVIDENCE_ARTIFACT'] ||
    env['AUTOMATION_EVIDENCE_SHA256']
  ) {
    throw new Error('Selected publication policy does not accept mutation evidence');
  }

  return {
    policy,
    repositoryRoot: realpathSync(repositoryRoot),
    baseSha,
    commandId,
    operation,
    inputSha256,
    changedFile,
    pullRequestBody,
    pullRequestBodySha256: sha256(pullRequestBody),
    workflowRef,
    workflowSha,
    workflowEvent,
    workflowRunId,
    workflowRunAttempt,
    appSlug,
    appInstallationId,
    evidence,
  };
}

export function automationPublicationRetryIdentity(request: AutomationPublicationRequest): string {
  return automationPublicationRetryIdentityHash({
    baseSha: request.baseSha,
    branch: request.policy.branch,
    commandId: request.commandId,
    operation: request.operation,
    inputSha256: request.inputSha256,
    changedPath: request.changedFile.path,
    changedPathSha256: request.changedFile.sha256,
    commitHeadline: request.policy.commitHeadline,
    pullRequestTitle: request.policy.pullRequestTitle,
    basePullRequestBodySha256: request.pullRequestBodySha256,
    workflowRef: request.workflowRef,
    workflowSha: request.workflowSha,
  });
}

function assertAutomationPublicationRequest(request: AutomationPublicationRequest): void {
  requireSha(request.baseSha, 'Publication base SHA');
  requireSha(request.workflowSha, 'Publication workflow SHA');
  if (request.workflowSha !== request.baseSha) {
    throw new Error('Publication workflow SHA differs from its exact base');
  }
  if (!COMMAND_ID_PATTERN.test(request.commandId)) {
    throw new Error('Publication command ID is not canonical');
  }
  const canonicalPolicy = resolveAutomationPublicationPolicy({
    operation: request.operation,
    commandId: request.commandId,
    baseSha: request.baseSha,
    workflowRef: request.workflowRef,
    branch: request.policy.branch,
    changedPath: request.changedFile.path,
    commitHeadline: request.policy.commitHeadline,
    pullRequestTitle: request.policy.pullRequestTitle,
  });
  if (
    canonicalPolicy.key !== request.policy.key ||
    canonicalPolicy.operation !== request.policy.operation ||
    canonicalPolicy.workflowRef !== request.policy.workflowRef ||
    canonicalPolicy.workflowPath !== request.policy.workflowPath ||
    canonicalPolicy.branch !== request.policy.branch ||
    canonicalPolicy.changedPath !== request.policy.changedPath ||
    canonicalPolicy.commitHeadline !== request.policy.commitHeadline ||
    canonicalPolicy.pullRequestTitle !== request.policy.pullRequestTitle ||
    canonicalPolicy.inputDigestKind !== request.policy.inputDigestKind ||
    canonicalPolicy.evidenceArtifactPrefix !== request.policy.evidenceArtifactPrefix ||
    canonicalPolicy.branchStrategy !== request.policy.branchStrategy
  ) {
    throw new Error('Publication policy object differs from the canonical SSOT');
  }
  assertExactStrings(
    request.policy.workflowEvents,
    canonicalPolicy.workflowEvents,
    'Publication workflow events',
  );
  if (!canonicalPolicy.workflowEvents.includes(request.workflowEvent)) {
    throw new Error('Publication workflow event is outside the selected policy');
  }
  if (
    request.changedFile.bytes.length > MAX_CHANGED_FILE_BYTES ||
    request.changedFile.sha256 !== sha256(request.changedFile.bytes) ||
    request.changedFile.gitBlobOid !== gitBlobOid(request.changedFile.bytes)
  ) {
    throw new Error('Publication snapshot hashes differ from its immutable bytes');
  }
  assertAutomationPublicationInputDigest(canonicalPolicy, request.changedFile, request.inputSha256);
  if (
    request.pullRequestBody.length === 0 ||
    request.pullRequestBody.trimEnd() !== request.pullRequestBody ||
    request.pullRequestBody.includes('\0') ||
    Buffer.byteLength(request.pullRequestBody, 'utf8') > MAX_BODY_BYTES ||
    request.pullRequestBodySha256 !== sha256(request.pullRequestBody)
  ) {
    throw new Error('Publication base PR body is not canonical');
  }
  for (const [value, field] of [
    [request.workflowRunId, 'workflow run ID'],
    [request.workflowRunAttempt, 'workflow run attempt'],
    [request.appInstallationId, 'App installation ID'],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Publication ${field} must be a positive safe integer`);
    }
  }
  if (
    canonicalPolicy.key === 'registry-sweep' &&
    request.commandId !== `finding-sweep:${String(request.workflowRunId)}`
  ) {
    throw new Error('Sweep command ID must equal its exact workflow run ID');
  }
  if (!APP_SLUG_PATTERN.test(request.appSlug)) {
    throw new Error('Publication App slug is not canonical');
  }
  if ((canonicalPolicy.evidenceArtifactPrefix === null) !== (request.evidence === null)) {
    throw new Error('Publication evidence presence differs from the selected policy');
  }
  if (
    request.evidence &&
    (!Number.isSafeInteger(request.evidence.artifactId) ||
      request.evidence.artifactId < 1 ||
      !SHA256_PATTERN.test(request.evidence.artifactSha256) ||
      request.evidence.artifactName !==
        automationPublicationEvidenceArtifactName(
          canonicalPolicy,
          request.workflowRunId,
          request.workflowRunAttempt,
        ))
  ) {
    throw new Error('Publication evidence differs from the selected policy');
  }
}

function publicationPullRequestBody(
  request: AutomationPublicationRequest,
  identity: string,
): string {
  if (RETRY_MARKER_PATTERN.test(request.pullRequestBody)) {
    RETRY_MARKER_PATTERN.lastIndex = 0;
    throw new Error('PR body must not supply its own automation retry marker');
  }
  RETRY_MARKER_PATTERN.lastIndex = 0;
  return `${request.pullRequestBody}\n\n<!-- aqua-automation-retry-identity:${identity} -->\n`;
}

function commitMessage(request: AutomationPublicationRequest, identity: string): string {
  const trailers = new Map<string, string>([
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.commandId, request.commandId],
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.operation, request.operation],
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.inputSha256, request.inputSha256],
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.baseSha, request.baseSha],
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.retryIdentity, identity],
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.changedPath, request.changedFile.path],
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.changedPathSha256, request.changedFile.sha256],
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRef, request.workflowRef],
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowSha, request.workflowSha],
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunId, String(request.workflowRunId)],
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunAttempt, String(request.workflowRunAttempt)],
  ]);
  if (request.evidence) {
    trailers.set(
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifactId,
      String(request.evidence.artifactId),
    );
    trailers.set(
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifact,
      request.evidence.artifactName,
    );
    trailers.set(
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceSha256,
      request.evidence.artifactSha256,
    );
  }
  return [
    request.policy.commitHeadline,
    '',
    ...AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER.flatMap((name) => {
      const value = trailers.get(name);
      return value === undefined ? [] : [`${name}: ${value}`];
    }),
  ].join('\n');
}

function validateCommitProvenance(
  request: AutomationPublicationRequest,
  commit: RemoteCommitEvidence,
  identity: string,
): void {
  if (!SHA_PATTERN.test(commit.sha)) throw new Error('Remote commit SHA is invalid');
  if (commit.message.split(/\r?\n/, 1)[0] !== request.policy.commitHeadline) {
    throw new Error('Remote commit headline differs from publication policy');
  }
  const stableTrailers: Readonly<Record<string, string>> = {
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.commandId]: request.commandId,
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.operation]: request.operation,
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.inputSha256]: request.inputSha256,
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.baseSha]: request.baseSha,
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.retryIdentity]: identity,
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.changedPath]: request.changedFile.path,
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.changedPathSha256]: request.changedFile.sha256,
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRef]: request.workflowRef,
    [AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowSha]: request.workflowSha,
  };
  for (const [name, expected] of Object.entries(stableTrailers)) {
    if (exactTrailer(commit.message, name) !== expected) {
      throw new Error(`Remote commit ${name} differs from the stable retry identity`);
    }
  }
  const runId = exactTrailer(commit.message, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunId);
  const runAttempt = exactTrailer(
    commit.message,
    AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunAttempt,
  );
  if (!POSITIVE_INTEGER_PATTERN.test(runId) || !POSITIVE_INTEGER_PATTERN.test(runAttempt)) {
    throw new Error('Remote commit workflow provenance is invalid');
  }
  if (request.policy.evidenceArtifactPrefix !== null) {
    const artifactId = exactTrailer(
      commit.message,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifactId,
    );
    const artifactName = exactTrailer(
      commit.message,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifact,
    );
    const artifactSha = exactTrailer(
      commit.message,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceSha256,
    );
    const expectedName = automationPublicationEvidenceArtifactName(
      request.policy,
      Number(runId),
      Number(runAttempt),
    );
    if (
      !POSITIVE_INTEGER_PATTERN.test(artifactId) ||
      artifactName !== expectedName ||
      !SHA256_PATTERN.test(artifactSha)
    ) {
      throw new Error('Remote commit mutation-evidence provenance is invalid');
    }
  } else {
    for (const name of [
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifactId,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifact,
      AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceSha256,
    ]) {
      if (optionalTrailer(commit.message, name) !== null) {
        throw new Error('Commit must not claim evidence excluded by publication policy');
      }
    }
  }
  assertExactStrings(commit.parentShas, [request.baseSha], 'Remote commit parents');
  assertExactStrings(commit.changedPaths, [request.changedFile.path], 'Remote changed paths');
  if (
    !commit.signatureValid ||
    commit.signatureReason !== 'valid' ||
    !commit.signatureWasSignedByGitHub ||
    commit.signatureState !== 'VALID' ||
    commit.authorLogin !== `${request.appSlug}[bot]` ||
    commit.changedBlobOid !== request.changedFile.gitBlobOid
  ) {
    throw new Error('Remote commit signature, actor, or content is not canonical');
  }
}

function validatePullRequest(
  request: AutomationPublicationRequest,
  pullRequest: RemotePullRequest,
  expectedHeadSha: string,
  identity: string,
  exactBody: string | null,
): void {
  const retryMarkers = [...pullRequest.body.matchAll(RETRY_MARKER_PATTERN)].map(
    (match) => match[1],
  );
  RETRY_MARKER_PATTERN.lastIndex = 0;
  if (
    pullRequest.url !==
      `https://github.com/${AUTOMATION_REPOSITORY}/pull/${String(pullRequest.number)}` ||
    pullRequest.baseRef !== AUTOMATION_BASE_BRANCH ||
    pullRequest.headRef !== automationPublicationBranch(request.policy, request.commandId) ||
    pullRequest.headSha !== expectedHeadSha ||
    pullRequest.headRepository !== AUTOMATION_REPOSITORY ||
    pullRequest.authorLogin !== `${request.appSlug}[bot]` ||
    pullRequest.draft ||
    pullRequest.title !== request.policy.pullRequestTitle ||
    retryMarkers.length !== 1 ||
    retryMarkers[0] !== identity ||
    (exactBody !== null && pullRequest.body !== exactBody)
  ) {
    throw new Error('Pull request metadata differs from the stable publication request');
  }
}

function resultFrom(
  request: AutomationPublicationRequest,
  status: Exclude<AutomationPublicationStatus, 'FAILED'>,
  identity: string,
  commitSha: string,
  observedBranchSha: string | null,
  pullRequest: RemotePullRequest | null,
): AutomationPublicationResult {
  return {
    $schema: 'aqua/automation-publication-result/v3',
    status,
    repository: AUTOMATION_REPOSITORY,
    repository_id: AUTOMATION_REPOSITORY_ID,
    base_sha: request.baseSha,
    branch: automationPublicationBranch(request.policy, request.commandId),
    command_id: request.commandId,
    operation: request.operation,
    input_sha256: request.inputSha256,
    retry_identity: identity,
    changed_path: request.changedFile.path,
    changed_path_sha256: request.changedFile.sha256,
    commit_sha: commitSha,
    observed_branch_sha: observedBranchSha,
    pr_number: pullRequest?.number ?? null,
    pr_url: pullRequest?.url ?? null,
    workflow: {
      ref: request.workflowRef,
      sha: request.workflowSha,
      run_id: request.workflowRunId,
      run_attempt: request.workflowRunAttempt,
    },
    github_app: {
      slug: request.appSlug,
      installation_id: request.appInstallationId,
    },
    mutation_evidence: request.evidence
      ? {
          artifact_id: request.evidence.artifactId,
          artifact_name: request.evidence.artifactName,
          artifact_sha256: request.evidence.artifactSha256,
        }
      : null,
    error: null,
  };
}

export class AutomationPublisher {
  public constructor(private readonly remote: AutomationPublicationRemote) {}

  private progress(
    current: PublicationFailureProgress,
    updates: Partial<PublicationFailureProgress>,
  ): PublicationFailureProgress {
    return { ...current, ...updates };
  }

  private async exactBranchOid(branch: string, expected: string | null): Promise<void> {
    const oid = await this.remote.getBranchOid(branch);
    if (oid !== expected) {
      throw new Error(
        `Branch ${branch} changed: expected ${expected ?? 'absent'}, observed ${oid ?? 'absent'}`,
      );
    }
  }

  private async adjudicatePullRequestSummary(
    request: AutomationPublicationRequest,
    identity: string,
    expectedHeadSha: string | null,
  ): Promise<RemotePullRequestSummary | null> {
    const branch = automationPublicationBranch(request.policy, request.commandId);
    const summaries = await this.remote.listPullRequests(branch);
    if (summaries.length > 1) {
      throw new Error('Identity-derived publication branch has more than one pull request');
    }
    const summary = summaries[0] ?? null;
    if (!summary) return null;
    const retryMarkers = [...summary.body.matchAll(RETRY_MARKER_PATTERN)].map((match) => match[1]);
    RETRY_MARKER_PATTERN.lastIndex = 0;
    if (
      summary.title !== request.policy.pullRequestTitle ||
      retryMarkers.length !== 1 ||
      retryMarkers[0] !== identity ||
      (expectedHeadSha !== null && summary.headSha !== expectedHeadSha)
    ) {
      throw this.publicationFailureForKnownPullRequest(
        new Error('Identity-derived branch PR metadata was edited or is not canonical'),
        identity,
        summary.headSha,
        summary.number,
      );
    }
    return summary;
  }

  private publicationFailureForKnownPullRequest(
    error: unknown,
    identity: string,
    headSha: string,
    pullRequestNumber: number,
    pullRequestUrl?: string,
  ): PublicationFailure {
    return new PublicationFailure(
      error instanceof Error ? error.message : String(error),
      {
        stage: 'PULL_REQUEST_CREATED',
        retryIdentity: identity,
        observedBranchSha: headSha,
        commitSha: headSha,
        pullRequestNumber,
        pullRequestUrl:
          pullRequestUrl ??
          `https://github.com/${AUTOMATION_REPOSITORY}/pull/${String(pullRequestNumber)}`,
      },
      { cause: error },
    );
  }

  private async recoverPullRequest(
    request: AutomationPublicationRequest,
    identity: string,
    headSha: string,
  ): Promise<RemotePullRequest | null> {
    const summary = await this.adjudicatePullRequestSummary(request, identity, headSha);
    if (!summary) return null;
    try {
      const pullRequest = await this.remote.getPullRequest(summary.number);
      validatePullRequest(
        request,
        pullRequest,
        headSha,
        identity,
        publicationPullRequestBody(request, identity),
      );
      return pullRequest;
    } catch (error) {
      throw this.publicationFailureForKnownPullRequest(error, identity, headSha, summary.number);
    }
  }

  private async verifyStableCommit(
    request: AutomationPublicationRequest,
    identity: string,
    sha: string,
  ): Promise<RemoteCommitEvidence> {
    const commit = await this.remote.getCommit(sha, request.changedFile.path);
    try {
      validateCommitProvenance(request, commit, identity);
    } catch (error) {
      throw new StablePublicationMismatch(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    return commit;
  }

  private async assertMergedPullRequestReachable(pullRequest: RemotePullRequest): Promise<void> {
    if (!pullRequest.merged || pullRequest.state !== 'MERGED' || !pullRequest.mergeCommitSha) {
      throw new Error('Stable publication was closed without merge and cannot be replayed');
    }
    const currentMain = await this.remote.getBranchOid(AUTOMATION_BASE_BRANCH);
    if (
      !currentMain ||
      !(await this.remote.isCommitReachableFrom(pullRequest.mergeCommitSha, currentMain))
    ) {
      throw new Error('Merged publication is not reachable from the authenticated current main');
    }
  }

  private async assertOpenPullRequestBase(
    request: AutomationPublicationRequest,
    pullRequest: RemotePullRequest,
  ): Promise<void> {
    const currentMain = await this.remote.getBranchOid(AUTOMATION_BASE_BRANCH);
    if (currentMain !== request.baseSha || pullRequest.baseSha !== currentMain) {
      throw new Error(
        'Open publication PR base no longer equals the exact authenticated publication base',
      );
    }
  }

  private async recoverFromHistory(
    request: AutomationPublicationRequest,
    identity: string,
  ): Promise<AutomationPublicationResult | null> {
    const summary = await this.adjudicatePullRequestSummary(request, identity, null);
    if (!summary) return null;
    try {
      await this.verifyStableCommit(request, identity, summary.headSha);
    } catch (error) {
      throw this.publicationFailureForKnownPullRequest(
        error,
        identity,
        summary.headSha,
        summary.number,
      );
    }
    let pullRequest: RemotePullRequest;
    try {
      pullRequest = await this.remote.getPullRequest(summary.number);
      validatePullRequest(
        request,
        pullRequest,
        summary.headSha,
        identity,
        publicationPullRequestBody(request, identity),
      );
    } catch (error) {
      throw this.publicationFailureForKnownPullRequest(
        error,
        identity,
        summary.headSha,
        summary.number,
      );
    }
    try {
      if (pullRequest.state === 'OPEN') {
        await this.assertOpenPullRequestBase(request, pullRequest);
        await this.exactBranchOid(
          automationPublicationBranch(request.policy, request.commandId),
          summary.headSha,
        );
        return resultFrom(
          request,
          'RECOVERED',
          identity,
          summary.headSha,
          summary.headSha,
          pullRequest,
        );
      }
      await this.assertMergedPullRequestReachable(pullRequest);
      return resultFrom(request, 'RECOVERED', identity, summary.headSha, null, pullRequest);
    } catch (error) {
      throw this.publicationFailureForKnownPullRequest(
        error,
        identity,
        summary.headSha,
        summary.number,
        pullRequest.url,
      );
    }
  }

  private async createOrRecoverPullRequest(
    request: AutomationPublicationRequest,
    identity: string,
    headSha: string,
    expectedBody: string,
  ): Promise<{ readonly pullRequest: RemotePullRequest; readonly recovered: boolean }> {
    const recovered = await this.recoverPullRequest(request, identity, headSha);
    if (recovered) {
      try {
        if (recovered.state !== 'OPEN') {
          if (recovered.merged) {
            await this.assertMergedPullRequestReachable(recovered);
            await this.exactBranchOid(
              automationPublicationBranch(request.policy, request.commandId),
              headSha,
            );
            return { pullRequest: recovered, recovered: true };
          }
          throw new Error('Existing stable pull request is closed without merge');
        }
        await this.assertOpenPullRequestBase(request, recovered);
        await this.exactBranchOid(
          automationPublicationBranch(request.policy, request.commandId),
          headSha,
        );
        return { pullRequest: recovered, recovered: true };
      } catch (error) {
        throw this.publicationFailureForKnownPullRequest(
          error,
          identity,
          headSha,
          recovered.number,
          recovered.url,
        );
      }
    }

    let created: RemotePullRequest;
    let createdNow = true;
    try {
      created = await this.remote.createPullRequest({
        branch: automationPublicationBranch(request.policy, request.commandId),
        title: request.policy.pullRequestTitle,
        body: expectedBody,
      });
    } catch (error) {
      let raced: RemotePullRequest | null;
      try {
        raced = await this.recoverPullRequest(request, identity, headSha);
      } catch (recoveryError) {
        if (error instanceof PublicationFailure) throw error;
        throw recoveryError;
      }
      if (!raced && (!(error instanceof GitHubApiError) || error.status !== 422)) {
        throw error;
      }
      if (!raced) throw new Error('Pull request creation raced without a matching stable PR');
      created = raced;
      createdNow = false;
    }

    try {
      const exact = await this.remote.getPullRequest(created.number);
      validatePullRequest(request, exact, headSha, identity, expectedBody);
      if (exact.state !== 'OPEN') throw new Error('New publication PR is not open');
      await this.assertOpenPullRequestBase(request, exact);
      await this.exactBranchOid(
        automationPublicationBranch(request.policy, request.commandId),
        headSha,
      );
      return { pullRequest: exact, recovered: !createdNow };
    } catch (error) {
      throw this.publicationFailureForKnownPullRequest(
        error,
        identity,
        headSha,
        created.number,
        created.url,
      );
    }
  }

  private async publishInternal(
    request: AutomationPublicationRequest,
    progress: { current: PublicationFailureProgress },
  ): Promise<AutomationPublicationResult> {
    assertAutomationPublicationRequest(request);
    const identity = automationPublicationRetryIdentity(request);
    progress.current = this.progress(progress.current, {
      stage: 'VALIDATED',
      retryIdentity: identity,
    });
    const branch = automationPublicationBranch(request.policy, request.commandId);
    const expectedBody = publicationPullRequestBody(request, identity);
    await this.remote.assertInstallationIdentity(request.appSlug, request.appInstallationId);

    let branchOid = await this.remote.getBranchOid(branch);
    progress.current = this.progress(progress.current, {
      stage: 'BRANCH_OBSERVED',
      observedBranchSha: branchOid,
    });
    if (branchOid && branchOid !== request.baseSha) {
      try {
        await this.verifyStableCommit(request, identity, branchOid);
      } catch (error) {
        if (!(error instanceof StablePublicationMismatch)) throw error;
        throw new StablePublicationMismatch(
          'Identity-derived immutable publication branch contains a noncanonical commit',
          { cause: error },
        );
      }
      progress.current = this.progress(progress.current, {
        stage: 'COMMIT_CREATED',
        observedBranchSha: branchOid,
        commitSha: branchOid,
      });
      const recoveredPr = await this.createOrRecoverPullRequest(
        request,
        identity,
        branchOid,
        expectedBody,
      );
      progress.current = this.progress(progress.current, {
        stage: 'PULL_REQUEST_CREATED',
        commitSha: branchOid,
        pullRequestNumber: recoveredPr.pullRequest.number,
        pullRequestUrl: recoveredPr.pullRequest.url,
      });
      return resultFrom(
        request,
        'RECOVERED',
        identity,
        branchOid,
        branchOid,
        recoveredPr.pullRequest,
      );
    } else if (!branchOid) {
      const historical = await this.recoverFromHistory(request, identity);
      if (historical) return historical;
    }

    const currentMain = await this.remote.getBranchOid(AUTOMATION_BASE_BRANCH);
    if (currentMain !== request.baseSha) {
      throw new Error('Authenticated current main differs from the exact publication base');
    }
    const baseBlobOid = await this.remote.getFileBlobOid(request.changedFile.path, request.baseSha);
    if (baseBlobOid === request.changedFile.gitBlobOid) {
      return resultFrom(request, 'NO_CHANGE', identity, request.baseSha, branchOid, null);
    }
    let branchCreatedByThisRun = false;
    if (!branchOid) {
      try {
        await this.remote.createBranch(branch, request.baseSha);
        branchCreatedByThisRun = true;
        branchOid = request.baseSha;
      } catch (error) {
        branchOid = await this.remote.getBranchOid(branch);
        if (!branchOid) {
          if (!(error instanceof GitHubApiError) || error.status !== 422) {
            throw error;
          }
          throw new Error('Branch creation returned 422 without an observable competing ref');
        }
        if (branchOid !== request.baseSha) {
          await this.verifyStableCommit(request, identity, branchOid);
          progress.current = this.progress(progress.current, {
            stage: 'COMMIT_CREATED',
            observedBranchSha: branchOid,
            commitSha: branchOid,
          });
          const recoveredPr = await this.createOrRecoverPullRequest(
            request,
            identity,
            branchOid,
            expectedBody,
          );
          progress.current = this.progress(progress.current, {
            stage: 'PULL_REQUEST_CREATED',
            observedBranchSha: branchOid,
            commitSha: branchOid,
            pullRequestNumber: recoveredPr.pullRequest.number,
            pullRequestUrl: recoveredPr.pullRequest.url,
          });
          return resultFrom(
            request,
            'RECOVERED',
            identity,
            branchOid,
            branchOid,
            recoveredPr.pullRequest,
          );
        }
      }
    }
    if (branchOid !== request.baseSha) {
      throw new Error('Automation branch is not the exact expectedHeadOid before commit creation');
    }

    const expectedCommitMessage = commitMessage(request, identity);
    const clientMutationId = `aqua-publication:${identity}`;
    let commitOid: string;
    try {
      const createdCommit = await this.remote.createCommit({
        branch,
        expectedHeadOid: request.baseSha,
        headline: request.policy.commitHeadline,
        body: expectedCommitMessage.slice(request.policy.commitHeadline.length + 2),
        path: request.changedFile.path,
        contentsBase64: request.changedFile.bytes.toString('base64'),
        clientMutationId,
      });
      if (
        createdCommit.clientMutationId !== clientMutationId ||
        createdCommit.oid !== createdCommit.refOid ||
        !SHA_PATTERN.test(createdCommit.oid) ||
        !createdCommit.signatureValid ||
        !createdCommit.wasSignedByGitHub ||
        createdCommit.signatureState !== 'VALID'
      ) {
        throw new Error(
          `GraphQL commit did not preserve expectedHeadOid and GitHub signature authority (${createdCommit.signatureState})`,
        );
      }
      commitOid = createdCommit.oid;
      progress.current = this.progress(progress.current, {
        stage: 'COMMIT_CREATED',
        observedBranchSha: commitOid,
        commitSha: commitOid,
      });
    } catch (error) {
      const racedHead = await this.remote.getBranchOid(branch);
      if (!racedHead || racedHead === request.baseSha) throw error;
      await this.verifyStableCommit(request, identity, racedHead);
      progress.current = this.progress(progress.current, {
        stage: 'COMMIT_CREATED',
        observedBranchSha: racedHead,
        commitSha: racedHead,
      });
      const recoveredPr = await this.createOrRecoverPullRequest(
        request,
        identity,
        racedHead,
        expectedBody,
      );
      progress.current = this.progress(progress.current, {
        stage: 'PULL_REQUEST_CREATED',
        observedBranchSha: racedHead,
        commitSha: racedHead,
        pullRequestNumber: recoveredPr.pullRequest.number,
        pullRequestUrl: recoveredPr.pullRequest.url,
      });
      return resultFrom(
        request,
        'RECOVERED',
        identity,
        racedHead,
        racedHead,
        recoveredPr.pullRequest,
      );
    }

    await this.exactBranchOid(branch, commitOid);
    const commit = await this.remote.getCommit(commitOid, request.changedFile.path);
    validateCommitProvenance(request, commit, identity);
    const pullRequest = await this.createOrRecoverPullRequest(
      request,
      identity,
      commitOid,
      expectedBody,
    );
    progress.current = this.progress(progress.current, {
      stage: 'PULL_REQUEST_CREATED',
      observedBranchSha: commitOid,
      commitSha: commitOid,
      pullRequestNumber: pullRequest.pullRequest.number,
      pullRequestUrl: pullRequest.pullRequest.url,
    });
    await this.exactBranchOid(branch, commitOid);
    await this.exactBranchOid(AUTOMATION_BASE_BRANCH, request.baseSha);
    return resultFrom(
      request,
      branchCreatedByThisRun && !pullRequest.recovered ? 'PUBLISHED' : 'RECOVERED',
      identity,
      commitOid,
      commitOid,
      pullRequest.pullRequest,
    );
  }

  public async publish(
    request: AutomationPublicationRequest,
  ): Promise<AutomationPublicationResult> {
    const progress: { current: PublicationFailureProgress } = {
      current: {
        stage: 'VALIDATED',
        retryIdentity: null,
        observedBranchSha: null,
        commitSha: null,
        pullRequestNumber: null,
        pullRequestUrl: null,
      },
    };
    try {
      return await this.publishInternal(request, progress);
    } catch (error) {
      const nested = error instanceof PublicationFailure ? error.progress : null;
      const merged = nested
        ? {
            ...progress.current,
            ...nested,
            retryIdentity: nested.retryIdentity ?? progress.current.retryIdentity,
            observedBranchSha: nested.observedBranchSha ?? progress.current.observedBranchSha,
            commitSha: nested.commitSha ?? progress.current.commitSha,
            pullRequestNumber: nested.pullRequestNumber ?? progress.current.pullRequestNumber,
            pullRequestUrl: nested.pullRequestUrl ?? progress.current.pullRequestUrl,
          }
        : progress.current;
      const message = error instanceof Error ? error.message : String(error);
      throw new PublicationFailure(message.slice(0, 2048), merged, { cause: error });
    }
  }
}

class BoundedGitHubTransport {
  private calls = 0;

  public constructor(private readonly token: string) {
    if (token.length === 0 || token.length > MAX_ENV_BYTES) {
      throw new Error('GH_TOKEN is required and bounded');
    }
  }

  private async boundedResponseBytes(response: Response, path: string): Promise<Buffer> {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.length;
        if (totalBytes > MAX_API_RESPONSE_BYTES) {
          await reader.cancel('response-size bound exceeded');
          throw new Error(`GitHub API ${path} exceeded its response-size bound`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, totalBytes);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: JsonRecord): Promise<unknown> {
    this.calls += 1;
    if (this.calls > MAX_API_CALLS) throw new Error('GitHub API call budget exhausted');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    timeout.unref();
    try {
      const response = await fetch(`${API_ROOT}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'aqua-automation-publication-v3',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      const declaredLength = response.headers.get('content-length');
      if (
        declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_API_RESPONSE_BYTES)
      ) {
        throw new Error(`GitHub API ${path} declared an oversized response`);
      }
      const bytes = await this.boundedResponseBytes(response, path);
      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `GitHub API ${method} ${path} returned HTTP ${String(response.status)}`,
        );
      }
      if (bytes.length === 0) return null;
      try {
        return JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        throw new Error(`GitHub API ${path} returned invalid JSON`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  public get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  public post(path: string, body: JsonRecord): Promise<unknown> {
    return this.request('POST', path, body);
  }

  public async graphql(query: string, variables: JsonRecord): Promise<unknown> {
    const value = requireRecord(
      await this.post('/graphql', { query, variables }),
      'GraphQL response',
    );
    if (value.errors !== undefined) {
      throw new Error('GitHub GraphQL returned an errors payload');
    }
    return value;
  }
}

export interface GitHubAutomationPublicationTransport {
  get(path: string): Promise<unknown>;
  post(path: string, body: JsonRecord): Promise<unknown>;
  graphql(query: string, variables: JsonRecord): Promise<unknown>;
}

export class GitHubAutomationPublicationRemote implements AutomationPublicationRemote {
  public constructor(private readonly transport: GitHubAutomationPublicationTransport) {}

  private encodedRef(branch: string): string {
    return branch
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  private async restBranchOid(branch: string): Promise<string | null> {
    try {
      const value = requireRecord(
        await this.transport.get(
          `/repos/${AUTOMATION_REPOSITORY}/git/ref/heads/${this.encodedRef(branch)}`,
        ),
        'REST branch ref',
      );
      return requireSha(
        requireRecord(value.object, 'REST branch ref.object').sha,
        'REST branch oid',
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async graphqlBranchOid(branch: string): Promise<string | null> {
    const value = requireRecord(
      await this.transport.graphql(
        `query PublicationRef($owner: String!, $name: String!, $qualifiedName: String!) {
          repository(owner: $owner, name: $name) {
            ref(qualifiedName: $qualifiedName) { target { oid } }
          }
        }`,
        {
          owner: AUTOMATION_REPOSITORY_OWNER,
          name: AUTOMATION_REPOSITORY_IDENTITY.name,
          qualifiedName: `refs/heads/${branch}`,
        },
      ),
      'GraphQL branch response',
    );
    const data = requireRecord(value.data, 'GraphQL branch response.data');
    const repository = requireRecord(data.repository, 'GraphQL branch repository');
    if (repository.ref === null) return null;
    const ref = requireRecord(repository.ref, 'GraphQL branch ref');
    return requireSha(requireRecord(ref.target, 'GraphQL branch target').oid, 'GraphQL branch oid');
  }

  public async assertInstallationIdentity(
    expectedAppSlug: string,
    expectedInstallationId: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(expectedInstallationId) || expectedInstallationId < 1) {
      throw new Error('Trusted GitHub App installation output is invalid');
    }
    // Installation tokens expose repository scope and their App bot principal,
    // while installation metadata requires an App JWT. The pinned mint action
    // verifies this ID before handing us the token; these independent live reads
    // bind that token to the same App and exact one-repository authority.
    const repositories = requireRecord(
      await this.transport.get('/installation/repositories?per_page=2'),
      'installation repositories',
    );
    const items = requireArray(repositories.repositories, 'installation repositories.repositories');
    if (
      requirePositiveInteger(repositories.total_count, 'installation total_count') !== 1 ||
      items.length !== 1
    ) {
      throw new Error('GitHub App token must be scoped to exactly one repository');
    }
    const repository = requireRecord(items[0], 'installation repository');
    const repositoryOwner = requireRecord(repository.owner, 'installation repository.owner');
    if (
      String(repository.id) !== AUTOMATION_REPOSITORY_ID ||
      repository.name !== AUTOMATION_REPOSITORY_IDENTITY.name ||
      repository.full_name !== AUTOMATION_REPOSITORY ||
      repositoryOwner.login !== AUTOMATION_REPOSITORY_OWNER ||
      String(repositoryOwner.id) !== AUTOMATION_REPOSITORY_OWNER_ID
    ) {
      throw new Error('GitHub App token repository identity differs from policy');
    }
    const viewerResponse = requireRecord(
      await this.transport.graphql('query PublicationViewer { viewer { login } }', {}),
      'GraphQL viewer response',
    );
    const viewer = requireRecord(
      requireRecord(viewerResponse.data, 'GraphQL viewer response.data').viewer,
      'GraphQL viewer',
    );
    if (viewer.login !== `${expectedAppSlug}[bot]`) {
      throw new Error('GitHub App token viewer differs from the expected App slug');
    }
  }

  public async getBranchOid(branch: string): Promise<string | null> {
    const [restOid, graphqlOid] = await Promise.all([
      this.restBranchOid(branch),
      this.graphqlBranchOid(branch),
    ]);
    if (
      (restOid === null) !== (graphqlOid === null) ||
      (restOid !== null && graphqlOid !== null && restOid !== graphqlOid)
    ) {
      throw new Error('REST and GraphQL branch identities disagree');
    }
    return restOid;
  }

  public async getFileBlobOid(path: string, ref: string): Promise<string | null> {
    try {
      const value = requireRecord(
        await this.transport.get(
          `/repos/${AUTOMATION_REPOSITORY}/contents/${path
            .split('/')
            .map((segment) => encodeURIComponent(segment))
            .join('/')}?ref=${encodeURIComponent(ref)}`,
        ),
        'repository content',
      );
      return requireString(value.sha, 'repository content.sha');
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  public async getCommit(sha: string, changedPath: string): Promise<RemoteCommitEvidence> {
    const [gitCommitValue, commitViewValue, contentValue, graphqlValue] = await Promise.all([
      this.transport.get(`/repos/${AUTOMATION_REPOSITORY}/git/commits/${sha}`),
      this.transport.get(`/repos/${AUTOMATION_REPOSITORY}/commits/${sha}?per_page=100&page=1`),
      this.transport.get(
        `/repos/${AUTOMATION_REPOSITORY}/contents/${changedPath
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')}?ref=${sha}`,
      ),
      this.transport.graphql(
        `query PublicationCommitSignature(
          $owner: String!
          $name: String!
          $oid: GitObjectID!
        ) {
          repository(owner: $owner, name: $name) {
            object(oid: $oid) {
              ... on Commit {
                oid
                signature { isValid state wasSignedByGitHub }
              }
            }
          }
        }`,
        {
          owner: AUTOMATION_REPOSITORY_OWNER,
          name: AUTOMATION_REPOSITORY_IDENTITY.name,
          oid: sha,
        },
      ),
    ]);
    const gitCommit = requireRecord(gitCommitValue, 'git commit');
    const commitView = requireRecord(commitViewValue, 'commit view');
    const verification = requireRecord(gitCommit.verification, 'git commit.verification');
    const author = requireRecord(commitView.author, 'commit view.author');
    const content = requireRecord(contentValue, 'commit content');
    const graphqlCommit = requireRecord(
      requireRecord(
        requireRecord(graphqlValue, 'GraphQL commit response').data,
        'GraphQL commit response.data',
      ).repository,
      'GraphQL commit repository',
    );
    const graphqlObject = requireRecord(graphqlCommit.object, 'GraphQL commit object');
    const graphqlSignature = requireRecord(graphqlObject.signature, 'GraphQL commit signature');
    const gitCommitSha = requireSha(gitCommit.sha, 'git commit.sha');
    const commitViewSha = requireSha(commitView.sha, 'commit view.sha');
    const graphqlCommitSha = requireSha(graphqlObject.oid, 'GraphQL commit oid');
    if (gitCommitSha !== sha || commitViewSha !== sha || graphqlCommitSha !== sha) {
      throw new Error('REST and GraphQL commit identities disagree');
    }
    return {
      sha: commitViewSha,
      message: requireString(gitCommit.message, 'git commit.message'),
      parentShas: requireArray(gitCommit.parents, 'git commit.parents').map((parent, index) =>
        requireSha(requireRecord(parent, `parent ${String(index)}`).sha, `parent ${String(index)}`),
      ),
      signatureValid:
        requireBoolean(verification.verified, 'commit verification.verified') &&
        requireBoolean(graphqlSignature.isValid, 'GraphQL commit signature.isValid'),
      signatureReason: requireString(verification.reason, 'commit verification.reason'),
      signatureWasSignedByGitHub: requireBoolean(
        graphqlSignature.wasSignedByGitHub,
        'GraphQL commit signature.wasSignedByGitHub',
      ),
      signatureState: requireString(graphqlSignature.state, 'GraphQL commit signature.state'),
      authorLogin: requireString(author.login, 'commit author.login'),
      changedPaths: requireArray(commitView.files, 'commit view.files').map((file, index) =>
        requireString(
          requireRecord(file, `commit file ${String(index)}`).filename,
          `commit file ${String(index)}.filename`,
        ),
      ),
      changedBlobOid: requireString(content.sha, 'commit content.sha'),
    };
  }

  public async listPullRequests(branch: string): Promise<readonly RemotePullRequestSummary[]> {
    const summaries: RemotePullRequestSummary[] = [];
    for (let page = 1; page <= MAX_PULL_REQUEST_PAGES; page += 1) {
      const query = new URLSearchParams({
        state: 'all',
        base: AUTOMATION_BASE_BRANCH,
        head: `${AUTOMATION_REPOSITORY_OWNER}:${branch}`,
        per_page: String(PULL_REQUEST_PAGE_SIZE),
        page: String(page),
      });
      const values = requireArray(
        await this.transport.get(`/repos/${AUTOMATION_REPOSITORY}/pulls?${query.toString()}`),
        `pull request list page ${String(page)}`,
      );
      if (values.length > PULL_REQUEST_PAGE_SIZE) {
        throw new Error('GitHub returned more pull requests than the requested page bound');
      }
      values.forEach((value, index) => {
        const pullRequest = requireRecord(
          value,
          `pull request page ${String(page)} item ${String(index)}`,
        );
        summaries.push({
          number: requirePositiveInteger(pullRequest.number, 'pull request number'),
          headSha: requireSha(
            requireRecord(pullRequest.head, 'pull request head').sha,
            'pull request head sha',
          ),
          title: requireString(pullRequest.title, 'pull request title'),
          body:
            pullRequest.body === null ? '' : requireString(pullRequest.body, 'pull request body'),
        });
      });
      if (values.length < PULL_REQUEST_PAGE_SIZE) return summaries;
    }
    throw new Error('Pull request history exceeds the fail-closed pagination bound');
  }

  public async getPullRequest(number: number): Promise<RemotePullRequest> {
    const [restValue, graphqlValue] = await Promise.all([
      this.transport.get(`/repos/${AUTOMATION_REPOSITORY}/pulls/${String(number)}`),
      this.transport.graphql(
        `query PublicationPullRequest($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              number url state merged mergeCommit { oid }
              baseRefName baseRefOid headRefName headRefOid
              headRepository { nameWithOwner }
              author { login }
              isDraft title body
            }
          }
        }`,
        {
          owner: AUTOMATION_REPOSITORY_OWNER,
          name: AUTOMATION_REPOSITORY_IDENTITY.name,
          number,
        },
      ),
    ]);
    const rest = requireRecord(restValue, 'REST pull request');
    const restBase = requireRecord(rest.base, 'REST pull request.base');
    const restHead = requireRecord(rest.head, 'REST pull request.head');
    const restUser = requireRecord(rest.user, 'REST pull request.user');
    const graphql = requireRecord(graphqlValue, 'GraphQL pull request response');
    const graphqlPullRequest = requireRecord(
      requireRecord(
        requireRecord(graphql.data, 'GraphQL pull request data').repository,
        'GraphQL pull request repository',
      ).pullRequest,
      'GraphQL pull request',
    );
    const merged = requireBoolean(rest.merged, 'REST pull request.merged');
    const restState = requireString(rest.state, 'REST pull request.state');
    const state: RemotePullRequest['state'] = merged
      ? 'MERGED'
      : restState === 'open'
        ? 'OPEN'
        : 'CLOSED';
    const result: RemotePullRequest = {
      number: requirePositiveInteger(rest.number, 'REST pull request.number'),
      url: requireString(rest.html_url, 'REST pull request.html_url'),
      state,
      merged,
      mergeCommitSha: requireNullableString(
        rest.merge_commit_sha,
        'REST pull request.merge_commit_sha',
      ),
      baseRef: requireString(restBase.ref, 'REST pull request.base.ref'),
      baseSha: requireSha(restBase.sha, 'REST pull request.base.sha'),
      headRef: requireString(restHead.ref, 'REST pull request.head.ref'),
      headSha: requireSha(restHead.sha, 'REST pull request.head.sha'),
      headRepository: requireString(
        requireRecord(restHead.repo, 'REST pull request.head.repo').full_name,
        'REST pull request.head.repo.full_name',
      ),
      authorLogin: requireString(restUser.login, 'REST pull request.user.login'),
      draft: requireBoolean(rest.draft, 'REST pull request.draft'),
      title: requireString(rest.title, 'REST pull request.title'),
      body: rest.body === null ? '' : requireString(rest.body, 'REST pull request.body'),
    };
    const graphqlState = requireString(graphqlPullRequest.state, 'GraphQL pull request.state');
    const graphqlMergeCommit =
      graphqlPullRequest.mergeCommit === null
        ? null
        : requireSha(
            requireRecord(graphqlPullRequest.mergeCommit, 'GraphQL merge commit').oid,
            'GraphQL merge commit oid',
          );
    if (
      result.number !== number ||
      requirePositiveInteger(graphqlPullRequest.number, 'GraphQL pull request.number') !==
        result.number ||
      requireString(graphqlPullRequest.url, 'GraphQL pull request.url') !== result.url ||
      requireBoolean(graphqlPullRequest.merged, 'GraphQL pull request.merged') !== result.merged ||
      graphqlMergeCommit !== result.mergeCommitSha ||
      requireString(graphqlPullRequest.baseRefName, 'GraphQL base ref') !== result.baseRef ||
      requireSha(graphqlPullRequest.baseRefOid, 'GraphQL base oid') !== result.baseSha ||
      requireString(graphqlPullRequest.headRefName, 'GraphQL head ref') !== result.headRef ||
      requireSha(graphqlPullRequest.headRefOid, 'GraphQL head oid') !== result.headSha ||
      requireString(
        requireRecord(graphqlPullRequest.headRepository, 'GraphQL head repository').nameWithOwner,
        'GraphQL head repository name',
      ) !== result.headRepository ||
      requireString(
        requireRecord(graphqlPullRequest.author, 'GraphQL pull request.author').login,
        'GraphQL pull request.author.login',
      ) !== result.authorLogin ||
      requireBoolean(graphqlPullRequest.isDraft, 'GraphQL pull request.isDraft') !== result.draft ||
      requireString(graphqlPullRequest.title, 'GraphQL pull request.title') !== result.title ||
      (graphqlPullRequest.body === null
        ? ''
        : requireString(graphqlPullRequest.body, 'GraphQL pull request.body')) !== result.body ||
      graphqlState !== result.state
    ) {
      throw new Error('REST and GraphQL pull request metadata disagree');
    }
    return result;
  }

  public async isCommitReachableFrom(commitSha: string, mainSha: string): Promise<boolean> {
    const comparison = requireRecord(
      await this.transport.get(`/repos/${AUTOMATION_REPOSITORY}/compare/${commitSha}...${mainSha}`),
      'commit comparison',
    );
    return (
      requireSha(
        requireRecord(comparison.merge_base_commit, 'comparison merge base').sha,
        'comparison merge base sha',
      ) === commitSha &&
      ['ahead', 'identical'].includes(requireString(comparison.status, 'comparison status'))
    );
  }

  public async createBranch(branch: string, sha: string): Promise<void> {
    await this.transport.post(`/repos/${AUTOMATION_REPOSITORY}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  public async createCommit(input: {
    readonly branch: string;
    readonly expectedHeadOid: string;
    readonly headline: string;
    readonly body: string;
    readonly path: string;
    readonly contentsBase64: string;
    readonly clientMutationId: string;
  }): Promise<CreatedCommit> {
    const value = requireRecord(
      await this.transport.graphql(
        `mutation PublicationCommit($input: CreateCommitOnBranchInput!) {
          createCommitOnBranch(input: $input) {
            clientMutationId
            commit {
              oid
              signature { isValid state wasSignedByGitHub }
            }
            ref { target { oid } }
          }
        }`,
        {
          input: {
            branch: {
              repositoryNameWithOwner: AUTOMATION_REPOSITORY,
              branchName: input.branch,
            },
            expectedHeadOid: input.expectedHeadOid,
            message: { headline: input.headline, body: input.body },
            fileChanges: {
              additions: [{ path: input.path, contents: input.contentsBase64 }],
            },
            clientMutationId: input.clientMutationId,
          },
        },
      ),
      'GraphQL create commit response',
    );
    const created = requireRecord(
      requireRecord(value.data, 'GraphQL create commit data').createCommitOnBranch,
      'GraphQL create commit',
    );
    const commit = requireRecord(created.commit, 'GraphQL created commit');
    const signature = requireRecord(commit.signature, 'GraphQL commit signature');
    return {
      oid: requireSha(commit.oid, 'GraphQL created commit oid'),
      refOid: requireSha(
        requireRecord(
          requireRecord(created.ref, 'GraphQL created ref').target,
          'created ref target',
        ).oid,
        'GraphQL created ref oid',
      ),
      clientMutationId: requireString(created.clientMutationId, 'GraphQL client mutation id'),
      signatureValid: requireBoolean(signature.isValid, 'GraphQL signature.isValid'),
      wasSignedByGitHub: requireBoolean(
        signature.wasSignedByGitHub,
        'GraphQL signature.wasSignedByGitHub',
      ),
      signatureState: requireString(signature.state, 'GraphQL signature.state'),
    };
  }

  public async createPullRequest(input: {
    readonly branch: string;
    readonly title: string;
    readonly body: string;
  }): Promise<RemotePullRequest> {
    const value = requireRecord(
      await this.transport.post(`/repos/${AUTOMATION_REPOSITORY}/pulls`, {
        head: input.branch,
        base: AUTOMATION_BASE_BRANCH,
        title: input.title,
        body: input.body,
        maintainer_can_modify: false,
      }),
      'created pull request',
    );
    const number = requirePositiveInteger(value.number, 'created pull request.number');
    try {
      return await this.getPullRequest(number);
    } catch (error) {
      throw new PublicationFailure(
        error instanceof Error ? error.message : String(error),
        {
          stage: 'PULL_REQUEST_CREATED',
          retryIdentity: null,
          observedBranchSha: null,
          commitSha: null,
          pullRequestNumber: number,
          pullRequestUrl:
            typeof value.html_url === 'string' && value.html_url.length > 0 ? value.html_url : null,
        },
        { cause: error },
      );
    }
  }
}

function safeEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
  maxBytes: number,
): string | null {
  const value = env[name];
  if (
    !value ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n') ||
    !pattern.test(value)
  ) {
    return null;
  }
  return value;
}

function safePositiveIntegerEnvironment(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = safeEnvironmentValue(env, name, POSITIVE_INTEGER_PATTERN, 32);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function sanitizedFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [...message]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && isControlCodePoint(codePoint) ? ' ' : character;
    })
    .join('')
    .slice(0, 2048);
}

function canonicalProgress(error: unknown): PublicationFailureProgress | null {
  return error instanceof PublicationFailure ? error.progress : null;
}

export function automationPublicationFailureResult(
  error: unknown,
  env: NodeJS.ProcessEnv,
  request: AutomationPublicationRequest | null = null,
): AutomationPublicationResult {
  const operationValue = env['AUTOMATION_OPERATION'];
  const operation =
    request?.operation ??
    (operationValue && ['add', 'close', 'sweep', 'report'].includes(operationValue)
      ? (operationValue as AutomationPublicationOperation)
      : null);
  const progress = canonicalProgress(error);
  const progressPullRequestNumber =
    progress?.pullRequestNumber &&
    Number.isSafeInteger(progress.pullRequestNumber) &&
    progress.pullRequestNumber > 0
      ? progress.pullRequestNumber
      : null;
  const progressPullRequestUrl =
    progressPullRequestNumber &&
    progress?.pullRequestUrl ===
      `https://github.com/${AUTOMATION_REPOSITORY}/pull/${String(progressPullRequestNumber)}`
      ? progress.pullRequestUrl
      : null;
  let retryIdentity =
    progress?.retryIdentity && SHA256_PATTERN.test(progress.retryIdentity)
      ? progress.retryIdentity
      : null;
  if (!retryIdentity && request) {
    try {
      retryIdentity = automationPublicationRetryIdentity(request);
    } catch {
      retryIdentity = null;
    }
  }
  let resultBranch =
    request?.policy.branch ?? safeEnvironmentValue(env, 'PR_BRANCH', /^[A-Za-z0-9._/-]+$/, 256);
  if (request && retryIdentity) {
    try {
      resultBranch = automationPublicationBranch(request.policy, request.commandId);
    } catch {
      // Preserve the validated logical namespace when the request itself is the failure.
    }
  }
  return {
    $schema: 'aqua/automation-publication-result/v3',
    status: 'FAILED',
    repository: AUTOMATION_REPOSITORY,
    repository_id: AUTOMATION_REPOSITORY_ID,
    base_sha: request?.baseSha ?? safeEnvironmentValue(env, 'EXPECTED_BASE_SHA', SHA_PATTERN, 40),
    branch: resultBranch,
    command_id:
      request?.commandId ??
      safeEnvironmentValue(env, 'AUTOMATION_COMMAND_ID', COMMAND_ID_PATTERN, 200),
    operation,
    input_sha256:
      request?.inputSha256 ??
      safeEnvironmentValue(env, 'AUTOMATION_INPUT_SHA256', SHA256_PATTERN, 64),
    retry_identity: retryIdentity,
    changed_path:
      request?.changedFile.path ??
      safeEnvironmentValue(env, 'CHANGED_PATHS', REPOSITORY_PATH_PATTERN, 512),
    changed_path_sha256: request?.changedFile.sha256 ?? null,
    commit_sha:
      progress?.commitSha && SHA_PATTERN.test(progress.commitSha) ? progress.commitSha : null,
    observed_branch_sha:
      progress?.observedBranchSha && SHA_PATTERN.test(progress.observedBranchSha)
        ? progress.observedBranchSha
        : null,
    pr_number: progressPullRequestNumber,
    pr_url: progressPullRequestUrl,
    workflow: {
      ref:
        request?.workflowRef ??
        safeEnvironmentValue(env, 'GITHUB_WORKFLOW_REF', /^[A-Za-z0-9._/@-]+$/, 512),
      sha:
        request?.workflowSha ?? safeEnvironmentValue(env, 'GITHUB_WORKFLOW_SHA', SHA_PATTERN, 40),
      run_id: request?.workflowRunId ?? safePositiveIntegerEnvironment(env, 'GITHUB_RUN_ID'),
      run_attempt:
        request?.workflowRunAttempt ?? safePositiveIntegerEnvironment(env, 'GITHUB_RUN_ATTEMPT'),
    },
    github_app: {
      slug: request?.appSlug ?? safeEnvironmentValue(env, 'GH_APP_SLUG', APP_SLUG_PATTERN, 100),
      installation_id:
        request?.appInstallationId ?? safePositiveIntegerEnvironment(env, 'GH_APP_INSTALLATION_ID'),
    },
    mutation_evidence: request?.evidence
      ? {
          artifact_id: request.evidence.artifactId,
          artifact_name: request.evidence.artifactName,
          artifact_sha256: request.evidence.artifactSha256,
        }
      : null,
    error: sanitizedFailureMessage(error),
  };
}

export function writeExclusiveDurableResult(
  resultPath: string,
  runnerTemp: string,
  result: AutomationPublicationResult,
  expectedBasename?: string,
): void {
  const canonicalRunnerTemp = realpathSync(runnerTemp);
  const resultBasename = basename(resultPath);
  if (
    !isAbsolute(resultPath) ||
    dirname(resultPath) !== canonicalRunnerTemp ||
    !isAutomationPublicationResultBasename(resultBasename) ||
    (expectedBasename !== undefined && resultBasename !== expectedBasename)
  ) {
    throw new Error(
      'AUTOMATION_RESULT_PATH must be the policy-owned direct child of canonical RUNNER_TEMP',
    );
  }
  const temporaryPath = join(
    canonicalRunnerTemp,
    `.${resultBasename}.${String(process.pid)}.${randomUUID()}.new`,
  );
  const bytes = Buffer.from(`${JSON.stringify(result)}\n`, 'utf8');
  let descriptor: number | null = null;
  let primaryError: unknown = null;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    linkSync(temporaryPath, resultPath);
    const directoryDescriptor = openSync(
      canonicalRunnerTemp,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
    );
    let directoryPrimaryError: unknown = null;
    let directoryCleanupError: unknown = null;
    try {
      fsyncSync(directoryDescriptor);
    } catch (error) {
      directoryPrimaryError = error;
    }
    try {
      closeSync(directoryDescriptor);
    } catch (error) {
      directoryCleanupError = error;
    }
    rethrowPublicationWriteErrors(directoryPrimaryError, [directoryCleanupError]);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (descriptor !== null) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    unlinkSync(temporaryPath);
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') cleanupErrors.push(error);
  }
  rethrowPublicationWriteErrors(primaryError, cleanupErrors);
}

export function rethrowPublicationWriteErrors(
  primaryError: unknown,
  cleanupErrors: readonly unknown[],
): void {
  const observedCleanupErrors = cleanupErrors.filter((error) => error !== null);
  if (primaryError !== null && observedCleanupErrors.length === 0) {
    throw publicationThrowable(primaryError, 'Automation publication result write failed');
  }
  if (primaryError === null && observedCleanupErrors.length === 1) {
    throw publicationThrowable(
      observedCleanupErrors[0],
      'Automation publication result cleanup failed',
    );
  }
  if (primaryError !== null || observedCleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError === null ? observedCleanupErrors : [primaryError, ...observedCleanupErrors],
      'Automation publication result write and cleanup did not both complete',
    );
  }
}

function publicationThrowable(value: unknown, message: string): Error {
  if (value instanceof Error) return value;
  const error = new Error(`${message}: ${String(value)}`);
  Object.defineProperty(error, 'cause', {
    configurable: false,
    enumerable: false,
    value,
    writable: false,
  });
  return error;
}

export function writeGitHubOutputs(
  path: string | undefined,
  result: AutomationPublicationResult,
): void {
  if (!path) {
    process.stdout.write(`${githubOutputPayload(result)}\n`);
    return;
  }
  const sink = new GitHubOutputSink(path);
  sink.writeAndClose(result);
}

function githubOutputPayload(result: AutomationPublicationResult): string {
  if (result.commit_sha !== null && !SHA_PATTERN.test(result.commit_sha)) {
    throw new Error('Publication result commit is unsafe for GITHUB_OUTPUT');
  }
  if (
    result.pr_url !== null &&
    result.pr_url !== `https://github.com/${AUTOMATION_REPOSITORY}/pull/${String(result.pr_number)}`
  ) {
    throw new Error('Publication result pull request is unsafe for GITHUB_OUTPUT');
  }
  const output = [
    `status=${result.status}`,
    `commit=${result.commit_sha ?? ''}`,
    `pr=${result.pr_url ?? ''}`,
  ].join('\n');
  return output;
}

export class GitHubOutputSink {
  private descriptor: number | null;

  public constructor(path: string) {
    if (!isAbsolute(path) || Buffer.byteLength(path, 'utf8') > 1024 || path.includes('\0')) {
      throw new Error('GITHUB_OUTPUT must be one bounded absolute path');
    }
    this.descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    );
    const metadata = fstatSync(this.descriptor);
    if (!metadata.isFile()) {
      closeSync(this.descriptor);
      this.descriptor = null;
      throw new Error('GITHUB_OUTPUT must be a regular file');
    }
  }

  public writeAndClose(result: AutomationPublicationResult): void {
    if (this.descriptor === null) throw new Error('GITHUB_OUTPUT sink is already closed');
    const descriptor = this.descriptor;
    this.descriptor = null;
    try {
      writeFileSync(descriptor, `${githubOutputPayload(result)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

export function finalizeAutomationPublication(
  resultPath: string,
  runnerTemp: string,
  expectedResultBasename: string | undefined,
  result: AutomationPublicationResult,
  env: NodeJS.ProcessEnv,
  request: AutomationPublicationRequest | null,
  writeOutputs: (result: AutomationPublicationResult) => void,
): AutomationPublicationResult {
  let finalResult = result;
  try {
    writeOutputs(result);
  } catch (error) {
    const outputError = `GITHUB_OUTPUT finalization failed: ${sanitizedFailureMessage(error)}`;
    if (result.status === 'FAILED') {
      finalResult = {
        ...result,
        error: sanitizedFailureMessage(
          new Error(`${result.error ?? 'automation publication failed'}; ${outputError}`),
        ),
      };
    } else {
      finalResult = automationPublicationFailureResult(
        new PublicationFailure(outputError, {
          stage: result.pr_number ? 'PULL_REQUEST_CREATED' : 'BRANCH_OBSERVED',
          retryIdentity: result.retry_identity,
          observedBranchSha: result.observed_branch_sha,
          commitSha: result.status === 'NO_CHANGE' ? null : result.commit_sha,
          pullRequestNumber: result.pr_number,
          pullRequestUrl: result.pr_url,
        }),
        env,
        request,
      );
    }
  }
  writeExclusiveDurableResult(resultPath, runnerTemp, finalResult, expectedResultBasename);
  return finalResult;
}

async function main(): Promise<void> {
  const env = process.env;
  const runnerTemp = requiredEnvironment(env, 'RUNNER_TEMP', 1024);
  const resultPath = requiredEnvironment(env, 'AUTOMATION_RESULT_PATH', 1024);
  let request: AutomationPublicationRequest | null = null;
  let expectedResultBasename: string | undefined;
  let durableResultPath = resultPath;
  let outputSink: GitHubOutputSink | null = null;
  let result: AutomationPublicationResult;
  try {
    request = publicationRequestFromEnvironment(env);
    const policyResultBasename = automationPublicationResultBasename(request.policy.key);
    expectedResultBasename = policyResultBasename;
    durableResultPath = join(realpathSync(runnerTemp), policyResultBasename);
    if (resolve(resultPath) !== durableResultPath) {
      throw new Error('AUTOMATION_RESULT_PATH basename differs from publication policy');
    }
    outputSink = new GitHubOutputSink(requiredEnvironment(env, 'GITHUB_OUTPUT', 1024));
    const token = requiredEnvironment(env, 'GH_TOKEN', MAX_ENV_BYTES);
    const remote = new GitHubAutomationPublicationRemote(new BoundedGitHubTransport(token));
    result = await new AutomationPublisher(remote).publish(request);
  } catch (error) {
    result = automationPublicationFailureResult(error, env, request);
  }

  result = finalizeAutomationPublication(
    durableResultPath,
    runnerTemp,
    expectedResultBasename,
    result,
    env,
    request,
    (publicationResult) => {
      if (!outputSink) {
        throw new Error('GITHUB_OUTPUT sink was not established before publication');
      }
      outputSink.writeAndClose(publicationResult);
    },
  );
  if (result.status === 'FAILED') {
    const commandMessage = (result.error ?? 'automation publication failed').replaceAll('%', '%25');
    process.stderr.write(`::error::${commandMessage}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
