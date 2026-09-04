// The gate that makes a machine-written `verified` impossible.
//
// WHY: `verified` is the one word in this product that means a human took
// responsibility. Everything else ARIA emits is a reading of bytes or a model's
// proposal. Until now the only thing binding `verified` to a human was
// packs/legal/schemas/statement.schema.json — and MEASURED, nothing in
// production loads that schema (its single reader is the pack's own test). Three
// agents are declared in pack.json with writes_records: ['statement']; the day
// one of them lands, nothing structural stops it writing status 'verified' and a
// lawyer reading the console would see a machine's guess wearing a human's word.
//
// WHAT: two layers, because a TypeScript type does not survive JSON.
//   1. Compile time — MachineAuthoredStatement cannot express `verified`. Code
//      inside the pack literally cannot construct one; there is no cast to
//      reach for because `as` is banned by the standards this repo enforces.
//   2. Runtime — acceptMachineStatement() refuses any envelope that arrives
//      from outside the process (an agent's JSON) carrying `verified`, a
//      verifiedBy, or a verifiedAt, and states which field caused the refusal.
//
// A human verification is applied by exactly one function, applyHumanVerification,
// which demands the verifier's identity and the time they recorded it.
import type { AssertionSource, LegalEvidenceRef, LegalStatement, StatementStatus } from '../legal-records';

/**
 * The statuses a machine may assert. `verified` is absent BY CONSTRUCTION —
 * this is the type-level half of the gate.
 */
export type MachineStatementStatus = Exclude<StatementStatus, 'verified'>;

export const MACHINE_STATEMENT_STATUSES: readonly MachineStatementStatus[] = [
  'asserted',
  'disputed',
  'supported',
  'contradicted',
  'unverifiable',
];

/** A statement as an adapter or an agent may author it: never verified, never signed. */
export interface MachineAuthoredStatement {
  readonly statementId: string;
  readonly statement: string;
  readonly status: MachineStatementStatus;
  readonly assertedBy: AssertionSource;
  readonly assertedByPartyId: string | null;
  readonly supportingSources: ReadonlyArray<LegalEvidenceRef>;
  readonly contradictingSources: ReadonlyArray<LegalEvidenceRef>;
  readonly missingEvidence: ReadonlyArray<string>;
  readonly confidence: number;
  readonly relatedClaimIds: ReadonlyArray<string>;
}

/** What a human records when they take responsibility for a statement. */
export interface HumanVerification {
  /** Who verified. A person or a named role account — never a model or an adapter. */
  readonly verifiedBy: string;
  /** When they recorded it, ISO 8601. */
  readonly verifiedAt: string;
}

export class StatementGateError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'StatementGateError';
    this.field = field;
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const STATEMENT_ID = /^stmt_[A-Za-z0-9._-]{4,64}$/;

/** Agent output arrives as JSON: `unknown` until every field has been checked. */
function readString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new StatementGateError(field, `statement.${field} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new StatementGateError(field, `statement.${field} must be a non-empty string or null`);
  }
  return value;
}

function readStringArray(source: Record<string, unknown>, field: string): string[] {
  const value = source[field] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new StatementGateError(field, `statement.${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function readEvidence(source: Record<string, unknown>, field: string): LegalEvidenceRef[] {
  const value = source[field] ?? [];
  if (!Array.isArray(value)) {
    throw new StatementGateError(field, `statement.${field} must be an array of evidence refs`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new StatementGateError(field, `statement.${field}[${index}] must be an evidence ref object`);
    }
    const ref = item as Record<string, unknown>;
    const documentId = ref['documentId'];
    const sha256 = ref['sha256'];
    if (typeof documentId !== 'string' || documentId.length === 0) {
      throw new StatementGateError(field, `statement.${field}[${index}].documentId must be a non-empty string`);
    }
    // An evidence ref without a content hash is an assertion, not evidence:
    // it names a document but pins no bytes, so it cannot be re-checked later.
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new StatementGateError(field, `statement.${field}[${index}].sha256 must be a 64-char sha256 hex digest`);
    }
    const versionId = ref['versionId'];
    const locator = ref['locator'];
    const normalized: LegalEvidenceRef = {
      documentId,
      sha256,
      ...(typeof versionId === 'string' && versionId.length > 0 ? { versionId } : {}),
      ...(typeof locator === 'string' && locator.length > 0 ? { locator } : {}),
    };
    return normalized;
  });
}

const ASSERTION_SOURCE_VALUES: ReadonlySet<string> = new Set([
  'party',
  'court',
  'counsel',
  'third_party',
  'ai_inference',
  'mechanical_extraction',
  'operator',
]);

/**
 * Accepts a statement authored OUTSIDE this process (an agent envelope, an
 * imported file) and refuses anything a machine may not say. This is the
 * runtime half of the gate: it exists because JSON carries no types.
 */
export function acceptMachineStatement(input: unknown): MachineAuthoredStatement {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new StatementGateError('statement', 'a statement must be a JSON object');
  }
  const source = input as Record<string, unknown>;

  // The three refusals this module exists for, checked before anything else so
  // the reason a submission was rejected is never masked by a shape complaint.
  if (source['status'] === 'verified') {
    throw new StatementGateError('status', "a machine may not write status 'verified'; verification is recorded by a human through applyHumanVerification");
  }
  if (source['verifiedBy'] !== undefined && source['verifiedBy'] !== null) {
    throw new StatementGateError('verifiedBy', 'a machine may not name a verifier');
  }
  if (source['verifiedAt'] !== undefined && source['verifiedAt'] !== null) {
    throw new StatementGateError('verifiedAt', 'a machine may not stamp a verification time');
  }

  const status = source['status'];
  if (typeof status !== 'string' || !MACHINE_STATEMENT_STATUSES.includes(status as MachineStatementStatus)) {
    throw new StatementGateError('status', `statement.status must be one of ${MACHINE_STATEMENT_STATUSES.join(', ')}`);
  }
  const assertedBy = source['assertedBy'];
  if (typeof assertedBy !== 'string' || !ASSERTION_SOURCE_VALUES.has(assertedBy)) {
    throw new StatementGateError('assertedBy', 'statement.assertedBy must be a declared assertion source');
  }
  const statementId = readString(source, 'statementId');
  if (!STATEMENT_ID.test(statementId)) {
    throw new StatementGateError('statementId', 'statement.statementId must match ^stmt_[A-Za-z0-9._-]{4,64}$');
  }
  const confidenceValue = source['confidence'];
  if (typeof confidenceValue !== 'number' || !Number.isFinite(confidenceValue) || confidenceValue < 0 || confidenceValue > 1) {
    throw new StatementGateError('confidence', 'statement.confidence must be a number in [0, 1]');
  }
  const supportingSources = readEvidence(source, 'supportingSources');
  const contradictingSources = readEvidence(source, 'contradictingSources');

  // A verdict must name what produced it. `supported` with nothing supporting it
  // and `contradicted` with nothing contradicting it are the two ways a machine
  // states a conclusion it did not reach from bytes.
  if (status === 'supported' && supportingSources.length === 0) {
    throw new StatementGateError('supportingSources', "status 'supported' requires at least one supporting source");
  }
  if (status === 'contradicted' && contradictingSources.length === 0) {
    throw new StatementGateError('contradictingSources', "status 'contradicted' requires at least one contradicting source");
  }

  return {
    statementId,
    statement: readString(source, 'statement'),
    status: status as MachineStatementStatus,
    assertedBy: assertedBy as AssertionSource,
    assertedByPartyId: readOptionalString(source, 'assertedByPartyId'),
    supportingSources,
    contradictingSources,
    missingEvidence: readStringArray(source, 'missingEvidence'),
    confidence: confidenceValue,
    relatedClaimIds: readStringArray(source, 'relatedClaimIds'),
  };
}

/**
 * Renders a machine-authored statement into the contract record. Every such
 * record carries humanReviewRequired: true and null verification fields — this
 * is the only way a statement can enter an artifact without a human.
 */
export function toUnverifiedRecord(statement: MachineAuthoredStatement): LegalStatement {
  return {
    statementId: statement.statementId,
    statement: statement.statement,
    status: statement.status,
    assertedBy: statement.assertedBy,
    assertedByPartyId: statement.assertedByPartyId,
    supportingSources: statement.supportingSources,
    contradictingSources: statement.contradictingSources,
    missingEvidence: statement.missingEvidence,
    confidence: statement.confidence,
    humanReviewRequired: true,
    verifiedBy: null,
    verifiedAt: null,
    relatedClaimIds: statement.relatedClaimIds,
  };
}

/**
 * The single path to a `verified` statement. It takes a human's identity and
 * the time they recorded the verification; there is no overload that omits them.
 */
export function applyHumanVerification(statement: MachineAuthoredStatement, verification: HumanVerification): LegalStatement {
  if (verification.verifiedBy.trim().length === 0) {
    throw new StatementGateError('verifiedBy', 'a verification must name the person who made it');
  }
  if (!ISO_INSTANT.test(verification.verifiedAt)) {
    throw new StatementGateError('verifiedAt', 'a verification must carry an ISO 8601 UTC instant');
  }
  return {
    ...toUnverifiedRecord(statement),
    status: 'verified',
    humanReviewRequired: false,
    verifiedBy: verification.verifiedBy.trim(),
    verifiedAt: verification.verifiedAt,
  };
}
