// The per-case access ledger: who opened what, when, as whom.
//
// WHY: a client's file is evidence, and evidence has readers. MEASURED
// 2026-09-04: reads were logged to stdout as {method, path, status} with no
// actor, and stdout is not a record — it scrolls away, and it named the case
// in clear. A custody claim has to answer "who has seen this?" as well as
// "who took it in?". The access ledger is the same signed, head-committed
// ledger the receipt is, kept beside it in the case directory, so a reader
// cannot be edited out any more than an arrival can.
//
// WHAT: one signed row per case-scoped request, appended after the route has
// answered. Without the ledger key no row can be signed, and a case route
// refuses rather than serve an unrecorded read.

import type { LedgerSigner, SignedRowFields } from './ledger.ts';
import { appendSigned, LEDGER_SCHEMA_VERSION } from './ledger.ts';
import { caseRoot } from './legal-intake.ts';

export const ACCESS_LEDGER = 'access.jsonl';

export interface AccessPayload {
  readonly caseId: string;
  readonly principalId: string;
  readonly role: string;
  readonly method: string;
  /** The route pattern, not the concrete path: the case is named by caseId, a document by its id. */
  readonly route: string;
  readonly documentId: string | null;
  readonly status: number;
  readonly at: string;
}

export type AccessRecord = AccessPayload & SignedRowFields;

export function accessCanonical(row: AccessPayload, previousRowHash: string | null): ReadonlyArray<unknown> {
  return [LEDGER_SCHEMA_VERSION, row.caseId, row.principalId, row.role, row.method, row.route, row.documentId, row.status, row.at, previousRowHash];
}

export function recordAccess(casesDir: string, signer: LedgerSigner, payload: AccessPayload): Promise<AccessRecord> {
  return appendSigned<AccessPayload>({ dir: caseRoot(casesDir, payload.caseId), ledger: ACCESS_LEDGER, payload, canonical: accessCanonical, signer, now: payload.at });
}
