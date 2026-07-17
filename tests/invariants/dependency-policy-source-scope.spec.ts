import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('dependency policy source scope', () => {
  it('uses the Git source set so ignored worktrees cannot affect policy results', () => {
    const gate = readFileSync(resolve(REPO_ROOT, 'scripts/ci/check-dependency-policy.mjs'), 'utf8');

    expect(gate).toContain("'ls-files', '--cached', '--others', '--exclude-standard', '-z'");
    expect(gate).toContain('for (const path of repositorySourceFiles())');
    expect(gate).not.toContain('walk(repoRoot)');
  });
});
