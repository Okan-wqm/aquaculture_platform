import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import * as YAML from 'yaml';

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci-affected.yml');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'ci', 'markdownlint-changed.mjs');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('markdownlint immutable event range', () => {
  it('binds pull-request linting to the event head instead of the synthetic merge checkout', () => {
    const workflow = YAML.parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;
    const step = workflow.jobs?.['docs-check']?.steps?.find(
      (candidate) => candidate.name === 'Check markdown files',
    );

    expect(step?.env).toEqual({
      MARKDOWNLINT_BASE_REF:
        "${{ github.event.pull_request.base.sha || (github.event.before != '0000000000000000000000000000000000000000' && github.event.before) || 'HEAD^' }}",
      MARKDOWNLINT_HEAD_REF: '${{ github.event.pull_request.head.sha || github.sha }}',
    });
  });

  it('excludes base-only docs from a queued pull request even when checkout points at a merge commit', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'aqua-markdownlint-event-range-'));
    try {
      const fixtureScript = join(fixtureRoot, 'scripts', 'ci', 'markdownlint-changed.mjs');
      const markdownlintStub = join(fixtureRoot, 'node_modules', '.bin', 'markdownlint');
      mkdirSync(join(fixtureRoot, 'scripts', 'ci'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'docs', 'plans'), { recursive: true });
      copyFileSync(SCRIPT_PATH, fixtureScript);
      writeFileSync(join(fixtureRoot, '.prettierrc'), '{"printWidth":100}\n', 'utf8');
      writeFileSync(
        markdownlintStub,
        "#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join('\\n'));\n",
        'utf8',
      );
      chmodSync(markdownlintStub, 0o755);

      git(fixtureRoot, 'init', '--initial-branch=main');
      git(fixtureRoot, 'config', 'user.name', 'Range Contract');
      git(fixtureRoot, 'config', 'user.email', 'range-contract@example.invalid');
      writeFileSync(join(fixtureRoot, 'docs', 'plans', 'base.md'), '# Base\n', 'utf8');
      git(fixtureRoot, 'add', 'docs/plans/base.md');
      git(fixtureRoot, 'commit', '-m', 'base');
      const base = git(fixtureRoot, 'rev-parse', 'HEAD');

      git(fixtureRoot, 'switch', '-c', 'plan');
      writeFileSync(join(fixtureRoot, 'docs', 'plans', 'plan.md'), '# Plan\n', 'utf8');
      writeFileSync(join(fixtureRoot, 'docs', 'root-plan.md'), '# Root plan\n', 'utf8');
      git(fixtureRoot, 'add', 'docs/plans/plan.md', 'docs/root-plan.md');
      git(fixtureRoot, 'commit', '-m', 'plan');
      const eventHead = git(fixtureRoot, 'rev-parse', 'HEAD');

      git(fixtureRoot, 'switch', 'main');
      writeFileSync(join(fixtureRoot, 'docs', 'plans', 'unrelated.md'), '# Unrelated\n', 'utf8');
      git(fixtureRoot, 'add', 'docs/plans/unrelated.md');
      git(fixtureRoot, 'commit', '-m', 'advance main');
      git(fixtureRoot, 'merge', '--no-ff', 'plan', '-m', 'synthetic merge');

      const lintTargets = execFileSync(process.execPath, [fixtureScript], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          MARKDOWNLINT_BASE_REF: base,
          MARKDOWNLINT_HEAD_REF: eventHead,
        },
      }).split('\n');

      expect(lintTargets).toContain('docs/plans/plan.md');
      expect(lintTargets).toContain('docs/root-plan.md');
      expect(lintTargets).not.toContain('docs/plans/unrelated.md');
      expect(lintTargets).not.toContain('docs/plans/base.md');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
