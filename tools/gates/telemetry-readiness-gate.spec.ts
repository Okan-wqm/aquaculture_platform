#!/usr/bin/env ts-node
/**
 * The 100-tenant readiness envelope is only a gate if something can fail it.
 *
 * `tools/scripts/evaluate-telemetry-readiness.ts` turns Task 5 of
 * `docs/reviews/zcode/2026-08-24-100-tenant-readiness.md` into a PASS/FAIL
 * decision over one evidence document. These tests run the REAL script over
 * synthetic evidence and pin the two things that decide whether the gate is
 * worth having: a fully-passing envelope is accepted exactly as written, and
 * every way of faking readiness — a missing source id, a duplicated business
 * effect, an unclassified stress message, a short drain, a logical dump
 * standing in for a physical restore, a fault scenario quietly dropped from
 * the matrix, a sidecar promotion assembled from runs of different builds,
 * and physically impossible negative measurements — is refused.
 *
 * Run by `npm run gates:test` (tools/gates/run-all.mjs globs this directory).
 */

import { strict as assert } from 'node:assert';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'tools/scripts/evaluate-telemetry-readiness.ts');
const scratchDirectories: string[] = [];

/** Evidence that satisfies every clause of Task 5, sitting exactly on the limits. */
function passingEvidence(): Record<string, unknown> {
  const sourceHash = 'a'.repeat(64);
  const childHash = 'b'.repeat(64);
  const faults = [
    'postgres-kill-5m',
    'sensor-service-restart',
    'nats-restart',
    'mosquitto-restart',
    'cloud-path-unavailable-30m',
    'edge-broker-buffer-60m',
    'restore-and-drain',
    'dlq-replay',
    'tenant-erasure-with-pending',
  ].map((scenario) => ({
    scenario,
    recovered: true,
    missingSourceIds: 0,
    duplicateBusinessEffects: 0,
    unexpectedDlqMessages: 0,
  }));

  return {
    schemaVersion: 1,
    runId: '100-tenant-readiness-2026-09-04',
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
      unaccountedBrokerDrops: 0,
      tenantMinuteMismatches: 0,
      p99EndToEndSeconds: 4.2,
      maxEndToEndSeconds: 8.4,
      eventsPerSecond: 4_000,
      rowsPerMinute: 120_000,
      rowsPerMessage: 1,
      childEventCount: 7_200_000,
      childIdSetSha256: childHash,
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
      corrupted: false,
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
      target: 'tenant-scoped-aggregate',
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
    sidecarPilotRuns: [0, 1, 2].map((runIndex) => ({
      runIndex,
      hostId: 'load-host-a',
      imageDigest: `sha256:${'e'.repeat(64)}`,
      configSha256: 'f'.repeat(64),
      reconciliationMismatches: 0,
      nodeP99Seconds: 4.2,
      rustP99Seconds: 4.1,
      nodeCpuSecondsPerMessage: 0.001,
      rustCpuSecondsPerMessage: 0.000_75,
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

void test('accepts the locked 2K sustained, drain and 15K stress envelopes', () => {
  const result = runGate(passingEvidence());

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status":"PASS"/);
  assert.match(result.stdout, /"hardwareDecision":"NONE"/);
  assert.match(result.stdout, /"sidecarPromotion":"PASS"/);
});

void test('refuses evidence with unreadable JSON before it can be scored', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aqua-telemetry-readiness-'));
  scratchDirectories.push(directory);
  const evidencePath = join(directory, 'evidence.json');
  writeFileSync(evidencePath, '{ not json');
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', SCRIPT, '--evidence', evidencePath],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /evidence is unreadable/);
});

void test('fails closed on missing ids, duplicate effects and unclassified stress messages', () => {
  const evidence = passingEvidence();
  const sustained = evidence['sustained'] as Record<string, unknown>;
  sustained['missingSourceIds'] = 1;
  sustained['duplicateBusinessEffects'] = 1;
  const stress = evidence['stress'] as Record<string, unknown>;
  stress['unclassified'] = 1;

  const result = runGate(evidence);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /sustained\.missingSourceIds must be 0/);
  assert.match(result.stderr, /sustained\.duplicateBusinessEffects must be 0/);
  assert.match(result.stderr, /stress\.unclassified must be 0/);
});

void test('holds the handler latency ceilings from Task 5.1', () => {
  const evidence = passingEvidence();
  const sustained = evidence['sustained'] as Record<string, unknown>;
  sustained['p99EndToEndSeconds'] = 5;
  sustained['maxEndToEndSeconds'] = 10;

  const result = runGate(evidence);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /sustained\.p99EndToEndSeconds must be below 5/);
  assert.match(result.stderr, /sustained\.maxEndToEndSeconds must be below 10/);
});

void test('requires the 60-minute backlog to drain while fresh 2K ingress continues', () => {
  const evidence = passingEvidence();
  const recovery = evidence['recovery'] as Record<string, unknown>;
  recovery['committedMps'] = 3_999;
  recovery['durationSeconds'] = 3_601;

  const result = runGate(evidence);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /recovery\.committedMps must be at least 4000/);
  assert.match(result.stderr, /recovery\.durationSeconds must be at most 3600/);
});

void test('derives the resize versus separate-volume decision from the measured ratios', () => {
  const resizeEvidence = passingEvidence();
  const resizeResources = resizeEvidence['resources'] as Record<string, unknown>;
  resizeResources['p95CpuRatio'] = 0.71;
  const resize = runGate(resizeEvidence);
  assert.equal(resize.status, 1);
  assert.match(resize.stdout, /"hardwareDecision":"RESIZE_DROPLET"/);

  const volumeEvidence = passingEvidence();
  const volumeResources = volumeEvidence['resources'] as Record<string, unknown>;
  volumeResources['p95IopsBusyRatio'] = 0.71;
  const volume = runGate(volumeEvidence);
  assert.equal(volume.status, 1);
  assert.match(volume.stdout, /"hardwareDecision":"SEPARATE_VOLUME_OFFLINE_MIGRATION"/);

  const bothEvidence = passingEvidence();
  const bothResources = bothEvidence['resources'] as Record<string, unknown>;
  bothResources['p95WorkingSetMemoryRatio'] = 0.76;
  bothResources['p95VolumeUsedRatio'] = 0.71;
  const both = runGate(bothEvidence);
  assert.equal(both.status, 1);
  assert.match(
    both.stdout,
    /"hardwareDecision":"RESIZE_DROPLET_AND_SEPARATE_VOLUME_OFFLINE_MIGRATION"/,
  );
});

void test('keeps raw telemetry uncompressed and under FORCE RLS whatever the benchmark says', () => {
  const evidence = passingEvidence();
  const compression = evidence['compression'] as Record<string, unknown>;
  compression['rawCompressed'] = true;
  compression['target'] = 'raw';
  compression['storageReductionRatio'] = 0.9;

  const result = runGate(evidence);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /compression\.rawCompressed must be false/);
  assert.match(
    result.stderr,
    /compression\.target must be tenant-scoped-aggregate or cold-storage/,
  );
});

void test('rejects a logical dump, an incomplete fault matrix and mixed-build sidecar runs', () => {
  const evidence = passingEvidence();
  const walgRestore = evidence['walgRestore'] as Record<string, unknown>;
  walgRestore['method'] = 'pg_dump';
  const faults = evidence['faults'] as Array<Record<string, unknown>>;
  faults.pop();
  const sidecarPilotRuns = evidence['sidecarPilotRuns'] as Array<Record<string, unknown>>;
  const thirdRun = sidecarPilotRuns[2];
  assert.ok(thirdRun);
  thirdRun['configSha256'] = '1'.repeat(64);

  const result = runGate(evidence);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /walgRestore\.method must be WAL-G/);
  assert.match(result.stderr, /tenant-erasure-with-pending/);
  assert.match(result.stderr, /same host, image and config/);
  assert.match(result.stdout, /"sidecarPromotion":"FAIL"/);
});

void test('refuses a sidecar promotion whose CPU saving misses the 20 percent floor', () => {
  const evidence = passingEvidence();
  const sidecarPilotRuns = evidence['sidecarPilotRuns'] as Array<Record<string, unknown>>;
  const firstRun = sidecarPilotRuns[0];
  assert.ok(firstRun);
  firstRun['rustCpuSecondsPerMessage'] = 0.000_81;

  const result = runGate(evidence);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 20% lower/);
  assert.match(result.stdout, /"sidecarPromotion":"FAIL"/);
});

void test('rejects physically impossible negative timing, resource and RPO evidence', () => {
  const evidence = passingEvidence();
  const sustained = evidence['sustained'] as Record<string, unknown>;
  sustained['p99EndToEndSeconds'] = -1;
  const recovery = evidence['recovery'] as Record<string, unknown>;
  recovery['durationSeconds'] = -1;
  const resources = evidence['resources'] as Record<string, unknown>;
  resources['p95CpuRatio'] = -0.1;
  const walgRestore = evidence['walgRestore'] as Record<string, unknown>;
  walgRestore['rpoSeconds'] = -1;

  const result = runGate(evidence);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /sustained\.p99EndToEndSeconds must be at least 0/);
  assert.match(result.stderr, /recovery\.durationSeconds must be at least 1/);
  assert.match(result.stderr, /resources\.p95CpuRatio must be at least 0/);
  assert.match(result.stderr, /walgRestore\.rpoSeconds must be at least 0/);
});
