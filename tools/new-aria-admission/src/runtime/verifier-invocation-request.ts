import { canonicalJsonBytes } from '../kernel/canonical-json';
import { requireIdentifier } from '../kernel/identifiers';
import { loadOracleBaselineDocument } from '../kernel/oracle-baseline';
import { parseStrictJson } from '../kernel/strict-json';
import type { JsonValue } from '../kernel/strict-json';

import { readCanonicalFile } from './canonical-files';
import { snapshotBaseExecutionArguments } from './execution-identity';
import {
  EXECUTION_INPUT_ENVELOPE_MAX_BYTES,
  validateExecutionInputEnvelope,
} from './execution-input-envelope';
import { readPrivateKeyFile } from './private-key-file';

const keys = [
  'schema_version',
  'contract_id',
  'target_request_path',
  'git_path',
  'git_sha256',
  'operator_envelope_path',
  'operator_trust_root_path',
  'execution_trust_root_path',
  'evidence_trust_root_path',
  'execution_private_key_path',
  'tool_id',
  'tool_path',
  'tool_sha256',
  'runtime_sha256',
  'args',
  'runs',
] as const;
const runKeys = ['run_id', 'run_context_sha256', 'input_envelope_path'] as const;
const sha64 = /^[a-f0-9]{64}$/u;
type JsonRecord = { [key: string]: JsonValue };

export interface VerifierRunDescriptor {
  readonly run_id: string;
  readonly run_context_sha256: string;
  readonly input_envelope_path: string;
}

export interface VerifierInvocationDescriptor {
  readonly target_request_path: string;
  readonly git_path: string;
  readonly git_sha256: string;
  readonly operator_envelope_path: string;
  readonly operator_trust_root_path: string;
  readonly execution_trust_root_path: string;
  readonly evidence_trust_root_path: string;
  readonly execution_private_key_path: string;
  readonly tool_id: string;
  readonly tool_path: string;
  readonly tool_sha256: string;
  readonly runtime_sha256: string;
  readonly args: readonly string[];
  readonly runs: readonly VerifierRunDescriptor[];
}

export interface LoadedVerifierRun {
  readonly run_id: string;
  readonly run_context_sha256: string;
  readonly input_envelope_path: string;
  readonly input_envelope_bytes: Buffer;
}

export interface LoadedVerifierInvocation extends VerifierInvocationDescriptor {
  readonly execution_trust_root_bytes: Buffer;
  readonly evidence_trust_root_bytes: Buffer;
  readonly execution_private_key_bytes: Buffer;
  readonly runs: readonly LoadedVerifierRun[];
}

function record(
  value: JsonValue | undefined,
  exactKeys: readonly string[],
  label: string,
): JsonRecord {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== exactKeys.length ||
    exactKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new TypeError(`${label} schema is invalid`);
  return value;
}

function text(value: JsonRecord, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new TypeError(`verifier invocation ${key} must be a non-empty string`);
  }
  return field;
}

function runDescriptor(value: JsonValue): VerifierRunDescriptor {
  const run = record(value, runKeys, 'verifier invocation run');
  const context = text(run, 'run_context_sha256');
  if (!sha64.test(context)) throw new TypeError('verifier invocation run context is invalid');
  return Object.freeze({
    run_id: requireIdentifier(run.run_id, 'verifier invocation run identifier'),
    run_context_sha256: context,
    input_envelope_path: text(run, 'input_envelope_path'),
  });
}

export function parseVerifierInvocationDescriptor(bytes: Uint8Array): VerifierInvocationDescriptor {
  const value = record(parseStrictJson(bytes), keys, 'verifier invocation descriptor');
  if (
    !canonicalJsonBytes(value).equals(Buffer.from(bytes)) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-verifier-invocation-v2' ||
    !Array.isArray(value.args) ||
    value.args.some((item) => typeof item !== 'string') ||
    !Array.isArray(value.runs) ||
    value.runs.length !== 5
  )
    throw new TypeError('verifier invocation descriptor is not canonical, closed, or complete');
  const digests = ['git_sha256', 'tool_sha256', 'runtime_sha256'];
  if (digests.some((field) => !sha64.test(text(value, field)))) {
    throw new TypeError('verifier invocation digest is invalid');
  }
  return Object.freeze({
    target_request_path: text(value, 'target_request_path'),
    git_path: text(value, 'git_path'),
    git_sha256: text(value, 'git_sha256'),
    operator_envelope_path: text(value, 'operator_envelope_path'),
    operator_trust_root_path: text(value, 'operator_trust_root_path'),
    execution_trust_root_path: text(value, 'execution_trust_root_path'),
    evidence_trust_root_path: text(value, 'evidence_trust_root_path'),
    execution_private_key_path: text(value, 'execution_private_key_path'),
    tool_id: requireIdentifier(value.tool_id, 'verifier invocation tool identifier'),
    tool_path: text(value, 'tool_path'),
    tool_sha256: text(value, 'tool_sha256'),
    runtime_sha256: text(value, 'runtime_sha256'),
    args: snapshotBaseExecutionArguments(value.args),
    runs: Object.freeze(value.runs.map(runDescriptor)),
  });
}

function loadRun(run: VerifierRunDescriptor): LoadedVerifierRun {
  const envelope = validateExecutionInputEnvelope(
    readCanonicalFile(
      run.input_envelope_path,
      'execution input envelope',
      EXECUTION_INPUT_ENVELOPE_MAX_BYTES,
    ),
  );
  return Object.freeze({
    run_id: run.run_id,
    run_context_sha256: run.run_context_sha256,
    input_envelope_path: run.input_envelope_path,
    input_envelope_bytes: Buffer.from(envelope.bytes),
  });
}

function assertDerivedRunContext(runs: readonly LoadedVerifierRun[]): void {
  const baselineRun = runs[0];
  if (baselineRun === undefined || baselineRun.run_id !== 'BASELINE') {
    throw new TypeError('verifier invocation baseline run is absent');
  }
  const baselineEnvelope = validateExecutionInputEnvelope(baselineRun.input_envelope_bytes);
  const baselineBytes = baselineEnvelope.object_bytes[0];
  if (baselineBytes === undefined)
    throw new TypeError('verifier invocation baseline object is absent');
  const derived = loadOracleBaselineDocument(baselineBytes).run_context_sha256;
  if (runs.some(({ run_context_sha256: context }) => context !== derived)) {
    throw new TypeError('verifier invocation run context differs from authenticated baseline');
  }
}

export function loadVerifierInvocationResources(
  descriptor: VerifierInvocationDescriptor,
): LoadedVerifierInvocation {
  const executionRoot = readCanonicalFile(
    descriptor.execution_trust_root_path,
    'execution trust root',
  );
  const evidenceRoot = readCanonicalFile(
    descriptor.evidence_trust_root_path,
    'evidence trust root',
  );
  const runs = Object.freeze(descriptor.runs.map(loadRun));
  assertDerivedRunContext(runs);
  let privateKey: Buffer | undefined;
  try {
    privateKey = readPrivateKeyFile(descriptor.execution_private_key_path);
    return Object.freeze({
      ...descriptor,
      execution_trust_root_bytes: executionRoot,
      evidence_trust_root_bytes: evidenceRoot,
      execution_private_key_bytes: privateKey,
      runs,
    });
  } catch (error) {
    privateKey?.fill(0);
    throw error;
  }
}
