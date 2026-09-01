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
  it('uses the detect-changes immutable range instead of event-specific refs', () => {
    const workflow = YAML.parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow;
    const step = workflow.jobs?.['docs-check']?.steps?.find(
      (candidate) => candidate.name === 'Check markdown files',
    );

    expect(step?.env).toEqual({
      MARKDOWNLINT_BASE_REF: '${{ needs.detect-changes.outputs.base_sha }}',
      MARKDOWNLINT_HEAD_REF: '${{ needs.detect-changes.outputs.head_sha }}',
    });
    expect(Object.values(step?.env ?? {}).join('\n')).not.toContain('github.event');
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
      writeFileSync(join(fixtureRoot, 'docs', 'plans', 'shared.md'), '# Shared\n', 'utf8');
      git(fixtureRoot, 'add', 'docs/plans/base.md', 'docs/plans/shared.md');
      git(fixtureRoot, 'commit', '-m', 'base');

      git(fixtureRoot, 'switch', '-c', 'plan');
      writeFileSync(join(fixtureRoot, 'docs', 'plans', 'plan.md'), '# Plan\n', 'utf8');
      writeFileSync(join(fixtureRoot, 'docs', 'root-plan.md'), '# Root plan\n', 'utf8');
      git(fixtureRoot, 'add', 'docs/plans/plan.md', 'docs/root-plan.md');
      git(fixtureRoot, 'commit', '-m', 'plan');
      const eventHead = git(fixtureRoot, 'rev-parse', 'HEAD');

      git(fixtureRoot, 'switch', 'main');
      writeFileSync(join(fixtureRoot, 'docs', 'plans', 'unrelated.md'), '# Unrelated\n', 'utf8');
      writeFileSync(join(fixtureRoot, 'docs', 'plans', 'shared.md'), '# Main advance\n', 'utf8');
      git(fixtureRoot, 'add', 'docs/plans/unrelated.md', 'docs/plans/shared.md');
      git(fixtureRoot, 'commit', '-m', 'advance main');
      const advancedMain = git(fixtureRoot, 'rev-parse', 'HEAD');
      git(fixtureRoot, 'merge', '--no-ff', 'plan', '-m', 'synthetic merge');

      const lintTargets = execFileSync(process.execPath, [fixtureScript], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          MARKDOWNLINT_BASE_REF: advancedMain,
          MARKDOWNLINT_HEAD_REF: eventHead,
        },
      }).split('\n');

      expect(lintTargets).toContain('docs/plans/plan.md');
      expect(lintTargets).toContain('docs/root-plan.md');
      expect(lintTargets).not.toContain('docs/plans/unrelated.md');
      expect(lintTargets).not.toContain('docs/plans/base.md');
      expect(lintTargets).not.toContain('docs/plans/shared.md');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('accepts only the Git empty tree as a full-rollout baseline snapshot', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'aqua-markdownlint-empty-tree-range-'));
    try {
      const fixtureScript = join(fixtureRoot, 'scripts', 'ci', 'markdownlint-changed.mjs');
      const markdownlintStub = join(fixtureRoot, 'node_modules', '.bin', 'markdownlint');
      mkdirSync(join(fixtureRoot, 'scripts', 'ci'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'docs'), { recursive: true });
      copyFileSync(SCRIPT_PATH, fixtureScript);
      writeFileSync(join(fixtureRoot, '.prettierrc'), '{"printWidth":100}\n', 'utf8');
      writeFileSync(
        markdownlintStub,
        [
          '#!/usr/bin/env node',
          "const fs = require('node:fs');",
          "const mode = process.env.MARKDOWNLINT_STUB_MODE ?? 'findings';",
          "const outputIndex = process.argv.indexOf('--output');",
          'const outputPath = process.argv[outputIndex + 1];',
          'if (!outputPath) process.exit(4);',
          "if (mode === 'clean') {",
          "  fs.writeFileSync(outputPath, '');",
          '  process.exit(0);',
          '}',
          "if (mode === 'malformed') {",
          "  fs.writeFileSync(outputPath, '{not-json');",
          '  process.exit(1);',
          '}',
          "if (mode === 'empty') {",
          "  fs.writeFileSync(outputPath, '[]');",
          '  process.exit(1);',
          '}',
          "if (mode === 'oversize') {",
          "  fs.writeFileSync(outputPath, 'x'.repeat(32 * 1024 * 1024 + 1));",
          '  process.exit(1);',
          '}',
          "if (mode === 'invalid') {",
          '  fs.writeFileSync(',
          '    outputPath,',
          "    JSON.stringify([{ fileName: 'docs/outside.md', lineNumber: 1, ruleNames: ['MD013'] }]),",
          '  );',
          '  process.exit(1);',
          '}',
          'fs.writeFileSync(',
          '  outputPath,',
          '  JSON.stringify([',
          "    { fileName: 'docs/first-rollout.md', lineNumber: 1, ruleNames: ['MD013'] },",
          "    { fileName: 'docs/first-rollout.md', lineNumber: 2, ruleNames: ['MD040'] },",
          "  ]) + '\\n',",
          ');',
          "process.exit(mode === 'fatal' ? 2 : 1);",
        ].join('\n') + '\n',
        'utf8',
      );
      chmodSync(markdownlintStub, 0o755);

      git(fixtureRoot, 'init', '--initial-branch=main');
      git(fixtureRoot, 'config', 'user.name', 'Empty Tree Range');
      git(fixtureRoot, 'config', 'user.email', 'empty-tree@example.invalid');
      writeFileSync(
        join(fixtureRoot, 'docs', 'first-rollout.md'),
        '# First rollout\nnew line\n',
        'utf8',
      );
      git(fixtureRoot, 'add', 'docs/first-rollout.md');
      git(fixtureRoot, 'commit', '-m', 'first rollout docs');
      const head = git(fixtureRoot, 'rev-parse', 'HEAD');
      const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      const arbitraryTree = git(fixtureRoot, 'rev-parse', 'HEAD^{tree}');

      const run = (
        base: string,
        mode = 'findings',
      ): { status: number | null; stdout: string; stderr: string } => {
        const result = spawnSync(process.execPath, [fixtureScript], {
          cwd: fixtureRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            MARKDOWNLINT_BASE_REF: base,
            MARKDOWNLINT_HEAD_REF: head,
            MARKDOWNLINT_STUB_MODE: mode,
          },
        });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      };

      const fullRollout = run(emptyTree);
      expect(fullRollout.stdout).toContain(
        'bootstrap inherited debt: findings=2 files=1 rules=MD013,MD040',
      );
      expect(fullRollout.stderr).toBe('');
      expect(fullRollout.status).toBe(0);

      const cleanResult = run(emptyTree, 'clean');
      expect(cleanResult.status).toBe(0);
      expect(cleanResult.stdout).toBe('');
      expect(cleanResult.stderr).toBe('');

      for (const mode of ['malformed', 'empty', 'oversize', 'invalid']) {
        const invalidResult = run(emptyTree, mode);
        expect(invalidResult.status).toBe(1);
        expect(invalidResult.stderr).toContain('markdownlint bootstrap baseline failed');
      }

      const fatalResult = run(emptyTree, 'fatal');
      expect(fatalResult.status).toBe(2);
      expect(fatalResult.stderr).toContain('markdownlint bootstrap baseline failed');

      const invalidTree = run(arbitraryTree);
      expect(invalidTree.status).toBe(1);
      expect(invalidTree.stderr).toContain(`markdownlint base ${arbitraryTree} cannot be resolved`);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps changed-lane markdownlint findings when stderr exceeds Node’s default buffer', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'aqua-markdownlint-large-stderr-'));
    try {
      const fixtureScript = join(fixtureRoot, 'scripts', 'ci', 'markdownlint-changed.mjs');
      const markdownlintStub = join(fixtureRoot, 'node_modules', '.bin', 'markdownlint');
      mkdirSync(join(fixtureRoot, 'scripts', 'ci'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'docs'), { recursive: true });
      copyFileSync(SCRIPT_PATH, fixtureScript);
      writeFileSync(join(fixtureRoot, '.prettierrc'), '{"printWidth":100}\n', 'utf8');
      writeFileSync(
        markdownlintStub,
        [
          '#!/usr/bin/env node',
          "process.stderr.write('docs/large.md:2:1 MD013/line-length ' + 'x'.repeat(1024 * 1024) + '\\n');",
          'process.exit(1);',
        ].join('\n') + '\n',
        'utf8',
      );
      chmodSync(markdownlintStub, 0o755);

      git(fixtureRoot, 'init', '--initial-branch=main');
      git(fixtureRoot, 'config', 'user.name', 'Large Stderr');
      git(fixtureRoot, 'config', 'user.email', 'large-stderr@example.invalid');
      writeFileSync(join(fixtureRoot, 'docs', 'large.md'), '# Large\n', 'utf8');
      git(fixtureRoot, 'add', 'docs/large.md');
      git(fixtureRoot, 'commit', '-m', 'base doc');
      const base = git(fixtureRoot, 'rev-parse', 'HEAD');
      writeFileSync(join(fixtureRoot, 'docs', 'large.md'), '# Large\nnew line\n', 'utf8');
      git(fixtureRoot, 'add', 'docs/large.md');
      git(fixtureRoot, 'commit', '-m', 'changed doc');
      const head = git(fixtureRoot, 'rev-parse', 'HEAD');

      const result = spawnSync(process.execPath, [fixtureScript], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, MARKDOWNLINT_BASE_REF: base, MARKDOWNLINT_HEAD_REF: head },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('docs/large.md:2:1 MD013/line-length');
      expect(result.stderr).not.toContain('markdownlint could not be launched');
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
