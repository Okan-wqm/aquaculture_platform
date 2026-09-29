import { canonicalJsonBytes } from '../kernel/canonical-json';
import { isJsonRecord } from '../kernel/evidence-object';
import { requireIdentifier } from '../kernel/identifiers';
import { parseStrictJson } from '../kernel/strict-json';
import type { JsonValue } from '../kernel/strict-json';
import type { SemanticVerdict } from '../kernel/verdict-propagation';
import { readBaselineVerifierOutput } from './verifier-baseline-output';

const rejectionKeys = [
  'schema_version',
  'contract_id',
  'oracle_id',
  'implementation_sha256',
  'control_id',
  'mutation_kind',
  'reason_code',
  'run_context_sha256',
  'baseline_input_sha256',
  'mutant_document_sha256',
  'mutated_input_sha256',
  'scope',
  'verdict',
] as const;
const failureKeys = [
  'schema_version',
  'contract_id',
  'control_id',
  'reason_code',
  'run_context_sha256',
  'verdict',
] as const;
const sha64 = /^[a-f0-9]{64}$/u;
type JsonRecord = { [key: string]: JsonValue };

export interface VerifierOutputExpectation {
  readonly run_id: string;
  readonly run_context_sha256: string;
  readonly baseline_input_sha256: string | undefined;
  readonly input_object_sha256s: readonly string[];
}

function record(value: JsonValue | undefined, keys: readonly string[], label: string): JsonRecord {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new TypeError(`${label} schema is invalid`);
  }
  return value;
}

function canonicalDocument(stdout: Uint8Array): JsonRecord {
  const bytes = Buffer.from(stdout);
  if (bytes.byteLength < 2 || bytes.at(-1) !== 0x0a || bytes.at(-2) === 0x0a) {
    throw new TypeError('verifier stdout must end in one canonical newline');
  }
  const body = bytes.subarray(0, -1);
  const value = parseStrictJson(body);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('verifier output must be a JSON object');
  }
  const document = value;
  if (!canonicalJsonBytes(document).equals(body)) {
    throw new TypeError('verifier output must be canonical JSON plus one newline');
  }
  return document;
}

function rejectionVerdict(
  document: JsonRecord,
  expectation: VerifierOutputExpectation,
): SemanticVerdict {
  const rejection = record(document, rejectionKeys, 'negative-control rejection receipt');
  const mutantDocumentSha256 = expectation.input_object_sha256s[4];
  const mutatedInputSha256 = expectation.input_object_sha256s[5];
  if (
    rejection.schema_version !== '1.0.0' ||
    rejection.contract_id !== 'new-aria-negative-control-rejection-receipt-v1' ||
    rejection.control_id !== expectation.run_id ||
    rejection.run_context_sha256 !== expectation.run_context_sha256 ||
    rejection.baseline_input_sha256 !== expectation.baseline_input_sha256 ||
    rejection.mutant_document_sha256 !== mutantDocumentSha256 ||
    rejection.mutated_input_sha256 !== mutatedInputSha256 ||
    expectation.input_object_sha256s.length !== 6 ||
    rejection.verdict !== 'REJECTED' ||
    typeof rejection.implementation_sha256 !== 'string' ||
    !sha64.test(rejection.implementation_sha256) ||
    typeof rejection.baseline_input_sha256 !== 'string' ||
    !sha64.test(rejection.baseline_input_sha256) ||
    typeof rejection.mutant_document_sha256 !== 'string' ||
    !sha64.test(rejection.mutant_document_sha256) ||
    typeof rejection.mutated_input_sha256 !== 'string' ||
    !sha64.test(rejection.mutated_input_sha256) ||
    rejection.scope === null ||
    typeof rejection.scope !== 'object' ||
    Array.isArray(rejection.scope)
  ) {
    throw new TypeError('negative-control rejection receipt is not bound to this run');
  }
  return 'FAILED';
}

export function readVerifierSemanticVerdict(
  stdout: Uint8Array,
  expectation: VerifierOutputExpectation,
): SemanticVerdict {
  if (expectation.run_id === 'BASELINE') return readBaselineVerifierOutput(stdout).verdict;
  return rejectionVerdict(canonicalDocument(stdout), expectation);
}

export function readVerifierOutputArtifact(
  stdout: Uint8Array,
  expectation: VerifierOutputExpectation,
): Buffer {
  readVerifierSemanticVerdict(stdout, expectation);
  return Buffer.from(stdout).subarray(0, stdout.byteLength - 1);
}

export function readVerifierFailureArtifact(
  stderr: Uint8Array,
  expectation: VerifierOutputExpectation,
): Buffer {
  const bytes = Buffer.from(stderr);
  if (
    expectation.run_id === 'BASELINE' ||
    expectation.input_object_sha256s.length !== 6 ||
    bytes.byteLength < 2 ||
    bytes.at(-1) !== 0x0a ||
    bytes.at(-2) === 0x0a
  ) {
    throw new TypeError('negative-control failure reason framing is invalid');
  }
  const body = bytes.subarray(0, -1);
  let parsed: JsonValue;
  try {
    parsed = parseStrictJson(body);
  } catch {
    throw new TypeError('negative-control failure reason is invalid');
  }
  const document = record(parsed, failureKeys, 'negative-control failure reason');
  if (
    !canonicalJsonBytes(document).equals(body) ||
    document.schema_version !== '1.0.0' ||
    document.contract_id !== 'new-aria-negative-control-failure-reason-v1' ||
    document.control_id !== expectation.run_id ||
    document.run_context_sha256 !== expectation.run_context_sha256 ||
    document.verdict !== 'REJECTED' ||
    typeof document.reason_code !== 'string' ||
    requireIdentifier(document.reason_code, 'negative-control reason code') !== document.reason_code
  ) {
    throw new TypeError('negative-control failure reason is not bound to this run');
  }
  return Buffer.from(body);
}
