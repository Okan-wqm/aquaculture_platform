import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'tools/scripts/perf-baseline.ts');

interface DryRunContract {
  profile: 'sustained' | 'stress';
  candidateSizing: true;
  tenants: number;
  rate: number;
  duration: number;
  sample: {
    topic: string;
    payloadBytes: number;
    mqttWireBytes: number;
    payload: {
      sourceEventId: string;
      sourceTimestamp: string;
      sourceSequence: number;
    };
  };
  measurements: {
    M: { unit: 'mqtt_messages_per_second' };
    E: { unit: 'child_events_per_second' };
    R: { unit: 'metric_rows_per_minute' };
  };
  observationTemplate: {
    brokerPersistenceBytesDelta: null;
    jetStreamStoredBytesDelta: null;
    jetStreamStoredEventsDelta: null;
    fanOutEventsPerMessage: null;
    rowsPerMessage: null;
    postgresHeapBytesDelta: null;
    postgresIndexBytesDelta: null;
    postgresWalBytesDelta: null;
  };
}

function dryRun(profile: 'sustained' | 'stress'): DryRunContract {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', SCRIPT, '--profile', profile, '--dry-run', 'true'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as DryRunContract;
}

void test('locks the sustained candidate profile to 100 tenants at 2K for 30 minutes', () => {
  const contract = dryRun('sustained');

  assert.equal(contract.profile, 'sustained');
  assert.equal(contract.candidateSizing, true);
  assert.equal(contract.tenants, 100);
  assert.equal(contract.rate, 2_000);
  assert.equal(contract.duration, 30 * 60);
});

void test('locks the stress profile to 15K for five minutes', () => {
  const contract = dryRun('stress');

  assert.equal(contract.rate, 15_000);
  assert.equal(contract.duration, 5 * 60);
});

void test('makes producer identity/time and MQTT wire volume part of every generated sample', () => {
  const contract = dryRun('sustained');

  assert.match(contract.sample.payload.sourceEventId, /^[0-9a-f-]{36}$/);
  assert.doesNotThrow(() => new Date(contract.sample.payload.sourceTimestamp).toISOString());
  assert.equal(contract.sample.payload.sourceSequence, 0);
  assert.ok(contract.sample.payloadBytes >= 600);
  assert.ok(contract.sample.mqttWireBytes > contract.sample.payloadBytes);
});

void test('keeps M, E and R as separately named and unit-bearing measurements', () => {
  const contract = dryRun('sustained');

  assert.deepEqual(contract.measurements, {
    M: { unit: 'mqtt_messages_per_second' },
    E: { unit: 'child_events_per_second' },
    R: { unit: 'metric_rows_per_minute' },
  });
  assert.deepEqual(contract.observationTemplate, {
    brokerPersistenceBytesDelta: null,
    jetStreamStoredBytesDelta: null,
    jetStreamStoredEventsDelta: null,
    fanOutEventsPerMessage: null,
    rowsPerMessage: null,
    postgresHeapBytesDelta: null,
    postgresIndexBytesDelta: null,
    postgresWalBytesDelta: null,
  });
});

void test('rejects ad-hoc rate overrides that could be mislabeled as an official profile', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      SCRIPT,
      '--profile',
      'sustained',
      '--rate',
      '3',
      '--dry-run',
      'true',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /profile envelope is locked/i);
});
