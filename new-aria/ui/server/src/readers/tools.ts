// Tool registry projection with run history joined in.
//
// WHY: registry.json declares every adapter and its lifecycle status; runs.jsonl
// says what each adapter actually did. The operator reads both together.
// WHAT: registry.tools[] mapped onto the contract, plus per-tool lastRunAt,
// lastRunStatus and runCount from the run ledger tail.

import type { ToolView, ToolsResponse } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import { readJsonFile, resolveInside } from '../fsafe.ts';
import { asRecord, asString, asStringArray, tailJsonl } from '../jsonl.ts';

interface RunStats {
  lastRunAt: string | null;
  lastRunStatus: string | null;
  runCount: number;
}

export async function readTools(toolsDir: string): Promise<ToolsResponse> {
  const registry = asRecord(await readJsonFile(resolveInside(toolsDir, LEDGER_SOURCES.tool_registry), 'registry_invalid'));
  const entries = registry === null || !Array.isArray(registry['tools']) ? [] : registry['tools'];
  const stats = new Map<string, RunStats>();
  for (const row of (await tailJsonl<Record<string, unknown>>(resolveInside(toolsDir, LEDGER_SOURCES.runs), { maxBytes: 16 * 1024 * 1024 })).rows) {
    const toolId = asString(row['tool_id']);
    if (toolId === null) continue;
    const current = stats.get(toolId) ?? { lastRunAt: null, lastRunStatus: null, runCount: 0 };
    current.runCount += 1;
    current.lastRunAt = asString(row['recorded_at']) ?? current.lastRunAt;
    current.lastRunStatus = asString(row['status']) ?? current.lastRunStatus;
    stats.set(toolId, current);
  }
  const tools: ToolView[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const toolId = record === null ? null : asString(record['tool_id']);
    if (record === null || toolId === null) continue;
    const runs = stats.get(toolId) ?? { lastRunAt: null, lastRunStatus: null, runCount: 0 };
    tools.push({
      toolId,
      kind: asString(record['kind']),
      status: asString(record['status']) ?? 'unknown',
      version: asString(record['version']),
      declaredScope: asStringArray(record['declared_scope']),
      lastRunAt: runs.lastRunAt,
      lastRunStatus: runs.lastRunStatus,
      runCount: runs.runCount,
    });
  }
  tools.sort((a, b) => a.toolId.localeCompare(b.toolId));
  return { tools };
}
