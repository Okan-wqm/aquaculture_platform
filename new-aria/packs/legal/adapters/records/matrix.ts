// The claim–evidence matrix, filled from what the documents actually state.
//
// WHY: the matrix is the operator's core working object, and it was empty by
// construction — `statements: []` in the adapter, with the three agents
// contracted to fill it unable to be dispatched. An empty matrix means the
// console shows a case with no working surface at all, and it means the honesty
// machinery around statements (the verification gate, the human-review marker,
// the supporting/contradicting columns) has nothing to protect.
//
// The rows this module writes are the ones that can be derived without
// judgement: a value two documents state differently is `disputed` with both
// sides attached, and a reference the archive cannot satisfy is `unverifiable`
// with the missing document named. That is a small matrix, and it is a true one.
// Rows requiring reading comprehension — what a party is actually claiming —
// remain an agent's job, and their absence is visible rather than papered over.
//
// WHAT: `matrixRows(...)` turns contradictions and missing references into
// statements, THROUGH the verification gate, so nothing this module produces can
// carry `verified` or name a verifier.
import { byteCompare, sha256Hex } from '../legal-text';
import type { LegalEvidenceRef, LegalStatement } from '../legal-records';
import type { ContradictionRow, MissingReferenceRow } from './fact-index';
import { acceptMachineStatement, toUnverifiedRecord } from './statement-gate';

function statementId(seed: string): string {
  return `stmt_${sha256Hex(seed).slice(0, 16)}`;
}

function evidenceOf(documentId: string, sha256: string, locator: string): LegalEvidenceRef {
  return { documentId, sha256, locator };
}

/**
 * One row per disagreement and one per unsatisfied reference.
 *
 * Both go through `acceptMachineStatement`, which is the point: the matrix is
 * written by the same gate that will police an agent's submissions, so the
 * adapter cannot take a shortcut the agents are denied.
 */
export function matrixRows(contradictions: readonly ContradictionRow[], missing: readonly MissingReferenceRow[]): LegalStatement[] {
  const rows: LegalStatement[] = [];

  for (const row of contradictions) {
    const statement = `${row.label} is stated as ${row.left.value} in ${row.left.relativePath} and as ${row.right.value} in ${row.right.relativePath}.`;
    const accepted = acceptMachineStatement({
      statementId: statementId(`contradiction\n${row.labelKey}\n${row.left.documentId}\n${row.right.documentId}`),
      statement,
      // `disputed` is the honest status: the documents disagree. It is NOT
      // `contradicted`, which would mean the evidence defeats the claim — that
      // is a verdict, and no verdict is reached here.
      status: 'disputed',
      assertedBy: 'mechanical_extraction',
      assertedByPartyId: null,
      supportingSources: [evidenceOf(row.left.documentId, row.left.sha256, row.left.locator)],
      contradictingSources: [evidenceOf(row.right.documentId, row.right.sha256, row.right.locator)],
      missingEvidence: [],
      confidence: 0.6,
      relatedClaimIds: [],
    });
    rows.push(toUnverifiedRecord(accepted));
  }

  for (const row of missing) {
    const accepted = acceptMachineStatement({
      statementId: statementId(`missing\n${row.reference.kind}\n${row.reference.identifier}\n${row.reference.documentId}`),
      statement:
        `${row.reference.relativePath} relies on ${row.reference.kind} ${row.reference.identifier}, which no document in this archive matches.`,
      // `unverifiable` says exactly what is true: the claim cannot be tested
      // against this archive because the document it rests on is not here.
      status: 'unverifiable',
      assertedBy: 'mechanical_extraction',
      assertedByPartyId: null,
      supportingSources: [evidenceOf(row.reference.documentId, row.reference.sha256, row.reference.locator)],
      contradictingSources: [],
      missingEvidence: [`${row.reference.kind} ${row.reference.identifier} (as cited: "${row.reference.raw}")`],
      confidence: 0.5,
      relatedClaimIds: [],
    });
    rows.push(toUnverifiedRecord(accepted));
  }

  return rows.sort((a, b) => byteCompare(a.statementId, b.statementId));
}
