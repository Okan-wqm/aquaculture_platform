#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  parseCanonicalWalgEvidenceBytes,
  validateWalgEvidenceRecord,
} from './evaluate-walg-evidence.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ZERO_SHA = '0000000000000000000000000000000000000000';
const SAFE_TOKEN_RE = /^[A-Za-z0-9._:-]+$/;
const MAX_RAW_EVIDENCE_BYTES = 8 * 1024 * 1024;
const WORKFLOWS = Object.freeze({
  'backup-production.yml': {
    name: 'Backup - Production Postgres',
    workflowId: 261067403,
    modes: new Set(['full_backup', 'dry_run', 'bootstrap_only']),
    evidenceType: 'base_backup',
    evidenceFile: 'base-backup.json',
  },
  'pitr-restore-production.yml': {
    name: 'PITR Restore - Production Postgres',
    workflowId: null,
    modes: new Set(['timestamp_pitr']),
    evidenceType: 'timestamp_pitr',
    evidenceFile: 'timestamp-pitr.json',
  },
});
const JOB_RESULTS = new Set(['success', 'failure', 'cancelled', 'skipped']);
const EVENTS = new Set(['schedule', 'workflow_dispatch']);
const SOURCE_TRANSPORT = Object.freeze({
  type: 'native_openssh_stdout',
  client: 'system_openssh',
  host_key_verification: 'protected_sha256_fingerprint_exact_match',
});
const REPOSITORY_ID = 1132698735;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) fail('command required');
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(`invalid argument pair at ${flag ?? '<end>'}`);
    }
    const name = flag.slice(2);
    if (options.has(name)) fail(`duplicate option --${name}`);
    options.set(name, value);
  }
  return { command, options };
}

function required(options, name) {
  const value = options.get(name);
  if (!value) fail(`--${name} required`);
  return value;
}

function rejectUnknown(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.has(name)) fail(`unknown option --${name}`);
  }
}

function parsePositiveInteger(value, field) {
  if (!/^[1-9][0-9]*$/.test(value)) fail(`${field} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${field} exceeds the safe integer range`);
  return parsed;
}

function parseUtcTimestamp(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    fail(`${field} must use whole-second UTC form`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== `${value.slice(0, -1)}.000Z`) {
    fail(`${field} is not a valid timestamp`);
  }
  return value;
}

function validateEvidenceLifecycle(evidence, artifactCreatedAt, issuedAt) {
  const evidenceStartedAt = parseUtcTimestamp(evidence.started_at ?? '', 'evidence.started_at');
  const evidenceCompletedAt = parseUtcTimestamp(
    evidence.completed_at ?? '',
    'evidence.completed_at',
  );
  const artifactTimestamp = parseUtcTimestamp(artifactCreatedAt, 'artifact_created_at');
  const issuedTimestamp = parseUtcTimestamp(issuedAt, 'issued_at');
  if (
    Date.parse(evidenceStartedAt) > Date.parse(evidenceCompletedAt) ||
    Date.parse(evidenceCompletedAt) > Date.parse(artifactTimestamp) ||
    Date.parse(artifactTimestamp) > Date.parse(issuedTimestamp)
  ) {
    fail('evidence lifecycle must complete before artifact creation and signing');
  }
  return { evidenceStartedAt, evidenceCompletedAt };
}

function readJson(path, field) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${field} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${field} must contain one JSON object`);
  }
  return parsed;
}

function readCanonicalJson(path, field) {
  const bytes = readFileSync(path);
  const parsed = readJson(path, field);
  const canonical = Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8');
  if (!bytes.equals(canonical)) {
    fail(`${field} must be canonical one-line JSON with one trailing newline`);
  }
  return parsed;
}

function requireExactKeys(value, expectedKeys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${field} has an unexpected key set`);
  }
}

function writeExclusive(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function workflowContract(workflow) {
  const contract = WORKFLOWS[workflow];
  if (!contract) fail(`unsupported workflow: ${workflow}`);
  return contract;
}

function validateWorkflowRecord(record) {
  requireExactKeys(
    record,
    [
      'schema_version',
      'record_type',
      'authority',
      'record_id',
      'repository',
      'repository_id',
      'workflow',
      'mode',
      'job_result',
      'issued_at',
    ],
    'run record',
  );
  if (record.schema_version !== 2 || record.record_type !== 'workflow_run') {
    fail('run record must be a schema-v2 workflow_run');
  }
  if (record.authority !== 'github_actions_oidc_rekor') {
    fail('run record authority must be github_actions_oidc_rekor');
  }
  const workflow = record.workflow;
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    fail('run record workflow must be an object');
  }
  requireExactKeys(
    workflow,
    ['file', 'name', 'repository', 'ref', 'sha', 'run_id', 'run_attempt', 'event_name'],
    'run record workflow',
  );
  const contract = workflowContract(workflow.file);
  if (workflow.name !== contract.name) fail('workflow name/file contract mismatch');
  if (workflow.repository !== record.repository) fail('workflow repository mismatch');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository ?? '')) {
    fail('run record repository is invalid');
  }
  if (record.repository_id !== REPOSITORY_ID) fail('run record repository_id is invalid');
  if (workflow.ref !== 'refs/heads/main') fail('only refs/heads/main may authorize evidence');
  if (!SHA_RE.test(workflow.sha ?? '')) fail('workflow sha is invalid');
  if (!Number.isSafeInteger(workflow.run_id) || workflow.run_id < 1)
    fail('workflow run_id is invalid');
  if (!Number.isSafeInteger(workflow.run_attempt) || workflow.run_attempt < 1) {
    fail('workflow run_attempt is invalid');
  }
  if (!EVENTS.has(workflow.event_name)) fail('workflow event_name is invalid');
  if (!JOB_RESULTS.has(record.job_result)) fail('run record job_result is invalid');
  if (!contract.modes.has(record.mode)) fail('run record mode is invalid for its workflow');
  const expectedRecordId = `${workflow.file.replace(/\.yml$/, '')}:${workflow.run_id}:${workflow.run_attempt}`;
  if (!SAFE_TOKEN_RE.test(record.record_id ?? '') || record.record_id !== expectedRecordId) {
    fail('run record_id is invalid');
  }
  parseUtcTimestamp(record.issued_at ?? '', 'issued_at');
  return { workflow, contract };
}

function createRun(options) {
  const allowed = new Set([
    'output',
    'workflow',
    'workflow-name',
    'repository',
    'ref',
    'sha',
    'run-id',
    'run-attempt',
    'event-name',
    'job-result',
    'mode',
    'issued-at',
  ]);
  rejectUnknown(options, allowed);
  const output = required(options, 'output');
  const workflowFile = required(options, 'workflow');
  const contract = workflowContract(workflowFile);
  const workflowName = required(options, 'workflow-name');
  const repository = required(options, 'repository');
  const ref = required(options, 'ref');
  const sha = required(options, 'sha');
  const runId = parsePositiveInteger(required(options, 'run-id'), 'run-id');
  const runAttempt = parsePositiveInteger(required(options, 'run-attempt'), 'run-attempt');
  const eventName = required(options, 'event-name');
  const jobResult = required(options, 'job-result');
  const mode = required(options, 'mode');
  const issuedAt = parseUtcTimestamp(required(options, 'issued-at'), 'issued-at');

  if (workflowName !== contract.name) fail('workflow-name does not match workflow file');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('repository is invalid');
  if (ref !== 'refs/heads/main') fail('only refs/heads/main may authorize evidence');
  if (!SHA_RE.test(sha)) fail('sha must be a lowercase 40-character Git SHA');
  if (!EVENTS.has(eventName)) fail('event-name is unsupported');
  if (workflowFile === 'pitr-restore-production.yml' && eventName !== 'workflow_dispatch') {
    fail('PITR workflow evidence must be manually dispatched');
  }
  if (!JOB_RESULTS.has(jobResult)) fail('job-result is unsupported');
  if (!contract.modes.has(mode)) fail('mode is invalid for workflow');

  const record = {
    schema_version: 2,
    record_type: 'workflow_run',
    authority: 'github_actions_oidc_rekor',
    record_id: `${workflowFile.replace(/\.yml$/, '')}:${runId}:${runAttempt}`,
    repository,
    repository_id: REPOSITORY_ID,
    workflow: {
      file: workflowFile,
      name: workflowName,
      repository,
      ref,
      sha,
      run_id: runId,
      run_attempt: runAttempt,
      event_name: eventName,
    },
    mode,
    job_result: jobResult,
    issued_at: issuedAt,
  };
  validateWorkflowRecord(record);
  writeExclusive(output, record);
}

function validateEvidenceGate(evidence, evidenceType) {
  validateWalgEvidenceRecord(evidence);
  const expectedSchemaVersion = evidenceType === 'base_backup' ? 1 : 2;
  if (
    evidence.schema_version !== expectedSchemaVersion ||
    evidence.evidence_type !== evidenceType
  ) {
    fail(`evidence must be a schema-v${expectedSchemaVersion} ${evidenceType} record`);
  }
  if (evidence.status !== 'success') fail('only successful evidence may be promoted');
  if (
    !SHA_RE.test(evidence.source_image_revision ?? '') ||
    evidence.source_image_revision === ZERO_SHA
  ) {
    fail('successful evidence must bind a nonzero source image Git revision');
  }
  if (!SHA256_RE.test(evidence.source_postgres_dr_contract_sha256 ?? '')) {
    fail('successful evidence must bind the PostgreSQL DR contract SHA-256');
  }
  if (evidenceType === 'base_backup') {
    for (const flag of ['full', 'verified', 'wal_verified']) {
      if (evidence[flag] !== true) fail(`base backup evidence requires ${flag}=true`);
    }
  } else {
    for (const flag of [
      'timestamp_recovery',
      'isolated_target_attested',
      'wal_verified',
      'before_wal_marker_replayed',
      'after_wal_marker_excluded',
      'promoted',
      'database_verified',
    ]) {
      if (evidence[flag] !== true) fail(`PITR evidence requires ${flag}=true`);
    }
    if (evidence.restored_recovery_target_inclusive !== false) {
      fail('PITR evidence requires restored_recovery_target_inclusive=false');
    }
    if (
      !Number.isSafeInteger(evidence.rpo_seconds) ||
      evidence.rpo_seconds < 0 ||
      evidence.rpo_seconds > 300
    ) {
      fail('PITR evidence exceeds the 300-second RPO');
    }
    if (
      !Number.isSafeInteger(evidence.rto_seconds) ||
      evidence.rto_seconds < 0 ||
      evidence.rto_seconds > 3600
    ) {
      fail('PITR evidence exceeds the 3600-second RTO');
    }
    for (const field of [
      'source_database_verification_sha256',
      'restored_database_verification_sha256',
      'source_verification_snapshot_sha256',
      'source_verification_lock_set_sha256',
      'source_before_marker_content_sha256',
      'source_after_marker_content_sha256',
    ]) {
      if (!SHA256_RE.test(evidence[field] ?? '')) {
        fail(`PITR evidence must bind ${field}`);
      }
    }
  }
}

function evidenceGateSummary(evidence, evidenceType) {
  const common = {
    schema_version: evidence.schema_version,
    evidence_type: evidence.evidence_type,
    run_id: evidence.run_id,
    main_sha: evidence.main_sha,
    status: evidence.status,
    source_image_revision: evidence.source_image_revision,
    source_postgres_dr_contract_sha256: evidence.source_postgres_dr_contract_sha256,
  };
  if (evidenceType === 'base_backup') {
    return {
      ...common,
      full: evidence.full,
      verified: evidence.verified,
      wal_verified: evidence.wal_verified,
    };
  }
  return {
    ...common,
    timestamp_recovery: evidence.timestamp_recovery,
    recovery_target_time: evidence.recovery_target_time,
    restored_recovery_target_time: evidence.restored_recovery_target_time,
    restored_recovery_target_inclusive: evidence.restored_recovery_target_inclusive,
    restored_recovery_target_timeline: evidence.restored_recovery_target_timeline,
    restored_recovery_target_action: evidence.restored_recovery_target_action,
    isolated_target_attested: evidence.isolated_target_attested,
    wal_verified: evidence.wal_verified,
    wal_marker_prefix: evidence.wal_marker_prefix,
    wal_commit_fence_prefix: evidence.wal_commit_fence_prefix,
    source_before_marker_content: evidence.source_before_marker_content,
    source_before_marker_content_sha256: evidence.source_before_marker_content_sha256,
    source_before_marker_emitted_at: evidence.source_before_marker_emitted_at,
    source_before_marker_lsn: evidence.source_before_marker_lsn,
    source_before_commit_fence_at: evidence.source_before_commit_fence_at,
    source_before_commit_fence_lsn: evidence.source_before_commit_fence_lsn,
    source_after_marker_content: evidence.source_after_marker_content,
    source_after_marker_content_sha256: evidence.source_after_marker_content_sha256,
    source_after_marker_emitted_at: evidence.source_after_marker_emitted_at,
    source_after_marker_lsn: evidence.source_after_marker_lsn,
    source_after_commit_fence_at: evidence.source_after_commit_fence_at,
    source_after_commit_fence_lsn: evidence.source_after_commit_fence_lsn,
    before_wal_marker_replayed: evidence.before_wal_marker_replayed,
    after_wal_marker_excluded: evidence.after_wal_marker_excluded,
    promoted: evidence.promoted,
    rpo_seconds: evidence.rpo_seconds,
    rto_seconds: evidence.rto_seconds,
    database_verified: evidence.database_verified,
    source_database_release_sha: evidence.source_database_release_sha,
    source_database_verification_sha256: evidence.source_database_verification_sha256,
    restored_database_release_sha: evidence.restored_database_release_sha,
    restored_database_verification_sha256: evidence.restored_database_verification_sha256,
    source_verification_snapshot_id: evidence.source_verification_snapshot_id,
    source_verification_snapshot_sha256: evidence.source_verification_snapshot_sha256,
    source_verification_completed_at: evidence.source_verification_completed_at,
    source_verification_floor_lsn: evidence.source_verification_floor_lsn,
    source_verification_lock_set_sha256: evidence.source_verification_lock_set_sha256,
    source_verification_lock_count: evidence.source_verification_lock_count,
    source_verification_lock_timeout_ms: evidence.source_verification_lock_timeout_ms,
    source_verification_statement_timeout_ms: evidence.source_verification_statement_timeout_ms,
    source_verification_idle_timeout_ms: evidence.source_verification_idle_timeout_ms,
    restored_replay_lsn: evidence.restored_replay_lsn,
  };
}

function canonicalArtifactDigest(value) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail('artifact-digest must use canonical sha256:<hex> form');
  }
  return value;
}

function expectedRawArtifactName(workflow) {
  return `walg-raw-evidence-v1-${workflow.file}-${workflow.run_id}-${workflow.run_attempt}`;
}

function validateRawArtifactBinding(binding, workflow, contract) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    fail('raw evidence artifact binding must be an object');
  }
  if (!Number.isSafeInteger(binding.id) || binding.id < 1) {
    fail('raw evidence artifact id is invalid');
  }
  if (binding.name !== expectedRawArtifactName(workflow)) {
    fail('raw evidence artifact name is invalid');
  }
  canonicalArtifactDigest(binding.digest ?? '');
  parseUtcTimestamp(binding.artifact_created_at ?? '', 'artifact_created_at');
  if (binding.path !== contract.evidenceFile) {
    fail('raw evidence artifact path is invalid');
  }
  if (
    binding.workflow_run_id !== workflow.run_id ||
    binding.workflow_run_attempt !== workflow.run_attempt ||
    binding.head_sha !== workflow.sha
  ) {
    fail('raw evidence artifact workflow authority is invalid');
  }
}

function createEvidence(options) {
  const allowed = new Set([
    'output',
    'run-record',
    'evidence',
    'artifact-id',
    'artifact-name',
    'artifact-digest',
    'artifact-created-at',
    'artifact-path',
  ]);
  rejectUnknown(options, allowed);
  const output = required(options, 'output');
  const runRecord = readCanonicalJson(required(options, 'run-record'), 'run-record');
  const { workflow, contract } = validateWorkflowRecord(runRecord);
  if (runRecord.job_result !== 'success') fail('failed workflow jobs cannot promote evidence');
  if (
    (contract.evidenceType === 'base_backup' && runRecord.mode !== 'full_backup') ||
    (contract.evidenceType === 'timestamp_pitr' && runRecord.mode !== 'timestamp_pitr')
  ) {
    fail('run mode is not evidence-producing');
  }

  const evidencePath = required(options, 'evidence');
  const evidenceBytes = readFileSync(evidencePath);
  if (evidenceBytes.byteLength < 1 || evidenceBytes.byteLength > MAX_RAW_EVIDENCE_BYTES) {
    fail(`evidence bytes must be in [1,${MAX_RAW_EVIDENCE_BYTES}]`);
  }
  const evidence = parseCanonicalWalgEvidenceBytes(evidenceBytes, 'evidence');
  validateEvidenceGate(evidence, contract.evidenceType);
  const expectedRunId = `gha-${workflow.run_id}-${workflow.run_attempt}`;
  if (evidence.run_id !== expectedRunId)
    fail('evidence run_id does not match workflow run/attempt');
  if (evidence.main_sha !== workflow.sha) fail('evidence main_sha does not match workflow SHA');

  const artifact = {
    id: parsePositiveInteger(required(options, 'artifact-id'), 'artifact-id'),
    name: required(options, 'artifact-name'),
    digest: canonicalArtifactDigest(required(options, 'artifact-digest')),
    artifact_created_at: parseUtcTimestamp(
      required(options, 'artifact-created-at'),
      'artifact-created-at',
    ),
    path: required(options, 'artifact-path'),
    workflow_run_id: workflow.run_id,
    workflow_run_attempt: workflow.run_attempt,
    head_sha: workflow.sha,
  };
  validateRawArtifactBinding(artifact, workflow, contract);
  validateEvidenceLifecycle(evidence, artifact.artifact_created_at, runRecord.issued_at);

  const record = {
    schema_version: 3,
    record_type: 'backup_evidence_binding',
    authority: 'github_actions_oidc_rekor',
    record_id: `${contract.evidenceType}:${workflow.run_id}:${workflow.run_attempt}`,
    repository: runRecord.repository,
    repository_id: runRecord.repository_id,
    workflow,
    mode: runRecord.mode,
    job_result: runRecord.job_result,
    issued_at: runRecord.issued_at,
    source_transport: {
      ...SOURCE_TRANSPORT,
      sha256: createHash('sha256').update(evidenceBytes).digest('hex'),
      bytes: evidenceBytes.byteLength,
      artifact,
    },
    evidence_gate: evidenceGateSummary(evidence, contract.evidenceType),
  };
  writeExclusive(output, record);
}

function validateApiWorkflow(apiWorkflow, workflow) {
  const contract = workflowContract(workflow.file);
  if (!Number.isSafeInteger(Number(apiWorkflow.id)) || Number(apiWorkflow.id) < 1) {
    fail('GitHub API workflow id is invalid');
  }
  if (apiWorkflow.path !== `.github/workflows/${workflow.file}`) {
    fail('GitHub API workflow authority path mismatch');
  }
  if (apiWorkflow.name !== workflow.name) fail('GitHub API workflow authority name mismatch');
  if (apiWorkflow.state !== 'active') fail('GitHub API workflow authority is not active');
  if (contract.workflowId !== null && Number(apiWorkflow.id) !== contract.workflowId) {
    fail('GitHub API canonical workflow id mismatch');
  }
}

function validateApiRun(
  apiRun,
  apiWorkflow,
  workflow,
  issuedAt,
  artifactCreatedAt = null,
  evidenceStartedAt = null,
  evidenceCompletedAt = null,
) {
  validateApiWorkflow(apiWorkflow, workflow);
  if (Number(apiRun.id) !== workflow.run_id) fail('GitHub API run id mismatch');
  if (Number(apiRun.run_attempt) !== workflow.run_attempt) fail('GitHub API run attempt mismatch');
  if (apiRun.head_sha !== workflow.sha) fail('GitHub API head SHA mismatch');
  if (apiRun.head_branch !== 'main') fail('GitHub API run is not on main');
  if (apiRun.event !== workflow.event_name) fail('GitHub API event mismatch');
  if (apiRun.path !== `.github/workflows/${workflow.file}`)
    fail('GitHub API workflow path mismatch');
  if (apiRun.name !== workflow.name) fail('GitHub API workflow name mismatch');
  if (Number(apiRun.workflow_id) !== Number(apiWorkflow.id)) {
    fail('GitHub API workflow id mismatch');
  }
  if (
    Number(apiRun.repository?.id) !== REPOSITORY_ID ||
    apiRun.repository?.full_name !== workflow.repository
  ) {
    fail('GitHub API repository identity mismatch');
  }
  const issuedEpoch = Date.parse(issuedAt);
  const startedEpoch = Date.parse(apiRun.run_started_at ?? '');
  const updatedEpoch = Date.parse(apiRun.updated_at ?? '');
  if (
    !Number.isFinite(startedEpoch) ||
    !Number.isFinite(updatedEpoch) ||
    startedEpoch > updatedEpoch
  ) {
    fail('GitHub run interval is invalid');
  }
  if (issuedEpoch < startedEpoch || issuedEpoch > updatedEpoch) {
    fail('signed issued_at is outside the GitHub run interval');
  }
  if (artifactCreatedAt !== null) {
    const artifactCreatedEpoch = Date.parse(artifactCreatedAt);
    if (artifactCreatedEpoch < startedEpoch || artifactCreatedEpoch > updatedEpoch) {
      fail('artifact_created_at is outside the exact GitHub run interval');
    }
  }
  if (evidenceStartedAt !== null || evidenceCompletedAt !== null) {
    if (evidenceStartedAt === null || evidenceCompletedAt === null || artifactCreatedAt === null) {
      fail('evidence lifecycle API validation is incomplete');
    }
    const evidenceStartedEpoch = Date.parse(evidenceStartedAt);
    const evidenceCompletedEpoch = Date.parse(evidenceCompletedAt);
    const artifactCreatedEpoch = Date.parse(artifactCreatedAt);
    if (
      evidenceStartedEpoch < startedEpoch ||
      evidenceStartedEpoch > evidenceCompletedEpoch ||
      evidenceCompletedEpoch > artifactCreatedEpoch ||
      artifactCreatedEpoch > issuedEpoch ||
      issuedEpoch > updatedEpoch
    ) {
      fail('signed evidence lifecycle is outside the exact GitHub run interval');
    }
  }
}

function verifyRun(options) {
  const allowed = new Set(['run-record', 'api-run', 'api-workflow']);
  rejectUnknown(options, allowed);
  const runRecord = readCanonicalJson(required(options, 'run-record'), 'run-record');
  const { workflow } = validateWorkflowRecord(runRecord);
  const apiRun = readJson(required(options, 'api-run'), 'api-run');
  const apiWorkflow = readJson(required(options, 'api-workflow'), 'api-workflow');
  validateApiRun(apiRun, apiWorkflow, workflow, runRecord.issued_at);
  if (apiRun.status !== 'completed' || apiRun.conclusion !== runRecord.job_result) {
    fail('GitHub API conclusion does not match the signed job result');
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, mode: runRecord.mode, result: runRecord.job_result })}\n`,
  );
}

function verifyLocalRun(options) {
  const allowed = new Set([
    'run-record',
    'workflow',
    'workflow-name',
    'repository',
    'ref',
    'sha',
    'run-id',
    'run-attempt',
    'event-name',
    'job-result',
    'mode',
  ]);
  rejectUnknown(options, allowed);
  const runRecord = readCanonicalJson(required(options, 'run-record'), 'run-record');
  const { workflow } = validateWorkflowRecord(runRecord);
  const expected = {
    file: required(options, 'workflow'),
    name: required(options, 'workflow-name'),
    repository: required(options, 'repository'),
    ref: required(options, 'ref'),
    sha: required(options, 'sha'),
    run_id: parsePositiveInteger(required(options, 'run-id'), 'run-id'),
    run_attempt: parsePositiveInteger(required(options, 'run-attempt'), 'run-attempt'),
    event_name: required(options, 'event-name'),
  };
  if (JSON.stringify(workflow) !== JSON.stringify(expected)) {
    fail('run record does not match the live signer workflow context');
  }
  if (
    runRecord.job_result !== required(options, 'job-result') ||
    runRecord.mode !== required(options, 'mode')
  ) {
    fail('run record result/mode does not match the live signer workflow context');
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, mode: runRecord.mode, result: runRecord.job_result })}\n`,
  );
}

function validateBoundEvidence(attestation, runRecord, evidencePath, artifactOptions) {
  requireExactKeys(
    attestation,
    [
      'schema_version',
      'record_type',
      'authority',
      'record_id',
      'repository',
      'repository_id',
      'workflow',
      'mode',
      'job_result',
      'issued_at',
      'source_transport',
      'evidence_gate',
    ],
    'evidence attestation',
  );
  if (
    attestation.schema_version !== 3 ||
    attestation.record_type !== 'backup_evidence_binding' ||
    attestation.authority !== 'github_actions_oidc_rekor'
  ) {
    fail('attestation must be a schema-v3 backup_evidence_binding record');
  }
  const { workflow, contract } = validateWorkflowRecord(runRecord);
  if (runRecord.job_result !== 'success') fail('signed run record is not successful');
  if (JSON.stringify(attestation.workflow) !== JSON.stringify(workflow)) {
    fail('evidence attestation workflow does not match its run record');
  }
  if (
    attestation.repository !== runRecord.repository ||
    attestation.repository_id !== runRecord.repository_id ||
    attestation.mode !== runRecord.mode
  ) {
    fail('evidence attestation authority fields do not match its run record');
  }
  if (
    attestation.job_result !== runRecord.job_result ||
    attestation.issued_at !== runRecord.issued_at ||
    attestation.record_id !== `${contract.evidenceType}:${workflow.run_id}:${workflow.run_attempt}`
  ) {
    fail('evidence attestation run binding does not match its run record');
  }
  const source = attestation.source_transport;
  if (
    !source ||
    source.type !== SOURCE_TRANSPORT.type ||
    source.client !== SOURCE_TRANSPORT.client ||
    source.host_key_verification !== SOURCE_TRANSPORT.host_key_verification ||
    !/^[0-9a-f]{64}$/.test(source.sha256 ?? '') ||
    !Number.isSafeInteger(source.bytes) ||
    source.bytes < 1 ||
    source.bytes > MAX_RAW_EVIDENCE_BYTES
  ) {
    fail('evidence source transport is invalid');
  }
  requireExactKeys(
    source,
    ['type', 'client', 'host_key_verification', 'sha256', 'bytes', 'artifact'],
    'evidence source transport',
  );
  requireExactKeys(
    source.artifact,
    [
      'id',
      'name',
      'digest',
      'artifact_created_at',
      'path',
      'workflow_run_id',
      'workflow_run_attempt',
      'head_sha',
    ],
    'raw evidence artifact binding',
  );
  const evidenceGateKeys = [
    'schema_version',
    'evidence_type',
    'run_id',
    'main_sha',
    'status',
    'source_image_revision',
    'source_postgres_dr_contract_sha256',
    ...(contract.evidenceType === 'base_backup'
      ? ['full', 'verified', 'wal_verified']
      : [
          'timestamp_recovery',
          'recovery_target_time',
          'restored_recovery_target_time',
          'restored_recovery_target_inclusive',
          'restored_recovery_target_timeline',
          'restored_recovery_target_action',
          'isolated_target_attested',
          'wal_verified',
          'wal_marker_prefix',
          'wal_commit_fence_prefix',
          'source_before_marker_content',
          'source_before_marker_content_sha256',
          'source_before_marker_emitted_at',
          'source_before_marker_lsn',
          'source_before_commit_fence_at',
          'source_before_commit_fence_lsn',
          'source_after_marker_content',
          'source_after_marker_content_sha256',
          'source_after_marker_emitted_at',
          'source_after_marker_lsn',
          'source_after_commit_fence_at',
          'source_after_commit_fence_lsn',
          'before_wal_marker_replayed',
          'after_wal_marker_excluded',
          'promoted',
          'rpo_seconds',
          'rto_seconds',
          'database_verified',
          'source_database_release_sha',
          'source_database_verification_sha256',
          'restored_database_release_sha',
          'restored_database_verification_sha256',
          'source_verification_snapshot_id',
          'source_verification_snapshot_sha256',
          'source_verification_completed_at',
          'source_verification_floor_lsn',
          'source_verification_lock_set_sha256',
          'source_verification_lock_count',
          'source_verification_lock_timeout_ms',
          'source_verification_statement_timeout_ms',
          'source_verification_idle_timeout_ms',
          'restored_replay_lsn',
        ]),
  ];
  if (
    !attestation.evidence_gate ||
    typeof attestation.evidence_gate !== 'object' ||
    Array.isArray(attestation.evidence_gate)
  ) {
    fail('evidence gate summary must be an object');
  }
  requireExactKeys(attestation.evidence_gate, evidenceGateKeys, 'evidence gate summary');
  validateRawArtifactBinding(source.artifact, workflow, contract);
  const suppliedArtifact = {
    id: parsePositiveInteger(required(artifactOptions, 'artifact-id'), 'artifact-id'),
    name: required(artifactOptions, 'artifact-name'),
    digest: canonicalArtifactDigest(required(artifactOptions, 'artifact-digest')),
    artifact_created_at: parseUtcTimestamp(
      required(artifactOptions, 'artifact-created-at'),
      'artifact-created-at',
    ),
    path: contract.evidenceFile,
    workflow_run_id: workflow.run_id,
    workflow_run_attempt: workflow.run_attempt,
    head_sha: workflow.sha,
  };
  if (JSON.stringify(suppliedArtifact) !== JSON.stringify(source.artifact)) {
    fail('downloaded raw evidence artifact identity does not match its signed binding');
  }

  const evidenceBytes = readFileSync(evidencePath);
  if (evidenceBytes.byteLength < 1 || evidenceBytes.byteLength > MAX_RAW_EVIDENCE_BYTES) {
    fail(`evidence bytes must be in [1,${MAX_RAW_EVIDENCE_BYTES}]`);
  }
  const evidence = parseCanonicalWalgEvidenceBytes(evidenceBytes, 'evidence');
  if (
    source.bytes !== evidenceBytes.byteLength ||
    source.sha256 !== createHash('sha256').update(evidenceBytes).digest('hex')
  ) {
    fail('raw evidence hash/size does not match the signed artifact binding');
  }
  validateEvidenceGate(evidence, contract.evidenceType);
  if (
    JSON.stringify(attestation.evidence_gate) !==
    JSON.stringify(evidenceGateSummary(evidence, contract.evidenceType))
  ) {
    fail('raw evidence gate fields do not match the signed summary');
  }
  if (evidence.run_id !== `gha-${workflow.run_id}-${workflow.run_attempt}`) {
    fail('raw evidence run_id mismatch');
  }
  if (evidence.main_sha !== workflow.sha) fail('raw evidence SHA mismatch');
  validateEvidenceLifecycle(evidence, source.artifact.artifact_created_at, runRecord.issued_at);
  return { evidence, workflow };
}

function verifyBinding(options) {
  const allowed = new Set([
    'attestation',
    'run-record',
    'evidence',
    'artifact-id',
    'artifact-name',
    'artifact-digest',
    'artifact-created-at',
  ]);
  rejectUnknown(options, allowed);
  const attestation = readCanonicalJson(required(options, 'attestation'), 'attestation');
  const runRecord = readCanonicalJson(required(options, 'run-record'), 'run-record');
  validateBoundEvidence(attestation, runRecord, required(options, 'evidence'), options);
  process.stdout.write(`${JSON.stringify({ ok: true, binding: 'raw_evidence_artifact' })}\n`);
}

function extractEvidence(options) {
  const allowed = new Set([
    'attestation',
    'run-record',
    'api-run',
    'api-workflow',
    'evidence',
    'artifact-id',
    'artifact-name',
    'artifact-digest',
    'artifact-created-at',
    'output',
  ]);
  rejectUnknown(options, allowed);
  const attestation = readCanonicalJson(required(options, 'attestation'), 'attestation');
  const runRecord = readCanonicalJson(required(options, 'run-record'), 'run-record');
  const { evidence, workflow } = validateBoundEvidence(
    attestation,
    runRecord,
    required(options, 'evidence'),
    options,
  );
  const apiRun = readJson(required(options, 'api-run'), 'api-run');
  const apiWorkflow = readJson(required(options, 'api-workflow'), 'api-workflow');
  validateApiRun(
    apiRun,
    apiWorkflow,
    workflow,
    runRecord.issued_at,
    attestation.source_transport.artifact.artifact_created_at,
    evidence.started_at,
    evidence.completed_at,
  );
  if (apiRun.status !== 'completed' || apiRun.conclusion !== 'success') {
    fail('evidence may only be extracted from a completed successful workflow');
  }
  writeExclusive(required(options, 'output'), evidence);
}

export function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'create-run') createRun(options);
  else if (command === 'create-evidence') createEvidence(options);
  else if (command === 'verify-run') verifyRun(options);
  else if (command === 'verify-local-run') verifyLocalRun(options);
  else if (command === 'verify-binding') verifyBinding(options);
  else if (command === 'extract-evidence') extractEvidence(options);
  else fail(`unknown command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`FATAL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
