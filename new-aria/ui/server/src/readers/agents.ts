// Agent invocation queue projection — requests joined with claims and results.
//
// WHY: the kernel mints envelopes (requests.jsonl), an executor claims them
// (claims.jsonl) and submits results (results.jsonl); the operator wants one
// line per request with its current lifecycle state.
// WHAT: fold requests by request_id (rows of row_type `request`), overlay the
// latest claim and result rows, derive a closed state vocabulary.

import type { AgentRequestState, AgentRequestView, AgentRequestsResponse } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import { resolveInside } from '../fsafe.ts';
import { asString, foldLatest, tailJsonl } from '../jsonl.ts';

export interface AgentFilter {
  readonly state: string | null;
  readonly limit: number;
}

const STATES: ReadonlySet<AgentRequestState> = new Set(['pending', 'claimed', 'submitted', 'accepted', 'rejected', 'expired', 'unknown']);

function normaliseState(value: string | null): AgentRequestState {
  if (value === null) return 'unknown';
  return STATES.has(value as AgentRequestState) ? (value as AgentRequestState) : 'unknown';
}

export async function readAgentRequests(toolsDir: string, filter: AgentFilter): Promise<AgentRequestsResponse> {
  const requests = (await tailJsonl<Record<string, unknown>>(resolveInside(toolsDir, LEDGER_SOURCES.agent_requests), { maxBytes: 16 * 1024 * 1024 })).rows;
  const claims = foldLatest((await tailJsonl<Record<string, unknown>>(resolveInside(toolsDir, LEDGER_SOURCES.agent_claims), { maxBytes: 8 * 1024 * 1024 })).rows, (row) => asString(row['request_id']));
  const results = foldLatest((await tailJsonl<Record<string, unknown>>(resolveInside(toolsDir, LEDGER_SOURCES.agent_results), { maxBytes: 8 * 1024 * 1024 })).rows, (row) => asString(row['request_id']));
  const latest = foldLatest(
    requests.filter((row) => asString(row['row_type']) === null || asString(row['row_type']) === 'request'),
    (row) => asString(row['request_id']),
  );
  const views: AgentRequestView[] = [];
  const byState: Record<string, number> = {};
  for (const [requestId, row] of latest) {
    const claim = claims.get(requestId);
    const result = results.get(requestId);
    let state = normaliseState(asString(row['state']));
    if (claim !== undefined && state === 'pending') state = 'claimed';
    const resultStatus = result === undefined ? null : asString(result['status']);
    if (resultStatus === 'accepted' || resultStatus === 'rejected') state = resultStatus;
    else if (resultStatus !== null) state = 'submitted';
    byState[state] = (byState[state] ?? 0) + 1;
    if (filter.state !== null && state !== filter.state) continue;
    views.push({
      requestId,
      cycleId: asString(row['cycle_id']),
      role: asString(row['role']),
      targetAgent: asString(row['target_agent']),
      state,
      createdAt: asString(row['created_at']),
      claimedAt: claim === undefined ? null : asString(claim['claimed_at']) ?? asString(claim['at']),
      submittedAt: result === undefined ? null : asString(result['submitted_at']) ?? asString(result['recorded_at']),
      resultStatus,
    });
  }
  return { requests: views.slice(-filter.limit).reverse(), byState };
}
