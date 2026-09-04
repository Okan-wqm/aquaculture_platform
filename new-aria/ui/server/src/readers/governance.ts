// Governance ledger projection.
//
// WHY: governance.jsonl is the kernel's audit spine (every refusal, bootstrap,
// registration, quarantine lands here); the console shows it as an event feed.
// WHAT: rows carry `kind` (event name), `details`, `ts`; the contract names them
// `event`/`details`/`at` while keeping every original field.

import type { GovernanceResponse, GovernanceRow } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import { resolveInside } from '../fsafe.ts';
import { asRecord, asString, countJsonlRows, tailJsonl } from '../jsonl.ts';

export interface GovernanceFilter {
  readonly limit: number;
  readonly since: string | null;
  readonly event: string | null;
}

export function toGovernanceRow(raw: Record<string, unknown>): GovernanceRow {
  const event = asString(raw['kind']) ?? asString(raw['event']) ?? 'unknown';
  const at = asString(raw['ts']) ?? asString(raw['at']) ?? asString(raw['recorded_at']);
  const details = asRecord(raw['details']) ?? {};
  return { ...raw, event, details, ...(at === null ? {} : { at }) };
}

export async function readGovernance(toolsDir: string, filter: GovernanceFilter): Promise<GovernanceResponse> {
  const path = resolveInside(toolsDir, LEDGER_SOURCES.governance);
  const tail = await tailJsonl<Record<string, unknown>>(path, { maxBytes: 4 * 1024 * 1024 });
  let rows = tail.rows.map(toGovernanceRow);
  if (filter.event !== null) rows = rows.filter((row) => row.event === filter.event);
  if (filter.since !== null) {
    const since = filter.since;
    rows = rows.filter((row) => typeof row.at === 'string' && row.at >= since);
  }
  const limited = rows.length > filter.limit ? rows.slice(rows.length - filter.limit) : rows;
  const total = (await countJsonlRows(path)) ?? 0;
  return { rows: limited, total };
}
