/** Local hooks remain installed; expensive verification is a required hosted gate. */
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as YAML from 'yaml';

const ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
interface Gate {
  id: string;
  lane: string;
  command: string[];
  hosted_owner: string;
}
interface Job {
  needs?: string[];
  if?: string;
  'runs-on'?: string;
  steps?: Array<{ run?: string }>;
}
const inventory: { lanes: string[]; gates: Gate[] } = JSON.parse(read('scripts/ci/hosted-validation.inventory.json'));
const workflow: { jobs: Record<string, Job> } = YAML.parse(read('.github/workflows/ci-affected.yml'));

describe('local metadata and required hosted validation boundary', () => {
  it.each(['commit-msg', 'pre-commit', 'pre-push', 'post-merge'])('keeps %s executable and lightweight', (hook) => {
    const path = join(ROOT, '.husky', hook);
    expect(statSync(path).isFile()).toBe(true);
    expect(() => accessSync(path, constants.X_OK)).not.toThrow();
    const code = read(`.husky/${hook}`).split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(code).toContain(`node scripts/ci/local-hook.mjs ${hook}`);
    expect(code).not.toMatch(/\b(?:npx|npm|ts-node|tsc|jest|pytest|cargo|nx|docker)\b/);
  });

  it('has an installer independent of npm lifecycle scripts', () => {
    const pkg: { scripts: Record<string, string> } = JSON.parse(read('package.json'));
    expect(pkg.scripts['hooks:install']).toContain('core.hooksPath .husky');
  });

  it('keeps the local entry point dependency-free and never dispatches compilation', () => {
    const source = read('scripts/ci/local-hook.mjs');
    const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier && specifier.startsWith('node:'))).toBe(true);
    expect(source).toContain("execFileSync('git', args");
    expect(source).not.toMatch(/spawnSync|execSync|import\(|require\(/);
    expect(source).toContain("git(['diff', '--cached', '--check'])");
    expect(source).toContain('Closes:');
  });

  it('preserves all former hook responsibilities in a declared hosted owner', () => {
    const ids = inventory.gates.map((gate) => gate.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'dependency-pins', 'banned-phrases', 'banned-constructs', 'migration-sql', 'tier-claims',
      'commit-traceability', 'gate-unit-suites', 'format-scope', 'format-changed',
      'aria-authority-pin', 'changed-types', 'gate-types', 'changed-rust', 'aria-affected',
      'required-check-contract', 'hosted-gate-contract',
    ]));
    for (const gate of inventory.gates) {
      expect(gate.hosted_owner).toBe('ci-affected.yml:hosted-validation');
      expect(inventory.lanes).toContain(gate.lane);
      expect(gate.command.length).toBeGreaterThan(1);
    }
    const runner = read('tools/gates/run-all.mjs');
    expect(runner).toContain("['tools/gates', 'tools/lint-gates']");
    expect(runner).not.toContain("spawnSync('npx'");
  });

  it.each(['build-status', 'merge-gate'])('%s cannot accept skipped hosted validation even without affected code', (name) => {
    const job = workflow.jobs[name];
    expect(job).toBeDefined();
    if (!job) throw new Error(`Missing required aggregate ${name}`);
    expect(job.needs).toContain('hosted-validation');
    if (!job.steps) throw new Error(`Missing aggregate steps ${name}`);
    const assertion = job.steps.map((step) => step.run ?? '').join('\n');
    const required = assertion.indexOf('needs.hosted-validation.result');
    const affected = assertion.indexOf('needs.detect-changes.outputs.has_changes');
    expect(required).toBeGreaterThanOrEqual(0);
    expect(assertion).toContain('Required hosted validation did not succeed.');
    expect(required).toBeLessThan(affected);
    const hosted = workflow.jobs['hosted-validation'];
    if (!hosted) throw new Error('Missing hosted-validation job');
    expect(hosted['runs-on']).toBe('ubuntu-latest');
    expect(hosted.if).toBeUndefined();
  });

  it('requires exact revision and hosted execution identities for the receipt', () => {
    const runner = read('scripts/ci/hosted-validation.mjs');
    expect(runner).toContain("process.env.RUNNER_ENVIRONMENT !== 'github-hosted'");
    expect(runner).toContain('checkout !== head');
    for (const field of ['base_sha', 'pr_head_sha', 'tested_merge_sha', 'run_id', 'run_attempt', 'inventory_sha256']) {
      expect(runner).toContain(field);
    }
    const selector = read('scripts/ci/aria-suite-changed.mjs');
    expect(selector).toContain("args.includes('--base')");
    expect(selector).toContain("args.includes('--head')");
    expect(selector).not.toContain('function baseRef');
    expect(selector).not.toContain('suite SKIPPED (CI still runs it)');
  });
});
