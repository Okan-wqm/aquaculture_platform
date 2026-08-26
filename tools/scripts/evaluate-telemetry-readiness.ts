#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';

type EvidenceRecord = Record<string, unknown>;
type HardwareDecision =
  | 'NONE'
  | 'RESIZE_DROPLET'
  | 'SEPARATE_VOLUME_OFFLINE_MIGRATION'
  | 'RESIZE_DROPLET_AND_SEPARATE_VOLUME_OFFLINE_MIGRATION';

const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const REQUIRED_FAULTS = new Set([
  'postgres-kill-5m',
  'sensor-service-restart',
  'nats-restart',
  'mosquitto-restart',
  'outage-30m',
  'buffer-60m',
  'dlq-replay',
  'tenant-erasure-with-pending',
]);

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

function requireSha256(value: string, path: string, errors: string[]): void {
  if (!SHA256.test(value)) errors.push(`${path} must be a lowercase SHA-256`);
}

function validateEnvironment(root: EvidenceRecord, errors: string[]): void {
  const environment = recordAt(root, 'environment', errors);
  requireEqual(environment.executionHost, 'external', 'environment.executionHost', errors);
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

function validateSustained(root: EvidenceRecord, errors: string[]): void {
  const sustained = recordAt(root, 'sustained', errors);
  const duration = numberAt(sustained, 'durationSeconds', 'sustained', errors);
  const accepted = numberAt(sustained, 'acceptedSourceIds', 'sustained', errors);
  const committed = numberAt(sustained, 'committedSourceIds', 'sustained', errors);
  requireEqual(duration, 1_800, 'sustained.durationSeconds', errors);
  requireEqual(
    numberAt(sustained, 'plannedMps', 'sustained', errors),
    2_000,
    'sustained.plannedMps',
    errors,
  );
  requireAtLeast(
    numberAt(sustained, 'achievedMps', 'sustained', errors),
    2_000,
    'sustained.achievedMps',
    errors,
  );
  requireEqual(accepted, 2_000 * 1_800, 'sustained.acceptedSourceIds', errors);
  requireEqual(committed, accepted, 'sustained.committedSourceIds', errors);
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
    numberAt(sustained, 'unexplainedDrops', 'sustained', errors),
    0,
    'sustained.unexplainedDrops',
    errors,
  );
  const p99EndToEndSeconds = numberAt(sustained, 'p99EndToEndSeconds', 'sustained', errors);
  requireAtLeast(p99EndToEndSeconds, 0, 'sustained.p99EndToEndSeconds', errors);
  requireAtMost(p99EndToEndSeconds, 4.999_999, 'sustained.p99EndToEndSeconds', errors);
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
  requireEqual(
    numberAt(sustained, 'tenantMinuteMismatches', 'sustained', errors),
    0,
    'sustained.tenantMinuteMismatches',
    errors,
  );
  requireAtLeast(
    numberAt(sustained, 'dlqCount', 'sustained', errors),
    0,
    'sustained.dlqCount',
    errors,
  );
}

function validateRecovery(root: EvidenceRecord, errors: string[]): void {
  const recovery = recordAt(root, 'recovery', errors);
  requireAtLeast(
    numberAt(recovery, 'newIngressMps', 'recovery', errors),
    2_000,
    'recovery.newIngressMps',
    errors,
  );
  requireEqual(
    numberAt(recovery, 'initialBacklogMessages', 'recovery', errors),
    2_000 * 3_600,
    'recovery.initialBacklogMessages',
    errors,
  );
  const durationSeconds = numberAt(recovery, 'durationSeconds', 'recovery', errors);
  requireAtLeast(durationSeconds, 1, 'recovery.durationSeconds', errors);
  requireAtMost(durationSeconds, 3_600, 'recovery.durationSeconds', errors);
  requireEqual(
    numberAt(recovery, 'backlogRemainingMessages', 'recovery', errors),
    0,
    'recovery.backlogRemainingMessages',
    errors,
  );
  requireAtLeast(
    numberAt(recovery, 'committedMps', 'recovery', errors),
    4_000,
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

function validateStress(root: EvidenceRecord, errors: string[]): void {
  const stress = recordAt(root, 'stress', errors);
  const attempted = numberAt(stress, 'attempted', 'stress', errors);
  const accepted = numberAt(stress, 'accepted', 'stress', errors);
  requireEqual(
    numberAt(stress, 'durationSeconds', 'stress', errors),
    300,
    'stress.durationSeconds',
    errors,
  );
  requireEqual(
    numberAt(stress, 'plannedMps', 'stress', errors),
    15_000,
    'stress.plannedMps',
    errors,
  );
  requireEqual(attempted, 15_000 * 300, 'stress.attempted', errors);
  requireAtLeast(accepted, 0, 'stress.accepted', errors);
  requireEqual(
    numberAt(stress, 'unclassified', 'stress', errors),
    0,
    'stress.unclassified',
    errors,
  );
  requireEqual(booleanAt(stress, 'crashed', 'stress', errors), false, 'stress.crashed', errors);
  requireEqual(booleanAt(stress, 'oomKilled', 'stress', errors), false, 'stress.oomKilled', errors);

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

function validateFaults(root: EvidenceRecord, errors: string[]): void {
  const value = root.faults;
  if (!Array.isArray(value)) {
    errors.push('faults must be an array');
    return;
  }
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
    if (!REQUIRED_FAULTS.has(scenario)) errors.push(`${path}.scenario is not in the locked matrix`);
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
      numberAt(item, 'unexplainedDrops', path, errors),
      0,
      `${path}.unexplainedDrops`,
      errors,
    );
  }
  for (const required of REQUIRED_FAULTS) {
    if (!observed.has(required)) errors.push(`faults must include ${required}`);
  }
}

function validateResources(root: EvidenceRecord, errors: string[]): HardwareDecision {
  const resources = recordAt(root, 'resources', errors);
  const cpu = numberAt(resources, 'p95CpuRatio', 'resources', errors);
  const memory = numberAt(resources, 'p95WorkingSetMemoryRatio', 'resources', errors);
  const volume = numberAt(resources, 'p95VolumeUsedRatio', 'resources', errors);
  const iops = numberAt(resources, 'p95IopsBusyRatio', 'resources', errors);
  const computeFailed = cpu > 0.7 || memory > 0.75;
  const storageFailed = volume > 0.7 || iops > 0.7;
  requireAtLeast(cpu, 0, 'resources.p95CpuRatio', errors);
  requireAtLeast(memory, 0, 'resources.p95WorkingSetMemoryRatio', errors);
  requireAtLeast(volume, 0, 'resources.p95VolumeUsedRatio', errors);
  requireAtLeast(iops, 0, 'resources.p95IopsBusyRatio', errors);
  requireAtMost(cpu, 0.7, 'resources.p95CpuRatio', errors);
  requireAtMost(memory, 0.75, 'resources.p95WorkingSetMemoryRatio', errors);
  requireAtMost(volume, 0.7, 'resources.p95VolumeUsedRatio', errors);
  requireAtMost(iops, 0.7, 'resources.p95IopsBusyRatio', errors);
  if (computeFailed && storageFailed) {
    return 'RESIZE_DROPLET_AND_SEPARATE_VOLUME_OFFLINE_MIGRATION';
  }
  if (storageFailed) return 'SEPARATE_VOLUME_OFFLINE_MIGRATION';
  if (computeFailed) return 'RESIZE_DROPLET';
  return 'NONE';
}

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
  requireEqual(compression.target, 'tenant-local-cagg', 'compression.target', errors);
  requireAtLeast(
    numberAt(compression, 'storageReductionRatio', 'compression', errors),
    0.3,
    'compression.storageReductionRatio',
    errors,
  );
  requireAtMost(
    numberAt(compression, 'p99RegressionRatio', 'compression', errors),
    0.1,
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

function validateWalgRestore(root: EvidenceRecord, errors: string[]): void {
  const restore = recordAt(root, 'walgRestore', errors);
  requireEqual(restore.method, 'WAL-G', 'walgRestore.method', errors);
  requireEqual(
    booleanAt(restore, 'scratchRestore', 'walgRestore', errors),
    true,
    'walgRestore.scratchRestore',
    errors,
  );
  const rpoSeconds = numberAt(restore, 'rpoSeconds', 'walgRestore', errors);
  requireAtLeast(rpoSeconds, 0, 'walgRestore.rpoSeconds', errors);
  requireAtMost(rpoSeconds, 300, 'walgRestore.rpoSeconds', errors);
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

function validateRustPilot(root: EvidenceRecord, errors: string[]): 'PASS' | 'FAIL' {
  const value = root.rustPilotRuns;
  if (!Array.isArray(value) || value.length !== 3) {
    errors.push('rustPilotRuns must contain exactly three runs');
    return 'FAIL';
  }
  const authorities = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`rustPilotRuns[${index}] must be an object`);
      continue;
    }
    const path = `rustPilotRuns[${index}]`;
    const hostId = stringAt(item, 'hostId', path, errors);
    const imageDigest = stringAt(item, 'imageDigest', path, errors);
    const configSha256 = stringAt(item, 'configSha256', path, errors);
    authorities.add(`${hostId}\u0000${imageDigest}\u0000${configSha256}`);
    if (!IMAGE_DIGEST.test(imageDigest))
      errors.push(`${path}.imageDigest must be a sha256 image digest`);
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
    if (rustP99 > nodeP99) errors.push(`${path}.rustP99Seconds must not exceed Node p99`);
    const nodeCpu = numberAt(item, 'nodeCpuSecondsPerAdmittedSource', path, errors);
    const rustCpu = numberAt(item, 'rustCpuSecondsPerAdmittedSource', path, errors);
    requireAtLeast(rustCpu, 0, `${path}.rustCpuSecondsPerAdmittedSource`, errors);
    if (!(nodeCpu > 0) || rustCpu < 0 || (nodeCpu - rustCpu) / nodeCpu + Number.EPSILON < 0.2) {
      errors.push(`${path}.rust CPU-seconds per admitted source must be at least 20% lower`);
    }
  }
  if (authorities.size !== 1) {
    errors.push('rustPilotRuns must use the same host, image and config');
  }
  return errors.some((error) => error.startsWith('rustPilotRuns')) ? 'FAIL' : 'PASS';
}

function evaluate(root: EvidenceRecord): {
  errors: string[];
  hardwareDecision: HardwareDecision;
  rustPromotion: 'PASS' | 'FAIL';
} {
  const errors: string[] = [];
  requireEqual(root.schemaVersion, 1, 'schemaVersion', errors);
  stringAt(root, 'runId', 'root', errors);
  validateEnvironment(root, errors);
  validateSustained(root, errors);
  validateRecovery(root, errors);
  validateStress(root, errors);
  validateFaults(root, errors);
  const hardwareDecision = validateResources(root, errors);
  validateCompression(root, errors);
  validateWalgRestore(root, errors);
  const rustPromotion = validateRustPilot(root, errors);
  return { errors, hardwareDecision, rustPromotion };
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
      rustPromotion: result.rustPromotion,
      violationCount: result.errors.length,
    })}\n`,
  );
  if (result.errors.length > 0) {
    stderr.write(`${result.errors.map((error) => `- ${error}`).join('\n')}\n`);
    exit(1);
  }
}

main();
