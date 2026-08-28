import { execFileSync, spawnSync } from 'node:child_process';
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

  // E17-a — a gate must not bill a PR for debt it did not create. Touching one
  // comment line in a 70KB contract doc used to surface every pre-existing
  // MD013 violation in that file and block the PR; the author's only "fix"
  // would be reflowing prose they never wrote — churn on the very SSoT the
  // doc is. New lines are enforced; inherited debt is reported, attributed,
  // and not billed (the format gate's base-debt quarantine, for markdown).
  it('bills findings on written lines and reports inherited debt without failing', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'aqua-markdownlint-linescope-'));
    try {
      const fixtureScript = join(fixtureRoot, 'scripts', 'ci', 'markdownlint-changed.mjs');
      const markdownlintStub = join(fixtureRoot, 'node_modules', '.bin', 'markdownlint');
      mkdirSync(join(fixtureRoot, 'scripts', 'ci'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'docs'), { recursive: true });
      copyFileSync(SCRIPT_PATH, fixtureScript);
      writeFileSync(join(fixtureRoot, '.prettierrc'), '{"printWidth":100}\n', 'utf8');
      // Stub linter: reports a violation on EVERY line of every target, so the
      // only thing under test is which findings survive the line filter.
      writeFileSync(
        markdownlintStub,
        [
          '#!/usr/bin/env node',
          "const fs = require('node:fs');",
          "const files = process.argv.slice(2).filter((a) => a.endsWith('.md'));",
          'for (const file of files) {',
          "  const lines = fs.readFileSync(file, 'utf8').split('\\n');",
          '  lines.forEach((_, index) => {',
          '    process.stderr.write(`${file}:${index + 1}:1 MD013/line-length stub\\n`);',
          '  });',
          '}',
          'process.exit(1);',
        ].join('\n') + '\n',
        'utf8',
      );
      chmodSync(markdownlintStub, 0o755);

      git(fixtureRoot, 'init', '--initial-branch=main');
      git(fixtureRoot, 'config', 'user.name', 'Line Scope');
      git(fixtureRoot, 'config', 'user.email', 'line-scope@example.invalid');
      writeFileSync(join(fixtureRoot, 'docs', 'legacy.md'), '# Legacy\nold line\n', 'utf8');
      git(fixtureRoot, 'add', 'docs/legacy.md');
      git(fixtureRoot, 'commit', '-m', 'legacy doc with inherited debt');
      const base = git(fixtureRoot, 'rev-parse', 'HEAD');

      // Touch the legacy doc WITHOUT adding lines: pure deletion-free rename of
      // nothing — append a line, then remove it, leaving content identical is
      // not expressible; instead commit a change that only edits an existing
      // line's neighbour file, so legacy.md is changed by a no-op comment.
      writeFileSync(
        join(fixtureRoot, 'docs', 'legacy.md'),
        '# Legacy\nold line\n<!-- marker -->\n',
        'utf8',
      );
      git(fixtureRoot, 'add', 'docs/legacy.md');
      git(fixtureRoot, 'commit', '-m', 'add one marker line');
      const head = git(fixtureRoot, 'rev-parse', 'HEAD');

      const run = (): { status: number | null; stdout: string; stderr: string } => {
        const result = spawnSync(process.execPath, [fixtureScript], {
          cwd: fixtureRoot,
          encoding: 'utf8',
          env: { ...process.env, MARKDOWNLINT_BASE_REF: base, MARKDOWNLINT_HEAD_REF: head },
        });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      };

      const billed = run();
      // Line 3 is the one this change wrote → billed → gate fails on it.
      expect(billed.stderr).toContain('docs/legacy.md:3:1');
      // Lines 1-2 are inherited debt → reported, not billed.
      expect(billed.stderr).not.toContain('docs/legacy.md:1:1');
      expect(billed.stdout + billed.stderr).toContain('docs/legacy.md');
      expect(billed.status).toBe(1);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
