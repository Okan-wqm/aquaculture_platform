import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { executionRunNonceSha256 } from '../src/kernel/execution-run-identity';

import type {
  ExecutionInputObject,
  ExecutionReceiptFixtureIssuer,
  ExecutionWitness,
  ObjectReference,
  OracleProofConfiguration,
  OracleProofOverrides,
  ReceiptlessExecutionWitness,
} from './oracle-proof-contracts';

const toolSha256 = '1'.repeat(64);
const runtimeSha256 = 'f'.repeat(64);
export const verifierArgv = ['node', 'verify.mjs', '--mode', 'full'];
export const verifierCwd = 'workspace://repo-1/workspace-1';

interface ExecutionWitnessFixtureOptions {
  readonly ordinal?: number;
  readonly control_id?: string;
  readonly failure_sha256?: string | null;
  readonly stdout_sha256?: string;
  readonly stderr_sha256?: string;
  readonly tree_sha?: string;
  readonly issue_receipt?: ExecutionReceiptFixtureIssuer;
  readonly current_epoch_provider_identity_sha256?: string;
  readonly current_epoch_revision?: number;
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export function storeObject(objects: Map<string, Uint8Array>, bytes: Uint8Array): ObjectReference {
  const digest = sha256(bytes);
  const reference = { uri: `aria-evidence://sha256/${digest}`, sha256: digest };
  objects.set(reference.uri, Buffer.from(bytes));
  return reference;
}

export function configuration(overrides: OracleProofOverrides): OracleProofConfiguration {
  return {
    argv: overrides.argv ?? verifierArgv,
    tool_id: overrides.tool_id ?? 'new-aria-admission-verifier',
    tool_sha256: overrides.tool_sha256 ?? toolSha256,
    runtime_id: overrides.runtime_id ?? 'nodejs-20.11.1-linux-x64',
    runtime_sha256: overrides.runtime_sha256 ?? runtimeSha256,
    cwd: overrides.cwd ?? verifierCwd,
  };
}

export function executionWitness(
  objects: Map<string, Uint8Array>,
  inputObjects: readonly ExecutionInputObject[],
  runContextSha256: string,
  outputSha256: string,
  config: OracleProofConfiguration,
  options: ExecutionWitnessFixtureOptions = {},
): ExecutionWitness {
  const ordinal = options.ordinal ?? 0;
  const controlId = options.control_id;
  const treeSha = options.tree_sha ?? 'c'.repeat(40);
  const runId = controlId ?? 'BASELINE';
  const references = inputObjects.map(({ reference }) => reference);
  const inputEnvelope = inputObjects.map(({ bytes, reference }) => ({
    object_base64: Buffer.from(bytes).toString('base64'),
    reference,
  }));
  const inputEnvelopeSha256 = sha256(canonicalJsonBytes(inputEnvelope));
  const inputSha256 = (controlId === undefined ? inputObjects[0] : inputObjects.at(-1))?.reference
    .sha256;
  const epochSnapshotSha256 = inputObjects[3]?.reference.sha256;
  if (inputSha256 === undefined || epochSnapshotSha256 === undefined) {
    throw new TypeError('closed execution input fixture is missing');
  }
  const argv =
    controlId === undefined ? [...config.argv] : [...config.argv, '--negative-control', controlId];
  const materializedArgv = [
    `/verified-runtime/${config.runtime_sha256}`,
    `/verified-tool/${config.tool_sha256}`,
    ...argv.slice(2),
  ];
  const stdout =
    options.stdout_sha256 ??
    storeObject(objects, Buffer.from(controlId === undefined ? 'verification passed\n' : ''))
      .sha256;
  const stderr = options.stderr_sha256 ?? storeObject(objects, Buffer.alloc(0)).sha256;
  const stderrBytes = objects.get(`aria-evidence://sha256/${stderr}`);
  if (stderrBytes === undefined) throw new TypeError('execution stderr fixture is missing');
  const finishedAt = `2026-09-02T11:${(41 + ordinal * 2).toString().padStart(2, '0')}:00.000Z`;
  const witness: ReceiptlessExecutionWitness = {
    execution_session_id: 'execution-session-s01-0001',
    run_id: runId,
    run_context_sha256: runContextSha256,
    run_nonce_sha256: executionRunNonceSha256({
      execution_session_id: 'execution-session-s01-0001',
      run_id: runId,
      run_context_sha256: runContextSha256,
      input_envelope_sha256: inputEnvelopeSha256,
      tree_sha: treeSha,
    }),
    argv,
    argv_sha256: sha256(canonicalJsonBytes(argv)),
    materialized_argv: materializedArgv,
    materialized_argv_sha256: sha256(canonicalJsonBytes(materializedArgv)),
    tool_id: config.tool_id,
    tool_sha256: config.tool_sha256,
    runtime_id: config.runtime_id,
    runtime_sha256: config.runtime_sha256,
    cwd: config.cwd,
    cwd_sha256: sha256(Buffer.from(config.cwd)),
    input_sha256: inputSha256,
    input_reference_bundle_sha256: sha256(canonicalJsonBytes(references)),
    input_envelope_sha256: inputEnvelopeSha256,
    input_object_sha256s: references.map(({ sha256: digest }) => digest),
    current_epoch_provider_identity_sha256:
      options.current_epoch_provider_identity_sha256 ?? '8'.repeat(64),
    current_epoch_snapshot_sha256: epochSnapshotSha256,
    current_epoch_revision: options.current_epoch_revision ?? 1,
    current_epoch_read_at: finishedAt.replace(':00.000Z', ':30.000Z'),
    output_sha256: outputSha256,
    started_at: `2026-09-02T11:${(40 + ordinal * 2).toString().padStart(2, '0')}:00.000Z`,
    finished_at: finishedAt,
    exit_code: controlId === undefined ? 0 : 1,
    stdout_sha256: stdout,
    stderr_sha256: stderr,
    stderr_byte_length: stderrBytes.byteLength,
    failure_reason_sha256: options.failure_sha256 ?? null,
    semantic_verdict: controlId === undefined ? 'PASSED' : 'REJECTED',
  };
  const executionReceipt =
    options.issue_receipt?.(objects, witness) ??
    storeObject(
      objects,
      canonicalJsonBytes({
        contract_id: 'test-only-execution-receipt-placeholder-v1',
        run_id: runId,
      }),
    );
  return { ...witness, execution_receipt: executionReceipt };
}
