// HUMAN_REQUIRED triage queue — one JSON file per escalation.
//
// WHY: the kernel writes human-required/<request_id>.json so an operator can
// resolve items one by one; the console lists them with their SLA state.
// WHAT: list the directory, parse each file, derive slaBreached from the
// kernel's own sla_deadline against the request clock.

import type { HumanRequiredItem, HumanRequiredResponse } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import { listDirectory, readJsonFile, resolveInside } from '../fsafe.ts';
import { asRecord, asString } from '../jsonl.ts';

export function toHumanRequiredItem(raw: Record<string, unknown>, now: Date): HumanRequiredItem | null {
  const requestId = asString(raw['request_id']);
  if (requestId === null) return null;
  const status = asString(raw['status']);
  const resolved = status === 'resolved' || status === 'closed' || asString(raw['resolved_at']) !== null;
  const slaDeadline = asString(raw['sla_deadline']);
  const deadline = slaDeadline === null ? Number.NaN : Date.parse(slaDeadline);
  return {
    requestId,
    severity: asString(raw['severity']) ?? 'HIGH',
    reason: asString(raw['reason']) ?? '',
    recordedAt: asString(raw['recorded_at']),
    slaDeadline,
    slaBreached: !resolved && !Number.isNaN(deadline) && deadline < now.getTime(),
    resolved,
    context: asRecord(raw['context']) ?? {},
  };
}

export async function readHumanRequired(toolsDir: string, now: Date = new Date()): Promise<HumanRequiredResponse> {
  const dir = resolveInside(toolsDir, LEDGER_SOURCES.human_required_dir);
  const items: HumanRequiredItem[] = [];
  for (const name of await listDirectory(dir)) {
    if (!name.endsWith('.json')) continue;
    const raw = asRecord(await readJsonFile(resolveInside(dir, name), 'human_required_invalid'));
    const item = raw === null ? null : toHumanRequiredItem(raw, now);
    if (item !== null) items.push(item);
  }
  items.sort((a, b) => (b.recordedAt ?? '').localeCompare(a.recordedAt ?? ''));
  return { items, open: items.filter((item) => !item.resolved).length };
}
