// Pressure projection — the attention queue of the latest cycle.
//
// WHY: pressure/pressure-log.jsonl writes one row per cycle holding the whole
// scored `pressures[]` array; the newest row is the current queue.
// WHAT: take the last row, map each pressure (pressure_id, source, score,
// severity/type, reason, recommended_action) onto the contract, sort by score.

import type { PressureView, PressuresResponse } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import { resolveInside } from '../fsafe.ts';
import { asNumber, asRecord, asString, tailJsonl } from '../jsonl.ts';

export function toPressureView(item: Record<string, unknown>, cycleId: string | null, at: string | null): PressureView | null {
  const pressureId = asString(item['pressure_id']);
  if (pressureId === null) return null;
  const components = asRecord(item['score_components']);
  return {
    pressureId,
    source: asString(item['source']),
    score: asNumber(item['score']),
    state: asString(item['state']) ?? asString(item['severity']) ?? asString(item['type']),
    occurrenceCount: components === null ? null : asNumber(components['occurrence_count']) ?? asNumber(components['count']),
    summary: asString(item['reason']) ?? asString(item['recommended_action']) ?? asString(item['summary']),
    cycleId: asString(item['cycle_id']) ?? cycleId,
    at,
  };
}

export async function readPressures(toolsDir: string, limit: number): Promise<PressuresResponse> {
  const path = resolveInside(toolsDir, LEDGER_SOURCES.pressure_log);
  const tail = await tailJsonl<Record<string, unknown>>(path, { maxBytes: 8 * 1024 * 1024, limit: 1 });
  const latest = tail.rows[tail.rows.length - 1];
  if (latest === undefined) return { pressures: [], total: 0 };
  const items = Array.isArray(latest['pressures']) ? latest['pressures'] : [];
  const cycleId = asString(latest['cycle_id']);
  const at = asString(latest['generated_at']);
  const views: PressureView[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const view = record === null ? null : toPressureView(record, cycleId, at);
    if (view !== null) views.push(view);
  }
  views.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return { pressures: views.slice(0, limit), total: views.length };
}
