import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA,
  AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA_VERSION,
  EXPECTED_AUTOMATION_PUBLICATION_BRANCH_POLICY,
} from './lib/automation-publication-authority';
import {
  activeAuthorityFromManifest,
  type AutomationPublicationAdmissionContext,
  type AutomationPublicationAuthority,
  type AutomationPublicationAuthorityProvider,
  type AutomationPublicationReader,
  verifyAutomationPublicationAdmission,
} from './finding-registry-publication';
import {
  AUTOMATION_REPOSITORY,
  AUTOMATION_REPOSITORY_ID,
  automationPublicationBranch,
  automationPublicationInputArtifact,
  automationPublicationResultArtifact,
  automationPublicationRetryIdentityHash,
  resolveAutomationPublicationPolicy,
  type AutomationPublicationOperation,
  type AutomationPublicationPolicyKey,
  type ResolvedAutomationPublicationPolicy,
} from './lib/automation-publication-policy';
import {
  buildFindingRegistryRequestReceipt,
  FINDING_REGISTRY_REQUEST_RECEIPT_BASENAME,
  serializeFindingRegistryRequestReceipt,
} from './lib/finding-registry-request-receipt';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const REQUEST_DIGEST = '3'.repeat(64);
const APP_SLUG = 'aqua-automation';
const APP_ID = '12345';
const INSTALLATION_ID = 54321;
const PR_NUMBER = 42;
const ORIGIN_RUN_ID = 9001;
const ORIGIN_ATTEMPT = 2;
const ORIGIN_INPUT_ID = 76;
const RECOVERY_RUN_ID = 9010;
const RECOVERY_ATTEMPT = 3;
const RECOVERY_INPUT_ID = 86;
const RESULT_ID = 77;
const EXPIRES_AT = '2099-01-01T00:00:00Z';
const REPOSITORY_PATH = `/repos/${AUTOMATION_REPOSITORY}`;

const ZIP_WRITER = String.raw`
import base64
import io
import json
import sys
import zipfile

request = json.load(sys.stdin)
output = io.BytesIO()
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for item in request:
        info = zipfile.ZipInfo(item["name"])
        info.create_system = 3
        mode = 0o120777 if item.get("symlink", False) else 0o100644
        info.external_attr = mode << 16
        bundle.writestr(info, base64.b64decode(item["content"]))
sys.stdout.buffer.write(output.getvalue())
`;

interface ZipEntry {
  readonly name: string;
  readonly content: Buffer;
  readonly symlink?: boolean;
}

interface ScenarioDefinition {
  readonly key: AutomationPublicationPolicyKey;
  readonly operation: AutomationPublicationOperation;
  readonly commandId: string;
  readonly branch: string;
  readonly path: string;
  readonly headline: string;
  readonly title: string;
  readonly workflowPath: string;
}

interface ScenarioOptions {
  readonly recovery?: boolean;
  readonly graphqlSignatureValid?: boolean;
  readonly graphqlWasSignedByGitHub?: boolean;
  readonly graphqlSignatureState?: string;
  readonly workflowAttemptOverride?: number;
  readonly inputDownloadMismatch?: boolean;
  readonly inputApiDigestMismatch?: boolean;
  readonly inputReceiptCommandId?: string;
  readonly headRepositoryId?: number;
  readonly resultRepositoryId?: string;
  readonly resultChangedPathSha256?: string;
  readonly resultExpired?: boolean;
  readonly resultExtraFile?: boolean;
  readonly resultSymlink?: boolean;
  readonly useLogicalHeadBranch?: boolean;
}

interface BuiltScenario {
  readonly reader: FakeReader;
  readonly authority: FakeAuthorityProvider;
  readonly context: AutomationPublicationAdmissionContext;
  readonly resultSearchPath: string;
  readonly originArtifactsPath: string;
  readonly recoveryInputPath: string | null;
}

const DEFINITIONS: Readonly<Record<AutomationPublicationPolicyKey, ScenarioDefinition>> = {
  'registry-add': {
    key: 'registry-add',
    operation: 'add',
    commandId: 'finding-request:INC-1234',
    branch: 'automation/finding-registry-active',
    path: 'docs/reviews/_registry/findings.jsonl',
    headline: 'chore(findings): canonical add mutation',
    title: 'chore(findings): canonical add mutation',
    workflowPath: '.github/workflows/finding-registry-authority.yml',
  },
  'registry-close': {
    key: 'registry-close',
    operation: 'close',
    commandId: 'finding-close:SEC-001',
    branch: 'automation/finding-registry-active',
    path: 'docs/reviews/_registry/findings.jsonl',
    headline: 'chore(findings): canonical close mutation',
    title: 'chore(findings): canonical close mutation',
    workflowPath: '.github/workflows/finding-registry-authority.yml',
  },
  'registry-sweep': {
    key: 'registry-sweep',
    operation: 'sweep',
    commandId: `finding-sweep:${String(ORIGIN_RUN_ID)}`,
    branch: 'automation/finding-registry-active',
    path: 'docs/reviews/_registry/findings.jsonl',
    headline: 'chore(findings): automated state sweep',
    title: 'chore(findings): daily state sweep - OPEN to STALE, past-deadline to BLOCKED',
    workflowPath: '.github/workflows/finding-state-sweep.yml',
  },
  'aria-daily-report': {
    key: 'aria-daily-report',
    operation: 'report',
    commandId: 'aria-daily-report:2026-07-30',
    branch: 'automation/aria-daily-report-2026-07-30',
    path: 'aria-tools/reports/daily/2026-07-30.md',
    headline: 'chore(aria-reports): daily 2026-07-30',
    title: 'chore(aria-reports): daily 2026-07-30',
    workflowPath: '.github/workflows/aria-daily-report.yml',
  },
  'rule-health-report': {
    key: 'rule-health-report',
    operation: 'report',
    commandId: `rule-health-report:2026-07:${BASE_SHA}`,
    branch: 'automation/rule-health-2026-07',
    path: 'docs/reviews/rule-health/2026-07-30-rule-health-2026-07.md',
    headline: 'chore(report): rule-health 2026-07',
    title: 'chore(report): monthly rule-health report - 2026-07',
    workflowPath: '.github/workflows/rule-health-report.yml',
  },
};

function zip(entries: readonly ZipEntry[]): Buffer {
  const request = entries.map((entry) => ({
    name: entry.name,
    content: entry.content.toString('base64'),
    symlink: entry.symlink ?? false,
  }));
  const result = spawnSync('python3', ['-c', ZIP_WRITER], {
    input: JSON.stringify(request),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.toString('utf8') || 'ZIP fixture creation failed');
  }
  return result.stdout;
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function blobOid(bytes: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from(`blob ${String(bytes.length)}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function repository(id = Number(AUTOMATION_REPOSITORY_ID)): Record<string, unknown> {
  return { id, full_name: AUTOMATION_REPOSITORY };
}

function graphRepository(id = Number(AUTOMATION_REPOSITORY_ID)): Record<string, unknown> {
  return { databaseId: id, nameWithOwner: AUTOMATION_REPOSITORY };
}

function artifact(
  id: number,
  name: string,
  archive: Buffer,
  runId: number,
  overrides: {
    readonly digest?: string;
    readonly expired?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    id,
    name,
    expired: overrides.expired ?? false,
    expires_at: EXPIRES_AT,
    digest: `sha256:${overrides.digest ?? digest(archive)}`,
    workflow_run: {
      id: runId,
      repository_id: Number(AUTOMATION_REPOSITORY_ID),
      head_repository_id: Number(AUTOMATION_REPOSITORY_ID),
      head_branch: 'main',
      head_sha: BASE_SHA,
    },
  };
}

function workflowRun(
  runId: number,
  attempt: number,
  definition: ScenarioDefinition,
): Record<string, unknown> {
  return {
    id: runId,
    run_attempt: attempt,
    head_sha: BASE_SHA,
    head_branch: 'main',
    path: definition.workflowPath,
    event:
      definition.key === 'registry-add' || definition.key === 'registry-close'
        ? 'workflow_dispatch'
        : 'schedule',
    status: 'completed',
    conclusion: 'success',
    repository: repository(),
    head_repository: repository(),
  };
}

function artifactEntries(
  policy: ResolvedAutomationPublicationPolicy,
  blob: Buffer,
  runId: number,
  attempt: number,
  commandId: string,
  inputSha256: string,
): readonly ZipEntry[] {
  return automationPublicationInputArtifact(policy, runId, attempt).exactFiles.map((name) => ({
    name,
    content:
      name === basename(policy.changedPath)
        ? blob
        : name === FINDING_REGISTRY_REQUEST_RECEIPT_BASENAME
          ? Buffer.from(
              serializeFindingRegistryRequestReceipt(
                buildFindingRegistryRequestReceipt({
                  repository: AUTOMATION_REPOSITORY,
                  repository_id: AUTOMATION_REPOSITORY_ID,
                  workflow_ref: policy.workflowRef,
                  workflow_sha: BASE_SHA,
                  workflow_run_id: runId,
                  workflow_run_attempt: attempt,
                  command_id: commandId,
                  operation:
                    policy.key === 'registry-add'
                      ? 'add'
                      : policy.key === 'registry-close'
                        ? 'close'
                        : (() => {
                            throw new Error('request receipt requested for a non-registry policy');
                          })(),
                  input_sha256: inputSha256,
                }),
              ),
              'utf8',
            )
          : Buffer.from('evidence\n'),
  }));
}

function basename(path: string): string {
  const segments = path.split('/');
  const value = segments[segments.length - 1];
  if (!value) throw new Error('fixture path has no basename');
  return value;
}

class FakeReader implements AutomationPublicationReader {
  public readonly requestedPaths: string[] = [];

  public constructor(
    private readonly values: ReadonlyMap<string, unknown>,
    private readonly graphValue: unknown,
    private readonly downloads: ReadonlyMap<number, Buffer>,
  ) {}

  public get(path: string): Promise<unknown> {
    this.requestedPaths.push(path);
    if (!this.values.has(path)) throw new Error(`Unexpected fake GitHub GET ${path}`);
    return Promise.resolve(this.values.get(path));
  }

  public graphql(_query: string, _variables: Record<string, unknown>): Promise<unknown> {
    this.requestedPaths.push('/graphql');
    return Promise.resolve(this.graphValue);
  }

  public downloadArtifact(artifactId: number): Promise<Buffer> {
    this.requestedPaths.push(`/artifact-download/${String(artifactId)}`);
    const value = this.downloads.get(artifactId);
    if (!value) throw new Error(`Unexpected fake artifact download ${String(artifactId)}`);
    return Promise.resolve(value);
  }
}

class FakeAuthorityProvider implements AutomationPublicationAuthorityProvider {
  public loads = 0;

  public constructor(
    private readonly authority: AutomationPublicationAuthority = {
      appId: APP_ID,
      appSlug: APP_SLUG,
      appInstallationId: INSTALLATION_ID,
    },
  ) {}

  public loadAuthorityIfActive(): AutomationPublicationAuthority {
    this.loads += 1;
    return this.authority;
  }
}

function buildScenario(
  key: AutomationPublicationPolicyKey,
  options: ScenarioOptions = {},
): BuiltScenario {
  const definition = DEFINITIONS[key];
  const blob = Buffer.from(`# ${definition.key}\ncanonical evidence\n`, 'utf8');
  const changedPathSha256 = digest(blob);
  const inputSha256 = definition.operation === 'report' ? changedPathSha256 : REQUEST_DIGEST;
  const workflowRef = `${AUTOMATION_REPOSITORY}/${definition.workflowPath}@refs/heads/main`;
  const policy = resolveAutomationPublicationPolicy({
    operation: definition.operation,
    commandId: definition.commandId,
    baseSha: BASE_SHA,
    workflowRef,
    branch: definition.branch,
    changedPath: definition.path,
    commitHeadline: definition.headline,
    pullRequestTitle: definition.title,
  });
  assert.equal(policy.key, key);

  const baseBody = `Canonical publication for ${definition.key}.`;
  const retryIdentity = automationPublicationRetryIdentityHash({
    baseSha: BASE_SHA,
    branch: definition.branch,
    commandId: definition.commandId,
    operation: definition.operation,
    inputSha256,
    changedPath: definition.path,
    changedPathSha256,
    commitHeadline: definition.headline,
    pullRequestTitle: definition.title,
    basePullRequestBodySha256: digest(baseBody),
    workflowRef,
    workflowSha: BASE_SHA,
  });
  const pullRequestBody = `${baseBody}\n\n<!-- aqua-automation-retry-identity:${retryIdentity} -->\n`;
  const publicationBranch = automationPublicationBranch(policy, definition.commandId);
  const liveHeadBranch =
    options.useLogicalHeadBranch === true ? definition.branch : publicationBranch;
  const originInputContract = automationPublicationInputArtifact(
    policy,
    ORIGIN_RUN_ID,
    ORIGIN_ATTEMPT,
  );
  const originInputArchive = zip(
    artifactEntries(
      policy,
      blob,
      ORIGIN_RUN_ID,
      ORIGIN_ATTEMPT,
      options.inputReceiptCommandId ?? definition.commandId,
      inputSha256,
    ),
  );
  const originInputDigest = digest(originInputArchive);
  const commitMessage = [
    definition.headline,
    '',
    `Automation-Command-ID: ${definition.commandId}`,
    `Automation-Operation: ${definition.operation}`,
    `Automation-Input-SHA256: ${inputSha256}`,
    `Automation-Base-SHA: ${BASE_SHA}`,
    `Automation-Retry-Identity: ${retryIdentity}`,
    `Automation-Changed-Path: ${definition.path}`,
    `Automation-Changed-Path-SHA256: ${changedPathSha256}`,
    `Automation-Workflow-Ref: ${workflowRef}`,
    `Automation-Workflow-SHA: ${BASE_SHA}`,
    `Automation-Workflow-Run-ID: ${String(ORIGIN_RUN_ID)}`,
    `Automation-Workflow-Run-Attempt: ${String(ORIGIN_ATTEMPT)}`,
    `Automation-Evidence-Artifact-ID: ${String(ORIGIN_INPUT_ID)}`,
    `Automation-Evidence-Artifact: ${originInputContract.name}`,
    `Automation-Evidence-SHA256: ${originInputDigest}`,
  ].join('\n');

  const recovery = options.recovery ?? false;
  const resultRunId = recovery ? RECOVERY_RUN_ID : ORIGIN_RUN_ID;
  const resultAttempt = recovery ? RECOVERY_ATTEMPT : ORIGIN_ATTEMPT;
  const resultInputId = recovery ? RECOVERY_INPUT_ID : ORIGIN_INPUT_ID;
  const resultInputContract = automationPublicationInputArtifact(
    policy,
    resultRunId,
    resultAttempt,
  );
  const resultInputArchive = recovery
    ? zip(
        artifactEntries(
          policy,
          blob,
          resultRunId,
          resultAttempt,
          options.inputReceiptCommandId ?? definition.commandId,
          inputSha256,
        ),
      )
    : originInputArchive;
  const resultInputDigest = digest(resultInputArchive);
  const resultValue: Record<string, unknown> = {
    $schema: 'aqua/automation-publication-result/v3',
    status: recovery ? 'RECOVERED' : 'PUBLISHED',
    repository: AUTOMATION_REPOSITORY,
    repository_id: options.resultRepositoryId ?? AUTOMATION_REPOSITORY_ID,
    base_sha: BASE_SHA,
    branch: publicationBranch,
    command_id: definition.commandId,
    operation: definition.operation,
    input_sha256: inputSha256,
    retry_identity: retryIdentity,
    changed_path: definition.path,
    changed_path_sha256: options.resultChangedPathSha256 ?? changedPathSha256,
    commit_sha: HEAD_SHA,
    observed_branch_sha: HEAD_SHA,
    pr_number: PR_NUMBER,
    pr_url: `https://github.com/${AUTOMATION_REPOSITORY}/pull/${String(PR_NUMBER)}`,
    workflow: {
      ref: workflowRef,
      sha: BASE_SHA,
      run_id: resultRunId,
      run_attempt: resultAttempt,
    },
    github_app: {
      slug: APP_SLUG,
      installation_id: INSTALLATION_ID,
    },
    mutation_evidence: {
      artifact_id: resultInputId,
      artifact_name: resultInputContract.name,
      artifact_sha256: resultInputDigest,
    },
    error: null,
  };
  const resultContract = automationPublicationResultArtifact(policy);
  const resultEntries: ZipEntry[] = resultContract.exactFiles.map((name) => ({
    name,
    content:
      name === resultContract.resultJsonBasename
        ? Buffer.from(`${JSON.stringify(resultValue)}\n`, 'utf8')
        : Buffer.from('{}\n', 'utf8'),
    symlink: options.resultSymlink === true && name === resultContract.resultJsonBasename,
  }));
  if (options.resultExtraFile) {
    resultEntries.push({ name: 'forged-extra.txt', content: Buffer.from('forged\n') });
  }
  const resultArchive = zip(resultEntries);
  const resultArtifactName = `automation-publication-result-${HEAD_SHA}`;
  const resultArtifact = artifact(RESULT_ID, resultArtifactName, resultArchive, resultRunId, {
    expired: options.resultExpired,
  });
  const originArtifact = artifact(
    ORIGIN_INPUT_ID,
    originInputContract.name,
    originInputArchive,
    ORIGIN_RUN_ID,
    {
      digest: options.inputApiDigestMismatch ? '9'.repeat(64) : originInputDigest,
    },
  );
  const changedBlobOid = blobOid(blob);
  const headRepositoryId = options.headRepositoryId ?? Number(AUTOMATION_REPOSITORY_ID);
  const pullRequest = {
    number: PR_NUMBER,
    state: 'open',
    draft: false,
    title: definition.title,
    body: pullRequestBody,
    html_url: `https://github.com/${AUTOMATION_REPOSITORY}/pull/${String(PR_NUMBER)}`,
    commits: 1,
    changed_files: 1,
    user: { login: `${APP_SLUG}[bot]`, type: 'Bot' },
    base: { ref: 'main', sha: BASE_SHA, repo: repository() },
    head: {
      ref: liveHeadBranch,
      sha: HEAD_SHA,
      repo: repository(headRepositoryId),
    },
  };
  const changedFile = {
    filename: definition.path,
    status: 'modified',
    sha: changedBlobOid,
  };
  const graphValue = {
    data: {
      repository: {
        ...graphRepository(),
        pullRequest: {
          number: PR_NUMBER,
          state: 'OPEN',
          isDraft: false,
          title: definition.title,
          body: pullRequestBody,
          url: `https://github.com/${AUTOMATION_REPOSITORY}/pull/${String(PR_NUMBER)}`,
          author: { login: `${APP_SLUG}[bot]` },
          baseRefName: 'main',
          baseRefOid: BASE_SHA,
          baseRepository: graphRepository(),
          headRefName: liveHeadBranch,
          headRefOid: HEAD_SHA,
          headRepository: graphRepository(headRepositoryId),
          commits: {
            totalCount: 1,
            nodes: [{ commit: { oid: HEAD_SHA } }],
          },
        },
        object: {
          oid: HEAD_SHA,
          message: commitMessage,
          parents: { totalCount: 1, nodes: [{ oid: BASE_SHA }] },
          author: { user: { login: `${APP_SLUG}[bot]` } },
          signature: {
            isValid: options.graphqlSignatureValid ?? true,
            wasSignedByGitHub: options.graphqlWasSignedByGitHub ?? true,
            state: options.graphqlSignatureState ?? 'VALID',
          },
          tree: {
            entry: {
              object: {
                oid: changedBlobOid,
                byteSize: blob.length,
                isBinary: false,
              },
            },
          },
        },
      },
    },
  };

  const values = new Map<string, unknown>();
  values.set(`${REPOSITORY_PATH}/pulls/${String(PR_NUMBER)}`, pullRequest);
  values.set(`${REPOSITORY_PATH}/pulls/${String(PR_NUMBER)}/files?per_page=100&page=1`, [
    changedFile,
  ]);
  values.set(`${REPOSITORY_PATH}/pulls/${String(PR_NUMBER)}/commits?per_page=2`, [
    { sha: HEAD_SHA },
  ]);
  values.set(`${REPOSITORY_PATH}/git/commits/${HEAD_SHA}`, {
    message: commitMessage,
    parents: [{ sha: BASE_SHA }],
    verification: { verified: true, reason: 'valid' },
  });
  values.set(`${REPOSITORY_PATH}/commits/${HEAD_SHA}`, {
    sha: HEAD_SHA,
    author: { login: `${APP_SLUG}[bot]` },
    commit: { message: commitMessage },
    files: [changedFile],
  });
  values.set(`${REPOSITORY_PATH}/git/blobs/${changedBlobOid}`, {
    encoding: 'base64',
    content: blob.toString('base64'),
    size: blob.length,
  });
  values.set(`/apps/${APP_SLUG}`, { id: Number(APP_ID), slug: APP_SLUG });
  values.set(
    `${REPOSITORY_PATH}/actions/runs/${String(ORIGIN_RUN_ID)}/attempts/${String(ORIGIN_ATTEMPT)}`,
    workflowRun(ORIGIN_RUN_ID, options.workflowAttemptOverride ?? ORIGIN_ATTEMPT, definition),
  );
  const originArtifactsPath = `${REPOSITORY_PATH}/actions/runs/${String(
    ORIGIN_RUN_ID,
  )}/artifacts?per_page=100`;
  values.set(originArtifactsPath, {
    total_count: recovery ? 1 : 2,
    artifacts: recovery ? [originArtifact] : [originArtifact, resultArtifact],
  });
  const recoveryInputPath = recovery
    ? `${REPOSITORY_PATH}/actions/runs/${String(RECOVERY_RUN_ID)}/artifacts?per_page=100`
    : null;
  if (recoveryInputPath !== null) {
    values.set(
      `${REPOSITORY_PATH}/actions/runs/${String(
        RECOVERY_RUN_ID,
      )}/attempts/${String(RECOVERY_ATTEMPT)}`,
      workflowRun(RECOVERY_RUN_ID, RECOVERY_ATTEMPT, definition),
    );
    values.set(recoveryInputPath, {
      total_count: 2,
      artifacts: [
        artifact(RECOVERY_INPUT_ID, resultInputContract.name, resultInputArchive, RECOVERY_RUN_ID),
        resultArtifact,
      ],
    });
  }
  const resultSearchPath = `${REPOSITORY_PATH}/actions/artifacts?per_page=100&name=${encodeURIComponent(
    resultArtifactName,
  )}`;
  values.set(resultSearchPath, {
    total_count: 1,
    artifacts: [resultArtifact],
  });
  const downloads = new Map<number, Buffer>();
  downloads.set(
    ORIGIN_INPUT_ID,
    options.inputDownloadMismatch ? Buffer.from('forged archive') : originInputArchive,
  );
  downloads.set(RESULT_ID, resultArchive);
  if (recovery) downloads.set(RECOVERY_INPUT_ID, resultInputArchive);

  return {
    reader: new FakeReader(values, graphValue, downloads),
    authority: new FakeAuthorityProvider(),
    context: {
      repository: AUTOMATION_REPOSITORY,
      repositoryId: AUTOMATION_REPOSITORY_ID,
      eventName: 'pull_request_target',
      pullRequestNumber: PR_NUMBER,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      headRepository: AUTOMATION_REPOSITORY,
    },
    resultSearchPath,
    originArtifactsPath,
    recoveryInputPath,
  };
}

async function verify(scenario: BuiltScenario): Promise<void> {
  const result = await verifyAutomationPublicationAdmission(
    scenario.context,
    scenario.reader,
    scenario.authority,
    {
      pollAttempts: 1,
      retryMilliseconds: 0,
      now: () => Date.parse('2026-07-30T00:00:00Z'),
      delay: (): Promise<void> => Promise.resolve(),
    },
  );
  assert.equal(result.applicable, true);
}

function unmanagedScenario(actor: {
  readonly login: string;
  readonly type: string;
}): BuiltScenario {
  const path = 'apps/auth-service/src/example.ts';
  const bytes = Buffer.from('source\n');
  const pullRequest = {
    number: PR_NUMBER,
    state: 'open',
    draft: false,
    title: 'feat(auth): human change',
    body: 'Human-authored pull request.',
    html_url: `https://github.com/${AUTOMATION_REPOSITORY}/pull/${String(PR_NUMBER)}`,
    commits: 4,
    changed_files: 1,
    user: actor,
    base: { ref: 'main', sha: BASE_SHA, repo: repository() },
    head: { ref: 'feature/auth', sha: HEAD_SHA, repo: repository() },
  };
  const values = new Map<string, unknown>([
    [`${REPOSITORY_PATH}/pulls/${String(PR_NUMBER)}`, pullRequest],
    [
      `${REPOSITORY_PATH}/pulls/${String(PR_NUMBER)}/files?per_page=100&page=1`,
      [{ filename: path, status: 'modified', sha: blobOid(bytes) }],
    ],
  ]);
  return {
    reader: new FakeReader(values, {}, new Map()),
    authority: new FakeAuthorityProvider(),
    context: {
      repository: AUTOMATION_REPOSITORY,
      repositoryId: AUTOMATION_REPOSITORY_ID,
      eventName: 'pull_request_target',
      pullRequestNumber: PR_NUMBER,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      headRepository: AUTOMATION_REPOSITORY,
    },
    resultSearchPath: '',
    originArtifactsPath: '',
    recoveryInputPath: null,
  };
}

void describe('automation publication merge-side admission', () => {
  void it('loads App authority only from an ACTIVE protected-base manifest and ignores unrelated extensions', () => {
    const manifest = {
      $schema: AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA,
      schema_version: AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA_VERSION,
      authority_id: 'aqua.github.automation-publication',
      state: 'ACTIVE',
      repository: {
        full_name: AUTOMATION_REPOSITORY,
        repository_id: Number(AUTOMATION_REPOSITORY_ID),
      },
      environment: {
        deployment_branch_policy: EXPECTED_AUTOMATION_PUBLICATION_BRANCH_POLICY,
      },
      requested_token_contract: { permissions: { contents: 'write' } },
      authorized_publishers: [
        {
          workflow_path: '.github/workflows/finding-registry-authority.yml',
          app_token_step_id: 'app-token',
          publisher_step_id: 'publication',
        },
      ],
      activation_evidence: {
        github_app_id: APP_ID,
        github_app_slug: APP_SLUG,
        github_app_installation_id: String(INSTALLATION_ID),
      },
    };
    assert.deepEqual(activeAuthorityFromManifest(manifest), {
      appId: APP_ID,
      appSlug: APP_SLUG,
      appInstallationId: INSTALLATION_ID,
    });
    assert.equal(activeAuthorityFromManifest({ ...manifest, state: 'BOOTSTRAP_PENDING' }), null);
    assert.throws(
      () =>
        activeAuthorityFromManifest({
          ...manifest,
          environment: {
            deployment_branch_policy: {
              mode: 'CUSTOM_BRANCH_POLICIES',
              rules: [{ name: 'unprotected-branch', type: 'branch' }],
            },
          },
        }),
      /exact protected main branch/,
    );
  });

  for (const key of Object.keys(DEFINITIONS) as AutomationPublicationPolicyKey[]) {
    void it(`accepts exact ${key} policy, commit, run, artifact, and v3 result evidence`, async () => {
      const scenario = buildScenario(key);
      await verify(scenario);
      assert.ok(scenario.reader.requestedPaths.includes(scenario.resultSearchPath));
    });
  }

  void it('uses the documented run-level artifact API while retaining exact-attempt proof', async () => {
    const scenario = buildScenario('registry-add');
    await verify(scenario);
    assert.ok(scenario.reader.requestedPaths.includes(scenario.originArtifactsPath));
    assert.ok(
      scenario.reader.requestedPaths.includes(
        `${REPOSITORY_PATH}/actions/runs/${String(ORIGIN_RUN_ID)}/attempts/${String(
          ORIGIN_ATTEMPT,
        )}`,
      ),
    );
    assert.equal(
      scenario.reader.requestedPaths.some((path) =>
        /\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*\/artifacts(?:\?|$)/.test(path),
      ),
      false,
    );
  });

  void it('returns NOOP for a normal human unmanaged PR before loading App authority', async () => {
    const scenario = unmanagedScenario({ login: 'human-reviewer', type: 'User' });
    const result = await verifyAutomationPublicationAdmission(
      scenario.context,
      scenario.reader,
      scenario.authority,
    );
    assert.deepEqual(result, { applicable: false });
    assert.equal(scenario.authority.loads, 0);
    assert.equal(scenario.reader.requestedPaths.includes('/graphql'), false);
  });

  void it('fails a managed path closed while protected-base authority is BOOTSTRAP_PENDING', async () => {
    const scenario = buildScenario('registry-add');
    const pendingAuthority: AutomationPublicationAuthorityProvider = {
      loadAuthorityIfActive: (): null => null,
    };
    await assert.rejects(
      () =>
        verifyAutomationPublicationAdmission(scenario.context, scenario.reader, pendingAuthority),
      /authority is not ACTIVE/,
    );
    assert.equal(scenario.reader.requestedPaths.includes('/graphql'), false);
  });

  void it('fails closed when the configured App attempts an unmanaged publication', async () => {
    const scenario = unmanagedScenario({
      login: `${APP_SLUG}[bot]`,
      type: 'Bot',
    });
    await assert.rejects(
      () =>
        verifyAutomationPublicationAdmission(scenario.context, scenario.reader, scenario.authority),
      /may not publish unmanaged paths/,
    );
    assert.equal(scenario.authority.loads, 1);
  });

  void it('rejects every GraphQL signature-authority downgrade', async () => {
    for (const options of [
      { graphqlSignatureValid: false },
      { graphqlWasSignedByGitHub: false },
      { graphqlSignatureState: 'UNKNOWN' },
    ]) {
      const scenario = buildScenario('registry-add', options);
      await assert.rejects(() => verify(scenario), /GraphQL commit, signature/);
    }
  });

  void it('rejects an origin workflow attempt mismatch', async () => {
    const scenario = buildScenario('registry-sweep', {
      workflowAttemptOverride: ORIGIN_ATTEMPT + 1,
    });
    await assert.rejects(() => verify(scenario), /No valid unexpired publication result/);
  });

  void it('rejects API-digest and downloaded-content mismatches for commit-bound input', async () => {
    await assert.rejects(
      () =>
        verify(
          buildScenario('registry-close', {
            inputApiDigestMismatch: true,
          }),
        ),
      /No valid unexpired publication result/,
    );
    await assert.rejects(
      () =>
        verify(
          buildScenario('registry-close', {
            inputDownloadMismatch: true,
          }),
        ),
      /No valid unexpired publication result/,
    );
    await assert.rejects(
      () =>
        verify(
          buildScenario('registry-close', {
            inputReceiptCommandId: 'finding-close:SEC-999',
          }),
        ),
      /No valid unexpired publication result/,
    );
  });

  void it('accepts a recovery result only after validating its exact run attempt and input artifact', async () => {
    const scenario = buildScenario('aria-daily-report', { recovery: true });
    await verify(scenario);
    assert.ok(scenario.recoveryInputPath);
    assert.ok(scenario.reader.requestedPaths.includes(scenario.recoveryInputPath));
    assert.ok(
      scenario.reader.requestedPaths.includes(
        `${REPOSITORY_PATH}/actions/runs/${String(
          RECOVERY_RUN_ID,
        )}/attempts/${String(RECOVERY_ATTEMPT)}`,
      ),
    );
  });

  void it('rejects a head repository ID mismatch even when the repository name matches', async () => {
    const scenario = buildScenario('registry-add', { headRepositoryId: 999 });
    await assert.rejects(() => verify(scenario), /exact configured repository name and ID/);
  });

  void it('rejects the legacy shared logical branch instead of the immutable command branch', async () => {
    const scenario = buildScenario('registry-add', {
      useLogicalHeadBranch: true,
    });
    await assert.rejects(() => verify(scenario), /command-identity immutable branch/);
  });

  void it('rejects a v3 result whose repository or changed-content evidence differs', async () => {
    await assert.rejects(
      () =>
        verify(
          buildScenario('rule-health-report', {
            resultRepositoryId: '999',
          }),
        ),
      /No valid unexpired publication result/,
    );
    await assert.rejects(
      () =>
        verify(
          buildScenario('rule-health-report', {
            resultChangedPathSha256: '9'.repeat(64),
          }),
        ),
      /No valid unexpired publication result/,
    );
  });

  void it('rejects expired, extra-file, and symlink result archives', async () => {
    for (const options of [
      { resultExpired: true },
      { resultExtraFile: true },
      { resultSymlink: true },
    ]) {
      const scenario = buildScenario('registry-add', options);
      await assert.rejects(() => verify(scenario), /No valid unexpired publication result/);
    }
  });
});
