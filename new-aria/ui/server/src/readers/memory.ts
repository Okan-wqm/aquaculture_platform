// Belief memory projection.
//
// WHY: memory/beliefs.jsonl is event-sourced — one row per revision of a belief;
// the operator wants the CURRENT state per belief plus the status distribution,
// with contradictions and uncertainties counted alongside.
// WHAT: fold by belief_id keeping the last row; map kernel field names
// (claim, evidence_refs, verified_at, last_seen_cycle) onto the contract.

import type { BeliefView, BeliefsResponse } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import { resolveInside } from '../fsafe.ts';
import { asNumber, asString, asStringArray, countJsonlRows, foldLatest, tailJsonl } from '../jsonl.ts';

export interface BeliefFilter {
  readonly status: string | null;
  readonly limit: number;
}

export function toBeliefView(row: Record<string, unknown>): BeliefView | null {
  const beliefId = asString(row['belief_id']);
  if (beliefId === null) return null;
  return {
    beliefId,
    statement: asString(row['claim']) ?? asString(row['statement']),
    status: asString(row['status']) ?? 'unknown',
    confidence: asNumber(row['confidence']),
    evidenceRefs: asStringArray(row['evidence_refs']),
    verifiedAt: asString(row['verified_at']),
    cycleId: asString(row['last_seen_cycle']) ?? asString(row['cycle_id']),
  };
}

export async function readBeliefs(toolsDir: string, filter: BeliefFilter): Promise<BeliefsResponse> {
  const path = resolveInside(toolsDir, LEDGER_SOURCES.memory_beliefs);
  const tail = await tailJsonl<Record<string, unknown>>(path, { maxBytes: 16 * 1024 * 1024 });
  const latest = foldLatest(tail.rows, (row) => asString(row['belief_id']));
  const views: BeliefView[] = [];
  const byStatus: Record<string, number> = {};
  for (const row of latest.values()) {
    const view = toBeliefView(row);
    if (view === null) continue;
    byStatus[view.status] = (byStatus[view.status] ?? 0) + 1;
    if (filter.status === null || view.status === filter.status) views.push(view);
  }
  const contradictions = (await countJsonlRows(resolveInside(toolsDir, LEDGER_SOURCES.memory_contradictions))) ?? 0;
  const uncertainties = (await countJsonlRows(resolveInside(toolsDir, LEDGER_SOURCES.memory_uncertainties))) ?? 0;
  return { beliefs: views.slice(-filter.limit).reverse(), byStatus, contradictions, uncertainties };
}
