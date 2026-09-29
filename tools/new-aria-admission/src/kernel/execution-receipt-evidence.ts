import { canonicalJsonBytes } from './canonical-json';
import { canonicalTimestamp } from './evidence-manifest-schema';
import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  JsonRecord,
  requiredSha256,
  requiredText,
} from './evidence-object';
import { requireIdentifier } from './identifiers';
import { JsonValue } from './strict-json';
import { workflowExitCode } from './verdict-propagation';

const executionKeys = [
  'schema_version',
  'contract_id',
  'repository_id',
  'workspace_id',
  'base_sha',
  'head_sha',
  'tree_sha',
  'execution_session_id',
  'run_id',
  'run_context_sha256',
  'run_nonce_sha256',
  'argv',
  'argv_sha256',
  'materialized_argv',
  'materialized_argv_sha256',
  'cwd',
  'cwd_sha256',
  'input_reference_bundle_sha256',
  'input_envelope_sha256',
  'input_object_sha256s',
  'current_epoch_provider_identity_sha256',
  'current_epoch_snapshot_sha256',
  'current_epoch_revision',
  'current_epoch_read_at',
  'output_sha256',
  'runtime',
  'tool',
  'started_at_utc',
  'ended_at_utc',
  'process',
  'result',
  'stdout',
  'stderr',
] as const;
const sha40 = /^[a-f0-9]{40}$/u;

function record(value: JsonValue | undefined, keys: readonly string[], label: string): JsonRecord {
  if (!isJsonRecord(value) || !hasExactKeys(value, keys)) {
    throw new TypeError(`${label} schema is invalid`);
  }
  return value;
}

function safeText(value: JsonValue | undefined, label: string): string {
  const text = requiredText(value, label);
  if (
    Array.from(text).some((character) => {
      const point = character.codePointAt(0);
      return (
        point === undefined ||
        point < 0x20 ||
        point === 0x7f ||
        (point >= 0x202a && point <= 0x202e) ||
        (point >= 0x2066 && point <= 0x2069)
      );
    })
  ) {
    throw new TypeError(`${label} contains unsafe text`);
  }
  return text;
}

function timestamp(value: JsonValue | undefined, label: string): string {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (
    !canonicalTimestamp.test(text) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== text
  ) {
    throw new TypeError(`${label} is not canonical UTC`);
  }
  return text;
}

function validateArtifact(value: JsonValue | undefined, label: string): JsonRecord {
  const artifact = record(value, ['byte_length', 'sha256'], label);
  if (!Number.isSafeInteger(artifact.byte_length) || (artifact.byte_length as number) < 0) {
    throw new TypeError(`${label} byte length is invalid`);
  }
  requiredSha256(artifact.sha256, `${label} digest`);
  return artifact;
}

function validateInvocation(value: JsonRecord): void {
  const argv = value.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((argument) => typeof argument !== 'string' || safeText(argument, 'argv') !== argument)
  ) {
    throw new TypeError('execution receipt argv is invalid');
  }
  const logicalArgv = argv.map((argument) => safeText(argument, 'argv'));
  if (
    requiredSha256(value.argv_sha256, 'execution argv digest') !==
    digestBytes(canonicalJsonBytes(logicalArgv))
  ) {
    throw new TypeError('execution argv digest mismatch');
  }
  const materializedArgv = value.materialized_argv;
  if (
    !Array.isArray(materializedArgv) ||
    materializedArgv.length !== argv.length ||
    materializedArgv.some(
      (argument) =>
        typeof argument !== 'string' || safeText(argument, 'materialized argv') !== argument,
    ) ||
    materializedArgv.slice(2).some((argument, index) => argument !== logicalArgv[index + 2]) ||
    requiredSha256(value.materialized_argv_sha256, 'materialized argv digest') !==
      digestBytes(canonicalJsonBytes(materializedArgv))
  ) {
    throw new TypeError('execution materialized argv is invalid');
  }
  const cwd = safeText(value.cwd, 'execution working directory');
  if (value.cwd_sha256 !== digestBytes(Buffer.from(cwd))) {
    throw new TypeError('execution working directory digest mismatch');
  }
}

function validateRuntime(value: JsonRecord): void {
  const runtime = record(
    value.runtime,
    ['id', 'version', 'executable_sha256'],
    'execution runtime',
  );
  const tool = record(value.tool, ['id', 'sha256'], 'execution tool');
  requireIdentifier(runtime.id, 'execution runtime identifier');
  safeText(runtime.version, 'execution runtime version');
  requiredSha256(runtime.executable_sha256, 'execution runtime digest');
  requireIdentifier(tool.id, 'execution tool identifier');
  requiredSha256(tool.sha256, 'execution tool digest');
}

function validateInputObjects(value: JsonRecord): void {
  const digests = value.input_object_sha256s;
  const expectedCount = value.run_id === 'BASELINE' ? 4 : 6;
  if (
    !Array.isArray(digests) ||
    digests.length !== expectedCount ||
    new Set(digests).size !== digests.length
  )
    throw new TypeError('execution input object roster is invalid');
  for (const digest of digests) requiredSha256(digest, 'execution input object digest');
}

function validateResult(value: JsonRecord): void {
  const process = record(value.process, ['exit_code', 'workflow_succeeded'], 'execution process');
  const result = record(value.result, ['semantic_verdict', 'final_exit_code'], 'execution result');
  if (
    !Number.isSafeInteger(process.exit_code) ||
    (process.exit_code as number) < 0 ||
    (process.exit_code as number) > 255 ||
    typeof process.workflow_succeeded !== 'boolean' ||
    process.workflow_succeeded !== (process.exit_code === 0) ||
    (result.semantic_verdict !== 'PASSED' && result.semantic_verdict !== 'FAILED') ||
    result.final_exit_code !== workflowExitCode(result.semantic_verdict, process.workflow_succeeded)
  ) {
    throw new TypeError('execution process result is inconsistent');
  }
}

export function validateReceiptExecution(value: JsonValue | undefined): JsonRecord {
  const execution = record(value, executionKeys, 'execution receipt evidence');
  if (
    execution.schema_version !== '1.0.0' ||
    execution.contract_id !== 'new-aria-executable-run-v1'
  ) {
    throw new TypeError('execution receipt evidence identity is invalid');
  }
  requireIdentifier(execution.repository_id, 'execution repository identifier');
  requireIdentifier(execution.workspace_id, 'execution workspace identifier');
  requireIdentifier(execution.execution_session_id, 'execution session identifier');
  requireIdentifier(execution.run_id, 'execution run identifier');
  requiredSha256(execution.run_context_sha256, 'execution run context digest');
  requiredSha256(execution.run_nonce_sha256, 'execution run nonce digest');
  for (const field of ['base_sha', 'head_sha', 'tree_sha'] as const) {
    if (typeof execution[field] !== 'string' || !sha40.test(execution[field])) {
      throw new TypeError(`execution ${field} is invalid`);
    }
  }
  if (execution.base_sha === execution.head_sha)
    throw new TypeError('execution target range is empty');
  validateInvocation(execution);
  validateInputObjects(execution);
  for (const field of [
    'cwd_sha256',
    'input_reference_bundle_sha256',
    'input_envelope_sha256',
    'output_sha256',
  ] as const) {
    requiredSha256(execution[field], `execution ${field}`);
  }
  validateRuntime(execution);
  validateResult(execution);
  validateArtifact(execution.stdout, 'execution stdout');
  validateArtifact(execution.stderr, 'execution stderr');
  const startedAt = timestamp(execution.started_at_utc, 'execution start');
  const endedAt = timestamp(execution.ended_at_utc, 'execution end');
  const epochReadAt = timestamp(execution.current_epoch_read_at, 'execution epoch read');
  requiredSha256(
    execution.current_epoch_provider_identity_sha256,
    'execution current epoch provider identity',
  );
  requiredSha256(execution.current_epoch_snapshot_sha256, 'execution current epoch snapshot');
  if (
    !Number.isSafeInteger(execution.current_epoch_revision) ||
    (execution.current_epoch_revision as number) < 1 ||
    Date.parse(startedAt) > Date.parse(endedAt) ||
    Date.parse(endedAt) > Date.parse(epochReadAt)
  )
    throw new TypeError('execution or current epoch time moved backwards');
  return execution;
}

function freezeJson(value: JsonValue): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}

export function freezeReceiptExecution(value: JsonRecord): JsonRecord {
  freezeJson(value);
  return value;
}
