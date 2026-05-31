import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
})();

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' });
}

function gitSucceeds(args: string[]): boolean {
  try {
    execFileSync('git', ['-C', REPO_ROOT, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const LIVE_DOCS = [
  'docs/aria/SPEC.md',
  'docs/aria/CONTRACTS.md',
  'docs/aria/IDENTITY.md',
  'docs/aria/ROADMAP.md',
  'docs/adr/033-aria-autonomous-profile.md',
];

const LIVE_WORKFLOWS = [
  '.github/workflows/aria-agent-eval.yml',
  '.github/workflows/aria-agent-executor.yml',
  '.github/workflows/aria-daily-report.yml',
  '.github/workflows/aria-kernel.yml',
  '.github/workflows/aria-kernel-fast.yml',
  '.github/workflows/aria-kernel-full.yml',
];

describe('ARIA live runtime/documentation SSoT', () => {
  it('CURRENT_STATE declares the live authority chain and executable anchors', () => {
    const current = read('docs/aria/CURRENT_STATE.md');
    expect(current).toContain('Date: 2026-05-31');
    expect(current).toContain('Target ref: `origin/main`');
    expect(current).toMatch(/Last verified commit: `[a-f0-9]{40}`/);
    expect(current).toContain('## Authority Chain');
    expect(current).toContain('Executable code and machine-checked contracts are normative');
    expect(current).toContain('Codex CLI');
    for (const anchor of [
      'aria-kernel/aria_kernel/cli.py',
      'aria-kernel/aria_kernel/runtime_profile.py',
      'aria-kernel/aria_kernel/state_manifest.py',
      'aria-kernel/aria_kernel/tool_registry.py',
      'aria-kernel/aria_kernel/runtime_artifacts.py',
      'aria-kernel/aria_kernel/agent_surface.py',
      'tools/aria-poc/ci_executor.py',
      'tools/aria-poc/worker_executor.py',
    ]) {
      expect(current).toContain(anchor);
    }
    expect(current).toContain('artifact-bearing');
    expect(current).toContain('Lifecycle-only cycles do not authorize promotion');
  });

  it('historical live docs are explicitly subordinate to CURRENT_STATE', () => {
    const staleRuntimeTerms = [
      'Claude Code',
      'Anthropic',
      'ANTHROPIC_API_KEY',
      'llm_bridge.py',
      'only implemented ARIA code',
      'does not implement the kernel',
      'never auto-merge pull requests',
    ];
    for (const rel of LIVE_DOCS) {
      const body = read(rel);
      const containsStaleTerm = staleRuntimeTerms.some((term) => body.includes(term));
      if (!containsStaleTerm) continue;
      expect(body).toMatch(/ARIA-LIVE-AUTHORITY|ARIA-CURRENT-STATE-NOTICE/);
    }
  });

  it('Codex executor contract is mainline, version-bound, and has no pending verification placeholders', () => {
    const contract = read('tools/aria-poc/ci_executor_contract_proven.md');
    expect(contract).toContain('checkout the `main` target ref');
    expect(contract).toContain('codex_cli_version_minimum: codex-cli 0.135.0');
    expect(contract).toContain('verification_mode: runtime-preflight');
    expect(contract).toContain('ChatGPT-managed Codex CLI login');
    expect(contract).not.toMatch(/PENDING-CODEX-CONTRACT-TESTS|codex_cli_version_minimum:\s*PENDING|verified_by_operator_handle:\s*PENDING|verified_at_iso8601:\s*PENDING/);
  });

  it('live ARIA workflows target main and enforce the Codex CLI floor', () => {
    for (const rel of LIVE_WORKFLOWS) {
      const workflow = read(rel);
      expect(workflow).not.toMatch(
        /ref:\s*snowball|refs\/heads\/snowball|origin snowball|branches:\s*\n\s*-\s*snowball/,
      );
    }
    const executor = read('.github/workflows/aria-agent-executor.yml');
    expect(executor).toContain('ref: main');
    expect(executor).toContain('REQUIRED_CODEX_VERSION="0.135.0"');
    expect(executor).toContain('codex --version');
    expect(read('.github/workflows/aria-kernel.yml')).toMatch(/branches:\s*\n\s*- main/);
    expect(read('.github/workflows/aria-kernel-fast.yml')).toMatch(/branches:\s*\n\s*- main/);
    expect(read('.github/workflows/aria-kernel-full.yml')).toMatch(/branches:\s*\n\s*- main/);
    const kernelWorkflow = read('.github/workflows/aria-kernel.yml');
    expect(kernelWorkflow).toContain('node-version: \"22\"');
    expect(read('.github/workflows/aria-kernel-full.yml')).toContain('node-version: \"22\"');
    expect(kernelWorkflow).toContain('Run ARIA docs/runtime SSoT invariant');
    expect(kernelWorkflow).toContain('Run ARIA runtime artifact smoke');
    expect(kernelWorkflow).toContain('Verify post-run clean worktree');
  });

  it('package scripts expose the clean ARIA validation entrypoints', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['aria:compile']).toContain("compile(p.read_text(encoding='utf-8'), str(p), 'exec')");
    expect(pkg.scripts['aria:compile']).not.toContain('compileall');
    expect(pkg.scripts['aria:test:unit']).toContain("python3 -m unittest discover aria-kernel -p '*test*.py'");
    expect(pkg.scripts['aria:docs:ssot']).toBe('jest --config tests/invariants/jest.config.ts --selectProjects layer-3 --runTestsByPath tests/invariants/aria-doc-runtime-ssot.spec.ts');
    expect(pkg.scripts['aria:ci:all']).toBe('npm run aria:compile && npm run aria:test:unit && npm run invariants:fast');
  });

  it('CODEOWNERS covers the ARIA control-plane authority chain', () => {
    const owners = read('.github/CODEOWNERS');
    for (const required of [
      'aria-kernel/',
      'docs/aria/',
      'tools/aria-poc/',
      'aria-tools/preflight/',
      'package.json',
      '.gitignore',
    ]) {
      expect(owners).toContain(required);
    }
  });

  it('runtime state roots are ignored and .aria-ci is not tracked', () => {
    expect(git(['ls-files', '.aria-ci']).trim()).toBe('');
    for (const rel of [
      '.aria-ci/tools/runs.jsonl',
      'artifacts/example.json',
      'aria-kernel/aria-tools/runs.jsonl',
      'aria-tools/autonomy_state.jsonl',
      'aria-tools/daemons/lease.json',
      'aria-tools/quarantine/finding.jsonl',
    ]) {
      expect(gitSucceeds(['check-ignore', '--no-index', '-q', '--', rel])).toBe(true);
    }
    expect(existsSync(join(REPO_ROOT, '.gitignore'))).toBe(true);
  });
});
