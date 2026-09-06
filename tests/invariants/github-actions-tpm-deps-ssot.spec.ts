import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

const REPO_ROOT = join(__dirname, '..', '..');
const TPM_ACTION = '.github/actions/install-tpm-build-dependencies/action.yml';
const WORKFLOWS = [
  '.github/workflows/ci-affected.yml',
  '.github/workflows/sens-api-gateway-ci.yml',
] as const;
const ACTION_REF = 'uses: ./.github/actions/install-tpm-build-dependencies';

const read = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), 'utf8');

describe('GitHub Actions TPM dependency SSoT', () => {
  it('keeps TPM apt behavior in one bounded local action', () => {
    expect(existsSync(join(REPO_ROOT, TPM_ACTION))).toBe(true);

    const action = read(TPM_ACTION);
    expect(action).toContain('Acquire::Retries=5');
    expect(action).toContain('Acquire::http::Timeout=20');
    expect(action).toContain('Acquire::https::Timeout=20');
    expect(action).toContain('Dpkg::Lock::Timeout=120');
    expect(action).toContain('timeout 5m apt-get');
    expect(action).toContain('timeout 20m apt-get');
    expect(action).toContain('pkg-config libtss2-dev');
    expect(action).not.toContain('continue-on-error');
  });

  it('routes every TPM dependency install through the local action', () => {
    const workflowText = WORKFLOWS.map(read).join('\n');
    const actionRefs = workflowText.match(new RegExp(ACTION_REF, 'g')) ?? [];

    expect(actionRefs).toHaveLength(5);
    expect(workflowText).not.toMatch(/sudo\s+apt-get\s+update/);
    expect(workflowText).not.toMatch(
      /apt-get\s+install\s+-y\s+--no-install-recommends\s+pkg-config\s+libtss2-dev/,
    );
  });

  it('installs TPM dependencies in the required hosted Rust lane', () => {
    const workflow = parse(read(WORKFLOWS[0])) as {
      jobs: Record<string, { steps: Array<{ uses?: string; if?: string }> }>;
    };
    const hostedValidation = workflow.jobs['hosted-validation'];
    if (!hostedValidation) {
      throw new Error('The required hosted-validation job must exist');
    }
    const steps = hostedValidation.steps;
    expect(steps.filter((step) => step.uses === './.github/actions/install-tpm-build-dependencies'))
      .toEqual([{ uses: './.github/actions/install-tpm-build-dependencies', if: "matrix.lane == 'rust'" }]);
  });
});
