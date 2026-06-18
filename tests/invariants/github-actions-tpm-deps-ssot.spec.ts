import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const TPM_ACTION = '.github/actions/install-tpm-build-dependencies/action.yml';
const WORKFLOWS = [
  '.github/workflows/ci-affected.yml',
  '.github/workflows/sens-api-gateway-ci.yml',
];
const ACTION_REF = 'uses: ./.github/actions/install-tpm-build-dependencies';

const read = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), 'utf8');

describe('GitHub Actions TPM dependency SSoT', () => {
  it('keeps TPM apt behavior in one bounded local action', () => {
    expect(existsSync(join(REPO_ROOT, TPM_ACTION))).toBe(true);

    const action = read(TPM_ACTION);
    expect(action).toContain('Acquire::Retries=3');
    expect(action).toContain('Dpkg::Lock::Timeout=120');
    expect(action).toContain('timeout 5m apt-get');
    expect(action).toContain('timeout 10m apt-get');
    expect(action).toContain('pkg-config libtss2-dev');
    expect(action).not.toContain('continue-on-error');
  });

  it('routes every TPM dependency install through the local action', () => {
    const workflowText = WORKFLOWS.map(read).join('\n');
    const actionRefs = workflowText.match(new RegExp(ACTION_REF, 'g')) ?? [];

    expect(actionRefs).toHaveLength(4);
    expect(workflowText).not.toMatch(/sudo\s+apt-get\s+update/);
    expect(workflowText).not.toMatch(
      /apt-get\s+install\s+-y\s+--no-install-recommends\s+pkg-config\s+libtss2-dev/,
    );
  });
});
