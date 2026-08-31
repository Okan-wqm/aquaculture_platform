import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONTRACT_PROJECT_PATH = join(REPO_ROOT, 'tests/admin-route-contract/project.json');
const AFFECTED_POLICY_PATH = join(REPO_ROOT, 'scripts/ci/affected-target-policy.json');
const AFFECTED_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/ci-affected.yml');
const CONTRACT_COMMAND =
  'node tools/toolchain/run.mjs jest --config apps/admin-api-service/jest.config.ts ' +
  '--runTestsByPath apps/admin-api-service/src/__tests__/contract-validation.spec.ts --runInBand';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function recordField(owner: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = owner[field];
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

describe('admin route contract CI boundary', () => {
  it('models the backend and frontend as dependencies of one dedicated contract project', () => {
    expect(existsSync(CONTRACT_PROJECT_PATH)).toBe(true);
    if (!existsSync(CONTRACT_PROJECT_PATH)) return;

    const project = readJsonObject(CONTRACT_PROJECT_PATH);
    expect(project.name).toBe('admin-route-contract');
    expect(project.implicitDependencies).toEqual(['admin-api-service', 'admin-panel']);

    const targets = recordField(project, 'targets');
    const contractTarget = recordField(targets, 'test:contract');
    expect(contractTarget.executor).toBe('nx:run-commands');
    expect(contractTarget.cache).toBe(true);
    expect(contractTarget.inputs).toEqual([
      'default',
      '^default',
      '{workspaceRoot}/apps/admin-api-service/jest.config.ts',
      '{workspaceRoot}/jest.preset.js',
    ]);
    expect(recordField(contractTarget, 'options').command).toBe(CONTRACT_COMMAND);
  });

  it('keeps the contract target strict and blocking in the affected test job', () => {
    const policy = readJsonObject(AFFECTED_POLICY_PATH);
    const targets = recordField(policy, 'targets');
    const contractPolicy = recordField(targets, 'test:contract');
    expect(recordField(contractPolicy, 'knownUnstableProjects')).toEqual({});

    const workflow = readFileSync(AFFECTED_WORKFLOW_PATH, 'utf8');
    const regularTestIndex = workflow.indexOf('- name: Run tests (affected only)');
    const contractStepIndex = workflow.indexOf(
      '- name: Run admin route contract (affected, strict)',
    );
    const nextStepIndex = workflow.indexOf('\n      - name:', contractStepIndex + 1);
    const contractStep = workflow.slice(
      contractStepIndex,
      nextStepIndex === -1 ? undefined : nextStepIndex,
    );

    expect(contractStepIndex).toBeGreaterThan(regularTestIndex);
    expect(contractStep).toContain(
      'bash scripts/ci/affected-target-policy.sh --target test:contract --base "$BASE_REF" --head "$HEAD_REF" --parallel 1',
    );
    expect(contractStep).not.toContain('continue-on-error');
  });
});
