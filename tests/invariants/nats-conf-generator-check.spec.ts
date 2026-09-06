/**
 * Platform-wide invariant — the NATS SSoT drift gate judges the committed
 * tree, and its detector is proven to detect.
 *
 * ADR-015 makes `infrastructure/nats/services.yaml` the only authority for
 * NATS authorization; `scripts/nats/generate-nats-conf.py` projects it into
 * the `authorization.users[]` block of `infrastructure/docker/nats/nats.conf`
 * and into the Helm certificate roster. Two CI jobs gate that projection.
 *
 * # Why this spec exists
 *
 * Both gates used to RUN the generator and then ask git whether the tree got
 * dirty. That repairs the checkout before judging it: the write lands first,
 * so every later step in the same job reads the repaired artifact while the
 * commit under test still carries the stale one. `--check` compares without
 * writing, so the tree the rest of the job sees is the tree that was pushed.
 *
 * A freshness gate is also only as good as its detector. A `--check` that
 * always returned 0 would leave both jobs green forever and nothing would
 * notice — the gate would still "run", still print OK, and enforce nothing.
 * So this spec does not merely assert that `--check` passes on a clean tree,
 * which is the assertion that cannot fail for the wrong reason: it copies the
 * whole repository state the generator reads into a scratch tree, perturbs
 * exactly one generated artifact, and requires the drift exit code and the
 * stale path in the diagnostic.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const GENERATOR = 'scripts/nats/generate-nats-conf.py';
const NATS_CONF = 'infrastructure/docker/nats/nats.conf';
const HELM_IDENTITIES = 'infrastructure/helm/aquaculture/files/nats-service-identities.yaml';
const SERVICES_YAML = 'infrastructure/nats/services.yaml';

const CI_AFFECTED = join(REPO_ROOT, '.github/workflows/ci-affected.yml');
const NATS_INVARIANTS = join(REPO_ROOT, '.github/workflows/nats-invariants.yml');

interface GeneratorRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runGenerator(root: string, args: readonly string[]): GeneratorRun {
  const result = spawnSync('python3', [join(root, GENERATOR), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, LC_ALL: 'C', PYTHONDONTWRITEBYTECODE: '1' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Copy only what the generator reads and writes. A full repository copy would
 * be gigabytes of node_modules for a four-file question.
 */
function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'aqua-nats-conf-check-'));
  for (const relative of [GENERATOR, NATS_CONF, HELM_IDENTITIES, SERVICES_YAML,
    'platform/libs/event-bus/src/nats/jetstream-storage-policy.json',
    'scripts/nats/jetstream_storage_policy.py',
    'infrastructure/monitoring/droplet/rules/35-broker-jetstream.yml',
    'libs/backend-common/src/nats/nats-response-policy.json']) {
    const destination = join(root, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(REPO_ROOT, relative), destination);
  }
  return root;
}

function read(root: string, relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

describe('INVARIANT: the NATS generated-artifact gate is read-only and detects drift', () => {
  it('reports the committed artifacts as fresh without writing to them', () => {
    const clean = runGenerator(REPO_ROOT, ['--check']);

    expect({ status: clean.status, stderr: clean.stderr }).toEqual({ status: 0, stderr: '' });
    expect(clean.stdout).toContain('already match SSoT');
  });

  /**
   * Each artifact drifts differently, and the difference is the point.
   *
   * `nats.conf` is spliced BETWEEN sentinels, so only bytes inside the
   * generated block are compared — a stray line appended at end of file is
   * carried through into the regenerated contents and is correctly NOT drift.
   * The Helm roster is compared whole-file. A perturbation that only worked on
   * one of them would leave the other's detector unproven.
   */
  const DRIFT: Readonly<Record<string, (source: string) => string>> = {
    [NATS_CONF]: (source) =>
      source.replace(
        '    # BEGIN GENERATED',
        '    # BEGIN GENERATED\n    # drift sentinel inside the generated block',
      ),
    [HELM_IDENTITIES]: (source) => `${source}# drift sentinel\n`,
  };

  it('names each drifted artifact and exits 3 without repairing it', () => {
    const root = createFixture();
    try {
      for (const stale of [NATS_CONF, HELM_IDENTITIES]) {
        const original = read(root, stale);
        const perturbed = DRIFT[stale]?.(original);
        if (perturbed === undefined || perturbed === original) {
          throw new Error(`drift fixture did not perturb ${stale}`);
        }
        writeFileSync(join(root, stale), perturbed);

        const drifted = runGenerator(root, ['--check']);
        expect({ stale, status: drifted.status }).toEqual({ stale, status: 3 });
        expect(drifted.stderr).toContain('do not match');
        expect(drifted.stderr).toContain(`stale: ${stale}`);
        // Read-only: the perturbed bytes are still there afterwards.
        expect(read(root, stale)).toBe(perturbed);

        // ...and the write mode repairs exactly what --check named.
        const repaired = runGenerator(root, []);
        expect({ stale, status: repaired.status }).toEqual({ stale, status: 0 });
        expect(read(root, stale)).toBe(original);
        expect(runGenerator(root, ['--check']).status).toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an unrecognized argument instead of silently regenerating', () => {
    const root = createFixture();
    try {
      const before = read(root, NATS_CONF);
      const rejected = runGenerator(root, ['--chekc']);

      expect(rejected.status).toBe(64);
      expect(rejected.stderr).toContain('usage: generate-nats-conf.py [--check]');
      expect(read(root, NATS_CONF)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps both CI drift gates on the read-only mode', () => {
    for (const workflow of [CI_AFFECTED, NATS_INVARIANTS]) {
      const source = readFileSync(workflow, 'utf8');
      // The separate artifact-producing job is explicitly allowed to generate;
      // it never judges freshness or publishes its patch to the branch.
      const artifactJob = /^  source-generation:\n[\s\S]*?(?=^  [a-z][\w-]*:|$(?![\s\S]))/m.exec(source)?.[0] ?? '';
      if (workflow === CI_AFFECTED) {
        expect(artifactJob).toContain(`python3 ${GENERATOR}\n`);
        expect(artifactJob).toContain('actions/upload-artifact@');
        expect(artifactJob).not.toMatch(/git\s+(?:push|commit)/);
      }
      const gateSource = source.replace(artifactJob, '');
      // Anchored to the start of a line so the operator guidance that quotes
      // the write-mode command inside an `echo` is not read as an invocation.
      const invocations = [
        ...gateSource.matchAll(new RegExp(`^[ \\t]*(python3 ${GENERATOR}[^\\n]*)$`, 'gm')),
      ].map((match) => match[1]?.trim());

      expect({ workflow, invocations }).toEqual({
        workflow,
        invocations: [`python3 ${GENERATOR} --check`],
      });
    }
  });

  it.each(['true', '{max: 0, expires: 120s}', '{max: -1, expires: 120s}',
    '{max: 3, expires: 120s}', '{max: 2, expires: -1s}', '{max: 2, expires: 0s}',
    '{max: 2, expires: 1h}', '{max: 2}', '{max: 2, expires: 120s, extra: true}'])
  ('rejects an unbounded or malformed response permission: %s', (responses) => {
    const root = createFixture();
    try {
      const source = read(root, SERVICES_YAML);
      const changed = source.replace(/  responses:\n    max: 2\n    expires: 120s/, `  responses: ${responses}`);
      expect(changed).not.toBe(source);
      writeFileSync(join(root, SERVICES_YAML), changed);
      const before = read(root, NATS_CONF);
      const result = runGenerator(root, []);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('responses');
      expect(read(root, NATS_CONF)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects distinct certificate CNs that map to the same reply-inbox prefix', () => {
    const root = createFixture();
    try {
      const source = read(root, SERVICES_YAML);
      const duplicate = '\n- name: auth-service\n  application: distinct-runtime\n' +
        '  description: Deliberately colliding fixture identity\n' +
        '  publish: [request.auth.fixture]\n  subscribe: [_INBOXAUTH_SERVICE.>]\n';
      writeFileSync(join(root, SERVICES_YAML), source + duplicate);
      const before = read(root, NATS_CONF);
      const result = runGenerator(root, []);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('inbox prefix');
      expect(read(root, NATS_CONF)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
