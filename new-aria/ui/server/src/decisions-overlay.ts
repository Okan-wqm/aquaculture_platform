// Human decisions are projected only after their complete signed chain verifies.
import type { LegalDecisionsResponse, LegalDecisionRecord, LegalEvidenceRef, LegalLifecycle, LegalOrphanedDecision, LegalStatement } from '../../shared/legal-contract.ts';
import { DECISIONS_LEDGER, parseDecisionRecord, verifyDecisionChain } from './decisions.ts';
import { HttpError } from './errors.ts';
import type { LedgerVerifier } from './ledger.ts';
import { caseRoot } from './legal-intake.ts';
import { hashCanonical, readLedgerSnapshot } from './ledger.ts';

export interface DecisionContext {
  readonly casesDir: string;
  readonly verifier: LedgerVerifier | null;
}

export async function readDecisionState(context: DecisionContext, caseId: string): Promise<LegalDecisionsResponse> {
  const { rows, head } = await readLedgerSnapshot(caseRoot(context.casesDir, caseId), DECISIONS_LEDGER, parseDecisionRecord);
  const chain = verifyDecisionChain(rows, head, context.verifier);
  if (!chain.valid) throw new HttpError(502, 'decision_chain_invalid', chain.reason ?? 'invalid chain');
  if (rows.some((row) => row.caseId !== caseId || row.role !== 'lawyer')) throw new HttpError(502, 'decision_provenance_invalid');
  return { decisions: rows, chain };
}

export async function verifiedDecisions(context: DecisionContext, caseId: string): Promise<ReadonlyArray<LegalDecisionRecord>> {
  return (await readDecisionState(context, caseId)).decisions;
}

export function lifecycleFrom(rows: ReadonlyArray<LegalDecisionRecord>): LegalLifecycle {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const decision = rows[index];
    if (decision !== undefined && decision.body.kind === 'case_lifecycle') {
      return { state: decision.body.state, retainUntil: decision.body.retainUntil, decision };
    }
  }
  return { state: 'open', retainUntil: null, decision: null };
}

const evidenceCanonical = (refs: ReadonlyArray<LegalEvidenceRef>): ReadonlyArray<unknown> =>
  refs.map((ref) => [ref.documentId, ref.sha256, ref.versionId ?? null, ref.locator ?? null]);

/** Includes all machine proposition content; excludes the human overlay fields. */
export function statementFingerprint(statement: LegalStatement): string {
  return hashCanonical([
    statement.statementId, statement.statement, statement.status, statement.assertedBy, statement.assertedByPartyId,
    evidenceCanonical(statement.supportingSources), evidenceCanonical(statement.contradictingSources),
    statement.missingEvidence, statement.relatedClaimIds, statement.confidence,
  ]);
}

export function overlayStatements(statements: ReadonlyArray<LegalStatement>, decisions: ReadonlyArray<LegalDecisionRecord>): {
  statements: ReadonlyArray<LegalStatement>;
  orphanedVerifications: ReadonlyArray<LegalOrphanedDecision>;
} {
  const latest = new Map<string, LegalDecisionRecord>();
  for (const decision of decisions) if (decision.body.kind === 'statement_verification') latest.set(decision.targetId, decision);
  const targets = new Map(statements.map((statement) => [statement.statementId, statement]));
  const orphanedVerifications: LegalOrphanedDecision[] = [];
  for (const decision of latest.values()) {
    if (decision.body.kind !== 'statement_verification' || decision.body.action === 'withdraw') continue;
    const target = targets.get(decision.targetId);
    if (target === undefined) orphanedVerifications.push({ decision, reason: 'target_missing' });
    else if (statementFingerprint(target) !== decision.body.statementFingerprint) orphanedVerifications.push({ decision, reason: 'target_changed' });
  }
  return {
    statements: statements.map((statement) => {
      const decision = latest.get(statement.statementId);
      if (decision === undefined || decision.body.kind !== 'statement_verification' || decision.body.action !== 'verify' || decision.body.statementFingerprint !== statementFingerprint(statement)) return statement;
      return { ...statement, status: 'verified', humanReviewRequired: false, verifiedBy: decision.decidedBy, verifiedAt: decision.decidedAt };
    }),
    orphanedVerifications,
  };
}
