#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ZERO_SHA = '0000000000000000000000000000000000000000';
const SAFE_TOKEN_RE = /^[A-Za-z0-9._:-]+$/;
const WORKFLOWS = Object.freeze({
  'backup-production.yml': {
    name: 'Backup - Production Postgres',
    workflowId: 261067403,
    modes: new Set(['full_backup', 'dry_run', 'bootstrap_only']),
    evidenceType: 'base_backup',
  },
  'pitr-restore-production.yml': {
    name: 'PITR Restore - Production Postgres',
    workflowId: null,
    modes: new Set(['timestamp_pitr']),
    evidenceType: 'timestamp_pitr',
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
  if (!Number.isFinite(epoch)) fail(`${field} is not a valid timestamp`);
  return value;
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

/**
 * Read a record this tool itself wrote, and refuse anything but the exact bytes
 * it would have written.
 *
 * `readJson` only proves the file PARSES. A run record is the signer's input,
 * so a file that parses is not enough: `{...record, "unsigned_payload": "x"}`
 * parses, a pretty-printed copy parses, and a duplicated key parses with
 * last-one-wins. Each of those is a record the signer would accept while a
 * downstream reader sees something else. Re-serialising the parsed value and
 * comparing bytes rejects all three at once — extra fields, reformatting,
 * duplicate keys, a missing or doubled trailing newline, a BOM — because
 * `writeExclusive` is the only thing that legitimately produces these files and
 * it emits exactly `JSON.stringify(value) + '\n'`.
 *
 * NOT for GitHub API responses: those are not ours to canonicalise.
 */
function readCanonicalJson(path, field) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    fail(`${field} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${field} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${field} must contain one JSON object`);
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8'))) {
    fail(`${field} must be the canonical one-line JSON this tool writes`);
  }
  return parsed;
}

/**
 * Close the schema: a validator that only checks the fields it knows about
 * accepts every field it does not.
 */
function requireExactKeys(record, keys, label) {
  const expected = new Set(keys);
  const unexpected = Object.keys(record)
    .filter((key) => !expected.has(key))
    .sort();
  if (unexpected.length > 0) {
    fail(`${label} carries unexpected field(s): ${unexpected.join(', ')}`);
  }
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (missing.length > 0) {
    fail(`${label} is missing field(s): ${missing.join(', ')}`);
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

/** Exactly what `createRun` writes — the closed schema `validateWorkflowRecord` enforces. */
const RUN_RECORD_KEYS = [
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
];

const RUN_RECORD_WORKFLOW_KEYS = [
  'file',
  'name',
  'repository',
  'ref',
  'sha',
  'run_id',
  'run_attempt',
  'event_name',
];

function validateWorkflowRecord(record) {
  if (record.schema_version !== 2 || record.record_type !== 'workflow_run') {
    fail('run record must be a schema-v2 workflow_run');
  }
  if (record.authority !== 'github_actions_oidc_rekor') {
    fail('run record authority must be github_actions_oidc_rekor');
  }
  requireExactKeys(record, RUN_RECORD_KEYS, 'run record');
  const workflow = record.workflow;
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    fail('run record workflow must be an object');
  }
  requireExactKeys(workflow, RUN_RECORD_WORKFLOW_KEYS, 'run record workflow');
  const contract = workflowContract(workflow.file);
  if (workflow.name !== contract.name) fail('workflow name/file contract mismatch');
  if (workflow.repository !== record.repository) fail('workflow repository mismatch');
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
  if (!SAFE_TOKEN_RE.test(record.record_id ?? '')) fail('run record_id is invalid');
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
  if (evidence.schema_version !== 1 || evidence.evidence_type !== evidenceType) {
    fail(`evidence must be a schema-v1 ${evidenceType} record`);
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
      'before_sentinel_present',
      'promoted',
    ]) {
      if (evidence[flag] !== true) fail(`PITR evidence requires ${flag}=true`);
    }
    if (evidence.after_sentinel_present !== false) {
      fail('PITR evidence requires after_sentinel_present=false');
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
    if (!SHA256_RE.test(evidence.database_verification_sha256 ?? '')) {
      fail('PITR evidence must bind the canonical database verification SHA-256');
    }
  }
}

function createEvidence(options) {
  const allowed = new Set(['output', 'run-record', 'evidence']);
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
  const evidence = readJson(evidencePath, 'evidence');
  const canonicalEvidence = Buffer.from(`${JSON.stringify(evidence)}\n`, 'utf8');
  if (!evidenceBytes.equals(canonicalEvidence)) {
    fail('evidence must be canonical one-line JSON with one trailing newline');
  }
  validateEvidenceGate(evidence, contract.evidenceType);
  const expectedRunId = `gha-${workflow.run_id}-${workflow.run_attempt}`;
  if (evidence.run_id !== expectedRunId)
    fail('evidence run_id does not match workflow run/attempt');
  if (evidence.main_sha !== workflow.sha) fail('evidence main_sha does not match workflow SHA');

  const record = {
    schema_version: 2,
    record_type: 'backup_evidence',
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
    },
    evidence,
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

function validateApiRun(apiRun, apiWorkflow, workflow, issuedAt) {
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
    issuedEpoch < startedEpoch - 60_000 ||
    issuedEpoch > updatedEpoch + 60_000
  ) {
    fail('signed issued_at is outside the GitHub run interval');
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

/**
 * Prove a run record describes THIS run before the signer is asked to sign it.
 *
 * `verify-run` compares the record against the GitHub API, which needs a token
 * and a network round trip. The signing job already holds the authoritative
 * context in its own environment, so it can reject a substituted or stale
 * record locally, first — the cheap check that closes the window between
 * `create-run` writing the file and the signer reading it back.
 */
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

function extractEvidence(options) {
  const allowed = new Set(['attestation', 'run-record', 'api-run', 'api-workflow', 'output']);
  rejectUnknown(options, allowed);
  const attestation = readJson(required(options, 'attestation'), 'attestation');
  if (
    attestation.schema_version !== 2 ||
    attestation.record_type !== 'backup_evidence' ||
    attestation.authority !== 'github_actions_oidc_rekor'
  ) {
    fail('attestation must be a schema-v2 backup_evidence record');
  }
  const runRecord = readCanonicalJson(required(options, 'run-record'), 'run-record');
  const { workflow, contract } = validateWorkflowRecord(runRecord);
  const apiRun = readJson(required(options, 'api-run'), 'api-run');
  const apiWorkflow = readJson(required(options, 'api-workflow'), 'api-workflow');
  validateApiRun(apiRun, apiWorkflow, workflow, runRecord.issued_at);
  if (apiRun.status !== 'completed' || apiRun.conclusion !== 'success') {
    fail('evidence may only be extracted from a completed successful workflow');
  }
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
    source.bytes < 1
  ) {
    fail('evidence source transport is invalid');
  }
  const embeddedBytes = Buffer.from(`${JSON.stringify(attestation.evidence)}\n`, 'utf8');
  if (
    source.bytes !== embeddedBytes.byteLength ||
    source.sha256 !== createHash('sha256').update(embeddedBytes).digest('hex')
  ) {
    fail('evidence source transport hash/size does not match the signed embedded record');
  }
  validateEvidenceGate(attestation.evidence, contract.evidenceType);
  if (attestation.evidence.run_id !== `gha-${workflow.run_id}-${workflow.run_attempt}`) {
    fail('embedded evidence run_id mismatch');
  }
  if (attestation.evidence.main_sha !== workflow.sha) fail('embedded evidence SHA mismatch');
  writeExclusive(required(options, 'output'), attestation.evidence);
}

export function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'create-run') createRun(options);
  else if (command === 'create-evidence') createEvidence(options);
  else if (command === 'verify-run') verifyRun(options);
  else if (command === 'verify-local-run') verifyLocalRun(options);
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
