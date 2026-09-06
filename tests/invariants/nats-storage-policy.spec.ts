import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import policy from '../../platform/libs/event-bus/src/nats/jetstream-storage-policy.json';
import { JETSTREAM_REQUIRED_FILE_STORE_BYTES } from '../../platform/libs/event-bus/src/nats/jetstream-storage-policy';

const REPO_ROOT = resolve(__dirname, '../..');
const POLICY = 'platform/libs/event-bus/src/nats/jetstream-storage-policy.json';
const HELPER = 'scripts/nats/jetstream_storage_policy.py';
const GENERATOR = 'scripts/nats/generate-nats-conf.py';
const NATS_CONF = 'infrastructure/docker/nats/nats.conf';
const ALERTS = 'infrastructure/monitoring/droplet/rules/35-broker-jetstream.yml';

function runPython(root: string, script: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('python3', [join(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

describe('NATS runtime, generated broker and deploy storage policy', () => {
  it('keeps generator output read-only until the changed allocation is explicitly generated', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aqua-nats-storage-'));
    try {
      for (const relative of [
        POLICY, HELPER, GENERATOR, NATS_CONF, ALERTS,
        'infrastructure/nats/services.yaml',
        'infrastructure/nats/services.schema.json',
        'infrastructure/helm/aquaculture/files/nats-service-identities.yaml',
        'libs/backend-common/src/nats/nats-response-policy.json',
      ]) {
        const destination = join(fixture, relative);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(REPO_ROOT, relative), destination);
      }
      const clean = runPython(fixture, GENERATOR, ['--check']);
      expect({ status: clean.status, stderr: clean.stderr }).toEqual({ status: 0, stderr: '' });
      const originalBroker = readFileSync(join(fixture, NATS_CONF), 'utf8');
      const originalAlerts = readFileSync(join(fixture, ALERTS), 'utf8');
      const changed = structuredClone(policy);
      changed.streams.events.max_bytes += 4;
      writeFileSync(join(fixture, POLICY), JSON.stringify(changed));

      const stale = runPython(fixture, GENERATOR, ['--check']);
      expect(stale.status).toBe(3);
      expect(stale.stderr).toContain(`stale: ${NATS_CONF}`);
      expect(stale.stderr).toContain(`stale: ${ALERTS}`);
      expect(readFileSync(join(fixture, NATS_CONF), 'utf8')).toBe(originalBroker);
      expect(readFileSync(join(fixture, ALERTS), 'utf8')).toBe(originalAlerts);

      const generated = runPython(fixture, GENERATOR, []);
      expect({ status: generated.status, stderr: generated.stderr }).toEqual({ status: 0, stderr: '' });
      const required = JETSTREAM_REQUIRED_FILE_STORE_BYTES + 5;
      expect(readFileSync(join(fixture, NATS_CONF), 'utf8')).toContain(`max_file_store: ${required}`);
      expect(readFileSync(join(fixture, ALERTS), 'utf8')).toContain(
        `nats_server_jetstream_total_storage_bytes > ${Math.floor(required * 3 / 4)}`,
      );
      expect(runPython(fixture, HELPER, ['--required-file-store']).stdout).toBe(`${required}\n`);
      expect(runPython(fixture, GENERATOR, ['--check']).status).toBe(0);
      const validBroker = readFileSync(join(fixture, NATS_CONF), 'utf8');
      changed.streams.telemetry.max_bytes = 0;
      writeFileSync(join(fixture, POLICY), JSON.stringify(changed));
      const invalid = runPython(fixture, GENERATOR, []);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('invalid canonical JetStream stream allocation');
      expect(readFileSync(join(fixture, NATS_CONF), 'utf8')).toBe(validBroker);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each([
    { operatorFloor: '', configuredDelta: 0, admitted: true },
    { operatorFloor: '1', configuredDelta: 0, admitted: true },
    { operatorFloor: '', configuredDelta: -1, admitted: false },
    { operatorFloor: String(JETSTREAM_REQUIRED_FILE_STORE_BYTES + 1), configuredDelta: 0, admitted: false },
  ])('deploy admission enforces declared floor: %j', ({ operatorFloor, configuredDelta, admitted }) => {
    const fixture = mkdtempSync(join(tmpdir(), 'aqua-nats-admission-'));
    try {
      const natsConf = join(fixture, 'nats.conf');
      writeFileSync(natsConf, `jetstream {\n  max_file_store: ${JETSTREAM_REQUIRED_FILE_STORE_BYTES + configuredDelta}\n}\n`);
      const capacity = readFileSync(join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh'), 'utf8');
      const assignment = capacity.slice(
        capacity.indexOf('NATS_REQUIRED_FILE_STORE_BYTES='),
        capacity.indexOf('NATS_MIN_MEMORY_BYTES='),
      );
      expect(assignment).toContain('jetstream_storage_policy.py');
      const functions = ['parse_size_bytes', 'nats_conf_max_file_store_bytes', 'droplet_compose_service_value', 'broker_capacity_error_lines'].map((name) => {
        const definition = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(capacity);
        if (definition === null) throw new Error(`Production capacity function missing: ${name}`);
        return definition[0];
      });
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail', assignment, ...functions, 'broker_capacity_error_lines',
      ].join('\n')], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: '/usr/bin:/bin',
          PYTHONDONTWRITEBYTECODE: '1',
          CAPACITY_SCRIPT_ROOT: join(REPO_ROOT, 'scripts/deploy'),
          NATS_REQUIRED_FILE_STORE_BYTES: operatorFloor,
          NATS_CONF_PATH: natsConf,
          DROPLET_COMPOSE_PATH: join(REPO_ROOT, 'docker-compose.droplet.yml'),
          NATS_MIN_MEMORY_BYTES: '536870912',
          NATS_MIN_CPUS: '1.0',
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      if (admitted) expect(result.stdout).toBe('');
      else expect(result.stdout).toContain('nats_file_store_below_required');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each(['0', '-1', '1.5', '1e3', ' ', '9007199254740992'])(
    'rejects malformed operator floors: %s',
    (override) => {
      const result = runPython(REPO_ROOT, HELPER, ['--required-file-store', override]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('positive safe integer');
    },
  );
});
