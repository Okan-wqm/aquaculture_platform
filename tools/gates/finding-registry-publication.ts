#!/usr/bin/env ts-node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
  AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA,
  AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA_VERSION,
  parseAutomationPublicationDeploymentBranchPolicy,
} from './lib/automation-publication-authority';
import {
  AUTOMATION_BASE_BRANCH,
  AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS,
  AUTOMATION_REPOSITORY,
  AUTOMATION_REPOSITORY_ID,
  automationPublicationBranch,
  automationPublicationInputArtifact,
  automationPublicationResultArtifact,
  automationPublicationRetryIdentityHash,
  isManagedAutomationPublicationPath,
  selectAutomationPublicationPolicy,
  type AutomationPublicationOperation,
  type AutomationPublicationPolicyKey,
  type ResolvedAutomationPublicationPolicy,
} from './lib/automation-publication-policy';
import { verifyGitHubArtifactArchive } from './lib/github-artifact-archive';

const API_ROOT = 'https://api.github.com';
const AUTHORITY_MANIFEST_PATH = resolve(
  __dirname,
  '..',
  '..',
  '.github',
  'manifests',
  'automation-publication-authority.json',
);
const API_TIMEOUT_MS = 15_000;
const MAX_READER_RUNTIME_MS = 120_000;
const MAX_API_CALLS = 64;
const MAX_API_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ENV_BYTES = 16 * 1024;
const MAX_PR_FILES = 3_000;
const MAX_RESULT_CANDIDATES = 20;
const RESULT_POLL_ATTEMPTS = 12;
const RESULT_RETRY_MS = 5_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]{0,19}$/;
const RETRY_MARKER_PATTERN = /<!-- aqua-automation-retry-identity:([0-9a-f]{64}) -->/g;
const RESULT_SCHEMA = 'aqua/automation-publication-result/v3';

interface JsonRecord {
  readonly [key: string]: unknown;
}

export interface AutomationPublicationReader {
  get(path: string): Promise<unknown>;
  graphql(query: string, variables: JsonRecord): Promise<unknown>;
  downloadArtifact(artifactId: number): Promise<Buffer>;
}

export interface AutomationPublicationAuthority {
  readonly appId: string;
  readonly appSlug: string;
  readonly appInstallationId: number;
}

export interface AutomationPublicationAuthorityProvider {
  loadAuthorityIfActive(): AutomationPublicationAuthority | null;
}

export interface AutomationPublicationAdmissionContext {
  readonly repository: string;
  readonly repositoryId: string;
  readonly eventName: string;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly headRepository: string;
}

export interface AutomationPublicationAdmissionOptions {
  readonly pollAttempts?: number;
  readonly retryMilliseconds?: number;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export type AutomationPublicationAdmissionResult =
  | {
      readonly applicable: false;
    }
  | {
      readonly applicable: true;
      readonly policyKey: AutomationPublicationPolicyKey;
      readonly commandId: string;
      readonly headSha: string;
      readonly resultArtifactId: number;
    };

interface RepositoryIdentity {
  readonly fullName: string;
  readonly id: string;
}

interface RestPullRequest {
  readonly number: number;
  readonly state: string;
  readonly draft: boolean;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly commits: number;
  readonly changedFiles: number;
  readonly actorLogin: string;
  readonly actorType: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly baseRepository: RepositoryIdentity;
  readonly headRef: string;
  readonly headSha: string;
  readonly headRepository: RepositoryIdentity;
}

interface RestChangedFile {
  readonly path: string;
  readonly status: string;
  readonly blobOid: string;
}

interface RestCommit {
  readonly sha: string;
  readonly message: string;
  readonly parents: readonly string[];
  readonly verified: boolean;
  readonly verificationReason: string;
  readonly authorLogin: string;
  readonly files: readonly RestChangedFile[];
}

interface GraphqlEvidence {
  readonly repository: RepositoryIdentity;
  readonly pullRequest: {
    readonly number: number;
    readonly state: string;
    readonly draft: boolean;
    readonly title: string;
    readonly body: string;
    readonly url: string;
    readonly actorLogin: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly baseRepository: RepositoryIdentity;
    readonly headRef: string;
    readonly headSha: string;
    readonly headRepository: RepositoryIdentity;
    readonly commitCount: number;
    readonly commitSha: string;
  };
  readonly commit: {
    readonly sha: string;
    readonly message: string;
    readonly parents: readonly string[];
    readonly authorLogin: string;
    readonly signatureValid: boolean;
    readonly wasSignedByGitHub: boolean;
    readonly signatureState: string;
    readonly blobOid: string;
    readonly blobBytes: number;
    readonly blobBinary: boolean;
  };
}

interface WorkflowRunEvidence {
  readonly id: number;
  readonly attempt: number;
  readonly headSha: string;
  readonly headBranch: string;
  readonly path: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly repository: RepositoryIdentity;
  readonly headRepository: RepositoryIdentity;
}

interface ArtifactEvidence {
  readonly id: number;
  readonly name: string;
  readonly expired: boolean;
  readonly expiresAt: string;
  readonly digest: string | null;
  readonly workflowRunId: number;
  readonly workflowRepositoryId: string;
  readonly workflowHeadRepositoryId: string;
  readonly workflowHeadBranch: string;
  readonly workflowHeadSha: string;
}

interface MutationEvidence {
  readonly artifactId: number;
  readonly artifactName: string;
  readonly artifactSha256: string;
}

interface CommitProvenance {
  readonly commandId: string;
  readonly operation: AutomationPublicationOperation;
  readonly inputSha256: string;
  readonly baseSha: string;
  readonly retryIdentity: string;
  readonly changedPath: string;
  readonly changedPathSha256: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly workflowRunId: number;
  readonly workflowRunAttempt: number;
  readonly mutationEvidence: MutationEvidence;
}

interface PublicationExpectation {
  readonly pullRequest: RestPullRequest;
  readonly policy: ResolvedAutomationPublicationPolicy;
  readonly publicationBranch: string;
  readonly authority: AutomationPublicationAuthority;
  readonly provenance: CommitProvenance;
  readonly blob: Buffer;
}

interface PublicationResult {
  readonly status: 'PUBLISHED' | 'RECOVERED';
  readonly repository: string;
  readonly repositoryId: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly commandId: string;
  readonly operation: AutomationPublicationOperation;
  readonly inputSha256: string;
  readonly retryIdentity: string;
  readonly changedPath: string;
  readonly changedPathSha256: string;
  readonly commitSha: string;
  readonly observedBranchSha: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly workflowRunId: number;
  readonly workflowRunAttempt: number;
  readonly appSlug: string;
  readonly appInstallationId: number;
  readonly mutationEvidence: MutationEvidence;
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

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
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

function requireNaturalInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a natural safe integer`);
  }
  return Number(value);
}

function requirePositiveInteger(value: unknown, field: string): number {
  const integer = requireNaturalInteger(value, field);
  if (integer < 1) throw new Error(`${field} must be positive`);
  return integer;
}

function parsePositiveInteger(value: string, field: string): number {
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} exceeds the safe integer range`);
  return parsed;
}

function requireSha(value: unknown, field: string): string {
  const sha = requireString(value, field);
  if (!SHA_PATTERN.test(sha)) throw new Error(`${field} must be a full lowercase Git SHA`);
  return sha;
}

function requireSha256(value: unknown, field: string): string {
  const digest = requireString(value, field);
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function requireOperation(value: unknown, field: string): AutomationPublicationOperation {
  if (value !== 'add' && value !== 'close' && value !== 'sweep' && value !== 'report') {
    throw new Error(`${field} must be add, close, sweep, or report`);
  }
  return value;
}

function requireExactKeys(record: JsonRecord, keys: readonly string[], field: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} does not have the exact v3 field set`);
  }
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
    throw new Error(`${field} differs from the canonical value`);
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobOid(bytes: Buffer): string {
  const header = Buffer.from(`blob ${String(bytes.length)}\0`, 'utf8');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

function repositoryIdentity(value: unknown, field: string): RepositoryIdentity {
  const record = requireRecord(value, field);
  return {
    fullName: requireString(record.full_name ?? record.nameWithOwner, `${field}.full name`),
    id: String(requirePositiveInteger(record.id ?? record.databaseId, `${field}.id`)),
  };
}

function assertRepository(identity: RepositoryIdentity, field: string): void {
  if (identity.fullName !== AUTOMATION_REPOSITORY || identity.id !== AUTOMATION_REPOSITORY_ID) {
    throw new Error(`${field} must be the exact configured repository name and ID`);
  }
}

function parsePullRequest(value: unknown): RestPullRequest {
  const record = requireRecord(value, 'pull request');
  const base = requireRecord(record.base, 'pull request.base');
  const head = requireRecord(record.head, 'pull request.head');
  const actor = requireRecord(record.user, 'pull request.user');
  return {
    number: requirePositiveInteger(record.number, 'pull request.number'),
    state: requireString(record.state, 'pull request.state'),
    draft: requireBoolean(record.draft, 'pull request.draft'),
    title: requireString(record.title, 'pull request.title'),
    body: record.body === null ? '' : requireText(record.body, 'pull request.body'),
    url: requireString(record.html_url, 'pull request.html_url'),
    commits: requireNaturalInteger(record.commits, 'pull request.commits'),
    changedFiles: requireNaturalInteger(record.changed_files, 'pull request.changed_files'),
    actorLogin: requireString(actor.login, 'pull request.user.login'),
    actorType: requireString(actor.type, 'pull request.user.type'),
    baseRef: requireString(base.ref, 'pull request.base.ref'),
    baseSha: requireSha(base.sha, 'pull request.base.sha'),
    baseRepository: repositoryIdentity(base.repo, 'pull request.base.repo'),
    headRef: requireString(head.ref, 'pull request.head.ref'),
    headSha: requireSha(head.sha, 'pull request.head.sha'),
    headRepository: repositoryIdentity(head.repo, 'pull request.head.repo'),
  };
}

function parseChangedFile(value: unknown, field: string): RestChangedFile {
  const record = requireRecord(value, field);
  return {
    path: requireString(record.filename, `${field}.filename`),
    status: requireString(record.status, `${field}.status`),
    blobOid: requireSha(record.sha, `${field}.sha`),
  };
}

function parseCommit(gitValue: unknown, viewValue: unknown): RestCommit {
  const gitCommit = requireRecord(gitValue, 'REST git commit');
  const commitView = requireRecord(viewValue, 'REST commit view');
  const verification = requireRecord(gitCommit.verification, 'REST git commit.verification');
  const viewCommit = requireRecord(commitView.commit, 'REST commit view.commit');
  const author = requireRecord(commitView.author, 'REST commit view.author');
  const message = requireString(gitCommit.message, 'REST git commit.message');
  if (requireString(viewCommit.message, 'REST commit view.commit.message') !== message) {
    throw new Error('REST commit representations disagree on the commit message');
  }
  return {
    sha: requireSha(commitView.sha, 'REST commit view.sha'),
    message,
    parents: requireArray(gitCommit.parents, 'REST git commit.parents').map((parent, index) =>
      requireSha(
        requireRecord(parent, `REST git commit.parents[${String(index)}]`).sha,
        `REST git commit.parents[${String(index)}].sha`,
      ),
    ),
    verified: requireBoolean(verification.verified, 'REST git commit.verification.verified'),
    verificationReason: requireString(verification.reason, 'REST git commit.verification.reason'),
    authorLogin: requireString(author.login, 'REST commit view.author.login'),
    files: requireArray(commitView.files, 'REST commit view.files').map((file, index) =>
      parseChangedFile(file, `REST commit view.files[${String(index)}]`),
    ),
  };
}

function parseGraphqlEvidence(value: unknown): GraphqlEvidence {
  const response = requireRecord(value, 'GraphQL response');
  if (response.errors !== undefined) {
    const errors = requireArray(response.errors, 'GraphQL response.errors');
    if (errors.length > 0) throw new Error('GraphQL response contains errors');
  }
  const repository = requireRecord(
    requireRecord(response.data, 'GraphQL response.data').repository,
    'GraphQL repository',
  );
  const pullRequest = requireRecord(repository.pullRequest, 'GraphQL pull request');
  const baseRepository = repositoryIdentity(
    pullRequest.baseRepository,
    'GraphQL pull request.baseRepository',
  );
  const headRepository = repositoryIdentity(
    pullRequest.headRepository,
    'GraphQL pull request.headRepository',
  );
  const pullCommits = requireRecord(pullRequest.commits, 'GraphQL pull request.commits');
  const pullCommitNodes = requireArray(pullCommits.nodes, 'GraphQL pull request.commits.nodes');
  if (pullCommitNodes.length !== 1 || !pullCommitNodes[0]) {
    throw new Error('GraphQL pull request must expose exactly one commit');
  }
  const pullCommit = requireRecord(
    requireRecord(pullCommitNodes[0], 'GraphQL pull request commit node').commit,
    'GraphQL pull request commit',
  );

  const commit = requireRecord(repository.object, 'GraphQL commit');
  const parents = requireRecord(commit.parents, 'GraphQL commit.parents');
  const parentNodes = requireArray(parents.nodes, 'GraphQL commit.parents.nodes');
  const signature = requireRecord(commit.signature, 'GraphQL commit.signature');
  const author = requireRecord(
    requireRecord(commit.author, 'GraphQL commit.author').user,
    'GraphQL commit.author.user',
  );
  const tree = requireRecord(commit.tree, 'GraphQL commit.tree');
  const entry = requireRecord(tree.entry, 'GraphQL commit.tree.entry');
  const blob = requireRecord(entry.object, 'GraphQL commit blob');

  return {
    repository: {
      fullName: requireString(repository.nameWithOwner, 'GraphQL repository.nameWithOwner'),
      id: String(requirePositiveInteger(repository.databaseId, 'GraphQL repository.databaseId')),
    },
    pullRequest: {
      number: requirePositiveInteger(pullRequest.number, 'GraphQL pull request.number'),
      state: requireString(pullRequest.state, 'GraphQL pull request.state'),
      draft: requireBoolean(pullRequest.isDraft, 'GraphQL pull request.isDraft'),
      title: requireString(pullRequest.title, 'GraphQL pull request.title'),
      body: requireString(pullRequest.body, 'GraphQL pull request.body'),
      url: requireString(pullRequest.url, 'GraphQL pull request.url'),
      actorLogin: requireString(
        requireRecord(pullRequest.author, 'GraphQL pull request.author').login,
        'GraphQL pull request.author.login',
      ),
      baseRef: requireString(pullRequest.baseRefName, 'GraphQL pull request.baseRefName'),
      baseSha: requireSha(pullRequest.baseRefOid, 'GraphQL pull request.baseRefOid'),
      baseRepository,
      headRef: requireString(pullRequest.headRefName, 'GraphQL pull request.headRefName'),
      headSha: requireSha(pullRequest.headRefOid, 'GraphQL pull request.headRefOid'),
      headRepository,
      commitCount: requireNaturalInteger(
        pullCommits.totalCount,
        'GraphQL pull request.commits.totalCount',
      ),
      commitSha: requireSha(pullCommit.oid, 'GraphQL pull request commit.oid'),
    },
    commit: {
      sha: requireSha(commit.oid, 'GraphQL commit.oid'),
      message: requireString(commit.message, 'GraphQL commit.message'),
      parents: parentNodes.map((parent, index) =>
        requireSha(
          requireRecord(parent, `GraphQL commit.parents[${String(index)}]`).oid,
          `GraphQL commit.parents[${String(index)}].oid`,
        ),
      ),
      authorLogin: requireString(author.login, 'GraphQL commit.author.user.login'),
      signatureValid: requireBoolean(signature.isValid, 'GraphQL signature.isValid'),
      wasSignedByGitHub: requireBoolean(
        signature.wasSignedByGitHub,
        'GraphQL signature.wasSignedByGitHub',
      ),
      signatureState: requireString(signature.state, 'GraphQL signature.state'),
      blobOid: requireSha(blob.oid, 'GraphQL commit blob.oid'),
      blobBytes: requireNaturalInteger(blob.byteSize, 'GraphQL commit blob.byteSize'),
      blobBinary: requireBoolean(blob.isBinary, 'GraphQL commit blob.isBinary'),
    },
  };
}

function parseWorkflowRun(value: unknown): WorkflowRunEvidence {
  const run = requireRecord(value, 'workflow run');
  return {
    id: requirePositiveInteger(run.id, 'workflow run.id'),
    attempt: requirePositiveInteger(run.run_attempt, 'workflow run.run_attempt'),
    headSha: requireSha(run.head_sha, 'workflow run.head_sha'),
    headBranch: requireString(run.head_branch, 'workflow run.head_branch'),
    path: requireString(run.path, 'workflow run.path'),
    event: requireString(run.event, 'workflow run.event'),
    status: requireString(run.status, 'workflow run.status'),
    conclusion: requireNullableString(run.conclusion, 'workflow run.conclusion'),
    repository: repositoryIdentity(run.repository, 'workflow run.repository'),
    headRepository: repositoryIdentity(run.head_repository, 'workflow run.head_repository'),
  };
}

function parseArtifact(value: unknown, field: string): ArtifactEvidence {
  const artifact = requireRecord(value, field);
  const workflowRun = requireRecord(artifact.workflow_run, `${field}.workflow_run`);
  return {
    id: requirePositiveInteger(artifact.id, `${field}.id`),
    name: requireString(artifact.name, `${field}.name`),
    expired: requireBoolean(artifact.expired, `${field}.expired`),
    expiresAt: requireString(artifact.expires_at, `${field}.expires_at`),
    digest: requireNullableString(artifact.digest, `${field}.digest`),
    workflowRunId: requirePositiveInteger(workflowRun.id, `${field}.workflow_run.id`),
    workflowRepositoryId: String(
      requirePositiveInteger(workflowRun.repository_id, `${field}.workflow_run.repository_id`),
    ),
    workflowHeadRepositoryId: String(
      requirePositiveInteger(
        workflowRun.head_repository_id,
        `${field}.workflow_run.head_repository_id`,
      ),
    ),
    workflowHeadBranch: requireString(workflowRun.head_branch, `${field}.workflow_run.head_branch`),
    workflowHeadSha: requireSha(workflowRun.head_sha, `${field}.workflow_run.head_sha`),
  };
}

function parseArtifactList(value: unknown, field: string): readonly ArtifactEvidence[] {
  const response = requireRecord(value, field);
  const total = requireNaturalInteger(response.total_count, `${field}.total_count`);
  const values = requireArray(response.artifacts, `${field}.artifacts`);
  if (total !== values.length || total > 100) {
    throw new Error(`${field} is paginated or exceeds the bounded artifact set`);
  }
  return values.map((artifact, index) =>
    parseArtifact(artifact, `${field}.artifacts[${String(index)}]`),
  );
}

function parseBlob(value: unknown): Buffer {
  const blob = requireRecord(value, 'REST git blob');
  if (requireString(blob.encoding, 'REST git blob.encoding') !== 'base64') {
    throw new Error('REST git blob must use base64 encoding');
  }
  const encoded = requireString(blob.content, 'REST git blob.content').replace(/\n/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('REST git blob content is not canonical base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.toString('base64') !== encoded ||
    bytes.length !== requireNaturalInteger(blob.size, 'REST git blob.size') ||
    bytes.length > 4 * 1024 * 1024
  ) {
    throw new Error('REST git blob content or size is invalid');
  }
  return bytes;
}

function canonicalCommitProvenance(message: string): {
  readonly headline: string;
  readonly trailers: ReadonlyMap<string, string>;
} {
  if (message.includes('\r') || message.endsWith('\n')) {
    throw new Error('Automation commit message is not canonical LF text');
  }
  const lines = message.split('\n');
  if (
    lines.length !== AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER.length + 2 ||
    !lines[0] ||
    lines[1] !== ''
  ) {
    throw new Error('Automation commit must contain one headline and the exact trailer set');
  }
  const trailers = new Map<string, string>();
  for (const [index, name] of AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER.entries()) {
    const line = lines[index + 2];
    const prefix = `${name}: `;
    if (!line?.startsWith(prefix) || line.length === prefix.length) {
      throw new Error(`Automation commit trailer ${name} is missing or out of order`);
    }
    trailers.set(name, line.slice(prefix.length));
  }
  return { headline: lines[0], trailers };
}

function trailer(trailers: ReadonlyMap<string, string>, name: string): string {
  const value = trailers.get(name);
  if (!value) throw new Error(`Automation commit trailer ${name} is missing`);
  return value;
}

function parseCommitProvenance(message: string): {
  readonly headline: string;
  readonly provenance: CommitProvenance;
} {
  const canonical = canonicalCommitProvenance(message);
  const trailers = canonical.trailers;
  return {
    headline: canonical.headline,
    provenance: {
      commandId: trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.commandId),
      operation: requireOperation(
        trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.operation),
        AUTOMATION_PUBLICATION_COMMIT_TRAILERS.operation,
      ),
      inputSha256: requireSha256(
        trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.inputSha256),
        AUTOMATION_PUBLICATION_COMMIT_TRAILERS.inputSha256,
      ),
      baseSha: requireSha(
        trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.baseSha),
        AUTOMATION_PUBLICATION_COMMIT_TRAILERS.baseSha,
      ),
      retryIdentity: requireSha256(
        trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.retryIdentity),
        AUTOMATION_PUBLICATION_COMMIT_TRAILERS.retryIdentity,
      ),
      changedPath: trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.changedPath),
      changedPathSha256: requireSha256(
        trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.changedPathSha256),
        AUTOMATION_PUBLICATION_COMMIT_TRAILERS.changedPathSha256,
      ),
      workflowRef: trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRef),
      workflowSha: requireSha(
        trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowSha),
        AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowSha,
      ),
      workflowRunId: parsePositiveInteger(
        trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunId),
        AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunId,
      ),
      workflowRunAttempt: parsePositiveInteger(
        trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunAttempt),
        AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunAttempt,
      ),
      mutationEvidence: {
        artifactId: parsePositiveInteger(
          trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifactId),
          AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifactId,
        ),
        artifactName: trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifact),
        artifactSha256: requireSha256(
          trailer(trailers, AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceSha256),
          AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceSha256,
        ),
      },
    },
  };
}

function basePullRequestBody(body: string, identity: string): string {
  const matches = [...body.matchAll(RETRY_MARKER_PATTERN)].map((match) => match[1]);
  RETRY_MARKER_PATTERN.lastIndex = 0;
  const suffix = `\n\n<!-- aqua-automation-retry-identity:${identity} -->\n`;
  if (matches.length !== 1 || matches[0] !== identity || !body.endsWith(suffix)) {
    throw new Error('Pull request body does not contain the exact retry-identity marker');
  }
  const baseBody = body.slice(0, -suffix.length);
  if (baseBody.length === 0 || baseBody.trimEnd() !== baseBody || baseBody.includes('\0')) {
    throw new Error('Pull request base body is not canonical');
  }
  return baseBody;
}

function assertEventPullRequestIdentity(
  context: AutomationPublicationAdmissionContext,
  pullRequest: RestPullRequest,
): void {
  assertRepository(pullRequest.baseRepository, 'PR base repository');
  if (
    context.repository !== AUTOMATION_REPOSITORY ||
    context.repositoryId !== AUTOMATION_REPOSITORY_ID ||
    context.eventName !== 'pull_request_target' ||
    context.pullRequestNumber !== pullRequest.number ||
    context.baseSha !== pullRequest.baseSha ||
    context.headSha !== pullRequest.headSha ||
    context.headRepository !== pullRequest.headRepository.fullName ||
    pullRequest.baseRef !== AUTOMATION_BASE_BRANCH
  ) {
    throw new Error('Pull request does not match the exact admission event identity');
  }
}

function assertManagedPullRequestIdentity(pullRequest: RestPullRequest): void {
  if (pullRequest.state !== 'open' || pullRequest.draft || pullRequest.commits !== 1) {
    throw new Error('Managed automation publication must be an open, ready, one-commit PR');
  }
}

function assertRestGraphqlAgreement(
  rest: RestPullRequest,
  commit: RestCommit,
  graph: GraphqlEvidence,
  changedFile: RestChangedFile,
  blob: Buffer,
  appLogin: string,
): void {
  assertRepository(graph.repository, 'GraphQL repository');
  assertRepository(graph.pullRequest.baseRepository, 'GraphQL PR base repository');
  assertRepository(graph.pullRequest.headRepository, 'GraphQL PR head repository');
  const pull = graph.pullRequest;
  if (
    pull.number !== rest.number ||
    pull.state !== 'OPEN' ||
    pull.draft !== rest.draft ||
    pull.title !== rest.title ||
    pull.body !== rest.body ||
    pull.url !== rest.url ||
    pull.actorLogin !== rest.actorLogin ||
    pull.baseRef !== rest.baseRef ||
    pull.baseSha !== rest.baseSha ||
    pull.baseRepository.fullName !== rest.baseRepository.fullName ||
    pull.baseRepository.id !== rest.baseRepository.id ||
    pull.headRef !== rest.headRef ||
    pull.headSha !== rest.headSha ||
    pull.headRepository.fullName !== rest.headRepository.fullName ||
    pull.headRepository.id !== rest.headRepository.id ||
    pull.commitCount !== 1 ||
    pull.commitSha !== rest.headSha
  ) {
    throw new Error('REST and GraphQL pull request evidence disagree');
  }
  const graphCommit = graph.commit;
  if (
    commit.sha !== rest.headSha ||
    graphCommit.sha !== commit.sha ||
    graphCommit.message !== commit.message ||
    graphCommit.authorLogin !== commit.authorLogin ||
    graphCommit.authorLogin !== appLogin ||
    !commit.verified ||
    commit.verificationReason !== 'valid' ||
    !graphCommit.signatureValid ||
    !graphCommit.wasSignedByGitHub ||
    graphCommit.signatureState !== 'VALID' ||
    graphCommit.blobOid !== changedFile.blobOid ||
    graphCommit.blobBytes !== blob.length ||
    graphCommit.blobBinary ||
    gitBlobOid(blob) !== changedFile.blobOid
  ) {
    throw new Error('REST and GraphQL commit, signature, actor, or blob evidence disagree');
  }
  assertExactStrings(commit.parents, [rest.baseSha], 'REST commit parents');
  assertExactStrings(graphCommit.parents, [rest.baseSha], 'GraphQL commit parents');
}

function assertArtifactLive(
  artifact: ArtifactEvidence,
  runId: number,
  baseSha: string,
  now: number,
): string {
  if (
    artifact.expired ||
    !Number.isFinite(Date.parse(artifact.expiresAt)) ||
    Date.parse(artifact.expiresAt) <= now
  ) {
    throw new Error(`Artifact ${artifact.name} is expired`);
  }
  if (
    artifact.workflowRunId !== runId ||
    artifact.workflowRepositoryId !== AUTOMATION_REPOSITORY_ID ||
    artifact.workflowHeadRepositoryId !== AUTOMATION_REPOSITORY_ID ||
    artifact.workflowHeadBranch !== AUTOMATION_BASE_BRANCH ||
    artifact.workflowHeadSha !== baseSha
  ) {
    throw new Error(`Artifact ${artifact.name} workflow identity is not canonical`);
  }
  if (artifact.digest === null || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)) {
    throw new Error(`Artifact ${artifact.name} lacks a canonical API digest`);
  }
  return artifact.digest.slice('sha256:'.length);
}

function parsePublicationResult(value: unknown): PublicationResult {
  const result = requireRecord(value, 'publication result');
  requireExactKeys(
    result,
    [
      '$schema',
      'status',
      'repository',
      'repository_id',
      'base_sha',
      'branch',
      'command_id',
      'operation',
      'input_sha256',
      'retry_identity',
      'changed_path',
      'changed_path_sha256',
      'commit_sha',
      'observed_branch_sha',
      'pr_number',
      'pr_url',
      'workflow',
      'github_app',
      'mutation_evidence',
      'error',
    ],
    'publication result',
  );
  if (result.$schema !== RESULT_SCHEMA) {
    throw new Error('Publication result schema is not v3');
  }
  if (result.status !== 'PUBLISHED' && result.status !== 'RECOVERED') {
    throw new Error('Publication result must prove PUBLISHED or RECOVERED');
  }
  if (result.error !== null) throw new Error('Successful publication result must have null error');

  const workflow = requireRecord(result.workflow, 'publication result.workflow');
  requireExactKeys(
    workflow,
    ['ref', 'sha', 'run_id', 'run_attempt'],
    'publication result.workflow',
  );
  const app = requireRecord(result.github_app, 'publication result.github_app');
  requireExactKeys(app, ['slug', 'installation_id'], 'publication result.github_app');
  const evidence = requireRecord(result.mutation_evidence, 'publication result.mutation_evidence');
  requireExactKeys(
    evidence,
    ['artifact_id', 'artifact_name', 'artifact_sha256'],
    'publication result.mutation_evidence',
  );
  return {
    status: result.status,
    repository: requireString(result.repository, 'publication result.repository'),
    repositoryId: requireString(result.repository_id, 'publication result.repository_id'),
    baseSha: requireSha(result.base_sha, 'publication result.base_sha'),
    branch: requireString(result.branch, 'publication result.branch'),
    commandId: requireString(result.command_id, 'publication result.command_id'),
    operation: requireOperation(result.operation, 'publication result.operation'),
    inputSha256: requireSha256(result.input_sha256, 'publication result.input_sha256'),
    retryIdentity: requireSha256(result.retry_identity, 'publication result.retry_identity'),
    changedPath: requireString(result.changed_path, 'publication result.changed_path'),
    changedPathSha256: requireSha256(
      result.changed_path_sha256,
      'publication result.changed_path_sha256',
    ),
    commitSha: requireSha(result.commit_sha, 'publication result.commit_sha'),
    observedBranchSha: requireSha(
      result.observed_branch_sha,
      'publication result.observed_branch_sha',
    ),
    pullRequestNumber: requirePositiveInteger(result.pr_number, 'publication result.pr_number'),
    pullRequestUrl: requireString(result.pr_url, 'publication result.pr_url'),
    workflowRef: requireString(workflow.ref, 'publication result.workflow.ref'),
    workflowSha: requireSha(workflow.sha, 'publication result.workflow.sha'),
    workflowRunId: requirePositiveInteger(workflow.run_id, 'publication result.workflow.run_id'),
    workflowRunAttempt: requirePositiveInteger(
      workflow.run_attempt,
      'publication result.workflow.run_attempt',
    ),
    appSlug: requireString(app.slug, 'publication result.github_app.slug'),
    appInstallationId: requirePositiveInteger(
      app.installation_id,
      'publication result.github_app.installation_id',
    ),
    mutationEvidence: {
      artifactId: requirePositiveInteger(
        evidence.artifact_id,
        'publication result.mutation_evidence.artifact_id',
      ),
      artifactName: requireString(
        evidence.artifact_name,
        'publication result.mutation_evidence.artifact_name',
      ),
      artifactSha256: requireSha256(
        evidence.artifact_sha256,
        'publication result.mutation_evidence.artifact_sha256',
      ),
    },
  };
}

function assertPublicationResult(
  expectation: PublicationExpectation,
  result: PublicationResult,
): void {
  const { pullRequest, policy, provenance, authority } = expectation;
  if (
    result.repository !== AUTOMATION_REPOSITORY ||
    result.repositoryId !== AUTOMATION_REPOSITORY_ID ||
    result.baseSha !== pullRequest.baseSha ||
    result.branch !== expectation.publicationBranch ||
    result.commandId !== provenance.commandId ||
    result.operation !== provenance.operation ||
    result.inputSha256 !== provenance.inputSha256 ||
    result.retryIdentity !== provenance.retryIdentity ||
    result.changedPath !== policy.changedPath ||
    result.changedPathSha256 !== provenance.changedPathSha256 ||
    result.commitSha !== pullRequest.headSha ||
    result.observedBranchSha !== pullRequest.headSha ||
    result.pullRequestNumber !== pullRequest.number ||
    result.pullRequestUrl !== pullRequest.url ||
    result.workflowRef !== policy.workflowRef ||
    result.workflowSha !== pullRequest.baseSha ||
    result.appSlug !== authority.appSlug ||
    result.appInstallationId !== authority.appInstallationId
  ) {
    throw new Error('Publication result differs from live repository or policy evidence');
  }
  if (
    result.status === 'PUBLISHED' &&
    (result.workflowRunId !== provenance.workflowRunId ||
      result.workflowRunAttempt !== provenance.workflowRunAttempt ||
      result.mutationEvidence.artifactId !== provenance.mutationEvidence.artifactId ||
      result.mutationEvidence.artifactName !== provenance.mutationEvidence.artifactName ||
      result.mutationEvidence.artifactSha256 !== provenance.mutationEvidence.artifactSha256)
  ) {
    throw new Error('PUBLISHED result is not bound to the commit-origin run and evidence');
  }
}

function workflowAttemptPath(runId: number, attempt: number): string {
  return `/repos/${AUTOMATION_REPOSITORY}/actions/runs/${String(
    runId,
  )}/attempts/${String(attempt)}`;
}

function workflowRunArtifactsPath(runId: number): string {
  // GitHub exposes artifacts at run scope. Exact-attempt authority is proven
  // independently by workflowAttemptPath plus the policy-owned artifact name,
  // ID, and digest; an attempt-scoped artifact endpoint does not exist.
  return `/repos/${AUTOMATION_REPOSITORY}/actions/runs/${String(runId)}/artifacts?per_page=100`;
}

async function verifyWorkflowRun(
  reader: AutomationPublicationReader,
  policy: ResolvedAutomationPublicationPolicy,
  baseSha: string,
  runId: number,
  attempt: number,
): Promise<void> {
  const run = parseWorkflowRun(await reader.get(workflowAttemptPath(runId, attempt)));
  assertRepository(run.repository, 'Workflow repository');
  assertRepository(run.headRepository, 'Workflow head repository');
  if (
    run.id !== runId ||
    run.attempt !== attempt ||
    run.headSha !== baseSha ||
    run.headBranch !== AUTOMATION_BASE_BRANCH ||
    run.path !== policy.workflowPath ||
    !policy.workflowEvents.includes(run.event) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  ) {
    throw new Error(
      `Workflow run ${String(runId)}/${String(attempt)} is not the exact successful policy run`,
    );
  }
}

async function verifyInputArtifact(
  reader: AutomationPublicationReader,
  expectation: PublicationExpectation,
  runId: number,
  attempt: number,
  evidence: MutationEvidence,
  now: number,
): Promise<void> {
  const contract = automationPublicationInputArtifact(expectation.policy, runId, attempt);
  if (evidence.artifactName !== contract.name) {
    throw new Error('Input artifact name differs from policy and exact run attempt');
  }
  const artifacts = parseArtifactList(
    await reader.get(workflowRunArtifactsPath(runId)),
    'workflow-run artifacts',
  );
  const matches = artifacts.filter(
    (artifact) => artifact.id === evidence.artifactId && artifact.name === evidence.artifactName,
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new Error('Commit-bound input artifact ID and name are not unique in the workflow run');
  }
  const artifact = matches[0];
  const apiDigest = assertArtifactLive(artifact, runId, expectation.pullRequest.baseSha, now);
  if (apiDigest !== evidence.artifactSha256) {
    throw new Error('Input artifact API digest differs from commit-bound evidence');
  }
  const entries = verifyGitHubArtifactArchive(
    await reader.downloadArtifact(artifact.id),
    apiDigest,
    contract.exactFiles,
  );
  if (expectation.policy.inputDigestKind === 'content') {
    const input = entries.get(basename(expectation.policy.changedPath));
    if (
      !input ||
      !input.equals(expectation.blob) ||
      sha256(input) !== expectation.provenance.changedPathSha256 ||
      sha256(input) !== expectation.provenance.inputSha256
    ) {
      throw new Error('Report input artifact does not equal the committed report content');
    }
  }
}

async function validateResultCandidate(
  reader: AutomationPublicationReader,
  expectation: PublicationExpectation,
  artifact: ArtifactEvidence,
  now: number,
): Promise<PublicationResult> {
  const contract = automationPublicationResultArtifact(expectation.policy);
  const apiDigest = assertArtifactLive(
    artifact,
    artifact.workflowRunId,
    expectation.pullRequest.baseSha,
    now,
  );
  const entries = verifyGitHubArtifactArchive(
    await reader.downloadArtifact(artifact.id),
    apiDigest,
    contract.exactFiles,
  );
  const resultBytes = entries.get(contract.resultJsonBasename);
  if (!resultBytes) throw new Error('Publication result JSON is absent from its exact archive');
  let resultValue: unknown;
  try {
    resultValue = JSON.parse(resultBytes.toString('utf8'));
  } catch {
    throw new Error('Publication result artifact contains invalid JSON');
  }
  const result = parsePublicationResult(resultValue);
  assertPublicationResult(expectation, result);
  if (artifact.workflowRunId !== result.workflowRunId) {
    throw new Error('Publication result artifact belongs to a different workflow run');
  }
  const runArtifacts = parseArtifactList(
    await reader.get(workflowRunArtifactsPath(result.workflowRunId)),
    'publication-result run artifacts',
  );
  const runMatches = runArtifacts.filter(
    (candidate) => candidate.id === artifact.id && candidate.name === artifact.name,
  );
  if (runMatches.length !== 1 || !runMatches[0] || runMatches[0].digest !== artifact.digest) {
    throw new Error('Publication result artifact is not unique in its exact workflow run');
  }
  const runDigest = assertArtifactLive(
    runMatches[0],
    result.workflowRunId,
    expectation.pullRequest.baseSha,
    now,
  );
  if (runDigest !== apiDigest) {
    throw new Error('Publication result artifact API views disagree on content digest');
  }

  await verifyWorkflowRun(
    reader,
    expectation.policy,
    expectation.pullRequest.baseSha,
    expectation.provenance.workflowRunId,
    expectation.provenance.workflowRunAttempt,
  );
  await verifyInputArtifact(
    reader,
    expectation,
    expectation.provenance.workflowRunId,
    expectation.provenance.workflowRunAttempt,
    expectation.provenance.mutationEvidence,
    now,
  );
  if (
    result.workflowRunId !== expectation.provenance.workflowRunId ||
    result.workflowRunAttempt !== expectation.provenance.workflowRunAttempt
  ) {
    await verifyWorkflowRun(
      reader,
      expectation.policy,
      expectation.pullRequest.baseSha,
      result.workflowRunId,
      result.workflowRunAttempt,
    );
  }
  if (
    result.workflowRunId !== expectation.provenance.workflowRunId ||
    result.workflowRunAttempt !== expectation.provenance.workflowRunAttempt ||
    result.mutationEvidence.artifactId !== expectation.provenance.mutationEvidence.artifactId ||
    result.mutationEvidence.artifactName !== expectation.provenance.mutationEvidence.artifactName ||
    result.mutationEvidence.artifactSha256 !==
      expectation.provenance.mutationEvidence.artifactSha256
  ) {
    await verifyInputArtifact(
      reader,
      expectation,
      result.workflowRunId,
      result.workflowRunAttempt,
      result.mutationEvidence,
      now,
    );
  }
  return result;
}

async function listPullRequestFiles(
  reader: AutomationPublicationReader,
  pullRequest: RestPullRequest,
): Promise<readonly RestChangedFile[]> {
  if (pullRequest.changedFiles > MAX_PR_FILES) {
    throw new Error(`Pull request exceeds the ${String(MAX_PR_FILES)}-file admission bound`);
  }
  const files: RestChangedFile[] = [];
  const pages = Math.ceil(pullRequest.changedFiles / 100);
  for (let page = 1; page <= pages; page += 1) {
    const values = requireArray(
      await reader.get(
        `/repos/${AUTOMATION_REPOSITORY}/pulls/${String(
          pullRequest.number,
        )}/files?per_page=100&page=${String(page)}`,
      ),
      `pull request files page ${String(page)}`,
    );
    for (const [index, value] of values.entries()) {
      files.push(
        parseChangedFile(value, `pull request files page ${String(page)}[${String(index)}]`),
      );
    }
  }
  if (files.length !== pullRequest.changedFiles) {
    throw new Error('Pull request file listing differs from its authenticated file count');
  }
  return files;
}

async function assertAppAuthority(
  reader: AutomationPublicationReader,
  authority: AutomationPublicationAuthority,
): Promise<void> {
  if (
    !APP_SLUG_PATTERN.test(authority.appSlug) ||
    !POSITIVE_INTEGER_PATTERN.test(authority.appId) ||
    !Number.isSafeInteger(authority.appInstallationId) ||
    authority.appInstallationId < 1
  ) {
    throw new Error('Protected-base automation authority is invalid');
  }
  const app = requireRecord(
    await reader.get(`/apps/${encodeURIComponent(authority.appSlug)}`),
    'GitHub App',
  );
  if (
    requireString(app.slug, 'GitHub App.slug') !== authority.appSlug ||
    String(requirePositiveInteger(app.id, 'GitHub App.id')) !== authority.appId
  ) {
    throw new Error('Live GitHub App identity differs from protected-base authority');
  }
}

function isConfiguredAppActor(
  pullRequest: RestPullRequest,
  authority: AutomationPublicationAuthority,
): boolean {
  return pullRequest.actorType === 'Bot' && pullRequest.actorLogin === `${authority.appSlug}[bot]`;
}

async function buildExpectation(
  context: AutomationPublicationAdmissionContext,
  reader: AutomationPublicationReader,
  authority: AutomationPublicationAuthority,
  pullRequest: RestPullRequest,
  files: readonly RestChangedFile[],
): Promise<PublicationExpectation> {
  assertEventPullRequestIdentity(context, pullRequest);
  assertManagedPullRequestIdentity(pullRequest);
  assertRepository(pullRequest.headRepository, 'PR head repository');
  await assertAppAuthority(reader, authority);
  const appLogin = `${authority.appSlug}[bot]`;
  if (!isConfiguredAppActor(pullRequest, authority)) {
    throw new Error('Managed automation publication PR actor is not the configured GitHub App');
  }
  if (files.length !== 1 || !files[0]) {
    throw new Error('Managed automation publication must change exactly one path');
  }
  const changedFile = files[0];
  if (changedFile.status !== 'added' && changedFile.status !== 'modified') {
    throw new Error('Managed automation publication path must be added or modified');
  }

  const repositoryPath = `/repos/${AUTOMATION_REPOSITORY}`;
  const [pullCommitsValue, gitCommitValue, commitViewValue, blobValue, graphValue] =
    await Promise.all([
      reader.get(`${repositoryPath}/pulls/${String(pullRequest.number)}/commits?per_page=2`),
      reader.get(`${repositoryPath}/git/commits/${pullRequest.headSha}`),
      reader.get(`${repositoryPath}/commits/${pullRequest.headSha}`),
      reader.get(`${repositoryPath}/git/blobs/${changedFile.blobOid}`),
      reader.graphql(
        `query AutomationPublicationAdmission(
          $owner: String!
          $name: String!
          $number: Int!
          $head: String!
          $path: String!
        ) {
          repository(owner: $owner, name: $name) {
            databaseId
            nameWithOwner
            pullRequest(number: $number) {
              number
              state
              isDraft
              title
              body
              url
              author { login }
              baseRefName
              baseRefOid
              baseRepository { databaseId nameWithOwner }
              headRefName
              headRefOid
              headRepository { databaseId nameWithOwner }
              commits(first: 2) { totalCount nodes { commit { oid } } }
            }
            object(expression: $head) {
              ... on Commit {
                oid
                message
                parents(first: 2) { totalCount nodes { oid } }
                author { user { login } }
                signature { isValid wasSignedByGitHub state }
                tree {
                  entry(path: $path) {
                    object { ... on Blob { oid byteSize isBinary } }
                  }
                }
              }
            }
          }
        }`,
        {
          owner: 'Okan-wqm',
          name: 'aquaculture_platform',
          number: pullRequest.number,
          head: pullRequest.headSha,
          path: changedFile.path,
        },
      ),
    ]);
  const pullCommits = requireArray(pullCommitsValue, 'REST pull request commits');
  if (
    pullCommits.length !== 1 ||
    !pullCommits[0] ||
    requireSha(
      requireRecord(pullCommits[0], 'REST pull request commit').sha,
      'REST pull request commit.sha',
    ) !== pullRequest.headSha
  ) {
    throw new Error('REST pull request does not contain exactly the event head commit');
  }
  const commit = parseCommit(gitCommitValue, commitViewValue);
  const blob = parseBlob(blobValue);
  const graph = parseGraphqlEvidence(graphValue);
  assertRestGraphqlAgreement(pullRequest, commit, graph, changedFile, blob, appLogin);
  assertExactStrings(
    commit.files.map((file) => file.path),
    [changedFile.path],
    'REST commit changed paths',
  );
  if (
    commit.files[0]?.blobOid !== changedFile.blobOid ||
    commit.files[0]?.status !== changedFile.status ||
    commit.authorLogin !== appLogin
  ) {
    throw new Error('REST pull request and commit file or author evidence disagree');
  }

  const { headline, provenance } = parseCommitProvenance(commit.message);
  const policy = selectAutomationPublicationPolicy({
    operation: provenance.operation,
    commandId: provenance.commandId,
    baseSha: pullRequest.baseSha,
    workflowRef: provenance.workflowRef,
    changedPath: changedFile.path,
    commitHeadline: headline,
    pullRequestTitle: pullRequest.title,
  });
  if (
    provenance.baseSha !== pullRequest.baseSha ||
    provenance.workflowSha !== pullRequest.baseSha ||
    provenance.changedPath !== changedFile.path ||
    provenance.changedPathSha256 !== sha256(blob) ||
    (policy.inputDigestKind === 'content' &&
      provenance.inputSha256 !== provenance.changedPathSha256)
  ) {
    throw new Error('Automation commit trailers are not bound to the exact base and blob');
  }
  const baseBody = basePullRequestBody(pullRequest.body, provenance.retryIdentity);
  const retryIdentity = automationPublicationRetryIdentityHash({
    baseSha: pullRequest.baseSha,
    branch: policy.branch,
    commandId: provenance.commandId,
    operation: provenance.operation,
    inputSha256: provenance.inputSha256,
    changedPath: policy.changedPath,
    changedPathSha256: provenance.changedPathSha256,
    commitHeadline: policy.commitHeadline,
    pullRequestTitle: policy.pullRequestTitle,
    basePullRequestBodySha256: sha256(baseBody),
    workflowRef: policy.workflowRef,
    workflowSha: pullRequest.baseSha,
  });
  if (retryIdentity !== provenance.retryIdentity) {
    throw new Error('Automation retry identity differs from the shared SSoT calculation');
  }
  const publicationBranch = automationPublicationBranch(policy, provenance.commandId);
  if (pullRequest.headRef !== publicationBranch) {
    throw new Error('Pull request head differs from its command-identity immutable branch');
  }
  const inputContract = automationPublicationInputArtifact(
    policy,
    provenance.workflowRunId,
    provenance.workflowRunAttempt,
  );
  if (provenance.mutationEvidence.artifactName !== inputContract.name) {
    throw new Error('Commit-bound input artifact name differs from policy');
  }
  return {
    pullRequest,
    policy,
    publicationBranch,
    authority,
    provenance,
    blob,
  };
}

async function pollForValidResult(
  reader: AutomationPublicationReader,
  expectation: PublicationExpectation,
  options: Required<AutomationPublicationAdmissionOptions>,
): Promise<{ readonly result: PublicationResult; readonly artifactId: number }> {
  const name = `automation-publication-result-${expectation.pullRequest.headSha}`;
  const searchPath = `/repos/${AUTOMATION_REPOSITORY}/actions/artifacts?per_page=100&name=${encodeURIComponent(
    name,
  )}`;
  let lastFailures: readonly string[] = ['result artifact is not visible'];
  for (let poll = 1; poll <= options.pollAttempts; poll += 1) {
    const artifacts = parseArtifactList(
      await reader.get(searchPath),
      'publication result artifact search',
    );
    const candidates = artifacts.filter((artifact) => artifact.name === name);
    if (candidates.length > MAX_RESULT_CANDIDATES) {
      throw new Error('Publication result candidate set exceeds its bound');
    }
    const failures: string[] = [];
    for (const artifact of candidates) {
      try {
        const result = await validateResultCandidate(reader, expectation, artifact, options.now());
        return { result, artifactId: artifact.id };
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    lastFailures = failures.length > 0 ? failures : ['result artifact is not visible'];
    if (poll < options.pollAttempts) {
      await options.delay(options.retryMilliseconds);
    }
  }
  throw new Error(`No valid unexpired publication result was found: ${lastFailures.join('; ')}`);
}

function normalizedOptions(
  options: AutomationPublicationAdmissionOptions,
): Required<AutomationPublicationAdmissionOptions> {
  const pollAttempts = options.pollAttempts ?? RESULT_POLL_ATTEMPTS;
  const retryMilliseconds = options.retryMilliseconds ?? RESULT_RETRY_MS;
  if (
    !Number.isSafeInteger(pollAttempts) ||
    pollAttempts < 1 ||
    pollAttempts > RESULT_POLL_ATTEMPTS ||
    !Number.isSafeInteger(retryMilliseconds) ||
    retryMilliseconds < 0 ||
    retryMilliseconds > RESULT_RETRY_MS
  ) {
    throw new Error('Admission polling configuration exceeds its bounded policy');
  }
  return {
    pollAttempts,
    retryMilliseconds,
    now: options.now ?? Date.now,
    delay:
      options.delay ??
      (async (milliseconds: number): Promise<void> => {
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, milliseconds);
        });
      }),
  };
}

export async function verifyAutomationPublicationAdmission(
  context: AutomationPublicationAdmissionContext,
  reader: AutomationPublicationReader,
  authorityProvider: AutomationPublicationAuthorityProvider,
  options: AutomationPublicationAdmissionOptions = {},
): Promise<AutomationPublicationAdmissionResult> {
  if (
    context.repository !== AUTOMATION_REPOSITORY ||
    context.repositoryId !== AUTOMATION_REPOSITORY_ID ||
    context.eventName !== 'pull_request_target' ||
    !Number.isSafeInteger(context.pullRequestNumber) ||
    context.pullRequestNumber < 1
  ) {
    throw new Error('Admission event repository, ID, event, or PR number is invalid');
  }
  requireSha(context.baseSha, 'admission event base SHA');
  requireSha(context.headSha, 'admission event head SHA');

  const pullRequest = parsePullRequest(
    await reader.get(`/repos/${AUTOMATION_REPOSITORY}/pulls/${String(context.pullRequestNumber)}`),
  );
  assertEventPullRequestIdentity(context, pullRequest);
  const files = await listPullRequestFiles(reader, pullRequest);
  const managed = files.filter((file) => isManagedAutomationPublicationPath(file.path));
  if (managed.length === 0) {
    if (pullRequest.actorType !== 'Bot') return { applicable: false };
    const authority = authorityProvider.loadAuthorityIfActive();
    if (authority === null) return { applicable: false };
    if (!isConfiguredAppActor(pullRequest, authority)) return { applicable: false };
    throw new Error('Configured automation App may not publish unmanaged paths');
  }
  if (managed.length !== 1 || files.length !== 1) {
    throw new Error('Automation publication PR must contain one managed path and no other files');
  }

  const authority = authorityProvider.loadAuthorityIfActive();
  if (authority === null) {
    throw new Error('Automation publication authority is not ACTIVE');
  }
  const expectation = await buildExpectation(context, reader, authority, pullRequest, files);
  const proof = await pollForValidResult(reader, expectation, normalizedOptions(options));
  return {
    applicable: true,
    policyKey: expectation.policy.key,
    commandId: expectation.provenance.commandId,
    headSha: expectation.pullRequest.headSha,
    resultArtifactId: proof.artifactId,
  };
}

export class ProtectedBaseAuthorityProvider implements AutomationPublicationAuthorityProvider {
  public loadAuthorityIfActive(): AutomationPublicationAuthority | null {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(AUTHORITY_MANIFEST_PATH, 'utf8'));
    } catch {
      throw new Error('Protected-base automation authority manifest is unreadable');
    }
    return activeAuthorityFromManifest(value);
  }
}

export function activeAuthorityFromManifest(value: unknown): AutomationPublicationAuthority | null {
  const manifest = requireRecord(value, 'automation authority manifest');
  if (
    manifest.$schema !== AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA ||
    manifest.schema_version !== AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA_VERSION ||
    manifest.authority_id !== 'aqua.github.automation-publication'
  ) {
    throw new Error('Automation publication authority schema or identity is invalid');
  }
  if (manifest.state !== 'ACTIVE' && manifest.state !== 'BOOTSTRAP_PENDING') {
    throw new Error('Automation publication authority state is invalid');
  }
  const repositoryRecord = requireRecord(
    manifest.repository,
    'automation authority manifest.repository',
  );
  const repository: RepositoryIdentity = {
    fullName: requireString(
      repositoryRecord.full_name,
      'automation authority manifest.repository.full_name',
    ),
    id: String(
      requirePositiveInteger(
        repositoryRecord.repository_id,
        'automation authority manifest.repository.repository_id',
      ),
    ),
  };
  assertRepository(repository, 'Automation authority repository');
  const environment = requireRecord(
    manifest.environment,
    'automation authority manifest.environment',
  );
  parseAutomationPublicationDeploymentBranchPolicy(environment.deployment_branch_policy);
  if (manifest.state === 'BOOTSTRAP_PENDING') return null;
  const activation = requireRecord(
    manifest.activation_evidence,
    'automation authority manifest.activation_evidence',
  );
  return {
    appId: requireString(activation.github_app_id, 'automation authority github_app_id'),
    appSlug: requireString(activation.github_app_slug, 'automation authority github_app_slug'),
    appInstallationId: parsePositiveInteger(
      requireString(
        activation.github_app_installation_id,
        'automation authority github_app_installation_id',
      ),
      'automation authority github_app_installation_id',
    ),
  };
}

export class BoundedGitHubReader implements AutomationPublicationReader {
  private calls = 0;
  private totalBytes = 0;
  private readonly startedAt = Date.now();

  public constructor(private readonly token: string) {
    if (token.length === 0 || token.length > MAX_ENV_BYTES) {
      throw new Error('GITHUB_TOKEN is required and bounded');
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: JsonRecord | undefined,
    binary: boolean,
  ): Promise<unknown> {
    if (!path.startsWith('/')) throw new Error('GitHub API path must be repository-relative');
    const remainingMilliseconds = MAX_READER_RUNTIME_MS - (Date.now() - this.startedAt);
    if (remainingMilliseconds <= 0) {
      throw new Error('GitHub API wall-clock budget exhausted');
    }
    this.calls += 1;
    if (this.calls > MAX_API_CALLS) throw new Error('GitHub API call budget exhausted');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(API_TIMEOUT_MS, remainingMilliseconds),
    );
    timeout.unref();
    try {
      const response = await fetch(`${API_ROOT}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'aqua-automation-publication-admission-v3',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: binary ? 'follow' : 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`GitHub API ${method} ${path} returned HTTP ${String(response.status)}`);
      }
      const declaredLength = response.headers.get('content-length');
      if (
        declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_API_RESPONSE_BYTES)
      ) {
        throw new Error(`GitHub API ${path} declared an oversized response`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      this.totalBytes += bytes.length;
      if (bytes.length > MAX_API_RESPONSE_BYTES || this.totalBytes > MAX_TOTAL_RESPONSE_BYTES) {
        throw new Error('GitHub API response byte budget exhausted');
      }
      if (binary) return bytes;
      try {
        return JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new Error(`GitHub API ${path} returned invalid JSON`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  public async get(path: string): Promise<unknown> {
    return this.request('GET', path, undefined, false);
  }

  public async graphql(query: string, variables: JsonRecord): Promise<unknown> {
    return this.request('POST', '/graphql', { query, variables }, false);
  }

  public async downloadArtifact(artifactId: number): Promise<Buffer> {
    if (!Number.isSafeInteger(artifactId) || artifactId < 1) {
      throw new Error('Artifact ID must be a positive safe integer');
    }
    const value = await this.request(
      'GET',
      `/repos/${AUTOMATION_REPOSITORY}/actions/artifacts/${String(artifactId)}/zip`,
      undefined,
      true,
    );
    if (!Buffer.isBuffer(value)) throw new Error('Artifact download did not return bytes');
    return value;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function contextFromEnvironment(): AutomationPublicationAdmissionContext {
  return {
    repository: requiredEnvironment('GITHUB_REPOSITORY'),
    repositoryId: requiredEnvironment('GITHUB_REPOSITORY_ID'),
    eventName: requiredEnvironment('GITHUB_EVENT_NAME'),
    pullRequestNumber: parsePositiveInteger(
      requiredEnvironment('AUTOMATION_PUBLICATION_PR_NUMBER'),
      'AUTOMATION_PUBLICATION_PR_NUMBER',
    ),
    baseSha: requireSha(
      requiredEnvironment('AUTOMATION_PUBLICATION_BASE_SHA'),
      'AUTOMATION_PUBLICATION_BASE_SHA',
    ),
    headSha: requireSha(
      requiredEnvironment('AUTOMATION_PUBLICATION_HEAD_SHA'),
      'AUTOMATION_PUBLICATION_HEAD_SHA',
    ),
    headRepository: requiredEnvironment('AUTOMATION_PUBLICATION_HEAD_REPOSITORY'),
  };
}

async function main(): Promise<void> {
  const result = await verifyAutomationPublicationAdmission(
    contextFromEnvironment(),
    new BoundedGitHubReader(requiredEnvironment('GITHUB_TOKEN')),
    new ProtectedBaseAuthorityProvider(),
  );
  if (!result.applicable) {
    process.stdout.write('automation publication admission: not applicable\n');
    return;
  }
  process.stdout.write(
    `automation publication admission: ${result.policyKey}/${result.commandId} at ${result.headSha} ok\n`,
  );
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `automation publication admission failed closed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
