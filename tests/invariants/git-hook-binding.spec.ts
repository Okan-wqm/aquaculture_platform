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
  steps?: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }>;
  strategy?: { matrix: { lane: string[] } };
}
const inventory: { lanes: string[]; gates: Gate[] } = JSON.parse(
  read('scripts/ci/hosted-validation.inventory.json'),
);
const workflow: { jobs: Record<string, Job> } = YAML.parse(
  read('.github/workflows/ci-affected.yml'),
);

describe('local metadata and required hosted validation boundary', () => {
  it.each(['commit-msg', 'pre-commit', 'pre-push', 'post-merge'])(
    'keeps %s executable and lightweight',
    (hook) => {
      const path = join(ROOT, '.husky', hook);
      expect(statSync(path).isFile()).toBe(true);
      expect(() => accessSync(path, constants.X_OK)).not.toThrow();
      const code = read(`.husky/${hook}`)
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      expect(code).toContain(`node scripts/ci/local-hook.mjs ${hook}`);
      expect(code).not.toMatch(/\b(?:npx|npm|ts-node|tsc|jest|pytest|cargo|nx|docker)\b/);
    },
  );

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
    expect(ids).toEqual(
      expect.arrayContaining([
        'dependency-pins',
        'banned-phrases',
        'banned-constructs',
        'migration-sql',
        'tier-claims',
        'commit-traceability',
        'gate-unit-suites',
        'format-scope',
        'format-changed',
        'aria-authority-pin',
        'changed-types',
        'gate-types',
        'changed-rust',
        'aria-affected',
        'required-check-contract',
        'hosted-gate-contract',
      ]),
    );
    for (const gate of inventory.gates) {
      expect(gate.hosted_owner).toBe('ci-affected.yml:hosted-validation');
      expect(inventory.lanes).toContain(gate.lane);
      expect(gate.command.length).toBeGreaterThan(1);
    }
    const runner = read('tools/gates/run-all.mjs');
    expect(runner).toContain("['tools/gates', 'tools/lint-gates']");
    expect(runner).not.toContain("spawnSync('npx'");
  });

  it.each(['build-status', 'merge-gate'])(
    '%s cannot accept skipped hosted validation even without affected code',
    (name) => {
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
    },
  );

  it('requires exact revision and hosted execution identities for the receipt', () => {
    const runner = read('scripts/ci/hosted-validation.mjs');
    expect(runner).toContain("process.env.RUNNER_ENVIRONMENT !== 'github-hosted'");
    expect(runner).toContain('checkout !== head');
    for (const field of [
      'base_sha',
      'pr_head_sha',
      'tested_merge_sha',
      'run_id',
      'run_attempt',
      'inventory_sha256',
    ]) {
      expect(runner).toContain(field);
    }
    const selector = read('scripts/ci/aria-suite-changed.mjs');
    expect(selector).toContain("args.includes('--base')");
    expect(selector).toContain("args.includes('--head')");
    expect(selector).not.toContain('function baseRef');
    expect(selector).not.toContain('suite SKIPPED (CI still runs it)');
  });
  it('keeps each declared hosted matrix complete and ungated', () => {
    for (const [name, path] of [
      ['hosted-validation', 'scripts/ci/hosted-validation.inventory.json'],
      ['authentication-proof', 'scripts/ci/authentication-proof.inventory.json'],
    ]) {
      if (!name || !path) throw new Error('Invalid matrix contract');
      const manifest: { lanes: string[] } = JSON.parse(read(path));
      const job = workflow.jobs[name];
      if (!job || !job.strategy) throw new Error(`Missing hosted matrix ${name}`);
      expect(job.strategy.matrix.lane).toEqual(manifest.lanes);
      expect(job.if).toBeUndefined();
      expect(job['runs-on']).toBe('ubuntu-latest');
    }
  });

  it.each(['build-status', 'merge-gate'])(
    '%s requires real auth and recovery execution',
    (name) => {
      const job = workflow.jobs[name];
      if (!job || !job.steps) throw new Error(`Missing aggregate ${name}`);
      const code = job.steps.map((step) => step.run ?? '').join('\n');
      for (const required of [
        'authentication-proof',
        'authentication-e2e',
        'postgres-recovery-proof',
      ]) {
        expect(job.needs).toContain(required);
        const assertion = code.indexOf(`needs.${required}.result`);
        expect(assertion).toBeGreaterThanOrEqual(0);
        expect(assertion).toBeLessThan(code.indexOf('needs.detect-changes.outputs.has_changes'));
      }
      const recovery = workflow.jobs['postgres-recovery-proof'];
      if (!recovery || !recovery.steps) throw new Error('Missing recovery proof');
      const build = recovery.steps.find(
        (step) => step.uses && step.uses.startsWith('docker/build-push-action@'),
      );
      if (!build || !build.with) throw new Error('Missing loaded image build');
      expect(build.with['load']).toBe(true);
      expect(build.with['push']).toBe(false);
      const commands = recovery.steps.map((step) => step.run ?? '').join('\n');
      expect(commands).toContain('POSTGRES_DR_TEST_IMAGE');
      expect(commands).toContain('bash scripts/ci/test-postgres-dr-recovery.sh');
      expect(commands).toContain('bash scripts/ci/test-nats-leaf-rollout.sh');
    },
  );

  it('runs candidate E2E on hosted Actions with no production SSH test execution', () => {
    const code = read('.github/workflows/e2e-tests.yml');
    expect(code).toContain('workflow_call:');
    expect(code).toContain('ref: ${{ inputs.head_sha }}');
    expect(code).toContain('runs-on: ubuntu-latest');
    expect(code).toContain('node scripts/ci/hosted-e2e-proof.mjs');
    expect(code).not.toMatch(/appleboy|DROPLET_|workflow_run:|continue-on-error/);
    const runtime = read('scripts/ci/hosted-e2e-stack.mjs');
    expect(runtime).toContain('service-catalog.generated.json');
    expect(runtime).toContain('docker-compose.droplet.yml');
    expect(runtime).toContain("process.env.RUNNER_ENVIRONMENT !== 'github-hosted'");
    expect(runtime).toContain("'run', '--rm', '--no-deps', 'db-migrate'");
    const fixture = read('e2e/fixtures/user.fixture.ts');
    expect(fixture).toContain('await hashPassword(password)');
    expect(fixture).toContain('await loginFixtureUser(email, password)');
    expect(fixture).not.toContain('generateTestToken');
    expect(read('e2e/global-setup.ts')).not.toMatch(/CREATE (?:SCHEMA|TABLE)/);
  });
});
