#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
//
// evaluate-telemetry-readiness.ts — the machine check on Task 5's exit gate.
//
// WHY this exists
//   `docs/reviews/zcode/2026-08-24-100-tenant-readiness.md` Task 5 ("External
//   Load, Failure and Decision Gates") states the 100-tenant envelope as prose:
//   30 minutes at 2K MQTT msg/s, a nine-scenario resilience matrix, a 5-minute
//   15K stress run, four hardware ratios, an RLS/compression rule, a WAL-G
//   scratch restore and a sidecar promotion verdict. Prose cannot fail a build.
//   SENSOR-HIGH-106 records that none of Task 5's artifacts exist yet, so the
//   zero-loss claim is asserted rather than measured — and nothing in the repo
//   could tell the difference between "measured and passing" and "never run".
//
//   This script closes that hole from the reading end: an operator who runs the
//   external load host emits ONE JSON evidence document, and this gate decides
//   PASS/FAIL against the plan's numbers. A missing field, a physically
//   impossible value, a fault scenario left out of the matrix and a lucky
//   cherry-picked sidecar run all fail closed. It never generates load and never
//   touches production — the runs happen on the external host, this reads what
//   they produced.
//
// WHY the thresholds are not configurable
//   Every constant below is quoted from the plan section named beside it. A
//   flag that let the caller lower a ceiling would turn the gate into a
//   rubber stamp: the whole point is that the envelope is fixed and the
//   measurement has to meet it.
//
// USAGE
//   npm run telemetry:readiness:evaluate -- --evidence <path-to-evidence.json>
//
// EXIT CODES
//   0 — every gate passes; stdout carries the verdict document.
//   1 — at least one gate failed; stdout still carries the verdict (so the
//       hardware decision is readable), stderr lists every violation.
//   2 — the evidence file is unreadable or is not a JSON object.

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';

type EvidenceRecord = Record<string, unknown>;

/** Task 5.4: which hardware branch the measured ratios force. */
type HardwareDecision =
  | 'NONE'
  | 'RESIZE_DROPLET'
  | 'SEPARATE_VOLUME_OFFLINE_MIGRATION'
  | 'RESIZE_DROPLET_AND_SEPARATE_VOLUME_OFFLINE_MIGRATION';

const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

// Plan §"Zero-loss kapsamı" + Task 5.1/5.3: the design envelope.
const SUSTAINED_MPS = 2_000;
const SUSTAINED_SECONDS = 1_800;
const STRESS_MPS = 15_000;
const STRESS_SECONDS = 300;
const BUFFER_SECONDS = 3_600;

// Task 5.1 pass line: "handler p99 below 5 seconds and hard max below 10".
const P99_CEILING_SECONDS = 5;
const HARD_MAX_CEILING_SECONDS = 10;

// Task 5.4 pass line.
const CPU_CEILING_RATIO = 0.7;
const MEMORY_CEILING_RATIO = 0.75;
const VOLUME_CEILING_RATIO = 0.7;
const IOPS_CEILING_RATIO = 0.7;

// Task 5.5 pass line.
const COMPRESSION_MIN_STORAGE_REDUCTION = 0.3;
const COMPRESSION_MAX_P99_REGRESSION = 0.1;
// Raw sensor_metrics never compresses (Task 5.5, first sentence).
const COMPRESSION_TARGETS = new Set(['tenant-scoped-aggregate', 'cold-storage']);

// Task 5.6 pass line.
const WALG_MAX_RPO_SECONDS = 300;

// Task 3 exit gate: "p99 no worse than Node, CPU per message at least 20
// percent lower".
const SIDECAR_MIN_CPU_REDUCTION = 0.2;

/**
 * Task 5.2's matrix, in the plan's order. Nine entries, not eight: the plan
 * counts "restore and measure drain time" as its own scenario because a buffer
 * that fills and a buffer that drains are different failures.
 */
const REQUIRED_FAULTS = [
  'postgres-kill-5m',
  'sensor-service-restart',
  'nats-restart',
  'mosquitto-restart',
  'cloud-path-unavailable-30m',
  'edge-broker-buffer-60m',
  'restore-and-drain',
  'dlq-replay',
  'tenant-erasure-with-pending',
] as const;

function isRecord(value: unknown): value is EvidenceRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argumentValue(name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value.startsWith('--')) {
    stderr.write(`telemetry-readiness: ${name} is required\n`);
    exit(2);
  }
  return value;
}

function recordAt(parent: EvidenceRecord, key: string, errors: string[]): EvidenceRecord {
  const value = parent[key];
  if (!isRecord(value)) {
    errors.push(`${key} must be an object`);
    return {};
  }
  return value;
}

function numberAt(record: EvidenceRecord, key: string, path: string, errors: string[]): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path}.${key} must be a finite number`);
    return Number.NaN;
  }
  return value;
}

function stringAt(record: EvidenceRecord, key: string, path: string, errors: string[]): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${path}.${key} must be a non-empty string`);
    return '';
  }
  return value;
}

function booleanAt(record: EvidenceRecord, key: string, path: string, errors: string[]): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    errors.push(`${path}.${key} must be a boolean`);
    return false;
  }
  return value;
}

function requireEqual(actual: unknown, expected: unknown, path: string, errors: string[]): void {
  if (actual !== expected) errors.push(`${path} must be ${String(expected)}`);
}

function requireAtLeast(actual: number, minimum: number, path: string, errors: string[]): void {
  if (!Number.isFinite(actual) || actual < minimum) {
    errors.push(`${path} must be at least ${minimum}`);
  }
}

function requireAtMost(actual: number, maximum: number, path: string, errors: string[]): void {
  if (!Number.isFinite(actual) || actual > maximum) {
    errors.push(`${path} must be at most ${maximum}`);
  }
}

function requireBelow(actual: number, ceiling: number, path: string, errors: string[]): void {
  if (!Number.isFinite(actual) || actual >= ceiling) {
    errors.push(`${path} must be below ${ceiling}`);
  }
}

function requireSha256(value: string, path: string, errors: string[]): void {
  if (!SHA256.test(value)) errors.push(`${path} must be a lowercase SHA-256`);
}

/**
 * Task 5.1: the run happens on an EXTERNAL multi-process host against 100
 * entitlement-compliant tenants. A single-process run on the droplet under
 * test measures the generator, not the platform.
 */
function validateEnvironment(root: EvidenceRecord, errors: string[]): void {
  const environment = recordAt(root, 'environment', errors);
  requireEqual(environment['executionHost'], 'external', 'environment.executionHost', errors);
  requireEqual(
    numberAt(environment, 'activeEntitlementTenants', 'environment', errors),
    100,
    'environment.activeEntitlementTenants',
    errors,
  );
  requireAtLeast(
    numberAt(environment, 'workerCount', 'environment', errors),
    2,
    'environment.workerCount',
    errors,
  );
  const imageDigest = stringAt(environment, 'imageDigest', 'environment', errors);
  if (!IMAGE_DIGEST.test(imageDigest)) {
    errors.push('environment.imageDigest must be a sha256 image digest');
  }
  requireSha256(
    stringAt(environment, 'configSha256', 'environment', errors),
    'environment.configSha256',
    errors,
  );
}

/** Task 5.1: 2K msg/s for 30 minutes, with the reconciliation artifact. */
function validateSustained(root: EvidenceRecord, errors: string[]): void {
  const sustained = recordAt(root, 'sustained', errors);
  const accepted = numberAt(sustained, 'acceptedSourceIds', 'sustained', errors);
  requireEqual(
    numberAt(sustained, 'durationSeconds', 'sustained', errors),
    SUSTAINED_SECONDS,
    'sustained.durationSeconds',
    errors,
  );
  requireEqual(
    numberAt(sustained, 'plannedMps', 'sustained', errors),
    SUSTAINED_MPS,
    'sustained.plannedMps',
    errors,
  );
  requireAtLeast(
    numberAt(sustained, 'achievedMps', 'sustained', errors),
    SUSTAINED_MPS,
    'sustained.achievedMps',
    errors,
  );
  requireEqual(accepted, SUSTAINED_MPS * SUSTAINED_SECONDS, 'sustained.acceptedSourceIds', errors);
  requireEqual(
    numberAt(sustained, 'committedSourceIds', 'sustained', errors),
    accepted,
    'sustained.committedSourceIds',
    errors,
  );
  requireSha256(
    stringAt(sustained, 'sourceIdSetSha256', 'sustained', errors),
    'sustained.sourceIdSetSha256',
    errors,
  );
  requireEqual(
    numberAt(sustained, 'missingSourceIds', 'sustained', errors),
    0,
    'sustained.missingSourceIds',
    errors,
  );
  requireEqual(
    numberAt(sustained, 'duplicateBusinessEffects', 'sustained', errors),
    0,
    'sustained.duplicateBusinessEffects',
    errors,
  );
  requireEqual(
    numberAt(sustained, 'unaccountedBrokerDrops', 'sustained', errors),
    0,
    'sustained.unaccountedBrokerDrops',
    errors,
  );
  requireEqual(
    numberAt(sustained, 'tenantMinuteMismatches', 'sustained', errors),
    0,
    'sustained.tenantMinuteMismatches',
    errors,
  );

  // Latency: a negative percentile is not a fast run, it is a broken
  // measurement, so the floor is checked as hard as the ceiling.
  const p99 = numberAt(sustained, 'p99EndToEndSeconds', 'sustained', errors);
  requireAtLeast(p99, 0, 'sustained.p99EndToEndSeconds', errors);
  requireBelow(p99, P99_CEILING_SECONDS, 'sustained.p99EndToEndSeconds', errors);
  const hardMax = numberAt(sustained, 'maxEndToEndSeconds', 'sustained', errors);
  requireAtLeast(hardMax, p99, 'sustained.maxEndToEndSeconds', errors);
  requireBelow(hardMax, HARD_MAX_CEILING_SECONDS, 'sustained.maxEndToEndSeconds', errors);

  // M/E/R are measured separately (plan §"Düzeltilmiş Kapasite Matematiği"):
  // messages in, child events out, metric rows written.
  requireAtLeast(
    numberAt(sustained, 'eventsPerSecond', 'sustained', errors),
    1,
    'sustained.eventsPerSecond',
    errors,
  );
  requireAtLeast(
    numberAt(sustained, 'rowsPerMinute', 'sustained', errors),
    1,
    'sustained.rowsPerMinute',
    errors,
  );
  requireAtLeast(
    numberAt(sustained, 'rowsPerMessage', 'sustained', errors),
    1,
    'sustained.rowsPerMessage',
    errors,
  );
  requireAtLeast(
    numberAt(sustained, 'childEventCount', 'sustained', errors),
    1,
    'sustained.childEventCount',
    errors,
  );
  requireSha256(
    stringAt(sustained, 'childIdSetSha256', 'sustained', errors),
    'sustained.childIdSetSha256',
    errors,
  );
  requireAtLeast(
    numberAt(sustained, 'dlqCount', 'sustained', errors),
    0,
    'sustained.dlqCount',
    errors,
  );
}

/**
 * Task 5.2 scenario 7: the 60-minute buffer drains within 60 minutes WHILE the
 * fresh 2K ingress keeps arriving. The committed-throughput floor is derived,
 * not typed in: fresh ingress plus the backlog spread over the drain window.
 * For the design envelope that is 2 000 + 3 600 000 / 3 600 = 4 000 msg/s.
 */
function validateRecovery(root: EvidenceRecord, errors: string[]): void {
  const recovery = recordAt(root, 'recovery', errors);
  const newIngressMps = numberAt(recovery, 'newIngressMps', 'recovery', errors);
  requireAtLeast(newIngressMps, SUSTAINED_MPS, 'recovery.newIngressMps', errors);
  const initialBacklogMessages = numberAt(recovery, 'initialBacklogMessages', 'recovery', errors);
  requireEqual(
    initialBacklogMessages,
    SUSTAINED_MPS * BUFFER_SECONDS,
    'recovery.initialBacklogMessages',
    errors,
  );
  const durationSeconds = numberAt(recovery, 'durationSeconds', 'recovery', errors);
  requireAtLeast(durationSeconds, 1, 'recovery.durationSeconds', errors);
  requireAtMost(durationSeconds, BUFFER_SECONDS, 'recovery.durationSeconds', errors);
  requireEqual(
    numberAt(recovery, 'backlogRemainingMessages', 'recovery', errors),
    0,
    'recovery.backlogRemainingMessages',
    errors,
  );
  requireAtLeast(
    numberAt(recovery, 'committedMps', 'recovery', errors),
    newIngressMps + initialBacklogMessages / BUFFER_SECONDS,
    'recovery.committedMps',
    errors,
  );
  requireAtLeast(
    numberAt(recovery, 'eventsPerSecond', 'recovery', errors),
    1,
    'recovery.eventsPerSecond',
    errors,
  );
  requireAtLeast(
    numberAt(recovery, 'rowsPerMinute', 'recovery', errors),
    1,
    'recovery.rowsPerMinute',
    errors,
  );
}

/**
 * Task 5.3: 15K for five minutes. This does NOT extend the SLO to 15K — the
 * only claims are no crash, no OOM, no corruption, and that every attempted
 * message ends in exactly one counted bucket. An "unclassified" residue is the
 * whole failure mode this checks for: it is how a silent drop hides.
 */
function validateStress(root: EvidenceRecord, errors: string[]): void {
  const stress = recordAt(root, 'stress', errors);
  const attempted = numberAt(stress, 'attempted', 'stress', errors);
  const accepted = numberAt(stress, 'accepted', 'stress', errors);
  requireEqual(
    numberAt(stress, 'durationSeconds', 'stress', errors),
    STRESS_SECONDS,
    'stress.durationSeconds',
    errors,
  );
  requireEqual(
    numberAt(stress, 'plannedMps', 'stress', errors),
    STRESS_MPS,
    'stress.plannedMps',
    errors,
  );
  requireEqual(attempted, STRESS_MPS * STRESS_SECONDS, 'stress.attempted', errors);
  requireAtLeast(accepted, 0, 'stress.accepted', errors);
  requireEqual(
    numberAt(stress, 'unclassified', 'stress', errors),
    0,
    'stress.unclassified',
    errors,
  );
  requireEqual(booleanAt(stress, 'crashed', 'stress', errors), false, 'stress.crashed', errors);
  requireEqual(booleanAt(stress, 'oomKilled', 'stress', errors), false, 'stress.oomKilled', errors);
  requireEqual(booleanAt(stress, 'corrupted', 'stress', errors), false, 'stress.corrupted', errors);

  const rejectedByReason = recordAt(stress, 'rejectedByReason', errors);
  let rejected = 0;
  for (const [reason, count] of Object.entries(rejectedByReason)) {
    if (
      reason.length === 0 ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      errors.push(`stress.rejectedByReason.${reason} must be a non-negative integer`);
    } else {
      rejected += count;
    }
  }
  requireEqual(accepted + rejected, attempted, 'stress accepted + rejectedByReason total', errors);
}

/** Task 5.2: all nine scenarios, each recovered, each with a clean ledger. */
function validateFaults(root: EvidenceRecord, errors: string[]): void {
  const value = root['faults'];
  if (!Array.isArray(value)) {
    errors.push('faults must be an array');
    return;
  }
  const required = new Set<string>(REQUIRED_FAULTS);
  const observed = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`faults[${index}] must be an object`);
      continue;
    }
    const path = `faults[${index}]`;
    const scenario = stringAt(item, 'scenario', path, errors);
    if (observed.has(scenario)) errors.push(`${path}.scenario must be unique`);
    observed.add(scenario);
    if (!required.has(scenario)) errors.push(`${path}.scenario is not in the locked matrix`);
    requireEqual(booleanAt(item, 'recovered', path, errors), true, `${path}.recovered`, errors);
    requireEqual(
      numberAt(item, 'missingSourceIds', path, errors),
      0,
      `${path}.missingSourceIds`,
      errors,
    );
    requireEqual(
      numberAt(item, 'duplicateBusinessEffects', path, errors),
      0,
      `${path}.duplicateBusinessEffects`,
      errors,
    );
    requireEqual(
      numberAt(item, 'unexpectedDlqMessages', path, errors),
      0,
      `${path}.unexpectedDlqMessages`,
      errors,
    );
  }
  for (const scenario of REQUIRED_FAULTS) {
    if (!observed.has(scenario)) errors.push(`faults must include ${scenario}`);
  }
}

/**
 * Task 5.4. The ratios are gates AND a routing decision: compute pressure buys
 * a droplet resize, storage pressure buys a separate volume with an offline
 * verified migration, and both buys both. The verdict is emitted even on
 * failure — that is the point of running the gate.
 */
function validateResources(root: EvidenceRecord, errors: string[]): HardwareDecision {
  const resources = recordAt(root, 'resources', errors);
  const cpu = numberAt(resources, 'p95CpuRatio', 'resources', errors);
  const memory = numberAt(resources, 'p95WorkingSetMemoryRatio', 'resources', errors);
  const volume = numberAt(resources, 'p95VolumeUsedRatio', 'resources', errors);
  const iops = numberAt(resources, 'p95IopsBusyRatio', 'resources', errors);
  const computeFailed = cpu > CPU_CEILING_RATIO || memory > MEMORY_CEILING_RATIO;
  const storageFailed = volume > VOLUME_CEILING_RATIO || iops > IOPS_CEILING_RATIO;
  requireAtLeast(cpu, 0, 'resources.p95CpuRatio', errors);
  requireAtLeast(memory, 0, 'resources.p95WorkingSetMemoryRatio', errors);
  requireAtLeast(volume, 0, 'resources.p95VolumeUsedRatio', errors);
  requireAtLeast(iops, 0, 'resources.p95IopsBusyRatio', errors);
  requireAtMost(cpu, CPU_CEILING_RATIO, 'resources.p95CpuRatio', errors);
  requireAtMost(memory, MEMORY_CEILING_RATIO, 'resources.p95WorkingSetMemoryRatio', errors);
  requireAtMost(volume, VOLUME_CEILING_RATIO, 'resources.p95VolumeUsedRatio', errors);
  requireAtMost(iops, IOPS_CEILING_RATIO, 'resources.p95IopsBusyRatio', errors);
  if (computeFailed && storageFailed) {
    return 'RESIZE_DROPLET_AND_SEPARATE_VOLUME_OFFLINE_MIGRATION';
  }
  if (storageFailed) return 'SEPARATE_VOLUME_OFFLINE_MIGRATION';
  if (computeFailed) return 'RESIZE_DROPLET';
  return 'NONE';
}

/**
 * Task 5.5. Raw sensor_metrics keeps FORCE RLS and stays uncompressed no
 * matter what the benchmark says; the three thresholds only decide whether
 * compression may be enabled OUTSIDE raw.
 */
function validateCompression(root: EvidenceRecord, errors: string[]): void {
  const compression = recordAt(root, 'compression', errors);
  requireEqual(
    booleanAt(compression, 'rawForceRls', 'compression', errors),
    true,
    'compression.rawForceRls',
    errors,
  );
  requireEqual(
    booleanAt(compression, 'rawCompressed', 'compression', errors),
    false,
    'compression.rawCompressed',
    errors,
  );
  const enabled = booleanAt(compression, 'enabled', 'compression', errors);
  if (!enabled) return;
  const target = stringAt(compression, 'target', 'compression', errors);
  if (!COMPRESSION_TARGETS.has(target)) {
    errors.push('compression.target must be tenant-scoped-aggregate or cold-storage');
  }
  requireAtLeast(
    numberAt(compression, 'storageReductionRatio', 'compression', errors),
    COMPRESSION_MIN_STORAGE_REDUCTION,
    'compression.storageReductionRatio',
    errors,
  );
  requireAtMost(
    numberAt(compression, 'p99RegressionRatio', 'compression', errors),
    COMPRESSION_MAX_P99_REGRESSION,
    'compression.p99RegressionRatio',
    errors,
  );
  requireEqual(
    numberAt(compression, 'isolationMismatches', 'compression', errors),
    0,
    'compression.isolationMismatches',
    errors,
  );
}

/**
 * Task 5.6. A logical dump is explicitly not accepted as the five-year DR
 * proof, so the method is checked before anything else. The three survival
 * flags are the three things a restore has to bring back for the retention
 * contract to mean anything: the tenant schemas, the aggregates older than the
 * hot window, and the archive lifecycle ledger that says which cold objects
 * were verified.
 */
function validateWalgRestore(root: EvidenceRecord, errors: string[]): void {
  const restore = recordAt(root, 'walgRestore', errors);
  requireEqual(restore['method'], 'WAL-G', 'walgRestore.method', errors);
  requireEqual(
    booleanAt(restore, 'scratchRestore', 'walgRestore', errors),
    true,
    'walgRestore.scratchRestore',
    errors,
  );
  const rpoSeconds = numberAt(restore, 'rpoSeconds', 'walgRestore', errors);
  requireAtLeast(rpoSeconds, 0, 'walgRestore.rpoSeconds', errors);
  requireAtMost(rpoSeconds, WALG_MAX_RPO_SECONDS, 'walgRestore.rpoSeconds', errors);
  requireEqual(
    booleanAt(restore, 'tenantSchemaSurvived', 'walgRestore', errors),
    true,
    'walgRestore.tenantSchemaSurvived',
    errors,
  );
  requireEqual(
    booleanAt(restore, 'olderThanP90dCaggSurvived', 'walgRestore', errors),
    true,
    'walgRestore.olderThanP90dCaggSurvived',
    errors,
  );
  requireEqual(
    booleanAt(restore, 'archiveLedgerSurvived', 'walgRestore', errors),
    true,
    'walgRestore.archiveLedgerSurvived',
    errors,
  );
}

/**
 * Task 3 exit gate, verified by Task 5's run. Every recorded run must pass —
 * there is no "best of" — and every run must come from the same host, image
 * and config, so a promotion cannot be assembled out of runs that measured
 * different software.
 */
function validateSidecarPilot(root: EvidenceRecord, errors: string[]): 'PASS' | 'FAIL' {
  const before = errors.length;
  const value = root['sidecarPilotRuns'];
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('sidecarPilotRuns must contain at least one run');
    return 'FAIL';
  }
  const authorities = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`sidecarPilotRuns[${index}] must be an object`);
      continue;
    }
    const path = `sidecarPilotRuns[${index}]`;
    const hostId = stringAt(item, 'hostId', path, errors);
    const imageDigest = stringAt(item, 'imageDigest', path, errors);
    const configSha256 = stringAt(item, 'configSha256', path, errors);
    authorities.add(`${hostId} ${imageDigest} ${configSha256}`);
    if (!IMAGE_DIGEST.test(imageDigest)) {
      errors.push(`${path}.imageDigest must be a sha256 image digest`);
    }
    requireSha256(configSha256, `${path}.configSha256`, errors);
    requireEqual(numberAt(item, 'runIndex', path, errors), index, `${path}.runIndex`, errors);
    requireEqual(
      numberAt(item, 'reconciliationMismatches', path, errors),
      0,
      `${path}.reconciliationMismatches`,
      errors,
    );
    const nodeP99 = numberAt(item, 'nodeP99Seconds', path, errors);
    const rustP99 = numberAt(item, 'rustP99Seconds', path, errors);
    requireAtLeast(nodeP99, 0, `${path}.nodeP99Seconds`, errors);
    requireAtLeast(rustP99, 0, `${path}.rustP99Seconds`, errors);
    if (rustP99 > nodeP99) errors.push(`${path}.rustP99Seconds must not exceed Node p99`);
    const nodeCpu = numberAt(item, 'nodeCpuSecondsPerMessage', path, errors);
    const rustCpu = numberAt(item, 'rustCpuSecondsPerMessage', path, errors);
    requireAtLeast(rustCpu, 0, `${path}.rustCpuSecondsPerMessage`, errors);
    // Cross-multiplied rather than divided: `saving / node >= 0.2` loses the
    // comparison to floating-point drift for a run sitting on the floor.
    if (!(nodeCpu > 0) || !(rustCpu >= 0)) {
      errors.push(`${path}.CPU-seconds per message must be a positive Node baseline`);
    } else if (nodeCpu - rustCpu < SIDECAR_MIN_CPU_REDUCTION * nodeCpu) {
      errors.push(`${path}.rust CPU-seconds per message must be at least 20% lower`);
    }
  }
  if (authorities.size !== 1) {
    errors.push('sidecarPilotRuns must use the same host, image and config');
  }
  return errors.length === before ? 'PASS' : 'FAIL';
}

interface Verdict {
  errors: string[];
  hardwareDecision: HardwareDecision;
  sidecarPromotion: 'PASS' | 'FAIL';
}

function evaluate(root: EvidenceRecord): Verdict {
  const errors: string[] = [];
  requireEqual(root['schemaVersion'], 1, 'schemaVersion', errors);
  stringAt(root, 'runId', 'root', errors);
  validateEnvironment(root, errors);
  validateSustained(root, errors);
  validateRecovery(root, errors);
  validateStress(root, errors);
  validateFaults(root, errors);
  const hardwareDecision = validateResources(root, errors);
  validateCompression(root, errors);
  validateWalgRestore(root, errors);
  const sidecarPromotion = validateSidecarPilot(root, errors);
  return { errors, hardwareDecision, sidecarPromotion };
}

function main(): void {
  const evidencePath = argumentValue('--evidence');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    stderr.write(`telemetry-readiness: evidence is unreadable: ${detail}\n`);
    exit(2);
  }
  if (!isRecord(parsed)) {
    stderr.write('telemetry-readiness: evidence root must be an object\n');
    exit(2);
  }

  const result = evaluate(parsed);
  const status = result.errors.length === 0 ? 'PASS' : 'FAIL';
  stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      status,
      hardwareDecision: result.hardwareDecision,
      sidecarPromotion: result.sidecarPromotion,
      violationCount: result.errors.length,
    })}\n`,
  );
  if (result.errors.length > 0) {
    stderr.write(`${result.errors.map((error) => `- ${error}`).join('\n')}\n`);
    exit(1);
  }
}

main();
