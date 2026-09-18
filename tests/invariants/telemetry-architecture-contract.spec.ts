/**
 * Platform-wide invariant — Task 7 (100-tenant readiness plan):
 *
 * The telemetry architecture is LOCKED to the approved boundaries. This
 * spec makes every regression a CI failure instead of a review
 * conversation:
 *
 *   1. NO Kafka — no kafkajs dependency, no KafkaStreamsService, no
 *      stream-processing placeholder modules resurrecting it.
 *   2. NO shared telemetry hypertable — active sensor-service SQL never
 *      targets the shared `sensor.sensor_metrics` (the Task 3 sidecar and
 *      the TS readers both route per-tenant; the platform scanners cannot
 *      see rows in the shared table).
 *   3. NO tenant shard/router map — the 16-hex SSoT
 *      (`getTenantSchemaName`) is the single resolution point; a second
 *      resolver is the first brick of a shard layer the plan defers.
 *   4. NO PgBouncer in the deploy manifests — the search_path-per-checkout
 *      pattern (tenant routing) is incompatible with transaction pooling.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function gitLs(glob: string): string[] {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', glob], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Active (non-test, non-archive) sensor-service sources. */
function activeSensorSources(): string[] {
  return gitLs('apps/sensor-service/src/**/*.ts').filter(
    (f) =>
      !f.includes('/.archive/') &&
      !f.includes('__tests__') &&
      !f.endsWith('.spec.ts') &&
      !f.endsWith('.test.ts'),
  );
}

describe('Telemetry architecture contract (Task 7)', () => {
  it('has no Kafka dependency, service, or placeholder module', () => {
    // 1a. package manifests.
    for (const manifest of ['package.json', 'apps/sensor-service/package.json']) {
      const path = resolve(REPO_ROOT, manifest);
      if (!existsSync(path)) continue;
      const pkg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
      for (const section of ['dependencies', 'devDependencies']) {
        expect(pkg[section]?.['kafkajs'] ?? pkg[section]?.['kafka-node']).toBeUndefined();
      }
    }

    // 1b. The no-op service is gone (Task 7 Step 7.2 deleted it).
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/sensor-service/src/stream-processing/kafka-streams.service.ts'),
      ),
    ).toBe(false);

    // 1c. No source anywhere in the app tree references the class.
    // (existsSync guard: the invariant also runs in a worktree where the
    // file list and disk can disagree mid-checkout.)
    const offenders: string[] = [];
    for (const file of gitLs('apps/**/*.ts')) {
      if (file.includes('node_modules') || file.includes('/.archive/')) continue;
      const path = resolve(REPO_ROOT, file);
      if (!existsSync(path)) continue;
      const source = readFileSync(path, 'utf8');
      if (source.includes('KafkaStreamsService')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('active sensor-service SQL never targets the shared sensor.sensor_metrics', () => {
    const offenders: string[] = [];
    for (const file of activeSensorSources()) {
      const path = resolve(REPO_ROOT, file);
      if (!existsSync(path)) continue;
      const source = readFileSync(path, 'utf8');
      // Doc-comments may MENTION the historical shared table; SQL against it
      // is what breaks.
      if (/\b(?:FROM|INTO|UPDATE|JOIN)\s+sensor\.sensor_metrics\b/i.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps exactly ONE canonical tenant-schema utility (no shard map can grow beside it)', () => {
    const sources = activeSensorSources().concat(
      gitLs('platform/libs/event-bus/src/**/*.ts').filter((f) => !f.includes('__tests__')),
    );
    const offenders: string[] = [];
    for (const file of sources) {
      const path = resolve(REPO_ROOT, file);
      if (!existsSync(path)) continue;
      const source = readFileSync(path, 'utf8');
      // A SECOND derivation of tenant_<hex> from a tenant UUID outside the
      // SSoT — the seed of a parallel routing table.
      const derivesItself = /`tenant_\$\{/.test(source);
      if (derivesItself && !file.includes('tenant-schema.utils')) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('deploys no PgBouncer (search_path-per-checkout is incompatible with transaction pooling)', () => {
    const offenders: string[] = [];
    for (const file of [
      'docker-compose.droplet.yml',
      'docker-compose.prod.yml',
      'docker-compose.yml',
    ]) {
      const path = resolve(REPO_ROOT, file);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      if (/pgbouncer/i.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
