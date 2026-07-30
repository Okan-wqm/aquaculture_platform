import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export const AUTOMATION_REPOSITORY_IDENTITY = {
  owner: 'Okan-wqm',
  ownerId: '77401788',
  name: 'aquaculture_platform',
  fullName: 'Okan-wqm/aquaculture_platform',
  repositoryId: '1132698735',
  baseBranch: 'main',
  baseRef: 'refs/heads/main',
} as const;
export const AUTOMATION_REPOSITORY = AUTOMATION_REPOSITORY_IDENTITY.fullName;
export const AUTOMATION_REPOSITORY_ID = AUTOMATION_REPOSITORY_IDENTITY.repositoryId;
export const AUTOMATION_REPOSITORY_OWNER = AUTOMATION_REPOSITORY_IDENTITY.owner;
export const AUTOMATION_REPOSITORY_OWNER_ID = AUTOMATION_REPOSITORY_IDENTITY.ownerId;
export const AUTOMATION_BASE_BRANCH = AUTOMATION_REPOSITORY_IDENTITY.baseBranch;
export const AUTOMATION_BASE_REF = AUTOMATION_REPOSITORY_IDENTITY.baseRef;
export const AUTOMATION_PUBLICATION_RETRY_IDENTITY_SCHEMA =
  'aqua/automation-publication-retry-identity/v1' as const;
export const AUTOMATION_PUBLICATION_COMMAND_IDENTITY_SCHEMA =
  'aqua/automation-publication-command-identity/v1' as const;
export const AUTOMATION_PUBLICATION_BRANCH_STRATEGY = 'command-identity-immutable-v1' as const;
export const AUTOMATION_PUBLICATION_PHYSICAL_BRANCH_TEMPLATE =
  '{logical_branch}--{command_identity_sha256}' as const;
export const AUTOMATION_PUBLICATION_BRANCH_LIFECYCLE =
  'CREATE_ONLY_IMMUTABLE_NO_DELETE_V1' as const;
export const AUTOMATION_PUBLICATION_COMPARE_AND_SWAP =
  'GRAPHQL_CREATE_COMMIT_EXPECTED_HEAD_OID_V1' as const;
export const AUTOMATION_PUBLICATION_IDEMPOTENCY =
  'AUTOMATION_PUBLICATION_COMMAND_IDENTITY_V1' as const;
export const AUTOMATION_REGISTRY_LOGICAL_BRANCH = 'automation/finding-registry-active' as const;
export const AUTOMATION_REGISTRY_WRITER_WORKFLOW_PATHS = [
  '.github/workflows/finding-registry-authority.yml',
  '.github/workflows/finding-state-sweep.yml',
] as const;
export const AUTOMATION_REGISTRY_WRITER_WORKFLOW_REFS = [
  `${AUTOMATION_REPOSITORY}/${AUTOMATION_REGISTRY_WRITER_WORKFLOW_PATHS[0]}@${AUTOMATION_BASE_REF}`,
  `${AUTOMATION_REPOSITORY}/${AUTOMATION_REGISTRY_WRITER_WORKFLOW_PATHS[1]}@${AUTOMATION_BASE_REF}`,
] as const;

export const AUTOMATION_PUBLICATION_COMMIT_TRAILERS = {
  commandId: 'Automation-Command-ID',
  operation: 'Automation-Operation',
  inputSha256: 'Automation-Input-SHA256',
  baseSha: 'Automation-Base-SHA',
  retryIdentity: 'Automation-Retry-Identity',
  changedPath: 'Automation-Changed-Path',
  changedPathSha256: 'Automation-Changed-Path-SHA256',
  workflowRef: 'Automation-Workflow-Ref',
  workflowSha: 'Automation-Workflow-SHA',
  workflowRunId: 'Automation-Workflow-Run-ID',
  workflowRunAttempt: 'Automation-Workflow-Run-Attempt',
  evidenceArtifactId: 'Automation-Evidence-Artifact-ID',
  evidenceArtifact: 'Automation-Evidence-Artifact',
  evidenceSha256: 'Automation-Evidence-SHA256',
} as const;

export const AUTOMATION_PUBLICATION_COMMIT_TRAILER_ORDER = [
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.commandId,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.operation,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.inputSha256,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.baseSha,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.retryIdentity,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.changedPath,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.changedPathSha256,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRef,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowSha,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunId,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.workflowRunAttempt,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifactId,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceArtifact,
  AUTOMATION_PUBLICATION_COMMIT_TRAILERS.evidenceSha256,
] as const;

export type AutomationPublicationOperation = 'add' | 'close' | 'sweep' | 'report';
export type AutomationPublicationPolicyKey =
  | 'registry-add'
  | 'registry-close'
  | 'registry-sweep'
  | 'aria-daily-report'
  | 'rule-health-report';

export interface AutomationPublicationPolicyInput {
  readonly operation: AutomationPublicationOperation;
  readonly commandId: string;
  readonly baseSha: string;
  readonly workflowRef: string;
  readonly branch: string;
  readonly changedPath: string;
  readonly commitHeadline: string;
  readonly pullRequestTitle: string;
}

export type AutomationPublicationPolicySelectionInput = Omit<
  AutomationPublicationPolicyInput,
  'branch'
>;

export interface ResolvedAutomationPublicationPolicy {
  readonly key: AutomationPublicationPolicyKey;
  readonly operation: AutomationPublicationOperation;
  readonly workflowRef: string;
  readonly workflowPath: string;
  readonly workflowEvents: readonly string[];
  readonly branch: string;
  readonly changedPath: string;
  readonly commitHeadline: string;
  readonly pullRequestTitle: string;
  readonly inputDigestKind: 'request' | 'content';
  readonly evidenceArtifactPrefix: string | null;
  readonly branchStrategy: typeof AUTOMATION_PUBLICATION_BRANCH_STRATEGY;
}

export interface AutomationPublicationRetryIdentityFields {
  readonly baseSha: string;
  readonly branch: string;
  readonly commandId: string;
  readonly operation: AutomationPublicationOperation;
  readonly inputSha256: string;
  readonly changedPath: string;
  readonly changedPathSha256: string;
  readonly commitHeadline: string;
  readonly pullRequestTitle: string;
  readonly basePullRequestBodySha256: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
}

export interface AutomationPublicationRetryIdentityPayload {
  readonly schema: typeof AUTOMATION_PUBLICATION_RETRY_IDENTITY_SCHEMA;
  readonly repository: typeof AUTOMATION_REPOSITORY;
  readonly repository_id: typeof AUTOMATION_REPOSITORY_ID;
  readonly base_sha: string;
  readonly branch: string;
  readonly command_id: string;
  readonly operation: AutomationPublicationOperation;
  readonly input_sha256: string;
  readonly changed_path: string;
  readonly changed_path_sha256: string;
  readonly commit_headline: string;
  readonly pull_request_title: string;
  readonly base_pull_request_body_sha256: string;
  readonly workflow_ref: string;
  readonly workflow_sha: string;
}

export interface AutomationPublicationCommandIdentityPayload {
  readonly schema: typeof AUTOMATION_PUBLICATION_COMMAND_IDENTITY_SCHEMA;
  readonly repository: typeof AUTOMATION_REPOSITORY;
  readonly repository_id: typeof AUTOMATION_REPOSITORY_ID;
  readonly logical_branch: string;
  readonly command_id: string;
}

export interface AutomationPublicationInputArtifactContract {
  readonly name: string;
  readonly exactFiles: readonly string[];
}

export interface AutomationPublicationResultArtifactContract {
  readonly resultJsonBasename: string;
  readonly exactFiles: readonly string[];
}

interface PolicyDefinition {
  readonly key: AutomationPublicationPolicyKey;
  readonly operation: AutomationPublicationOperation;
  readonly workflowPath: string;
  readonly workflowEvents: readonly string[];
  readonly commandPattern: RegExp;
  readonly resolve: (
    match: RegExpExecArray,
  ) => Omit<
    ResolvedAutomationPublicationPolicy,
    'key' | 'operation' | 'workflowRef' | 'workflowPath' | 'workflowEvents'
  >;
}

const REGISTRY_PATH = 'docs/reviews/_registry/findings.jsonl';
const REGISTRY_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,199}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]{0,19}$/;
const DAILY_REPORT_PATH_PATTERN = /^aria-tools\/reports\/daily\/([0-9]{4}-[0-9]{2}-[0-9]{2})\.md$/;
const RULE_HEALTH_REPORT_PATH_PATTERN =
  /^docs\/reviews\/rule-health\/([0-9]{4}-[0-9]{2}-[0-9]{2})-rule-health-([0-9]{4}-(?:0[1-9]|1[0-2]))\.md$/;

const RESULT_JSON_BASENAME_BY_POLICY: Readonly<Record<AutomationPublicationPolicyKey, string>> = {
  'registry-add': 'finding-registry-publication.json',
  'registry-close': 'finding-registry-publication.json',
  'registry-sweep': 'finding-state-sweep-publication.json',
  'aria-daily-report': 'aria-daily-report-publication.json',
  'rule-health-report': 'rule-health-report-publication.json',
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertDigest(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) throw new Error(`${field} is not canonical`);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || !POSITIVE_INTEGER_PATTERN.test(String(value))) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function workflowRef(workflowPath: string): string {
  return `${AUTOMATION_REPOSITORY}/${workflowPath}@${AUTOMATION_BASE_REF}`;
}

function assertCalendarDate(value: string, field: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a real UTC calendar date`);
  }
}

function registryPolicy(
  operation: 'add' | 'close',
): Omit<
  ResolvedAutomationPublicationPolicy,
  'key' | 'operation' | 'workflowRef' | 'workflowPath' | 'workflowEvents'
> {
  const headline = `chore(findings): canonical ${operation} mutation`;
  return {
    branch: AUTOMATION_REGISTRY_LOGICAL_BRANCH,
    changedPath: REGISTRY_PATH,
    commitHeadline: headline,
    pullRequestTitle: headline,
    inputDigestKind: 'request',
    evidenceArtifactPrefix: 'finding-registry-authority',
    branchStrategy: AUTOMATION_PUBLICATION_BRANCH_STRATEGY,
  };
}

export const AUTOMATION_PUBLICATION_POLICY_TABLE: readonly PolicyDefinition[] = [
  {
    key: 'registry-add',
    operation: 'add',
    workflowPath: AUTOMATION_REGISTRY_WRITER_WORKFLOW_PATHS[0],
    workflowEvents: ['workflow_dispatch'],
    commandPattern: REGISTRY_COMMAND_PATTERN,
    resolve: () => registryPolicy('add'),
  },
  {
    key: 'registry-close',
    operation: 'close',
    workflowPath: AUTOMATION_REGISTRY_WRITER_WORKFLOW_PATHS[0],
    workflowEvents: ['workflow_dispatch'],
    commandPattern: REGISTRY_COMMAND_PATTERN,
    resolve: () => registryPolicy('close'),
  },
  {
    key: 'registry-sweep',
    operation: 'sweep',
    workflowPath: AUTOMATION_REGISTRY_WRITER_WORKFLOW_PATHS[1],
    workflowEvents: ['schedule', 'workflow_dispatch'],
    commandPattern: /^finding-sweep:([1-9][0-9]{0,19})$/,
    resolve: () => ({
      branch: AUTOMATION_REGISTRY_LOGICAL_BRANCH,
      changedPath: REGISTRY_PATH,
      commitHeadline: 'chore(findings): automated state sweep',
      pullRequestTitle:
        'chore(findings): daily state sweep - OPEN to STALE, past-deadline to BLOCKED',
      inputDigestKind: 'request',
      evidenceArtifactPrefix: 'finding-state-sweep',
      branchStrategy: AUTOMATION_PUBLICATION_BRANCH_STRATEGY,
    }),
  },
  {
    key: 'aria-daily-report',
    operation: 'report',
    workflowPath: '.github/workflows/aria-daily-report.yml',
    workflowEvents: ['schedule', 'workflow_dispatch'],
    commandPattern: /^aria-daily-report:([0-9]{4}-[0-9]{2}-[0-9]{2})$/,
    resolve: (match) => {
      const date = match[1];
      if (!date) throw new Error('Daily report command is missing its date');
      assertCalendarDate(date, 'Daily report command date');
      return {
        branch: `automation/aria-daily-report-${date}`,
        changedPath: `aria-tools/reports/daily/${date}.md`,
        commitHeadline: `chore(aria-reports): daily ${date}`,
        pullRequestTitle: `chore(aria-reports): daily ${date}`,
        inputDigestKind: 'content',
        evidenceArtifactPrefix: 'aria-daily-report',
        branchStrategy: AUTOMATION_PUBLICATION_BRANCH_STRATEGY,
      };
    },
  },
  {
    key: 'rule-health-report',
    operation: 'report',
    workflowPath: '.github/workflows/rule-health-report.yml',
    workflowEvents: ['schedule', 'workflow_dispatch'],
    commandPattern: /^rule-health-report:([0-9]{4}-[0-9]{2}):([0-9a-f]{40})$/,
    resolve: (match) => {
      const month = match[1];
      if (!month || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month)) {
        throw new Error('Rule-health command month must be a real YYYY-MM month');
      }
      return {
        branch: `automation/rule-health-${month}`,
        changedPath: '',
        commitHeadline: `chore(report): rule-health ${month}`,
        pullRequestTitle: `chore(report): monthly rule-health report - ${month}`,
        inputDigestKind: 'content',
        evidenceArtifactPrefix: 'rule-health-report',
        branchStrategy: AUTOMATION_PUBLICATION_BRANCH_STRATEGY,
      };
    },
  },
];

function resolveRuleHealthPath(month: string, changedPath: string): string {
  const match = RULE_HEALTH_REPORT_PATH_PATTERN.exec(changedPath);
  if (!match?.[1] || match[2] !== month) {
    throw new Error('Rule-health changed path is not bound to its command month');
  }
  assertCalendarDate(match[1], 'Rule-health report path date');
  return changedPath;
}

export function selectAutomationPublicationPolicy(
  input: AutomationPublicationPolicySelectionInput,
): ResolvedAutomationPublicationPolicy {
  const matches = AUTOMATION_PUBLICATION_POLICY_TABLE.flatMap((definition) => {
    if (definition.operation !== input.operation) return [];
    const match = definition.commandPattern.exec(input.commandId);
    return match ? [{ definition, match }] : [];
  });
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      'Automation operation and command do not select exactly one publication policy',
    );
  }

  const { definition, match } = matches[0];
  if (definition.key === 'rule-health-report' && match[2] !== input.baseSha) {
    throw new Error('Rule-health command base must equal the exact protected-main base');
  }
  const resolved = definition.resolve(match);
  const expectedWorkflowRef = workflowRef(definition.workflowPath);
  const changedPath =
    definition.key === 'rule-health-report'
      ? resolveRuleHealthPath(match[1] ?? '', input.changedPath)
      : resolved.changedPath;
  const expected: ResolvedAutomationPublicationPolicy = {
    ...resolved,
    key: definition.key,
    operation: definition.operation,
    workflowRef: expectedWorkflowRef,
    workflowPath: definition.workflowPath,
    workflowEvents: definition.workflowEvents,
    changedPath,
  };

  const mismatches: string[] = [];
  if (input.workflowRef !== expected.workflowRef) mismatches.push('workflow ref');
  if (input.changedPath !== expected.changedPath) mismatches.push('changed path');
  if (input.commitHeadline !== expected.commitHeadline) mismatches.push('commit headline');
  if (input.pullRequestTitle !== expected.pullRequestTitle) mismatches.push('pull request title');
  if (mismatches.length > 0) {
    throw new Error(`Automation publication differs from policy: ${mismatches.join(', ')}`);
  }
  return expected;
}

export function resolveAutomationPublicationPolicy(
  input: AutomationPublicationPolicyInput,
): ResolvedAutomationPublicationPolicy {
  const expected = selectAutomationPublicationPolicy(input);
  if (input.branch !== expected.branch) {
    throw new Error('Automation publication differs from policy: branch');
  }
  return expected;
}

export function isManagedAutomationPublicationPath(path: string): boolean {
  if (path === REGISTRY_PATH) return true;
  const daily = DAILY_REPORT_PATH_PATTERN.exec(path);
  if (daily?.[1]) {
    try {
      assertCalendarDate(daily[1], 'Daily report path date');
      return true;
    } catch {
      return false;
    }
  }
  const ruleHealth = RULE_HEALTH_REPORT_PATH_PATTERN.exec(path);
  if (ruleHealth?.[1]) {
    try {
      assertCalendarDate(ruleHealth[1], 'Rule-health report path date');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function automationPublicationRetryIdentityPayload(
  fields: AutomationPublicationRetryIdentityFields,
): AutomationPublicationRetryIdentityPayload {
  assertDigest(fields.baseSha, SHA_PATTERN, 'Retry-identity base SHA');
  assertDigest(fields.workflowSha, SHA_PATTERN, 'Retry-identity workflow SHA');
  assertDigest(fields.inputSha256, SHA256_PATTERN, 'Retry-identity input digest');
  assertDigest(fields.changedPathSha256, SHA256_PATTERN, 'Retry-identity changed-path digest');
  assertDigest(
    fields.basePullRequestBodySha256,
    SHA256_PATTERN,
    'Retry-identity base PR-body digest',
  );
  if (!isManagedAutomationPublicationPath(fields.changedPath)) {
    throw new Error('Retry identity changed path is outside automation publication policy');
  }
  for (const [field, value, maxBytes] of [
    ['branch', fields.branch, 256],
    ['command ID', fields.commandId, 200],
    ['commit headline', fields.commitHeadline, 256],
    ['pull request title', fields.pullRequestTitle, 256],
    ['workflow ref', fields.workflowRef, 512],
  ] as const) {
    if (
      value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > maxBytes ||
      value.includes('\0') ||
      value.includes('\r') ||
      value.includes('\n')
    ) {
      throw new Error(`Retry-identity ${field} is not canonical`);
    }
  }

  return {
    schema: AUTOMATION_PUBLICATION_RETRY_IDENTITY_SCHEMA,
    repository: AUTOMATION_REPOSITORY,
    repository_id: AUTOMATION_REPOSITORY_ID,
    base_sha: fields.baseSha,
    branch: fields.branch,
    command_id: fields.commandId,
    operation: fields.operation,
    input_sha256: fields.inputSha256,
    changed_path: fields.changedPath,
    changed_path_sha256: fields.changedPathSha256,
    commit_headline: fields.commitHeadline,
    pull_request_title: fields.pullRequestTitle,
    base_pull_request_body_sha256: fields.basePullRequestBodySha256,
    workflow_ref: fields.workflowRef,
    workflow_sha: fields.workflowSha,
  };
}

export function automationPublicationRetryIdentityHash(
  fields: AutomationPublicationRetryIdentityFields,
): string {
  return sha256(canonicalJson(automationPublicationRetryIdentityPayload(fields)));
}

/**
 * Returns the repository-global identity of one externally allocated command.
 *
 * Request content, base SHA, run/attempt provenance, and evidence deliberately
 * do not enter this identity. They remain signed commit/request evidence and
 * are compared on recovery. Keeping the physical ref command-scoped means a
 * repeated command can recover its one immutable publication or fail closed on
 * semantic drift; it can never allocate a second branch merely because main,
 * the run clock, or an Actions attempt changed.
 */
export function automationPublicationCommandIdentityPayload(
  policy: ResolvedAutomationPublicationPolicy,
  commandId: string,
): AutomationPublicationCommandIdentityPayload {
  if (policy.branchStrategy !== AUTOMATION_PUBLICATION_BRANCH_STRATEGY) {
    throw new Error('Publication policy branch strategy is not canonical');
  }
  for (const [field, value, maxBytes] of [
    ['logical branch', policy.branch, 256],
    ['command ID', commandId, 200],
  ] as const) {
    if (
      value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > maxBytes ||
      value.includes('\0') ||
      value.includes('\r') ||
      value.includes('\n')
    ) {
      throw new Error(`Command-identity ${field} is not canonical`);
    }
  }
  if (!REGISTRY_COMMAND_PATTERN.test(commandId)) {
    throw new Error('Command-identity command ID is not canonical');
  }
  return {
    schema: AUTOMATION_PUBLICATION_COMMAND_IDENTITY_SCHEMA,
    repository: AUTOMATION_REPOSITORY,
    repository_id: AUTOMATION_REPOSITORY_ID,
    logical_branch: policy.branch,
    command_id: commandId,
  };
}

export function automationPublicationCommandIdentityHash(
  policy: ResolvedAutomationPublicationPolicy,
  commandId: string,
): string {
  return sha256(canonicalJson(automationPublicationCommandIdentityPayload(policy, commandId)));
}

/**
 * Returns the only physical ref name a stable publication identity may use.
 *
 * The policy branch is a logical namespace, not a shared mutable branch.
 * Appending the command identity gives one create-only ref to one idempotency
 * key. The complete retry identity remains signed request evidence, while any
 * request drift for an existing command fails closed against its immutable
 * commit. The publisher never deletes or force-updates these refs; branch
 * creation is create-only and commit creation is guarded by expectedHeadOid.
 */
export function automationPublicationBranch(
  policy: ResolvedAutomationPublicationPolicy,
  commandId: string,
): string {
  const commandIdentity = automationPublicationCommandIdentityHash(policy, commandId);
  const branch = `${policy.branch}--${commandIdentity}`;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.endsWith('.') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock') ||
    Buffer.byteLength(branch, 'utf8') > 255
  ) {
    throw new Error('Identity-derived publication branch is not a canonical Git ref');
  }
  return branch;
}

export function automationPublicationEvidenceArtifactName(
  policy: ResolvedAutomationPublicationPolicy,
  workflowRunId: number,
  workflowRunAttempt: number,
): string {
  assertPositiveInteger(workflowRunId, 'Workflow run ID');
  assertPositiveInteger(workflowRunAttempt, 'Workflow run attempt');
  if (policy.evidenceArtifactPrefix === null) {
    throw new Error('Selected automation publication policy has no input-evidence artifact');
  }
  return `${policy.evidenceArtifactPrefix}-input-${String(workflowRunId)}-${String(
    workflowRunAttempt,
  )}`;
}

export function automationPublicationInputArtifact(
  policy: ResolvedAutomationPublicationPolicy,
  workflowRunId: number,
  workflowRunAttempt: number,
): AutomationPublicationInputArtifactContract {
  const exactFiles: readonly string[] =
    policy.key === 'registry-add' || policy.key === 'registry-close'
      ? ['finding-registry-authority-preflight.json', 'finding-registry-operation.txt']
      : policy.key === 'registry-sweep'
        ? ['finding-state-sweep-preflight.json', 'finding-state-sweep-plan.txt']
        : policy.key === 'aria-daily-report'
          ? [basename(policy.changedPath)]
          : ['rule-health-report-preflight.json', basename(policy.changedPath)];
  return {
    name: automationPublicationEvidenceArtifactName(policy, workflowRunId, workflowRunAttempt),
    exactFiles,
  };
}

export function automationPublicationResultBasename(
  policyKey: AutomationPublicationPolicyKey,
): string {
  return RESULT_JSON_BASENAME_BY_POLICY[policyKey];
}

export function isAutomationPublicationResultBasename(value: string): boolean {
  return Object.values(RESULT_JSON_BASENAME_BY_POLICY).includes(value);
}

export function automationPublicationResultArtifact(
  policy: ResolvedAutomationPublicationPolicy,
): AutomationPublicationResultArtifactContract {
  const resultJsonBasename = automationPublicationResultBasename(policy.key);
  return {
    resultJsonBasename,
    exactFiles:
      policy.key === 'aria-daily-report'
        ? ['aria-daily-report-preflight.json', resultJsonBasename]
        : [resultJsonBasename],
  };
}
