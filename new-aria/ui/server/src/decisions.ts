// The decision ledger — what a person decided about a case, signed and chained.
//
// WHY: `verified` is the one word in this product that means a human took
// responsibility, and MEASURED 2026-09-04 there was no place a human could put
// it: the adapter rewrote every artifact on each run, a verification typed
// into statements.json was gone after one inventory, and the only function
// that could mint a verification had no caller outside its own test. A
// decision has to live somewhere the adapter never writes and never reads.
//
// WHAT: one ledger per case, `decisions.jsonl`, beside the intake receipt and
// on the same signed, head-committed chain (ledger.ts). A row names who
// decided (the authenticated principal), as what role, when, why, and pins
// WHAT was decided by content — a statement's fingerprint, a document's
// sha256 — so a decision can never migrate onto something the person did not
// look at. The console overlays the ledger on the artifacts at read time
// (decisions-overlay.ts); the artifacts on disk stay exactly what the machine
// wrote.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LegalDecisionBody, LegalDecisionKind, LegalDecisionRecord, LegalLifecycleState } from '../../shared/legal-contract.ts';
import { LEGAL_CASE_LAYOUT, LEGAL_DECISION_KINDS, LEGAL_LIFECYCLE_STATES } from '../../shared/legal-contract.ts';
import { HttpError } from './errors.ts';
import type { LedgerHead, LedgerSigner, LedgerVerdict, LedgerVerifier } from './ledger.ts';
import { appendSigned, LEDGER_SCHEMA_VERSION, readHead, verifyLedger } from './ledger.ts';
import { caseRoot } from './legal-intake.ts';

export const DECISIONS_LEDGER = LEGAL_CASE_LAYOUT.decisions;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** A reason is required on every decision and bounded so a ledger row stays a row. */
export const MAX_REASON_LENGTH = 2000;

/** The fields a decision row's hash is computed over; the chain fields are added by the ledger. */
export type DecisionPayload = Omit<LegalDecisionRecord, 'schemaVersion' | 'previousRowHash' | 'rowHash' | 'keyId' | 'signature'>;

/**
 * The body's fields in a fixed order per kind, so the row hash never depends
 * on how the object was built. Adding a kind means adding a branch here and
 * in parseBody; the switch is exhaustive by type.
 */
function bodyCanonical(body: LegalDecisionBody): ReadonlyArray<unknown> {
  switch (body.kind) {
    case 'statement_verification':
      return [body.kind, body.action, body.statementFingerprint];
    case 'filed_version_declaration':
      return [body.kind, body.action, body.documentId, body.sha256];
    case 'party_identity_merge':
      return [body.kind, [...body.partyIds], body.displayName];
    case 'document_removal':
      return [body.kind, body.relativePath, body.sha256];
    case 'case_lifecycle':
      return [body.kind, body.state, body.retainUntil];
  }
}

export function decisionCanonical(row: DecisionPayload, previousRowHash: string | null): ReadonlyArray<unknown> {
  return [LEDGER_SCHEMA_VERSION, row.caseId, row.decisionId, row.kind, row.targetId, bodyCanonical(row.body), row.decidedBy, row.role, row.decidedAt, row.reason, previousRowHash];
}

export function isDecisionKind(value: string): value is LegalDecisionKind {
  return (LEGAL_DECISION_KINDS as ReadonlyArray<string>).includes(value);
}

export function isLifecycleState(value: string): value is LegalLifecycleState {
  return (LEGAL_LIFECYCLE_STATES as ReadonlyArray<string>).includes(value);
}

/** A reason as a request supplied it: required, trimmed, bounded. */
export function assertReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'reason_required', 'a decision carries the reason it was made');
  const reason = value.trim();
  if (reason.length > MAX_REASON_LENGTH) throw new HttpError(400, 'reason_too_long', `at most ${MAX_REASON_LENGTH} characters`);
  return reason;
}

// ---------------------------------------------------------------------------
// Reading rows back, in the shape they were written and no other
// ---------------------------------------------------------------------------
type Invalid = (detail: string) => never;

function parseBody(value: unknown, invalid: Invalid): LegalDecisionBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('body must be an object');
  const body = value as Record<string, unknown>;
  const text = (field: string): string => {
    const candidate = body[field];
    if (typeof candidate !== 'string' || candidate === '') invalid(`body.${field} must be a non-empty string`);
    return candidate as string;
  };
  const digest = (field: string): string => {
    const candidate = text(field);
    if (!SHA256.test(candidate)) invalid(`body.${field} must be a sha256 hex digest`);
    return candidate;
  };
  const kind = text('kind');
  switch (kind) {
    case 'statement_verification': {
      const action = text('action');
      if (action !== 'verify' && action !== 'withdraw') invalid('body.action must be verify or withdraw');
      return { kind, action: action as 'verify' | 'withdraw', statementFingerprint: digest('statementFingerprint') };
    }
    case 'filed_version_declaration': {
      const action = text('action');
      if (action !== 'declare' && action !== 'withdraw') invalid('body.action must be declare or withdraw');
      return { kind, action: action as 'declare' | 'withdraw', documentId: text('documentId'), sha256: digest('sha256') };
    }
    case 'party_identity_merge': {
      const ids = body['partyIds'];
      if (!Array.isArray(ids) || ids.length < 2 || ids.some((id) => typeof id !== 'string' || id === '')) invalid('body.partyIds must list at least two party ids');
      return { kind, partyIds: ids as string[], displayName: text('displayName') };
    }
    case 'document_removal':
      return { kind, relativePath: text('relativePath'), sha256: digest('sha256') };
    case 'case_lifecycle': {
      const state = text('state');
      if (!isLifecycleState(state)) invalid(`body.state ${state} is not a lifecycle state`);
      const retainUntil = body['retainUntil'];
      if (retainUntil !== null && (typeof retainUntil !== 'string' || !ISO_INSTANT.test(retainUntil))) invalid('body.retainUntil must be an ISO 8601 UTC instant or null');
      return { kind, state, retainUntil: retainUntil as string | null };
    }
    default:
      return invalid(`body.kind ${kind} is not a decision kind`);
  }
}

export function parseDecisionRecord(value: unknown, where: string): LegalDecisionRecord {
  const invalid: Invalid = (detail) => {
    throw new HttpError(502, 'decision_ledger_invalid', `${where}: ${detail}`);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('row must be an object');
  const row = value as Record<string, unknown>;
  if (row['schemaVersion'] !== LEDGER_SCHEMA_VERSION) invalid(`schemaVersion ${String(row['schemaVersion'])} is not one this console reads`);
  const text = (field: string): string => {
    const candidate = row[field];
    if (typeof candidate !== 'string' || candidate === '') invalid(`${field} must be a non-empty string`);
    return candidate as string;
  };
  const kind = text('kind');
  if (!isDecisionKind(kind)) invalid(`kind ${kind} is not a decision kind`);
  const body = parseBody(row['body'], invalid);
  if (body.kind !== kind) invalid(`kind ${kind} disagrees with body.kind ${body.kind}`);
  const decidedAt = text('decidedAt');
  if (!ISO_INSTANT.test(decidedAt)) invalid('decidedAt must be an ISO 8601 UTC instant');
  const rowHash = text('rowHash');
  if (!SHA256.test(rowHash)) invalid('rowHash must be a sha256 hex digest');
  const previousRowHash = row['previousRowHash'];
  if (previousRowHash !== null && (typeof previousRowHash !== 'string' || !SHA256.test(previousRowHash))) invalid('previousRowHash must be a sha256 hex digest or null');
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    caseId: text('caseId'),
    decisionId: text('decisionId'),
    kind,
    targetId: text('targetId'),
    body,
    decidedBy: text('decidedBy'),
    role: text('role'),
    decidedAt,
    reason: text('reason'),
    previousRowHash: previousRowHash as string | null,
    rowHash,
    keyId: text('keyId'),
    signature: text('signature'),
  };
}

export async function readDecisions(casesDir: string, caseId: string): Promise<LegalDecisionRecord[]> {
  const path = join(caseRoot(casesDir, caseId), DECISIONS_LEDGER);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') return [];
    throw error;
  }
  const rows: LegalDecisionRecord[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new HttpError(502, 'decision_ledger_corrupt', path);
    }
    rows.push(parseDecisionRecord(parsed, `${path}:${index + 1}`));
  }
  return rows;
}

export function readDecisionsHead(casesDir: string, caseId: string): Promise<LedgerHead | null> {
  return readHead(caseRoot(casesDir, caseId), DECISIONS_LEDGER);
}

export function verifyDecisionChain(rows: ReadonlyArray<LegalDecisionRecord>, head: LedgerHead | null, verifier: LedgerVerifier | null): LedgerVerdict {
  return verifyLedger({ rows, head, canonical: decisionCanonical, verifier });
}

export interface DecisionInput {
  readonly caseId: string;
  readonly kind: LegalDecisionKind;
  readonly targetId: string;
  readonly body: LegalDecisionBody;
  readonly decidedBy: string;
  readonly role: string;
  readonly reason: string;
  readonly now: string;
}

/** Appends one signed decision. The ledger serialises appends per case, so two lawyers deciding at once both land. */
export function recordDecision(casesDir: string, signer: LedgerSigner, input: DecisionInput): Promise<LegalDecisionRecord> {
  const payload: DecisionPayload = {
    caseId: input.caseId,
    decisionId: `dec_${randomUUID()}`,
    kind: input.kind,
    targetId: input.targetId,
    body: input.body,
    decidedBy: input.decidedBy,
    role: input.role,
    decidedAt: input.now,
    reason: input.reason,
  };
  return appendSigned<DecisionPayload>({ dir: caseRoot(casesDir, input.caseId), ledger: DECISIONS_LEDGER, payload, canonical: decisionCanonical, signer, now: input.now });
}
