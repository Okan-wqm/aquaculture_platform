import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './repo-root';

export const SOURCE_CONTROL_LEAF_CATALOG_SCHEMA_V1 = 'SourceControlLeafCatalogV1' as const;

const SOURCE_CONTROL_LEAF_CATALOG_PATH = join(
  REPO_ROOT,
  'tools/quality/source-control-leaf-catalog.v1.json',
);
const ROOT_PACKAGE_PATH = join(REPO_ROOT, 'package.json');

const SOURCE_CONTROL_LEAF_ROLES_V1 = [
  'FINDING_REGISTRY_AUTHORITY_TEST_V1',
  'SOURCE_CONTROL_CONTRACTS_V1',
  'SOURCE_INVENTORY_STATIC_CI_V1',
  'CAPABILITY_INTEGRATION_EVIDENCE_V1',
] as const;
const EVENT_HEAD_RUNNER_ALLOWLIST_V1 = ['ubuntu-latest'] as const;
const EVENT_HEAD_CHECKOUT_WITH_V1 = {
  ref: '${{ github.event.pull_request.head.sha || github.sha }}',
  'fetch-depth': 0,
  'persist-credentials': false,
} as const;
const SOURCE_CONTROL_WORKSPACE_CALLER_WITH_V1 = {
  'node-version': '${{ env.NODE_VERSION }}',
} as const;
const SOURCE_CONTROL_WORKSPACE_INPUTS_V1 = {
  'node-version': { required: true },
} as const;
const SOURCE_CONTROL_WORKSPACE_SETUP_NODE_WITH_V1 = {
  'node-version': '${{ inputs.node-version }}',
  cache: 'npm',
} as const;
const SOURCE_CONTROL_WORKSPACE_INSTALL_V1 =
  'npm ci --ignore-scripts --no-audit --prefer-offline --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000' as const;
const GITHUB_READ_TOKEN_PERMISSIONS_V1 = {
  actions: 'read',
  checks: 'read',
  contents: 'read',
  'pull-requests': 'read',
} as const;
const GITHUB_READ_TOKEN_COMMAND_ENV_V1 = {
  GITHUB_TOKEN: '${{ github.token }}',
} as const;
const WORKFLOW_READ_ONLY_PERMISSIONS_V1 = {
  contents: 'read',
} as const;
const SOURCE_CONTROL_LEAF_ROLE_CONTRACT_V1: Readonly<
  Record<
    SourceControlLeafRoleV1,
    {
      readonly executionIdentity: SourceControlExecutionIdentityV1['kind'];
      readonly commands: number;
    }
  >
> = {
  FINDING_REGISTRY_AUTHORITY_TEST_V1: {
    executionIdentity: 'NO_COMMAND_CREDENTIALS_V1',
    commands: 1,
  },
  SOURCE_CONTROL_CONTRACTS_V1: {
    executionIdentity: 'NO_COMMAND_CREDENTIALS_V1',
    commands: 3,
  },
  SOURCE_INVENTORY_STATIC_CI_V1: {
    executionIdentity: 'NO_COMMAND_CREDENTIALS_V1',
    commands: 3,
  },
  CAPABILITY_INTEGRATION_EVIDENCE_V1: {
    executionIdentity: 'GITHUB_READ_TOKEN_V1',
    commands: 1,
  },
};

export type SourceControlLeafRoleV1 = (typeof SOURCE_CONTROL_LEAF_ROLES_V1)[number];

export type SourceControlExecutionIdentityV1 =
  | { readonly kind: 'NO_COMMAND_CREDENTIALS_V1' }
  | {
      readonly kind: 'GITHUB_READ_TOKEN_V1';
      readonly permissions: typeof GITHUB_READ_TOKEN_PERMISSIONS_V1;
      readonly commandEnv: typeof GITHUB_READ_TOKEN_COMMAND_ENV_V1;
    };

export interface SourceControlActionStepV1 {
  name: string;
  uses?: string;
  shell?: string;
  run?: string;
  with?: Readonly<Record<string, string | number | boolean>>;
}

export interface SourceControlBootstrapActionV1 {
  id: 'SOURCE_CONTROL_WORKSPACE_V1';
  path: string;
  uses: string;
  invocationName: string;
  with: Readonly<Record<string, string | number | boolean>>;
  inputs: Readonly<Record<string, { readonly required: true }>>;
  steps: readonly SourceControlActionStepV1[];
}

export interface SourceControlCommandLeafV1 {
  id: string;
  name: string;
  npmScript: string;
  run: string;
}

export interface SourceControlLeafJobV1 {
  role: SourceControlLeafRoleV1;
  workflow: string;
  job: string;
  runsOn: string;
  timeoutMinutes: number;
  executionIdentity: SourceControlExecutionIdentityV1;
  commands: readonly SourceControlCommandLeafV1[];
}

export interface SourceControlWorkflowAuthorityV1 {
  path: string;
  permissions: Readonly<Record<string, 'read'>>;
}

export interface SourceControlLeafCatalogV1 {
  schema: typeof SOURCE_CONTROL_LEAF_CATALOG_SCHEMA_V1;
  workflowClosure: readonly SourceControlWorkflowAuthorityV1[];
  checkoutProfile: {
    readonly kind: 'EVENT_HEAD_V1';
    readonly runner: (typeof EVENT_HEAD_RUNNER_ALLOWLIST_V1)[number];
    readonly uses: string;
    readonly with: Readonly<Record<string, string | number | boolean>>;
  };
  bootstrapAction: SourceControlBootstrapActionV1;
  leafJobs: readonly SourceControlLeafJobV1[];
}

export interface SourceControlYamlSurfaceV1 {
  kind: 'WORKFLOW' | 'ACTION';
  path: string;
  document: unknown;
}

interface SourceControlStepOccurrenceV1 {
  surface: SourceControlYamlSurfaceV1;
  owner: string;
  stepIndex: number;
  step: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreezeInPlace(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreezeInPlace(entry));
    Object.freeze(value);
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((entry) => deepFreezeInPlace(entry));
    Object.freeze(value);
  }
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} keys must be exactly ${expected.join(', ')}`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be one non-empty trimmed string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0) {
    throw new Error(`${field} must be one positive integer`);
  }
  return value;
}

function requireClosedValue<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${field} must be one of ${values.join(', ')}`);
  }
  return value as T;
}

function requireStringMap(value: unknown, field: string): Readonly<Record<string, string>> {
  const record = requireRecord(value, field);
  const entries = Object.entries(record);
  if (entries.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return Object.fromEntries(
    entries.map(([key, entryValue]) => [
      requireString(key, `${field} key`),
      requireString(entryValue, `${field}.${key}`),
    ]),
  );
}

function requireScalarMap(
  value: unknown,
  field: string,
): Readonly<Record<string, string | number | boolean>> {
  const record = requireRecord(value, field);
  const entries = Object.entries(record);
  if (entries.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  const parsed: Record<string, string | number | boolean> = {};
  for (const [key, entryValue] of entries) {
    if (
      typeof entryValue !== 'string' &&
      typeof entryValue !== 'number' &&
      typeof entryValue !== 'boolean'
    ) {
      throw new Error(`${field}.${key} must be a string, number, or boolean`);
    }
    parsed[requireString(key, `${field} key`)] = entryValue;
  }
  return parsed;
}

function requireRepositoryPath(value: unknown, field: string): string {
  const repositoryPath = requireString(value, field);
  if (
    repositoryPath.startsWith('/') ||
    repositoryPath.includes('\\') ||
    repositoryPath
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${field} must be one normalized repository-relative path`);
  }
  return repositoryPath;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalJsonValue(entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error('canonical JSON accepts only finite JSON values');
}

export function canonicalSourceControlLeafCatalogBytesV1(raw: unknown): string {
  return `${serializeCanonicalJsonV1(canonicalJsonValue(raw))}\n`;
}

function serializeCanonicalJsonV1(value: unknown, depth = 0): string {
  const indentation = '  '.repeat(depth);
  const childIndentation = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value
      .map((entry) => `${childIndentation}${serializeCanonicalJsonV1(entry, depth + 1)}`)
      .join(',\n')}\n${indentation}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${childIndentation}${JSON.stringify(key)}: ${serializeCanonicalJsonV1(
            value[key],
            depth + 1,
          )}`,
      );
    return entries.length === 0 ? '{}' : `{\n${entries.join(',\n')}\n${indentation}}`;
  }
  const primitive = JSON.stringify(value);
  if (primitive === undefined) {
    throw new Error('canonical JSON primitive serialization failed');
  }
  return primitive;
}

export function parseCanonicalSourceControlLeafCatalogBytesV1(
  bytes: string,
): SourceControlLeafCatalogV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes) as unknown;
  } catch (error) {
    throw new Error(
      `SourceControlLeafCatalogV1 is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const canonical = canonicalSourceControlLeafCatalogBytesV1(raw);
  if (bytes !== canonical) {
    throw new Error(
      'SourceControlLeafCatalogV1 bytes must be canonical sorted JSON with one trailing newline',
    );
  }
  return parseSourceControlLeafCatalogV1(raw);
}

function parseActionStep(value: unknown, field: string): SourceControlActionStepV1 {
  const record = requireRecord(value, field);
  const hasUses = hasOwn(record, 'uses');
  const hasRun = hasOwn(record, 'run');
  if (hasUses === hasRun) {
    throw new Error(`${field} must declare exactly one of uses or run`);
  }
  const expectedKeys = hasUses ? ['name', 'uses', 'with'] : ['name', 'shell', 'run'];
  assertExactKeys(record, expectedKeys, field);
  return hasUses
    ? {
        name: requireString(record.name, `${field}.name`),
        uses: requireString(record.uses, `${field}.uses`),
        with: requireScalarMap(record.with, `${field}.with`),
      }
    : {
        name: requireString(record.name, `${field}.name`),
        shell: requireString(record.shell, `${field}.shell`),
        run: requireString(record.run, `${field}.run`),
      };
}

function parseBootstrapAction(value: unknown): SourceControlBootstrapActionV1 {
  const field = 'bootstrap_action';
  const record = requireRecord(value, field);
  assertExactKeys(
    record,
    ['id', 'path', 'uses', 'invocation_name', 'with', 'inputs', 'steps'],
    field,
  );
  if (record.id !== 'SOURCE_CONTROL_WORKSPACE_V1') {
    throw new Error(`${field}.id must be SOURCE_CONTROL_WORKSPACE_V1`);
  }
  const inputs = requireRecord(record.inputs, `${field}.inputs`);
  const parsedInputs: Record<string, { readonly required: true }> = {};
  for (const [key, rawInput] of Object.entries(inputs)) {
    const input = requireRecord(rawInput, `${field}.inputs.${key}`);
    assertExactKeys(input, ['required'], `${field}.inputs.${key}`);
    if (input.required !== true) {
      throw new Error(`${field}.inputs.${key}.required must be true`);
    }
    parsedInputs[requireString(key, `${field}.inputs key`)] = { required: true };
  }
  if (!Array.isArray(record.steps) || record.steps.length !== 2) {
    throw new Error(`${field}.steps must contain the immutable two-step bootstrap profile`);
  }
  const parsed: SourceControlBootstrapActionV1 = {
    id: record.id,
    path: requireRepositoryPath(record.path, `${field}.path`),
    uses: requireString(record.uses, `${field}.uses`),
    invocationName: requireString(record.invocation_name, `${field}.invocation_name`),
    with: requireScalarMap(record.with, `${field}.with`),
    inputs: parsedInputs,
    steps: record.steps.map((step, index) => parseActionStep(step, `${field}.steps[${index}]`)),
  };
  if (!parsed.path.endsWith('/action.yml')) {
    throw new Error(`${field}.path must select one action.yml`);
  }
  const expectedUses = `./${parsed.path.slice(0, -'/action.yml'.length)}`;
  if (parsed.uses !== expectedUses) {
    throw new Error(`${field}.uses must resolve its exact repository action path ${expectedUses}`);
  }
  if (!equalComparable(parsed.with, SOURCE_CONTROL_WORKSPACE_CALLER_WITH_V1)) {
    throw new Error(`${field}.with must be the exact source-control workspace caller input`);
  }
  if (!equalComparable(parsed.inputs, SOURCE_CONTROL_WORKSPACE_INPUTS_V1)) {
    throw new Error(`${field}.inputs must be the exact required node-version input set`);
  }
  const setupNode = parsed.steps[0];
  if (
    setupNode?.name !== 'Setup Node.js' ||
    setupNode.shell !== undefined ||
    setupNode.run !== undefined ||
    !/^actions\/setup-node@[0-9a-f]{40}$/.test(setupNode.uses ?? '') ||
    !equalComparable(setupNode.with, SOURCE_CONTROL_WORKSPACE_SETUP_NODE_WITH_V1)
  ) {
    throw new Error(`${field}.steps[0] must be the pinned setup-node profile`);
  }
  const install = parsed.steps[1];
  if (
    install?.name !== 'Install immutable workspace dependencies' ||
    install.uses !== undefined ||
    install.with !== undefined ||
    install.shell !== 'bash' ||
    install.run !== SOURCE_CONTROL_WORKSPACE_INSTALL_V1
  ) {
    throw new Error(`${field}.steps[1] must be the exact immutable npm-ci profile`);
  }
  return parsed;
}

function parseCommand(value: unknown, field: string): SourceControlCommandLeafV1 {
  const record = requireRecord(value, field);
  assertExactKeys(record, ['id', 'name', 'npm_script'], field);
  const npmScript = requireString(record.npm_script, `${field}.npm_script`);
  if (!/^[a-z0-9][a-z0-9:._-]*$/.test(npmScript)) {
    throw new Error(`${field}.npm_script must be one canonical npm script name`);
  }
  return {
    id: requireString(record.id, `${field}.id`),
    name: requireString(record.name, `${field}.name`),
    npmScript,
    run: `npm run ${npmScript}`,
  };
}

function parseExecutionIdentity(value: unknown, field: string): SourceControlExecutionIdentityV1 {
  const record = requireRecord(value, field);
  if (record.kind === 'NO_COMMAND_CREDENTIALS_V1') {
    assertExactKeys(record, ['kind'], field);
    return { kind: record.kind };
  }
  if (record.kind !== 'GITHUB_READ_TOKEN_V1') {
    throw new Error(`${field}.kind must be NO_COMMAND_CREDENTIALS_V1 or GITHUB_READ_TOKEN_V1`);
  }
  assertExactKeys(record, ['kind', 'permissions', 'command_env'], field);
  const permissions = requireStringMap(record.permissions, `${field}.permissions`);
  const commandEnv = requireStringMap(record.command_env, `${field}.command_env`);
  if (!equalComparable(permissions, GITHUB_READ_TOKEN_PERMISSIONS_V1)) {
    throw new Error(`${field}.permissions must be the exact GitHub read-token grant set`);
  }
  if (!equalComparable(commandEnv, GITHUB_READ_TOKEN_COMMAND_ENV_V1)) {
    throw new Error(`${field}.command_env must bind the exact GitHub Actions read token`);
  }
  return {
    kind: record.kind,
    permissions: GITHUB_READ_TOKEN_PERMISSIONS_V1,
    commandEnv: GITHUB_READ_TOKEN_COMMAND_ENV_V1,
  };
}

function parseLeafJob(value: unknown, index: number): SourceControlLeafJobV1 {
  const field = `leaf_jobs[${index}]`;
  const record = requireRecord(value, field);
  assertExactKeys(
    record,
    ['role', 'workflow', 'job', 'runs_on', 'timeout_minutes', 'execution_identity', 'commands'],
    field,
  );
  if (!Array.isArray(record.commands) || record.commands.length === 0) {
    throw new Error(`${field}.commands must be one non-empty array`);
  }
  return {
    role: requireClosedValue(record.role, SOURCE_CONTROL_LEAF_ROLES_V1, `${field}.role`),
    workflow: requireRepositoryPath(record.workflow, `${field}.workflow`),
    job: requireString(record.job, `${field}.job`),
    runsOn: requireString(record.runs_on, `${field}.runs_on`),
    timeoutMinutes: requirePositiveInteger(record.timeout_minutes, `${field}.timeout_minutes`),
    executionIdentity: parseExecutionIdentity(
      record.execution_identity,
      `${field}.execution_identity`,
    ),
    commands: record.commands.map((command, commandIndex) =>
      parseCommand(command, `${field}.commands[${commandIndex}]`),
    ),
  };
}

function assertUnique(values: readonly string[], field: string): void {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length > 0) {
    throw new Error(
      `${field} must be unique; duplicates=${[...new Set(duplicates)].sort().join(',')}`,
    );
  }
}

export function parseSourceControlLeafCatalogV1(raw: unknown): SourceControlLeafCatalogV1 {
  const record = requireRecord(raw, 'source control leaf catalog');
  assertExactKeys(
    record,
    ['schema', 'workflow_closure', 'checkout_profile', 'bootstrap_action', 'leaf_jobs'],
    'source control leaf catalog',
  );
  if (record.schema !== SOURCE_CONTROL_LEAF_CATALOG_SCHEMA_V1) {
    throw new Error(
      `source control leaf catalog.schema must be ${SOURCE_CONTROL_LEAF_CATALOG_SCHEMA_V1}`,
    );
  }
  if (!Array.isArray(record.workflow_closure) || record.workflow_closure.length === 0) {
    throw new Error('source control leaf catalog.workflow_closure must be one non-empty array');
  }
  const workflowClosure = record.workflow_closure.map(
    (workflow, index): SourceControlWorkflowAuthorityV1 => {
      const field = `source control leaf catalog.workflow_closure[${index}]`;
      const workflowRecord = requireRecord(workflow, field);
      assertExactKeys(workflowRecord, ['path', 'permissions'], field);
      const permissions = requireStringMap(workflowRecord.permissions, `${field}.permissions`);
      if (!equalComparable(permissions, WORKFLOW_READ_ONLY_PERMISSIONS_V1)) {
        throw new Error(`${field}.permissions must be the exact workflow read-only grant set`);
      }
      return {
        path: requireRepositoryPath(workflowRecord.path, `${field}.path`),
        permissions: permissions as Readonly<Record<string, 'read'>>,
      };
    },
  );
  assertUnique(
    workflowClosure.map((workflow) => workflow.path),
    'source control leaf catalog.workflow_closure',
  );

  const checkout = requireRecord(record.checkout_profile, 'checkout_profile');
  assertExactKeys(checkout, ['kind', 'runner', 'uses', 'with'], 'checkout_profile');
  if (checkout.kind !== 'EVENT_HEAD_V1') {
    throw new Error('checkout_profile.kind must be EVENT_HEAD_V1');
  }
  const checkoutRunner = requireClosedValue(
    checkout.runner,
    EVENT_HEAD_RUNNER_ALLOWLIST_V1,
    'checkout_profile.runner',
  );
  const checkoutProfile = {
    kind: 'EVENT_HEAD_V1' as const,
    runner: checkoutRunner,
    uses: requireString(checkout.uses, 'checkout_profile.uses'),
    with: requireScalarMap(checkout.with, 'checkout_profile.with'),
  };
  if (!/^actions\/checkout@[0-9a-f]{40}$/.test(checkoutProfile.uses)) {
    throw new Error('checkout_profile.uses must pin actions/checkout to one full commit SHA');
  }
  if (!equalComparable(checkoutProfile.with, EVENT_HEAD_CHECKOUT_WITH_V1)) {
    throw new Error(
      'checkout_profile.with must bind the exact event head, full history, and disabled persisted credentials',
    );
  }

  const bootstrapAction = parseBootstrapAction(record.bootstrap_action);
  if (!Array.isArray(record.leaf_jobs) || record.leaf_jobs.length === 0) {
    throw new Error('source control leaf catalog.leaf_jobs must be one non-empty array');
  }
  const leafJobs = record.leaf_jobs.map(parseLeafJob);
  const actualRoles = leafJobs.map((job) => job.role).sort();
  const requiredRoles = [...SOURCE_CONTROL_LEAF_ROLES_V1].sort();
  if (!equalComparable(actualRoles, requiredRoles)) {
    throw new Error(
      `leaf job roles must equal the SourceControlLeafCatalogV1 required role set; actual=${actualRoles.join(
        ',',
      )}; required=${requiredRoles.join(',')}`,
    );
  }
  assertUnique(
    leafJobs.map((job) => job.role),
    'leaf job roles',
  );
  assertUnique(
    leafJobs.map((job) => `${job.workflow}#${job.job}`),
    'leaf job owners',
  );
  assertUnique(
    leafJobs.flatMap((job) => job.commands.map((command) => command.id)),
    'leaf command IDs',
  );
  assertUnique(
    leafJobs.flatMap((job) => job.commands.map((command) => command.npmScript)),
    'leaf npm scripts',
  );
  for (const job of leafJobs) {
    const roleContract = SOURCE_CONTROL_LEAF_ROLE_CONTRACT_V1[job.role];
    if (!workflowClosure.some((workflow) => workflow.path === job.workflow)) {
      throw new Error(`${job.workflow}#${job.job} is outside workflow_closure`);
    }
    if (job.runsOn !== checkoutProfile.runner) {
      throw new Error(
        `${job.workflow}#${job.job} must use the EVENT_HEAD_V1 runner ${checkoutProfile.runner}`,
      );
    }
    if (job.executionIdentity.kind !== roleContract.executionIdentity) {
      throw new Error(`${job.role} execution identity must be ${roleContract.executionIdentity}`);
    }
    if (job.commands.length !== roleContract.commands) {
      throw new Error(`${job.role} must own exactly ${roleContract.commands} command(s)`);
    }
  }
  const workflowPathsFromJobs = [...new Set(leafJobs.map((job) => job.workflow))].sort();
  const workflowPathsFromClosure = workflowClosure.map((workflow) => workflow.path).sort();
  if (!equalComparable(workflowPathsFromJobs, workflowPathsFromClosure)) {
    throw new Error('workflow_closure must equal the exact set of leaf owner workflows');
  }

  const catalog: SourceControlLeafCatalogV1 = {
    schema: record.schema,
    workflowClosure,
    checkoutProfile,
    bootstrapAction,
    leafJobs,
  };
  deepFreezeInPlace(catalog);
  return catalog;
}

function normalizedComparable(value: unknown, key: string | null = null): unknown {
  if (typeof value === 'string') {
    return key === 'run' ? value.replace(/\s+/g, ' ').trim() : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizedComparable(entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((entryKey) => [entryKey, normalizedComparable(value[entryKey], entryKey)]),
    );
  }
  return value;
}

function equalComparable(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizedComparable(left)) === JSON.stringify(normalizedComparable(right));
}

function describeComparable(value: unknown): string {
  return JSON.stringify(normalizedComparable(value));
}

function requireSurfaceDocument(surface: SourceControlYamlSurfaceV1): Record<string, unknown> {
  return requireRecord(surface.document, surface.path);
}

function workflowSteps(surface: SourceControlYamlSurfaceV1): SourceControlStepOccurrenceV1[] {
  const document = requireSurfaceDocument(surface);
  const jobs = requireRecord(document.jobs, `${surface.path}.jobs`);
  const occurrences: SourceControlStepOccurrenceV1[] = [];
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = requireRecord(rawJob, `${surface.path}.jobs.${jobId}`);
    if (!Array.isArray(job.steps)) {
      if (typeof job.uses === 'string') {
        continue;
      }
      throw new Error(`${surface.path}.jobs.${jobId}.steps must be an array`);
    }
    job.steps.forEach((rawStep, stepIndex) => {
      occurrences.push({
        surface,
        owner: jobId,
        stepIndex,
        step: requireRecord(rawStep, `${surface.path}.jobs.${jobId}.steps[${stepIndex}]`),
      });
    });
  }
  return occurrences;
}

function actionSteps(surface: SourceControlYamlSurfaceV1): SourceControlStepOccurrenceV1[] {
  const document = requireSurfaceDocument(surface);
  const runs = requireRecord(document.runs, `${surface.path}.runs`);
  if (!hasOwn(runs, 'steps')) {
    return [];
  }
  if (!Array.isArray(runs.steps)) {
    throw new Error(`${surface.path}.runs.steps must be an array`);
  }
  return runs.steps.map((rawStep, stepIndex) => ({
    surface,
    owner: 'runs',
    stepIndex,
    step: requireRecord(rawStep, `${surface.path}.runs.steps[${stepIndex}]`),
  }));
}

function allSurfaceSteps(
  surfaces: readonly SourceControlYamlSurfaceV1[],
): SourceControlStepOccurrenceV1[] {
  return surfaces.flatMap((surface) =>
    surface.kind === 'WORKFLOW' ? workflowSteps(surface) : actionSteps(surface),
  );
}

function expectedLeafJob(
  job: SourceControlLeafJobV1,
  catalog: SourceControlLeafCatalogV1,
): unknown {
  const commandSteps = job.commands.map((command) => ({
    name: command.name,
    run: command.run,
    ...(job.executionIdentity.kind === 'GITHUB_READ_TOKEN_V1'
      ? { env: job.executionIdentity.commandEnv }
      : {}),
  }));
  return {
    'runs-on': job.runsOn,
    'timeout-minutes': job.timeoutMinutes,
    ...(job.executionIdentity.kind === 'GITHUB_READ_TOKEN_V1'
      ? { permissions: job.executionIdentity.permissions }
      : {}),
    steps: [
      {
        uses: catalog.checkoutProfile.uses,
        with: catalog.checkoutProfile.with,
      },
      {
        name: catalog.bootstrapAction.invocationName,
        uses: catalog.bootstrapAction.uses,
        with: catalog.bootstrapAction.with,
      },
      ...commandSteps,
    ],
  };
}

function expectedBootstrapRuns(catalog: SourceControlLeafCatalogV1): unknown {
  return {
    using: 'composite',
    steps: catalog.bootstrapAction.steps.map((step) => ({
      name: step.name,
      ...(step.uses === undefined ? {} : { uses: step.uses }),
      ...(step.shell === undefined ? {} : { shell: step.shell }),
      ...(step.run === undefined ? {} : { run: step.run }),
      ...(step.with === undefined ? {} : { with: step.with }),
    })),
  };
}

function commandOccurs(run: string, command: string): boolean {
  return run.replace(/\s+/g, ' ').includes(command);
}

function readRootPackageScriptsV1(): Readonly<Record<string, string>> {
  const raw: unknown = JSON.parse(readFileSync(ROOT_PACKAGE_PATH, 'utf8'));
  const packageDocument = requireRecord(raw, 'package.json');
  const scripts = requireRecord(packageDocument.scripts, 'package.json.scripts');
  return Object.fromEntries(
    Object.entries(scripts).map(([name, command]) => [
      requireString(name, 'package.json.scripts key'),
      requireString(command, `package.json.scripts.${name}`),
    ]),
  );
}

/**
 * Compiles the catalog into the exact workflow and composite-action projection, then proves
 * global ownership closure. A catalog command embedded in a second workflow/action or hidden
 * inside a compound shell line is still an occurrence and therefore fails cardinality. Root npm
 * scripts are bound by exact name and may not acquire npm's implicit pre/post hook entrypoints.
 */
export function assertSourceControlLeafCatalogTopologyV1(
  catalog: SourceControlLeafCatalogV1,
  surfaces: readonly SourceControlYamlSurfaceV1[],
  packageScripts: Readonly<Record<string, string>> = readRootPackageScriptsV1(),
): void {
  assertUnique(
    surfaces.map((surface) => surface.path),
    'source control YAML surface paths',
  );
  const surfaceByPath = new Map(surfaces.map((surface) => [surface.path, surface]));
  const failures: string[] = [];
  for (const job of catalog.leafJobs) {
    for (const command of job.commands) {
      const implementation = packageScripts[command.npmScript];
      if (implementation === undefined) {
        failures.push(`${command.id} references missing npm script ${command.npmScript}`);
        continue;
      }
      for (const hookName of [`pre${command.npmScript}`, `post${command.npmScript}`]) {
        if (hasOwn(packageScripts, hookName)) {
          failures.push(`${command.id} must not acquire implicit npm hook ${hookName}`);
        }
      }
    }
  }

  for (const workflowAuthority of catalog.workflowClosure) {
    const surface = surfaceByPath.get(workflowAuthority.path);
    if (surface?.kind !== 'WORKFLOW') {
      failures.push(`workflow closure is missing ${workflowAuthority.path}`);
      continue;
    }
    const document = requireSurfaceDocument(surface);
    if (!equalComparable(document.permissions, workflowAuthority.permissions)) {
      failures.push(
        `${workflowAuthority.path} permissions differ: actual=${describeComparable(
          document.permissions,
        )} expected=${describeComparable(workflowAuthority.permissions)}`,
      );
    }
  }

  for (const job of catalog.leafJobs) {
    const workflow = surfaceByPath.get(job.workflow);
    if (workflow?.kind !== 'WORKFLOW') {
      failures.push(`leaf owner workflow is missing ${job.workflow}`);
      continue;
    }
    const document = requireSurfaceDocument(workflow);
    const jobs = requireRecord(document.jobs, `${job.workflow}.jobs`);
    const actual = jobs[job.job];
    const expected = expectedLeafJob(job, catalog);
    if (!equalComparable(actual, expected)) {
      failures.push(
        `${job.workflow}#${job.job} differs from catalog: actual=${describeComparable(
          actual,
        )} expected=${describeComparable(expected)}`,
      );
    }
  }

  const bootstrapSurface = surfaceByPath.get(catalog.bootstrapAction.path);
  if (bootstrapSurface?.kind !== 'ACTION') {
    failures.push(`bootstrap action closure is missing ${catalog.bootstrapAction.path}`);
  } else {
    const document = requireSurfaceDocument(bootstrapSurface);
    if (!equalComparable(document.runs, expectedBootstrapRuns(catalog))) {
      failures.push(
        `${catalog.bootstrapAction.path} runs projection differs from catalog: actual=${describeComparable(
          document.runs,
        )} expected=${describeComparable(expectedBootstrapRuns(catalog))}`,
      );
    }
    const actualInputs = requireRecord(document.inputs, `${catalog.bootstrapAction.path}.inputs`);
    const actualInputNames = Object.keys(actualInputs).sort();
    const expectedInputNames = Object.keys(catalog.bootstrapAction.inputs).sort();
    if (!equalComparable(actualInputNames, expectedInputNames)) {
      failures.push(
        `${catalog.bootstrapAction.path} input names differ: actual=${describeComparable(
          actualInputNames,
        )} expected=${describeComparable(expectedInputNames)}`,
      );
    }
    for (const inputName of expectedInputNames) {
      const actualInput = requireRecord(
        actualInputs[inputName],
        `${catalog.bootstrapAction.path}.inputs.${inputName}`,
      );
      if (actualInput.required !== true) {
        failures.push(`${catalog.bootstrapAction.path} input ${inputName} must remain required`);
      }
    }
  }

  const steps = allSurfaceSteps(surfaces);
  for (const job of catalog.leafJobs) {
    for (const command of job.commands) {
      const occurrences = steps.filter(
        (occurrence) =>
          typeof occurrence.step.run === 'string' &&
          commandOccurs(occurrence.step.run, command.run),
      );
      const expectedStepIndex =
        2 + job.commands.findIndex((candidate) => candidate.id === command.id);
      if (
        occurrences.length !== 1 ||
        occurrences[0]?.surface.path !== job.workflow ||
        occurrences[0]?.owner !== job.job ||
        occurrences[0]?.stepIndex !== expectedStepIndex ||
        occurrences[0]?.step.run !== command.run
      ) {
        failures.push(
          `${command.id} must have one atomic owner at ${job.workflow}#${job.job}[${expectedStepIndex}]; occurrences=${occurrences
            .map(
              (occurrence) =>
                `${occurrence.surface.path}#${occurrence.owner}[${occurrence.stepIndex}]`,
            )
            .join(',')}`,
        );
      }
    }
  }

  const bootstrapOccurrences = steps.filter(
    (occurrence) => occurrence.step.uses === catalog.bootstrapAction.uses,
  );
  const expectedBootstrapOwners = catalog.leafJobs
    .map((job) => `${job.workflow}#${job.job}[1]`)
    .sort();
  const actualBootstrapOwners = bootstrapOccurrences
    .map((occurrence) => `${occurrence.surface.path}#${occurrence.owner}[${occurrence.stepIndex}]`)
    .sort();
  if (!equalComparable(actualBootstrapOwners, expectedBootstrapOwners)) {
    failures.push(
      `${catalog.bootstrapAction.id} owners differ: actual=${describeComparable(
        actualBootstrapOwners,
      )} expected=${describeComparable(expectedBootstrapOwners)}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`SourceControlLeafCatalogV1 topology failed:\n${failures.join('\n')}`);
  }
}

export function loadSourceControlLeafCatalogV1(): SourceControlLeafCatalogV1 {
  return parseCanonicalSourceControlLeafCatalogBytesV1(
    readFileSync(SOURCE_CONTROL_LEAF_CATALOG_PATH, 'utf8'),
  );
}

export function sourceControlLeafJobByRoleV1(
  catalog: SourceControlLeafCatalogV1,
  role: SourceControlLeafRoleV1,
): SourceControlLeafJobV1 {
  const matches = catalog.leafJobs.filter((job) => job.role === role);
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`source control leaf role ${role} resolved ${matches.length} owners`);
  }
  return matches[0];
}

export const SOURCE_CONTROL_LEAF_CATALOG_V1 = loadSourceControlLeafCatalogV1();
export const SOURCE_INVENTORY_STATIC_CI_JOB_V1 = sourceControlLeafJobByRoleV1(
  SOURCE_CONTROL_LEAF_CATALOG_V1,
  'SOURCE_INVENTORY_STATIC_CI_V1',
).job;
