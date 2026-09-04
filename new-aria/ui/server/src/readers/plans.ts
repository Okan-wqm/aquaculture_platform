// Convergent-plan projection.
//
// WHY: plans/ holds the kernel's active-plan cache plus event-sourced plan
// ledgers; the operator wants each plan's current state (round, terminal).
// WHAT: read active-plans-cache.json for the active id set, fold every
// plans/*.jsonl ledger by plan_id keeping the last event, merge both.

import type { PlanView, PlansResponse } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import { listDirectory, readJsonFile, resolveInside } from '../fsafe.ts';
import { asNumber, asRecord, asString, asStringArray, foldLatest, tailJsonl } from '../jsonl.ts';

export async function readPlans(toolsDir: string, limit: number): Promise<PlansResponse> {
  const dir = resolveInside(toolsDir, LEDGER_SOURCES.plans_dir);
  const cache = asRecord(await readJsonFile(resolveInside(dir, 'active-plans-cache.json'), 'plans_cache_invalid'));
  const activeIds = new Set(cache === null ? [] : asStringArray(cache['active_plan_ids']));
  const rows: Record<string, unknown>[] = [];
  for (const name of await listDirectory(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    rows.push(...(await tailJsonl<Record<string, unknown>>(resolveInside(dir, name), { maxBytes: 8 * 1024 * 1024 })).rows);
  }
  const latest = foldLatest(rows, (row) => asString(row['plan_id']));
  const views = new Map<string, PlanView>();
  for (const [planId, row] of latest) {
    const terminal = asString(row['terminal_state']);
    views.set(planId, {
      planId,
      state: terminal ?? asString(row['state']) ?? asString(row['event_type']) ?? asString(row['event']) ?? 'unknown',
      round: asNumber(row['round_number']) ?? asNumber(row['round']),
      pressureEventId: asString(row['pressure_event_id']),
      updatedAt: asString(row['recorded_at']) ?? asString(row['at']),
      terminalState: terminal,
    });
  }
  for (const planId of activeIds) {
    if (!views.has(planId)) {
      views.set(planId, { planId, state: 'active', round: null, pressureEventId: null, updatedAt: null, terminalState: null });
    }
  }
  const byState: Record<string, number> = {};
  for (const view of views.values()) byState[view.state] = (byState[view.state] ?? 0) + 1;
  return { plans: [...views.values()].slice(-limit).reverse(), byState };
}
