import { canonicalJsonBytes } from '../kernel/canonical-json';
import { digestBytes, isJsonRecord } from '../kernel/evidence-object';
import { requireIdentifier } from '../kernel/identifiers';
import { parseStrictJson } from '../kernel/strict-json';
import type { JsonRecord } from '../kernel/evidence-object';
import type { VerifiedDossierResult } from '../verifier/verification-dossier';

const reportKeys = ['schema_version', 'contract_id', 'result', 'verdict'] as const;
const resultKeys = [
  'code',
  'event_chain_sha256',
  'history_sha256',
  'object_closure_sha256',
  'summary',
  'verification_plan_sha256',
  'verifying_projection',
] as const;
const projectionKeys = ['bytes_base64', 'sha256'] as const;
const sha64 = /^[a-f0-9]{64}$/u;
const unsafeSummaryCharacters =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const surrogateCodeUnit = /[\ud800-\udfff]/u;

export interface BaselineVerifierOutput {
  readonly verdict: 'PASSED' | 'FAILED';
  readonly code: string;
  readonly event_chain_sha256: string;
  readonly history_sha256: string;
  readonly object_closure_sha256: string;
  readonly verification_plan_sha256: string;
  readonly verifying_projection_bytes: Buffer;
  readonly verifying_projection_sha256: string;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): JsonRecord {
  if (
    !isJsonRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new TypeError(`${label} schema is invalid`);
  return value;
}

function canonicalReport(stdout: Uint8Array): JsonRecord {
  const bytes = Buffer.from(stdout);
  if (bytes.byteLength < 2 || bytes.at(-1) !== 0x0a || bytes.at(-2) === 0x0a) {
    throw new TypeError('verifier stdout must end in one canonical newline');
  }
  const body = bytes.subarray(0, -1);
  const document = exactRecord(parseStrictJson(body), reportKeys, 'baseline verifier report');
  if (!canonicalJsonBytes(document).equals(body)) {
    throw new TypeError('verifier output must be canonical JSON plus one newline');
  }
  return document;
}

function canonicalProjection(value: unknown): { readonly bytes: Buffer; readonly sha256: string } {
  const projection = exactRecord(value, projectionKeys, 'baseline VERIFYING projection');
  const encoded = projection.bytes_base64;
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > 32_768) {
    throw new TypeError('baseline VERIFYING projection encoding is invalid');
  }
  const bytes = Buffer.from(encoded, 'base64');
  const body =
    bytes.byteLength > 1 && bytes.at(-1) === 0x0a ? bytes.subarray(0, -1) : Buffer.alloc(0);
  if (
    bytes.toString('base64') !== encoded ||
    typeof projection.sha256 !== 'string' ||
    !sha64.test(projection.sha256) ||
    digestBytes(bytes) !== projection.sha256 ||
    !isJsonRecord(parseStrictJson(body)) ||
    !canonicalJsonBytes(parseStrictJson(body)).equals(body)
  )
    throw new TypeError('baseline VERIFYING projection bytes are invalid');
  return Object.freeze({ bytes, sha256: projection.sha256 });
}

export function readBaselineVerifierOutput(stdout: Uint8Array): BaselineVerifierOutput {
  const report = canonicalReport(stdout);
  const result = exactRecord(report.result, resultKeys, 'baseline verifier result');
  const digests = [
    result.event_chain_sha256,
    result.history_sha256,
    result.object_closure_sha256,
    result.verification_plan_sha256,
  ];
  if (
    report.schema_version !== '1.0.0' ||
    report.contract_id !== 'new-aria-verifier-report-v1' ||
    (report.verdict !== 'PASSED' && report.verdict !== 'FAILED') ||
    typeof result.code !== 'string' ||
    requireIdentifier(result.code, 'baseline verifier result code') !== result.code ||
    typeof result.summary !== 'string' ||
    result.summary.length === 0 ||
    result.summary.normalize('NFC') !== result.summary ||
    unsafeSummaryCharacters.test(result.summary) ||
    surrogateCodeUnit.test(result.summary) ||
    Buffer.byteLength(result.summary) > 4_096 ||
    digests.some((value) => typeof value !== 'string' || !sha64.test(value))
  )
    throw new TypeError('baseline verifier report identity or result is invalid');
  const projection = canonicalProjection(result.verifying_projection);
  return Object.freeze({
    verdict: report.verdict,
    code: result.code,
    event_chain_sha256: String(result.event_chain_sha256),
    history_sha256: String(result.history_sha256),
    object_closure_sha256: String(result.object_closure_sha256),
    verification_plan_sha256: String(result.verification_plan_sha256),
    verifying_projection_bytes: projection.bytes,
    verifying_projection_sha256: projection.sha256,
  });
}

export function assertBaselineVerifierOutput(
  stdout: Uint8Array,
  expected: VerifiedDossierResult,
): void {
  const actual = readBaselineVerifierOutput(stdout);
  if (
    actual.verdict !== 'PASSED' ||
    actual.code !== 'VERIFICATION_PASSED' ||
    actual.event_chain_sha256 !== expected.event_chain_sha256 ||
    actual.history_sha256 !== expected.history_sha256 ||
    actual.object_closure_sha256 !== expected.object_closure_sha256 ||
    actual.verification_plan_sha256 !== expected.verification_plan_sha256 ||
    actual.verifying_projection_sha256 !== expected.verifying_projection_sha256 ||
    !actual.verifying_projection_bytes.equals(expected.verifying_projection_bytes)
  )
    throw new TypeError('baseline verifier output differs from trusted recomputation');
}
