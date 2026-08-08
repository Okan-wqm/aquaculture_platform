/**
 * Fail-closed contract for the GitHub-side automation publication boundary.
 *
 * The manifest is the repository SSoT for who may publish automation PRs and
 * which environment protects their GitHub App credentials. Runtime GitHub
 * configuration remains deliberately BOOTSTRAP_PENDING until the environment
 * credentials and the protected-main admission context have machine evidence.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as YAML from 'yaml';

import {
  AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA,
  AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA_VERSION,
  EXPECTED_AUTOMATION_PUBLICATION_BRANCH_POLICY,
  parseAutomationPublicationDeploymentBranchPolicy,
  type AutomationPublicationDeploymentBranchPolicy,
} from '../../tools/gates/lib/automation-publication-authority';

type AuthorityState = 'BOOTSTRAP_PENDING' | 'ACTIVE';

interface AuthorizedPublisher {
  workflow_path: string;
  job_id: string;
  environment: string;
  app_token_step_id: string;
  publisher_step_id: string;
}

interface RequestedTokenContract {
  mint_action: string;
  repository_selection: string;
  repositories: Array<{
    full_name: string;
    repository_id: number;
  }>;
  permissions: {
    actions: string;
    contents: string;
    pull_requests: string;
  };
  installation_id_binding: string;
  principal_binding: string;
  repository_scope_binding: string;
}

interface ActivationEvidence {
  activated_at: string | null;
  protected_main_sha: string | null;
  credential_scope_configuration_sha256: string | null;
  required_status_checks_configuration_sha256: string | null;
  publisher_workflow_bindings_sha256: string | null;
  github_app_id: string | null;
  github_app_slug: string | null;
  github_app_installation_id: string | null;
  admission_check_run_url: string | null;
  publication_proof_run_url: string | null;
  publication_proof_artifact_sha256: string | null;
}

interface AutomationPublicationAuthority {
  $schema: string;
  schema_version: number;
  authority_id: string;
  state: AuthorityState;
  repository: {
    full_name: string;
    repository_id: number;
  };
  observation: {
    observed_at: string;
    source: string;
  };
  environment: {
    name: string;
    deployment_branch_policy: AutomationPublicationDeploymentBranchPolicy;
  };
  credentials: {
    scope: string;
    required_environment_secret_names: string[];
    required_environment_variable_names: string[];
    observed_environment_secret_names: string[];
    observed_environment_variable_names: string[];
    forbidden_publisher_token_references: string[];
    requested_token_contract: RequestedTokenContract;
  };
  authorized_publishers: AuthorizedPublisher[];
  admission: {
    workflow_path: string;
    event: string;
    job_id: string;
    context: string;
    trust_source: string;
    checkout_ref: string;
    required_status_checks_manifest: string;
    required_on_protected_main: boolean;
  };
  bootstrap_blocker: {
    id: string;
    path: string;
    state: string;
    owner: string;
    deadline: string;
    missing_conditions: string[];
  };
  activation_evidence: ActivationEvidence;
}

interface WorkflowStep {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface WorkflowJob {
  name?: string;
  environment?: string | { name?: string };
  steps?: WorkflowStep[];
}

interface WorkflowDocument {
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

interface RequiredStatusChecksManifest {
  required_status_checks?: {
    contexts?: string[];
  };
}

interface BlockerRow {
  id: string;
  state: string;
  owner: string;
  deadline: string;
}

interface ValidationInputs {
  authority: AutomationPublicationAuthority;
  blockerReadme: string;
  requiredStatusChecks: RequiredStatusChecksManifest;
  workflows: Map<string, WorkflowDocument>;
}

const REPO_ROOT = resolve(__dirname, '..', '..');
const AUTHORITY_PATH = resolve(
  REPO_ROOT,
  '.github/manifests/automation-publication-authority.json',
);
const CODEOWNERS_PATH = resolve(REPO_ROOT, '.github/CODEOWNERS');
const EXPECTED_REPOSITORY = {
  full_name: 'Okan-wqm/aquaculture_platform',
  repository_id: 1132698735,
} as const;
const EXPECTED_ENVIRONMENT = 'automation-publication';
const EXPECTED_OBSERVED_AT = '2026-07-30T07:22:24Z';
const REQUIRED_ENVIRONMENT_SECRETS = ['ARIA_GITHUB_APP_PRIVATE_KEY'];
const REQUIRED_ENVIRONMENT_VARIABLES = [
  'ARIA_GITHUB_APP_CLIENT_ID',
  'ARIA_GITHUB_APP_INSTALLATION_ID',
  'ARIA_GITHUB_APP_SLUG',
];
const FORBIDDEN_PUBLISHER_TOKEN_REFERENCES = [
  'ARIA_GITHUB_APP_TOKEN',
  'secrets.GITHUB_TOKEN',
  'github.token',
];
const EXPECTED_TOKEN_CONTRACT: RequestedTokenContract = {
  mint_action: '.github/actions/mint-automation-app-token/action.yml',
  repository_selection: 'EXACTLY_ONE_SELECTED_REPOSITORY',
  repositories: [EXPECTED_REPOSITORY],
  permissions: {
    actions: 'read',
    contents: 'write',
    pull_requests: 'write',
  },
  installation_id_binding: 'PINNED_ACTION_OUTPUT_MATCH_V1',
  principal_binding: 'GRAPHQL_VIEWER_APP_BOT_V1',
  repository_scope_binding: 'INSTALLATION_REPOSITORIES_EXACT_ONE_V1',
};
const EXPECTED_PUBLISHERS: AuthorizedPublisher[] = [
  {
    workflow_path: '.github/workflows/finding-registry-authority.yml',
    job_id: 'mutate',
    environment: EXPECTED_ENVIRONMENT,
    app_token_step_id: 'app-token',
    publisher_step_id: 'publication',
  },
  {
    workflow_path: '.github/workflows/finding-state-sweep.yml',
    job_id: 'sweep',
    environment: EXPECTED_ENVIRONMENT,
    app_token_step_id: 'app-token',
    publisher_step_id: 'publication',
  },
  {
    workflow_path: '.github/workflows/aria-daily-report.yml',
    job_id: 'commit-report',
    environment: EXPECTED_ENVIRONMENT,
    app_token_step_id: 'automation-app',
    publisher_step_id: 'publication',
  },
  {
    workflow_path: '.github/workflows/rule-health-report.yml',
    job_id: 'generate',
    environment: EXPECTED_ENVIRONMENT,
    app_token_step_id: 'automation-app',
    publisher_step_id: 'publication',
  },
];
const EXPECTED_EVIDENCE_FIELDS: Array<keyof ActivationEvidence> = [
  'activated_at',
  'protected_main_sha',
  'credential_scope_configuration_sha256',
  'required_status_checks_configuration_sha256',
  'publisher_workflow_bindings_sha256',
  'github_app_id',
  'github_app_slug',
  'github_app_installation_id',
  'admission_check_run_url',
  'publication_proof_run_url',
  'publication_proof_artifact_sha256',
];
const PENDING_CONDITIONS = ['ENVIRONMENT_APP_CREDENTIALS_ABSENT', 'ADMISSION_CONTEXT_NOT_REQUIRED'];
const PUBLICATION_CODEOWNER_PATHS = [
  '.github/actions/mint-automation-app-token/action.yml',
  '.github/manifests/automation-publication-authority.json',
  '.github/workflows/automation-publication-admission.yml',
  'tools/gates/finding-registry-publication.ts',
  'tools/gates/lib/automation-publication-policy.ts',
  'tools/scripts/automation/publish-automation-pr.ts',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject<T>(path: string): T {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as T;
}

function parseWorkflow(path: string): WorkflowDocument {
  const parsed: unknown = YAML.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a YAML object`);
  }
  return parsed as WorkflowDocument;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneWorkflowMap(workflows: Map<string, WorkflowDocument>): Map<string, WorkflowDocument> {
  return new Map([...workflows.entries()].map(([path, workflow]) => [path, clone(workflow)]));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function publisherIdentity(publisher: AuthorizedPublisher): string {
  return (
    `${publisher.workflow_path}#${publisher.job_id}@${publisher.environment}:` +
    `${publisher.app_token_step_id}->${publisher.publisher_step_id}`
  );
}

function environmentName(environment: WorkflowJob['environment']): string | undefined {
  if (typeof environment === 'string') {
    return environment;
  }
  return environment?.name;
}

function blockerRow(readme: string, blockerId: string): BlockerRow | undefined {
  const row = readme.split(/\r?\n/).find((line) => line.startsWith(`| \`${blockerId}\``));
  if (!row) {
    return undefined;
  }
  const cells = row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim().replace(/^`|`$/g, ''));
  if (cells.length < 4) {
    return undefined;
  }
  return {
    id: cells[0] ?? '',
    state: cells[1] ?? '',
    owner: cells[2] ?? '',
    deadline: cells[3] ?? '',
  };
}

function validActivationEvidence(evidence: ActivationEvidence): string[] {
  const violations: string[] = [];
  if (!evidence.activated_at?.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)) {
    violations.push('activation evidence: activated_at');
  }
  if (!evidence.protected_main_sha?.match(/^[0-9a-f]{40}$/)) {
    violations.push('activation evidence: protected_main_sha');
  }
  for (const field of [
    'credential_scope_configuration_sha256',
    'required_status_checks_configuration_sha256',
    'publisher_workflow_bindings_sha256',
    'publication_proof_artifact_sha256',
  ] as const) {
    if (!evidence[field]?.match(/^[0-9a-f]{64}$/)) {
      violations.push(`activation evidence: ${field}`);
    }
  }
  if (!evidence.github_app_id?.match(/^[1-9][0-9]*$/)) {
    violations.push('activation evidence: github_app_id');
  }
  if (!evidence.github_app_slug?.match(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)) {
    violations.push('activation evidence: github_app_slug');
  }
  if (!evidence.github_app_installation_id?.match(/^[1-9][0-9]*$/)) {
    violations.push('activation evidence: github_app_installation_id');
  }
  for (const field of ['admission_check_run_url', 'publication_proof_run_url'] as const) {
    if (
      !evidence[field]?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/[1-9][0-9]*$/)
    ) {
      violations.push(`activation evidence: ${field}`);
    }
  }
  return violations;
}

function validateAuthority(inputs: ValidationInputs): string[] {
  const { authority, blockerReadme, requiredStatusChecks, workflows } = inputs;
  const violations: string[] = [];
  const expectedPublisherIds = EXPECTED_PUBLISHERS.map(publisherIdentity).sort();
  const publisherIds = authority.authorized_publishers.map(publisherIdentity).sort();
  const requiredContexts = requiredStatusChecks.required_status_checks?.contexts ?? [];
  const admissionIsRequired = requiredContexts.includes(authority.admission.context);
  const blocker = blockerRow(blockerReadme, authority.bootstrap_blocker.id);

  if (authority.$schema !== AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA) {
    violations.push('schema identity');
  }
  if (authority.schema_version !== AUTOMATION_PUBLICATION_AUTHORITY_SCHEMA_VERSION) {
    violations.push('schema version');
  }
  if (authority.authority_id !== 'aqua.github.automation-publication') {
    violations.push('authority identity');
  }
  if (
    authority.repository.full_name !== EXPECTED_REPOSITORY.full_name ||
    authority.repository.repository_id !== EXPECTED_REPOSITORY.repository_id
  ) {
    violations.push('repository identity');
  }
  if (authority.environment.name !== EXPECTED_ENVIRONMENT) {
    violations.push('environment identity');
  }
  try {
    const branchPolicy = parseAutomationPublicationDeploymentBranchPolicy(
      authority.environment.deployment_branch_policy,
    );
    if (
      JSON.stringify(branchPolicy) !== JSON.stringify(EXPECTED_AUTOMATION_PUBLICATION_BRANCH_POLICY)
    ) {
      violations.push('deployment branch policy');
    }
  } catch {
    violations.push('deployment branch policy');
  }
  if (authority.credentials.scope !== 'ENVIRONMENT_ONLY') {
    violations.push('credential scope');
  }
  if (
    JSON.stringify(sorted(authority.credentials.required_environment_secret_names)) !==
    JSON.stringify(sorted(REQUIRED_ENVIRONMENT_SECRETS))
  ) {
    violations.push('required environment secrets');
  }
  if (
    JSON.stringify(sorted(authority.credentials.required_environment_variable_names)) !==
    JSON.stringify(sorted(REQUIRED_ENVIRONMENT_VARIABLES))
  ) {
    violations.push('required environment variables');
  }
  if (
    JSON.stringify(sorted(authority.credentials.forbidden_publisher_token_references)) !==
    JSON.stringify(sorted(FORBIDDEN_PUBLISHER_TOKEN_REFERENCES))
  ) {
    violations.push('forbidden publisher token references');
  }
  if (
    JSON.stringify(authority.credentials.requested_token_contract) !==
    JSON.stringify(EXPECTED_TOKEN_CONTRACT)
  ) {
    violations.push('requested token contract');
  }
  if (
    new Set(authority.authorized_publishers.map(publisherIdentity)).size !==
    authority.authorized_publishers.length
  ) {
    violations.push('duplicate authorized publisher');
  }
  if (JSON.stringify(publisherIds) !== JSON.stringify(expectedPublisherIds)) {
    violations.push('authorized publisher set');
  }

  for (const publisher of authority.authorized_publishers) {
    const workflow = workflows.get(publisher.workflow_path);
    const job = workflow?.jobs?.[publisher.job_id];
    if (environmentName(job?.environment) !== publisher.environment) {
      violations.push(`publisher environment: ${publisher.workflow_path}#${publisher.job_id}`);
    }
    const steps = job?.steps ?? [];
    const appTokenSteps = steps.filter((step) => step.id === publisher.app_token_step_id);
    if (
      appTokenSteps.length !== 1 ||
      appTokenSteps[0]?.uses !== './.github/actions/mint-automation-app-token'
    ) {
      violations.push(`publisher App token step: ${publisher.workflow_path}#${publisher.job_id}`);
    }
    const publicationSteps = steps.filter((step) => step.id === publisher.publisher_step_id);
    const publicationStep = publicationSteps[0];
    if (
      publicationSteps.length !== 1 ||
      !publicationStep?.run?.includes('npm run automation:publish') ||
      publicationStep.run.includes('open-report-pr.sh')
    ) {
      violations.push(`typed publisher step: ${publisher.workflow_path}#${publisher.job_id}`);
    }
    const expectedTokenReference = `\${{ steps.${publisher.app_token_step_id}.outputs.token }}`;
    if (publicationStep?.env?.GH_TOKEN !== expectedTokenReference) {
      violations.push(`publisher token binding: ${publisher.workflow_path}#${publisher.job_id}`);
    }
    const publisherTokenReference = JSON.stringify(publicationStep?.env?.GH_TOKEN ?? '');
    for (const forbidden of authority.credentials.forbidden_publisher_token_references) {
      if (publisherTokenReference.includes(forbidden)) {
        violations.push(
          `forbidden publisher token: ${publisher.workflow_path}#${publisher.job_id} contains ${forbidden}`,
        );
      }
    }
  }

  const admissionWorkflow = workflows.get(authority.admission.workflow_path);
  const admissionJob = admissionWorkflow?.jobs?.[authority.admission.job_id];
  const checkout = admissionJob?.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
  if (!admissionWorkflow?.on || !(authority.admission.event in admissionWorkflow.on)) {
    violations.push('base-owned admission event');
  }
  if (admissionWorkflow?.on && 'pull_request' in admissionWorkflow.on) {
    violations.push('head-owned admission event');
  }
  if (admissionJob?.name !== authority.admission.context) {
    violations.push('admission context');
  }
  if (checkout?.with?.ref !== authority.admission.checkout_ref) {
    violations.push('admission protected-base checkout');
  }
  if (checkout?.with?.['persist-credentials'] !== false) {
    violations.push('admission checkout credentials');
  }
  if (authority.admission.trust_source !== 'PROTECTED_BASE') {
    violations.push('admission trust source');
  }
  if (authority.admission.required_on_protected_main !== admissionIsRequired) {
    violations.push('admission required-check observation');
  }

  if (
    !blocker ||
    blocker.id !== authority.bootstrap_blocker.id ||
    blocker.state !== authority.bootstrap_blocker.state ||
    blocker.owner !== authority.bootstrap_blocker.owner ||
    blocker.deadline !== authority.bootstrap_blocker.deadline
  ) {
    violations.push('README blocker parity');
  }

  if (authority.state === 'BOOTSTRAP_PENDING') {
    if (authority.bootstrap_blocker.state !== 'OPEN') {
      violations.push('pending blocker state');
    }
    if (
      JSON.stringify(sorted(authority.bootstrap_blocker.missing_conditions)) !==
      JSON.stringify(sorted(PENDING_CONDITIONS))
    ) {
      violations.push('pending missing conditions');
    }
    if (
      authority.credentials.observed_environment_secret_names.length !== 0 ||
      authority.credentials.observed_environment_variable_names.length !== 0
    ) {
      violations.push('pending credential observation');
    }
    if (admissionIsRequired || authority.admission.required_on_protected_main) {
      violations.push('pending admission context');
    }
    if (Object.values(authority.activation_evidence).some((value) => value !== null)) {
      violations.push('pending activation evidence');
    }
    if (!blockerReadme.includes(authority.observation.observed_at)) {
      violations.push('pending observation timestamp');
    }
  } else if (authority.state === 'ACTIVE') {
    if (authority.bootstrap_blocker.state !== 'RESOLVED') {
      violations.push('active blocker state');
    }
    if (authority.bootstrap_blocker.missing_conditions.length !== 0) {
      violations.push('active missing conditions');
    }
    if (
      JSON.stringify(sorted(authority.credentials.observed_environment_secret_names)) !==
        JSON.stringify(sorted(REQUIRED_ENVIRONMENT_SECRETS)) ||
      JSON.stringify(sorted(authority.credentials.observed_environment_variable_names)) !==
        JSON.stringify(sorted(REQUIRED_ENVIRONMENT_VARIABLES))
    ) {
      violations.push('active credential observation');
    }
    if (!admissionIsRequired || !authority.admission.required_on_protected_main) {
      violations.push('active required admission context');
    }
    violations.push(...validActivationEvidence(authority.activation_evidence));
  } else {
    violations.push('unsupported authority state');
  }

  return violations;
}

function activeAuthority(
  authority: AutomationPublicationAuthority,
): AutomationPublicationAuthority {
  const active = clone(authority);
  active.state = 'ACTIVE';
  active.observation.observed_at = '2026-07-30T08:00:00Z';
  active.credentials.observed_environment_secret_names = [...REQUIRED_ENVIRONMENT_SECRETS];
  active.credentials.observed_environment_variable_names = [...REQUIRED_ENVIRONMENT_VARIABLES];
  active.admission.required_on_protected_main = true;
  active.bootstrap_blocker.state = 'RESOLVED';
  active.bootstrap_blocker.missing_conditions = [];
  active.activation_evidence = {
    activated_at: '2026-07-30T08:00:00Z',
    protected_main_sha: 'a'.repeat(40),
    credential_scope_configuration_sha256: 'b'.repeat(64),
    required_status_checks_configuration_sha256: 'c'.repeat(64),
    publisher_workflow_bindings_sha256: 'd'.repeat(64),
    github_app_id: '123456',
    github_app_slug: 'suderra-automation',
    github_app_installation_id: '987654',
    admission_check_run_url: 'https://github.com/Okan-wqm/aquaculture_platform/actions/runs/123456',
    publication_proof_run_url:
      'https://github.com/Okan-wqm/aquaculture_platform/actions/runs/123457',
    publication_proof_artifact_sha256: 'e'.repeat(64),
  };
  return active;
}

function resolvedBlockerReadme(readme: string): string {
  return readme.replace(/(\| `P1-AUTOMATION-PUBLICATION-001`\s+\|) `OPEN` /, '$1 `RESOLVED` ');
}

describe('automation publication authority SSoT', () => {
  const authority = parseJsonObject<AutomationPublicationAuthority>(AUTHORITY_PATH);
  const codeowners = readFileSync(CODEOWNERS_PATH, 'utf8');
  const blockerPath = resolve(REPO_ROOT, authority.bootstrap_blocker.path);
  const blockerReadme = readFileSync(blockerPath, 'utf8');
  const requiredStatusPath = resolve(
    REPO_ROOT,
    authority.admission.required_status_checks_manifest,
  );
  const requiredStatusChecks = parseJsonObject<RequiredStatusChecksManifest>(requiredStatusPath);
  const workflows = new Map<string, WorkflowDocument>();
  for (const publisher of authority.authorized_publishers) {
    workflows.set(publisher.workflow_path, parseWorkflow(publisher.workflow_path));
  }
  workflows.set(
    authority.admission.workflow_path,
    parseWorkflow(authority.admission.workflow_path),
  );

  it('records the exact repository, environment policy, and duplicate-free publisher authority', () => {
    expect(authority.repository).toEqual(EXPECTED_REPOSITORY);
    expect(authority.observation).toEqual({
      observed_at: EXPECTED_OBSERVED_AT,
      source: 'LIVE_GITHUB_API',
    });
    expect(authority.environment).toEqual({
      name: EXPECTED_ENVIRONMENT,
      deployment_branch_policy: EXPECTED_AUTOMATION_PUBLICATION_BRANCH_POLICY,
    });
    expect(authority.credentials.scope).toBe('ENVIRONMENT_ONLY');
    expect(sorted(authority.credentials.required_environment_secret_names)).toEqual(
      sorted(REQUIRED_ENVIRONMENT_SECRETS),
    );
    expect(sorted(authority.credentials.required_environment_variable_names)).toEqual(
      sorted(REQUIRED_ENVIRONMENT_VARIABLES),
    );
    expect(authority.authorized_publishers.map(publisherIdentity).sort()).toEqual(
      EXPECTED_PUBLISHERS.map(publisherIdentity).sort(),
    );
    expect(new Set(authority.authorized_publishers.map(publisherIdentity)).size).toBe(4);
    for (const path of PUBLICATION_CODEOWNER_PATHS) {
      expect(codeowners).toMatch(
        new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+@Okan-wqm$`, 'm'),
      );
    }
  });

  it('keeps the current BOOTSTRAP_PENDING state aligned with the dated README blocker', () => {
    expect(authority.state).toBe('BOOTSTRAP_PENDING');
    expect(authority.bootstrap_blocker).toEqual({
      id: 'P1-AUTOMATION-PUBLICATION-001',
      path: 'docs/plans/2026-06-18-enterprise-grade-debt-closure/README.md',
      state: 'OPEN',
      owner: 'security-reviewer',
      deadline: '2026-07-30',
      missing_conditions: PENDING_CONDITIONS,
    });
    expect(authority.credentials.observed_environment_secret_names).toEqual([]);
    expect(authority.credentials.observed_environment_variable_names).toEqual([]);
    expect(authority.admission.required_on_protected_main).toBe(false);
    expect(requiredStatusChecks.required_status_checks?.contexts).not.toContain(
      authority.admission.context,
    );
    expect(Object.keys(authority.activation_evidence).sort()).toEqual(
      [...EXPECTED_EVIDENCE_FIELDS].sort(),
    );
    expect(Object.values(authority.activation_evidence).every((value) => value === null)).toBe(
      true,
    );
    expect(
      validateAuthority({ authority, blockerReadme, requiredStatusChecks, workflows }),
    ).toEqual([]);
  });

  it('loads the admission verifier only from the protected pull-request base', () => {
    expect(authority.admission).toEqual({
      workflow_path: '.github/workflows/automation-publication-admission.yml',
      event: 'pull_request_target',
      job_id: 'automation-publication-admission',
      context: 'automation-publication-admission',
      trust_source: 'PROTECTED_BASE',
      checkout_ref: '${{ github.event.pull_request.base.sha }}',
      required_status_checks_manifest: '.github/manifests/main-required-status-checks.json',
      required_on_protected_main: false,
    });
    const workflow = workflows.get(authority.admission.workflow_path);
    const job = workflow?.jobs?.[authority.admission.job_id];
    expect(workflow?.on).toHaveProperty('pull_request_target');
    expect(workflow?.on?.pull_request_target?.types).toEqual([
      'opened',
      'synchronize',
      'reopened',
      'ready_for_review',
      'edited',
    ]);
    expect(workflow?.on).not.toHaveProperty('pull_request');
    expect(job?.name).toBe(authority.admission.context);
    expect(
      job?.steps?.find((step) => step.uses?.startsWith('actions/checkout@'))?.with,
    ).toMatchObject({
      ref: authority.admission.checkout_ref,
      'persist-credentials': false,
    });
  });

  it('rejects an ACTIVE claim while credentials, required context, blocker closure, and evidence are absent', () => {
    const falseActive = clone(authority);
    falseActive.state = 'ACTIVE';

    expect(
      validateAuthority({
        authority: falseActive,
        blockerReadme,
        requiredStatusChecks,
        workflows,
      }),
    ).toEqual(
      expect.arrayContaining([
        'active blocker state',
        'active missing conditions',
        'active credential observation',
        'active required admission context',
        'activation evidence: activated_at',
        'activation evidence: protected_main_sha',
      ]),
    );
  });

  it('rejects ACTIVE on any publisher environment drift or static-token regression', () => {
    const active = activeAuthority(authority);
    const activeRequiredChecks = clone(requiredStatusChecks);
    activeRequiredChecks.required_status_checks?.contexts?.push(active.admission.context);
    const activeReadme = resolvedBlockerReadme(blockerReadme);

    const environmentDrift = cloneWorkflowMap(workflows);
    const registryWorkflow = environmentDrift.get(
      '.github/workflows/finding-registry-authority.yml',
    );
    if (registryWorkflow?.jobs?.mutate) {
      registryWorkflow.jobs.mutate.environment = 'unprotected-environment';
    }
    expect(
      validateAuthority({
        authority: active,
        blockerReadme: activeReadme,
        requiredStatusChecks: activeRequiredChecks,
        workflows: environmentDrift,
      }),
    ).toContain('publisher environment: .github/workflows/finding-registry-authority.yml#mutate');

    const tokenDrift = cloneWorkflowMap(workflows);
    const sweepJob = tokenDrift.get('.github/workflows/finding-state-sweep.yml')?.jobs?.sweep;
    const publicationStep = sweepJob?.steps?.find((step) => step.id === 'publication');
    if (publicationStep) {
      publicationStep.env = {
        ...(publicationStep.env ?? {}),
        GH_TOKEN: '${{ secrets.ARIA_GITHUB_APP_TOKEN }}',
      };
    }
    expect(
      validateAuthority({
        authority: active,
        blockerReadme: activeReadme,
        requiredStatusChecks: activeRequiredChecks,
        workflows: tokenDrift,
      }),
    ).toContain(
      'forbidden publisher token: .github/workflows/finding-state-sweep.yml#sweep contains ARIA_GITHUB_APP_TOKEN',
    );
  });

  it('admits ACTIVE only when every declared exit condition and evidence field is satisfied', () => {
    const active = activeAuthority(authority);
    const activeRequiredChecks = clone(requiredStatusChecks);
    activeRequiredChecks.required_status_checks?.contexts?.push(active.admission.context);

    expect(
      validateAuthority({
        authority: active,
        blockerReadme: resolvedBlockerReadme(blockerReadme),
        requiredStatusChecks: activeRequiredChecks,
        workflows,
      }),
    ).toEqual([]);
  });
});
