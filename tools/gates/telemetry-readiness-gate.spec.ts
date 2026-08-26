import { strict as assert } from 'node:assert';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'tools/scripts/evaluate-telemetry-readiness.ts');
const RESOURCE_RULES = resolve(
  REPO_ROOT,
  'infrastructure/monitoring/droplet/rules/30-resources.yml',
);
const scratchDirectories: string[] = [];

function successfulEvidence(): Record<string, unknown> {
  const sourceHash = 'a'.repeat(64);
  const childHash = 'b'.repeat(64);
  const faults = [
    'postgres-kill-5m',
    'sensor-service-restart',
    'nats-restart',
    'mosquitto-restart',
    'outage-30m',
    'buffer-60m',
    'dlq-replay',
    'tenant-erasure-with-pending',
  ].map((scenario) => ({
    scenario,
    recovered: true,
    missingSourceIds: 0,
    duplicateBusinessEffects: 0,
    unexplainedDrops: 0,
  }));

  return {
    schemaVersion: 1,
    runId: '100-tenant-readiness-2026-08-26',
    environment: {
      executionHost: 'external',
      activeEntitlementTenants: 100,
      workerCount: 4,
      imageDigest: `sha256:${'c'.repeat(64)}`,
      configSha256: 'd'.repeat(64),
    },
    sustained: {
      durationSeconds: 1_800,
      plannedMps: 2_000,
      achievedMps: 2_000,
      acceptedSourceIds: 3_600_000,
      committedSourceIds: 3_600_000,
      sourceIdSetSha256: sourceHash,
      missingSourceIds: 0,
      duplicateBusinessEffects: 0,
      unexplainedDrops: 0,
      p99EndToEndSeconds: 4.2,
      eventsPerSecond: 4_000,
      rowsPerMinute: 120_000,
      rowsPerMessage: 1,
      childEventCount: 7_200_000,
      childIdSetSha256: childHash,
      tenantMinuteMismatches: 0,
      dlqCount: 0,
    },
    recovery: {
      newIngressMps: 2_000,
      initialBacklogMessages: 7_200_000,
      durationSeconds: 3_600,
      backlogRemainingMessages: 0,
      committedMps: 4_000,
      eventsPerSecond: 8_000,
      rowsPerMinute: 240_000,
    },
    stress: {
      durationSeconds: 300,
      plannedMps: 15_000,
      attempted: 4_500_000,
      accepted: 4_000_000,
      rejectedByReason: { capacity: 500_000 },
      unclassified: 0,
      crashed: false,
      oomKilled: false,
    },
    faults,
    resources: {
      p95CpuRatio: 0.7,
      p95WorkingSetMemoryRatio: 0.75,
      p95VolumeUsedRatio: 0.7,
      p95IopsBusyRatio: 0.7,
    },
    compression: {
      rawForceRls: true,
      rawCompressed: false,
      target: 'tenant-local-cagg',
      enabled: true,
      storageReductionRatio: 0.3,
      p99RegressionRatio: 0.1,
      isolationMismatches: 0,
    },
    walgRestore: {
      method: 'WAL-G',
      scratchRestore: true,
      rpoSeconds: 300,
      tenantSchemaSurvived: true,
      olderThanP90dCaggSurvived: true,
      archiveLedgerSurvived: true,
    },
    rustPilotRuns: [0, 1, 2].map((runIndex) => ({
      runIndex,
      hostId: 'load-host-a',
      imageDigest: `sha256:${'e'.repeat(64)}`,
      configSha256: 'f'.repeat(64),
      reconciliationMismatches: 0,
      nodeP99Seconds: 4.2,
      rustP99Seconds: 4.1,
      nodeCpuSecondsPerAdmittedSource: 0.001,
      rustCpuSecondsPerAdmittedSource: 0.0008,
    })),
  };
}

function runGate(evidence: Record<string, unknown>): SpawnSyncReturns<string> {
  const directory = mkdtempSync(join(tmpdir(), 'aqua-telemetry-readiness-'));
  scratchDirectories.push(directory);
  const evidencePath = join(directory, 'evidence.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', SCRIPT, '--evidence', evidencePath],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('passes only the locked 100-tenant sustained, recovery and stress envelopes', () => {
  const result = runGate(successfulEvidence());

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status":"PASS"/);
  assert.match(result.stdout, /"hardwareDecision":"NONE"/);
  assert.match(result.stdout, /"rustPromotion":"PASS"/);
});

void test('fails closed on missing IDs, duplicate effects and unclassified stress messages', () => {
  const evidence = successfulEvidence();
  const sustained = evidence.sustained as Record<string, unknown>;
  sustained.missingSourceIds = 1;
  sustained.duplicateBusinessEffects = 1;
  const stress = evidence.stress as Record<string, unknown>;
  stress.unclassified = 1;

  const result = runGate(evidence);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /sustained\.missingSourceIds must be 0/);
  assert.match(result.stderr, /sustained\.duplicateBusinessEffects must be 0/);
  assert.match(result.stderr, /stress\.unclassified must be 0/);
});

void test('requires 4K equivalent drain while fresh 2K ingress continues', () => {
  const evidence = successfulEvidence();
  const recovery = evidence.recovery as Record<string, unknown>;
  recovery.committedMps = 3_999;
  recovery.durationSeconds = 3_601;

  const result = runGate(evidence);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /recovery\.committedMps must be at least 4000/);
  assert.match(result.stderr, /recovery\.durationSeconds must be at most 3600/);
});

void test('derives resize versus separate-volume decisions from measured resource failures', () => {
  const resizeEvidence = successfulEvidence();
  const resizeResources = resizeEvidence.resources as Record<string, unknown>;
  resizeResources.p95CpuRatio = 0.71;
  const resize = runGate(resizeEvidence);
  assert.equal(resize.status, 1);
  assert.match(resize.stdout, /"hardwareDecision":"RESIZE_DROPLET"/);

  const volumeEvidence = successfulEvidence();
  const volumeResources = volumeEvidence.resources as Record<string, unknown>;
  volumeResources.p95IopsBusyRatio = 0.71;
  const volume = runGate(volumeEvidence);
  assert.equal(volume.status, 1);
  assert.match(volume.stdout, /"hardwareDecision":"SEPARATE_VOLUME_OFFLINE_MIGRATION"/);
});

void test('rejects pg_dump evidence, incomplete faults and non-equivalent Rust pilot runs', () => {
  const evidence = successfulEvidence();
  const walgRestore = evidence.walgRestore as Record<string, unknown>;
  walgRestore.method = 'pg_dump';
  const faults = evidence.faults as Array<Record<string, unknown>>;
  faults.pop();
  const rustPilotRuns = evidence.rustPilotRuns as Array<Record<string, unknown>>;
  const thirdPilotRun = rustPilotRuns[2];
  assert.ok(thirdPilotRun);
  thirdPilotRun.configSha256 = '1'.repeat(64);

  const result = runGate(evidence);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /walgRestore\.method must be WAL-G/);
  assert.match(result.stderr, /tenant-erasure-with-pending/);
  assert.match(result.stderr, /same host, image and config/);
});

void test('keeps live resource alarms aligned with the readiness hardware gates', () => {
  const rules = readFileSync(RESOURCE_RULES, 'utf8');

  assert.match(rules, /container_memory_working_set_bytes[\s\S]*?> 0\.75[\s\S]*?more than 75%/);
  assert.match(rules, /container_cpu_usage_seconds_total[\s\S]*?> 0\.70[\s\S]*?more than 70%/);
});

void test('rejects physically impossible negative timing, resource and RPO evidence', () => {
  const evidence = successfulEvidence();
  const sustained = evidence.sustained as Record<string, unknown>;
  sustained.p99EndToEndSeconds = -1;
  const recovery = evidence.recovery as Record<string, unknown>;
  recovery.durationSeconds = -1;
  const resources = evidence.resources as Record<string, unknown>;
  resources.p95CpuRatio = -0.1;
  const walgRestore = evidence.walgRestore as Record<string, unknown>;
  walgRestore.rpoSeconds = -1;

  const result = runGate(evidence);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /sustained\.p99EndToEndSeconds must be at least 0/);
  assert.match(result.stderr, /recovery\.durationSeconds must be at least 1/);
  assert.match(result.stderr, /resources\.p95CpuRatio must be at least 0/);
  assert.match(result.stderr, /walgRestore\.rpoSeconds must be at least 0/);
});
