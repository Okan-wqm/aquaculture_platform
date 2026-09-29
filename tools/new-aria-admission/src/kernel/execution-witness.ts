import { canonicalJsonBytes } from './canonical-json';
import { canonicalTimestamp } from './evidence-manifest-schema';
import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  JsonRecord,
  requiredSha256,
  requiredText,
  verifyDigestObject,
  verifyEvidenceObject,
} from './evidence-object';
import { requireIdentifier } from './identifiers';
import { JsonValue } from './strict-json';

export type ExecutionVerdict = 'PASSED' | 'REJECTED';

export interface ExecutionExpectation {
  readonly run_context_sha256: string;
  readonly input_sha256: string;
  readonly output_sha256: string;
  readonly semantic_verdict: ExecutionVerdict;
  readonly observed_at: string;
}

export const executionWitnessKeys = [
  'execution_session_id',
  'run_id',
  'run_context_sha256',
  'run_nonce_sha256',
  'argv',
  'argv_sha256',
  'materialized_argv',
  'materialized_argv_sha256',
  'tool_id',
  'tool_sha256',
  'runtime_id',
  'runtime_sha256',
  'cwd',
  'cwd_sha256',
  'input_sha256',
  'input_reference_bundle_sha256',
  'input_envelope_sha256',
  'input_object_sha256s',
  'current_epoch_provider_identity_sha256',
  'current_epoch_snapshot_sha256',
  'current_epoch_revision',
  'current_epoch_read_at',
  'execution_receipt',
  'output_sha256',
  'started_at',
  'finished_at',
  'exit_code',
  'stdout_sha256',
  'stderr_sha256',
  'stderr_byte_length',
  'failure_reason_sha256',
  'semantic_verdict',
] as const;

function isSafeText(value: string): boolean {
  if (value.length === 0) return false;
  return Array.from(value).every((character) => {
    const point = character.codePointAt(0);
    return (
      point !== undefined &&
      point >= 0x20 &&
      point !== 0x7f &&
      (point < 0x202a || point > 0x202e) &&
      (point < 0x2066 || point > 0x2069)
    );
  });
}

function timestamp(value: JsonValue | undefined, label: string): string {
  const result = requiredText(value, label);
  if (
    !canonicalTimestamp.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(Date.parse(result)).toISOString() !== result
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return result;
}

function validateInvocation(value: JsonRecord): void {
  const argv = value.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((argument) => typeof argument !== 'string' || !isSafeText(argument))
  ) {
    throw new TypeError('oracle execution argv is invalid');
  }
  const logicalArgv = argv.map((argument) => {
    if (typeof argument !== 'string') {
      throw new TypeError('oracle execution argv is invalid');
    }
    return argument;
  });
  if (value.argv_sha256 !== digestBytes(canonicalJsonBytes(logicalArgv))) {
    throw new TypeError('oracle execution argv digest mismatch');
  }
  const materializedArgv = value.materialized_argv;
  if (
    !Array.isArray(materializedArgv) ||
    materializedArgv.length !== argv.length ||
    materializedArgv.some((argument) => typeof argument !== 'string' || !isSafeText(argument)) ||
    materializedArgv.slice(2).some((argument, index) => argument !== logicalArgv[index + 2]) ||
    value.materialized_argv_sha256 !== digestBytes(canonicalJsonBytes(materializedArgv))
  ) {
    throw new TypeError('oracle execution materialized argv is invalid');
  }
  requireIdentifier(value.tool_id, 'oracle execution tool identifier');
  requireIdentifier(value.runtime_id, 'oracle execution runtime identifier');
  requiredSha256(value.tool_sha256, 'oracle execution tool digest');
  requiredSha256(value.runtime_sha256, 'oracle execution runtime digest');
  const cwd = requiredText(value.cwd, 'oracle execution working directory');
  if (!isSafeText(cwd) || value.cwd_sha256 !== digestBytes(Buffer.from(cwd))) {
    throw new TypeError('oracle execution working directory digest mismatch');
  }
}

function validateInputEnvelope(value: JsonRecord, objects: ReadonlyMap<string, Uint8Array>): void {
  requireIdentifier(value.execution_session_id, 'oracle execution session');
  const runId = requireIdentifier(value.run_id, 'oracle execution run');
  requiredSha256(value.run_context_sha256, 'oracle execution run context');
  requiredSha256(value.run_nonce_sha256, 'oracle execution run nonce');
  const digests = value.input_object_sha256s;
  const expectedCount = runId === 'BASELINE' ? 4 : 6;
  if (
    !Array.isArray(digests) ||
    digests.length !== expectedCount ||
    new Set(digests).size !== digests.length
  )
    throw new TypeError('oracle execution input object roster is invalid');
  const references = digests.map((entry) => {
    const sha256 = requiredSha256(entry, 'oracle execution input object digest');
    verifyDigestObject(sha256, objects, 'oracle execution input object');
    return { uri: `aria-evidence://sha256/${sha256}`, sha256 };
  });
  const semanticInput = requiredSha256(value.input_sha256, 'oracle execution input digest');
  if (semanticInput !== (runId === 'BASELINE' ? digests[0] : digests[5])) {
    throw new TypeError('oracle execution semantic input role is invalid');
  }
  if (
    requiredSha256(value.input_reference_bundle_sha256, 'oracle execution reference bundle') !==
    digestBytes(canonicalJsonBytes(references))
  )
    throw new TypeError('oracle execution reference bundle digest mismatch');
  const entries = references.map((reference) => ({
    object_base64: Buffer.from(
      verifyDigestObject(reference.sha256, objects, 'oracle execution input object'),
    ).toString('base64'),
    reference,
  }));
  if (
    requiredSha256(value.input_envelope_sha256, 'oracle execution envelope') !==
    digestBytes(canonicalJsonBytes(entries))
  )
    throw new TypeError('oracle execution input envelope digest mismatch');
  verifyEvidenceObject(value.execution_receipt, objects, 'oracle execution receipt');
}

export function validateExecutionWitness(
  value: unknown,
  objects: ReadonlyMap<string, Uint8Array>,
  expected: ExecutionExpectation,
): JsonRecord {
  if (!isJsonRecord(value) || !hasExactKeys(value, executionWitnessKeys)) {
    throw new TypeError('oracle execution witness schema is invalid');
  }
  validateInvocation(value);
  validateInputEnvelope(value, objects);
  if (
    requiredSha256(value.run_context_sha256, 'oracle execution run context') !==
    expected.run_context_sha256
  ) {
    throw new TypeError('oracle execution run context does not match the baseline input');
  }
  const input = requiredSha256(value.input_sha256, 'oracle execution input digest');
  const output = requiredSha256(value.output_sha256, 'oracle execution output digest');
  const stdout = requiredSha256(value.stdout_sha256, 'oracle execution stdout digest');
  const stderr = requiredSha256(value.stderr_sha256, 'oracle execution stderr digest');
  if (input !== expected.input_sha256 || output !== expected.output_sha256) {
    throw new TypeError('oracle execution input or output digest mismatch');
  }
  verifyDigestObject(output, objects, 'oracle execution output');
  verifyDigestObject(stdout, objects, 'oracle execution stdout');
  const stderrBytes = verifyDigestObject(stderr, objects, 'oracle execution stderr');
  if (
    !Number.isSafeInteger(value.stderr_byte_length) ||
    value.stderr_byte_length !== stderrBytes.byteLength
  ) {
    throw new TypeError('oracle execution stderr byte length is invalid');
  }
  requiredSha256(
    value.current_epoch_provider_identity_sha256,
    'oracle execution current epoch provider identity',
  );
  requiredSha256(value.current_epoch_snapshot_sha256, 'oracle execution current epoch snapshot');
  if (
    !Number.isSafeInteger(value.current_epoch_revision) ||
    (value.current_epoch_revision as number) < 1
  ) {
    throw new TypeError('oracle execution current epoch revision is invalid');
  }
  const startedAt = timestamp(value.started_at, 'oracle execution start timestamp');
  const finishedAt = timestamp(value.finished_at, 'oracle execution finish timestamp');
  const epochReadAt = timestamp(
    value.current_epoch_read_at,
    'oracle execution epoch read timestamp',
  );
  if (
    Date.parse(startedAt) > Date.parse(finishedAt) ||
    Date.parse(finishedAt) > Date.parse(epochReadAt) ||
    Date.parse(epochReadAt) > Date.parse(expected.observed_at)
  ) {
    throw new TypeError('oracle execution timestamps are not ordered');
  }
  const failure = value.failure_reason_sha256;
  if (expected.semantic_verdict === 'PASSED') {
    if (value.exit_code !== 0 || failure !== null || value.semantic_verdict !== 'PASSED') {
      throw new TypeError('oracle passed execution result is invalid');
    }
  } else {
    if (!Number.isSafeInteger(value.exit_code) || (value.exit_code as number) <= 0) {
      throw new TypeError('oracle rejected execution exit code is invalid');
    }
    const failureDigest = requiredSha256(failure, 'oracle execution failure reason digest');
    verifyDigestObject(failureDigest, objects, 'oracle execution failure reason', true);
    if (value.semantic_verdict !== 'REJECTED') {
      throw new TypeError('oracle rejected execution verdict is invalid');
    }
  }
  return value;
}
