import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';

import commonSchema from '../../../../contracts/suderra-edge/v1/schemas/common.schema.json';
import resultSchema from '../../../../contracts/suderra-edge/v1/schemas/result.schema.json';

import { assertWellFormed, ContractEncodingError } from './edge-contract';

/**
 * `suderra.result.v1` (ADR-048 DEC-27; `schemas/result.schema.json`): what the
 * cloud accepts from a device's result topic. The schema is the contract's own
 * and the cloud validates against it, not against a copy: the per-kind reason
 * enums, the ok/reason exclusion, the second-precision timestamps and the
 * unknown-member refusal all come from the schema file.
 *
 * A result is an unsigned observation (DEC-27): the cloud stores it as
 * device-reported evidence and never reads it as authority. The one decision a
 * result drives, concluding an update request, is judged by
 * `edge-update-channel.ts` from the contract's settlement rules.
 */

const SCHEMA_ID = resultSchema.$id;

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
ajv.addSchema(commonSchema);
ajv.addSchema(resultSchema);

const validateResult: ValidateFunction = (() => {
  const compiled = ajv.getSchema(SCHEMA_ID);
  if (compiled === undefined) {
    throw new Error(`result.schema.json (${SCHEMA_ID}) did not compile`);
  }
  return compiled;
})();

/** The kinds and outcomes the schema enumerates, read from it. */
export const RESULT_KINDS: readonly string[] = resultSchema.properties.kind.enum;
export const RESULT_OUTCOMES: readonly string[] = resultSchema.properties.outcome.enum;
export const TIME_STATES: readonly string[] = resultSchema.properties.time_state.enum;

/** What a result says about the statement it concludes (`subject`). */
export interface ResultSubject {
  readonly version?: string;
  readonly security_version?: number;
  readonly statement_type?: string;
  readonly statement_digest?: { readonly sha256: string };
  readonly update_seq?: number;
  readonly lifecycle_from?: string;
  readonly lifecycle_to?: string;
}

/** A schema-valid `suderra.result.v1` document. */
export interface EdgeResult {
  readonly _type: 'suderra.result.v1';
  readonly seq: number;
  readonly kind: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly occurred_at: string;
  readonly time_state: string;
  readonly board_profile: string;
  readonly os_version: string;
  readonly subject?: ResultSubject;
  readonly detail?: string;
}

/** Why a message on a result topic is not a result document. */
export class ResultDocumentError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`not a suderra.result.v1 document: ${reasons.join('; ')}`);
    this.name = 'ResultDocumentError';
  }
}

/**
 * A result document is a few hundred bytes (`detail` is at most 512
 * characters, every other member is bounded); anything near this limit is not
 * one, and the limit keeps a hostile publisher from making the cloud parse
 * megabytes under a tenant-scoped grant.
 */
export const MAX_RESULT_BYTES = 8 * 1024;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses and validates one result message; throws {@link ResultDocumentError}. */
export function parseResultDocument(payload: Buffer): EdgeResult {
  if (payload.length > MAX_RESULT_BYTES) {
    throw new ResultDocumentError([`it is ${payload.length} bytes (limit ${MAX_RESULT_BYTES})`]);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new ResultDocumentError(['it is not UTF-8']);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ResultDocumentError(['it is not JSON']);
  }
  try {
    requireWellFormed(parsed, '$');
  } catch (error) {
    if (!(error instanceof ContractEncodingError)) throw error;
    throw new ResultDocumentError([error.message]);
  }
  if (!isRecord(parsed) || !validateResult(parsed)) {
    const errors = (validateResult.errors ?? []).map(
      (e) => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message ?? 'is invalid'}`,
    );
    throw new ResultDocumentError(errors.length > 0 ? errors : ['it is not an object']);
  }
  // The schema has been satisfied: the record has exactly the members of EdgeResult.
  return toEdgeResult(parsed);
}

/** The contract's JSON rules refuse an unpaired UTF-16 surrogate in any string or member name. */
function requireWellFormed(value: unknown, where: string): void {
  if (typeof value === 'string') {
    assertWellFormed(value, where);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => requireWellFormed(item, `${where}[${index}]`));
  } else if (isRecord(value)) {
    for (const [key, member] of Object.entries(value)) {
      assertWellFormed(key, `${where} member name`);
      requireWellFormed(member, `${where}.${key}`);
    }
  }
}

function toEdgeResult(doc: Readonly<Record<string, unknown>>): EdgeResult {
  const seq = doc['seq'];
  const subject = doc['subject'];
  const reason = doc['reason'];
  const detail = doc['detail'];
  return {
    _type: 'suderra.result.v1',
    seq: requireNumber(seq, 'seq'),
    kind: requireString(doc['kind'], 'kind'),
    outcome: requireString(doc['outcome'], 'outcome'),
    ...(typeof reason === 'string' ? { reason } : {}),
    occurred_at: requireString(doc['occurred_at'], 'occurred_at'),
    time_state: requireString(doc['time_state'], 'time_state'),
    board_profile: requireString(doc['board_profile'], 'board_profile'),
    os_version: requireString(doc['os_version'], 'os_version'),
    ...(isRecord(subject) ? { subject: toSubject(subject) } : {}),
    ...(typeof detail === 'string' ? { detail } : {}),
  };
}

function toSubject(subject: Readonly<Record<string, unknown>>): ResultSubject {
  const digest = subject['statement_digest'];
  const sha256 = isRecord(digest) ? digest['sha256'] : undefined;
  const out: { -readonly [K in keyof ResultSubject]: ResultSubject[K] } = {};
  if (typeof subject['version'] === 'string') out.version = subject['version'];
  if (typeof subject['security_version'] === 'number') {
    out.security_version = subject['security_version'];
  }
  if (typeof subject['statement_type'] === 'string') out.statement_type = subject['statement_type'];
  if (typeof sha256 === 'string') out.statement_digest = { sha256 };
  if (typeof subject['update_seq'] === 'number') out.update_seq = subject['update_seq'];
  if (typeof subject['lifecycle_from'] === 'string') out.lifecycle_from = subject['lifecycle_from'];
  if (typeof subject['lifecycle_to'] === 'string') out.lifecycle_to = subject['lifecycle_to'];
  return out;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`result member ${name} is not a string`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new Error(`result member ${name} is not a number`);
  return value;
}
