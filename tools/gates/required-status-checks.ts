#!/usr/bin/env ts-node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './lib/repo-root';

interface RequiredStatusChecksManifest {
  schema_version: number;
  repository: string;
  branch: string;
  finding_ids: string[];
  branch_protection: {
    enforce_admins: boolean;
  };
  required_status_checks: {
    strict: boolean;
    contexts: string[];
    checks: RequiredStatusCheck[];
  };
  ci_affected_required_path_filters: string[];
  workflow_contracts: WorkflowContract[];
}

interface WorkflowContract {
  workflow: string;
  contexts: WorkflowContextContract[];
}

interface WorkflowContextContract {
  context: string;
  job_id: string;
  requires_jobs: string[];
  required_markers: string[];
}

interface RequiredStatusCheck {
  context: string;
  app_id: number;
}

interface GithubRequiredStatusChecksResponse {
  strict: boolean;
  contexts: string[];
  checks: GithubRequiredStatusCheck[];
}

interface GithubRequiredStatusCheck {
  context: string;
  app_id: number;
}

interface GithubBranchProtectionResponse {
  required_status_checks: GithubRequiredStatusChecksResponse;
  enforce_admins: {
    enabled: boolean;
  };
}

const MANIFEST_PATH = '.github/manifests/main-required-status-checks.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be a string array`);
  }
  return value;
}

function requireRecordArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${field} must be an object array`);
  }
  return value;
}

function parseWorkflowContext(
  value: Record<string, unknown>,
  field: string,
): WorkflowContextContract {
  return {
    context: requireString(value.context, `${field}.context`),
    job_id: requireString(value.job_id, `${field}.job_id`),
    requires_jobs: requireStringArray(value.requires_jobs, `${field}.requires_jobs`),
    required_markers: requireStringArray(value.required_markers, `${field}.required_markers`),
  };
}

function parseWorkflowContract(value: Record<string, unknown>, index: number): WorkflowContract {
  const field = `workflow_contracts[${index}]`;
  return {
    workflow: requireString(value.workflow, `${field}.workflow`),
    contexts: requireRecordArray(value.contexts, `${field}.contexts`).map((context, contextIndex) =>
      parseWorkflowContext(context, `${field}.contexts[${contextIndex}]`),
    ),
  };
}

function parseManifest(raw: unknown): RequiredStatusChecksManifest {
  if (!isRecord(raw)) {
    throw new Error('manifest must be a JSON object');
  }
  if (!isRecord(raw.required_status_checks)) {
    throw new Error('required_status_checks must be a JSON object');
  }
  if (!isRecord(raw.branch_protection)) {
    throw new Error('branch_protection must be a JSON object');
  }

  return {
    schema_version: requireNumber(raw.schema_version, 'schema_version'),
    repository: requireString(raw.repository, 'repository'),
    branch: requireString(raw.branch, 'branch'),
    finding_ids: requireStringArray(raw.finding_ids, 'finding_ids'),
    branch_protection: {
      enforce_admins: requireBoolean(
        raw.branch_protection.enforce_admins,
        'branch_protection.enforce_admins',
      ),
    },
    required_status_checks: {
      strict: requireBoolean(raw.required_status_checks.strict, 'required_status_checks.strict'),
      contexts: requireStringArray(
        raw.required_status_checks.contexts,
        'required_status_checks.contexts',
      ),
      checks: requireRecordArray(
        raw.required_status_checks.checks,
        'required_status_checks.checks',
      ).map((check, index) => ({
        context: requireString(check.context, `required_status_checks.checks[${index}].context`),
        app_id: requireNumber(check.app_id, `required_status_checks.checks[${index}].app_id`),
      })),
    },
    ci_affected_required_path_filters: requireStringArray(
      raw.ci_affected_required_path_filters,
      'ci_affected_required_path_filters',
    ),
    workflow_contracts: requireRecordArray(raw.workflow_contracts, 'workflow_contracts').map(
      parseWorkflowContract,
    ),
  };
}

function readManifest(): RequiredStatusChecksManifest {
  const raw: unknown = JSON.parse(readFileSync(join(REPO_ROOT, MANIFEST_PATH), 'utf8'));
  return parseManifest(raw);
}

function workflowJobBlock(source: string, jobId: string): string | null {
  const marker = `\n  ${jobId}:\n`;
  const start = source.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const afterStart = start + marker.length;
  const rest = source.slice(afterStart);
  const nextJob = rest.search(/\n  [A-Za-z0-9_-]+:\n/);
  const end = nextJob === -1 ? source.length : afterStart + nextJob;
  return source.slice(start, end);
}

function includesNeed(jobBlock: string, dependency: string): boolean {
  return jobBlock.includes(`- ${dependency}`) || jobBlock.includes(`[${dependency}]`);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function missingValues(expected: string[], actual: string[]): string[] {
  const actualSet = new Set(actual);
  return expected.filter((value) => !actualSet.has(value));
}

function unexpectedValues(expected: string[], actual: string[]): string[] {
  const expectedSet = new Set(expected);
  return actual.filter((value) => !expectedSet.has(value));
}

function checkStaticContract(manifest: RequiredStatusChecksManifest): string[] {
  const errors: string[] = [];
  const requiredContexts = [
    'sens-enterprise-summary',
    'merge-gate',
    'aria-merge-authority',
    'build-status',
  ];

  if (manifest.schema_version !== 1) {
    errors.push(`schema_version must be 1, got ${manifest.schema_version}`);
  }
  if (!manifest.finding_ids.includes('EDGE-CRITICAL-001')) {
    errors.push('manifest must trace EDGE-CRITICAL-001');
  }
  if (!manifest.required_status_checks.strict) {
    errors.push('main required status checks must use strict mode');
  }
  if (!manifest.branch_protection.enforce_admins) {
    errors.push('main branch protection must enforce administrators');
  }
  const manifestContexts = sortedUnique(manifest.required_status_checks.contexts);
  if (manifestContexts.length !== manifest.required_status_checks.contexts.length) {
    errors.push('required_status_checks.contexts must not contain duplicate entries');
  }
  for (const requiredContext of missingValues(requiredContexts, manifestContexts)) {
    errors.push(`required_status_checks.contexts missing ${requiredContext}`);
  }
  for (const unexpectedContext of unexpectedValues(requiredContexts, manifestContexts)) {
    errors.push(`required_status_checks.contexts contains unmanaged context ${unexpectedContext}`);
  }
  const manifestChecks = [...manifest.required_status_checks.checks].sort(
    (left, right) => left.context.localeCompare(right.context) || left.app_id - right.app_id,
  );
  if (
    JSON.stringify(manifestChecks.map((check) => check.context)) !==
    JSON.stringify(manifestContexts)
  ) {
    errors.push('required_status_checks.checks must bind every context exactly once');
  }
  if (manifestChecks.some((check) => !Number.isInteger(check.app_id) || check.app_id <= 0)) {
    errors.push('required_status_checks.checks app_id values must be positive integers');
  }

  const ciAffectedPath = '.github/workflows/ci-affected.yml';
  const ciAffected = readFileSync(join(REPO_ROOT, ciAffectedPath), 'utf8');
  if (!ciAffected.includes('pull_request:') || !ciAffected.includes('branches: [main, develop]')) {
    errors.push(`${ciAffectedPath} must run on pull_request to main`);
  }
  for (const filter of manifest.ci_affected_required_path_filters) {
    if (!ciAffected.includes(`'${filter}'`) && !ciAffected.includes(`"${filter}"`)) {
      errors.push(`${ciAffectedPath} deploy-config filter missing ${filter}`);
    }
  }

  const contractedContexts = new Set<string>();
  for (const workflowContract of manifest.workflow_contracts) {
    const workflow = readFileSync(join(REPO_ROOT, workflowContract.workflow), 'utf8');
    for (const contextContract of workflowContract.contexts) {
      contractedContexts.add(contextContract.context);
      const block = workflowJobBlock(workflow, contextContract.job_id);
      if (block === null) {
        errors.push(`${workflowContract.workflow} missing job ${contextContract.job_id}`);
        continue;
      }
      for (const dependency of contextContract.requires_jobs) {
        if (!includesNeed(block, dependency)) {
          errors.push(
            `${workflowContract.workflow} job ${contextContract.job_id} missing needs entry ${dependency}`,
          );
        }
      }
      for (const marker of contextContract.required_markers) {
        if (!block.includes(marker)) {
          errors.push(
            `${workflowContract.workflow} job ${contextContract.job_id} missing marker ${marker}`,
          );
        }
      }
    }
  }

  for (const requiredContext of manifest.required_status_checks.contexts) {
    if (!contractedContexts.has(requiredContext)) {
      errors.push(`required context ${requiredContext} has no workflow contract`);
    }
  }

  return errors;
}

function parseGithubRequiredStatusChecksResponse(
  value: unknown,
  field: string,
): GithubRequiredStatusChecksResponse {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return {
    strict: requireBoolean(value.strict, `${field}.strict`),
    contexts: requireStringArray(value.contexts, `${field}.contexts`),
    checks: requireRecordArray(value.checks, `${field}.checks`).map((check, index) => ({
      context: requireString(check.context, `${field}.checks[${index}].context`),
      app_id: requireNumber(check.app_id, `${field}.checks[${index}].app_id`),
    })),
  };
}

function parseGithubBranchProtectionResponse(raw: string): GithubBranchProtectionResponse {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('GitHub branch protection response must be an object');
  }
  if (!isRecord(parsed.enforce_admins)) {
    throw new Error('github.enforce_admins must be an object');
  }
  return {
    required_status_checks: parseGithubRequiredStatusChecksResponse(
      parsed.required_status_checks,
      'github.required_status_checks',
    ),
    enforce_admins: {
      enabled: requireBoolean(parsed.enforce_admins.enabled, 'github.enforce_admins.enabled'),
    },
  };
}

function checkLiveContract(manifest: RequiredStatusChecksManifest): string[] {
  const endpoint = `repos/${manifest.repository}/branches/${manifest.branch}/protection`;
  const result = spawnSync('gh', ['api', endpoint], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    if (stderr.includes('HTTP 404')) {
      return [`${manifest.branch} branch protection is disabled or unreadable: ${stderr}`];
    }
    if (stderr.includes('HTTP 401') || stderr.includes('HTTP 403')) {
      return [`branch protection lookup permission denied: ${stderr}`];
    }
    return [`branch protection lookup failed: ${stderr || 'gh api exited non-zero'}`];
  }

  let response: GithubBranchProtectionResponse;
  try {
    response = parseGithubBranchProtectionResponse(result.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`branch protection response parse failed: ${message}`];
  }

  const errors: string[] = [];
  if (response.enforce_admins.enabled !== manifest.branch_protection.enforce_admins) {
    errors.push(
      `GitHub enforce_admins.enabled=${response.enforce_admins.enabled}, manifest enforce_admins=${manifest.branch_protection.enforce_admins}`,
    );
  }
  if (response.required_status_checks.strict !== manifest.required_status_checks.strict) {
    errors.push(
      `GitHub strict=${response.required_status_checks.strict}, manifest strict=${manifest.required_status_checks.strict}`,
    );
  }

  const expectedContexts = sortedUnique(manifest.required_status_checks.contexts);
  const liveContexts = [...response.required_status_checks.contexts].sort((left, right) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(liveContexts) !== JSON.stringify(expectedContexts)) {
    errors.push(
      `GitHub raw required status contexts=${JSON.stringify(liveContexts)}, manifest contexts=${JSON.stringify(expectedContexts)}`,
    );
  }
  for (const missingContext of missingValues(expectedContexts, liveContexts)) {
    errors.push(`GitHub required status checks missing ${missingContext}`);
  }
  for (const unmanagedContext of unexpectedValues(expectedContexts, liveContexts)) {
    errors.push(`GitHub required status checks contains unmanaged context ${unmanagedContext}`);
  }
  const expectedChecks = [...manifest.required_status_checks.checks].sort(
    (left, right) => left.context.localeCompare(right.context) || left.app_id - right.app_id,
  );
  const liveChecks = [...response.required_status_checks.checks].sort(
    (left, right) => left.context.localeCompare(right.context) || left.app_id - right.app_id,
  );
  if (JSON.stringify(liveChecks) !== JSON.stringify(expectedChecks)) {
    errors.push(
      `GitHub required status check app bindings=${JSON.stringify(liveChecks)}, manifest checks=${JSON.stringify(expectedChecks)}`,
    );
  }
  return errors;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const live = args.has('--live');
  const unknownArgs = [...args].filter((arg) => arg !== '--live');
  if (unknownArgs.length > 0) {
    process.stderr.write(`required-status-checks: unknown args: ${unknownArgs.join(', ')}\n`);
    process.exit(2);
  }

  let manifest: RequiredStatusChecksManifest;
  try {
    manifest = readManifest();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`required-status-checks: manifest parse failed: ${message}\n`);
    process.exit(1);
  }

  const staticErrors = checkStaticContract(manifest);
  if (staticErrors.length > 0) {
    process.stderr.write(
      `required-status-checks: static contract failed\n${staticErrors.join('\n')}\n`,
    );
    process.exit(1);
  }

  if (live) {
    const liveErrors = checkLiveContract(manifest);
    if (liveErrors.length > 0) {
      process.stderr.write(
        `required-status-checks: live GitHub contract failed\n${liveErrors.join('\n')}\n`,
      );
      process.exit(1);
    }
    process.stdout.write('required-status-checks: live GitHub contract ok\n');
    return;
  }

  process.stdout.write('required-status-checks: static contract ok\n');
}

main();
