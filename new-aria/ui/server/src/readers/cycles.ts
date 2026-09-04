// Cycle ledger projection — started/terminal rows folded into one summary each.
//
// WHY: cycles.jsonl holds two rows per cycle (started + terminal); the console
// wants one line per cycle with duration and outcome, and a detail view that
// joins the discovery proof, metrics, tool runs and governance of that cycle.
// WHAT: fold by cycle_id in file order; detail reads discovery/<id>/*.json,
// observability/cycle-metrics.jsonl, runs.jsonl and governance.jsonl.

import type { CycleDetailResponse, CycleStatus, CycleSummary, CyclesResponse, LedgerRow } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import { HttpError } from '../errors.ts';
import { readJsonFile, resolveInside } from '../fsafe.ts';
import { asNumber, asRecord, asString, tailJsonl } from '../jsonl.ts';
import { toGovernanceRow } from './governance.ts';

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped', 'aborted']);
const CYCLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function durationSeconds(startedAt: string | null, endedAt: string | null): number | null {
  if (startedAt === null || endedAt === null) return null;
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (Number.isNaN(started) || Number.isNaN(ended)) return null;
  return Math.max(0, Math.round((ended - started) / 1000));
}

export function foldCycles(rows: ReadonlyArray<Record<string, unknown>>): CycleSummary[] {
  const byId = new Map<string, CycleSummary>();
  for (const row of rows) {
    const cycleId = asString(row['cycle_id']);
    if (cycleId === null) continue;
    const event = asString(row['event']) ?? asString(row['status']) ?? 'unknown';
    const at = asString(row['at']);
    const existing = byId.get(cycleId) ?? {
      cycleId,
      startedAt: null,
      endedAt: null,
      status: 'unknown' as const,
      durationSeconds: null,
      gitHeadSha: null,
      toolDecisionCount: null,
    };
    let next: CycleSummary = existing;
    if (event === 'started') {
      next = { ...existing, startedAt: at, status: existing.endedAt === null ? 'started' : existing.status, gitHeadSha: asString(row['git_head_sha_at_cycle']) ?? existing.gitHeadSha };
    } else if (TERMINAL.has(event)) {
      next = {
        ...existing,
        endedAt: at,
        status: event as CycleStatus,
        toolDecisionCount: asNumber(row['tool_decision_count']) ?? existing.toolDecisionCount,
        gitHeadSha: asString(row['git_head_sha_at_cycle']) ?? existing.gitHeadSha,
      };
    }
    byId.set(cycleId, { ...next, durationSeconds: durationSeconds(next.startedAt, next.endedAt) });
  }
  return [...byId.values()];
}

export async function readCycles(toolsDir: string, limit: number): Promise<CyclesResponse> {
  const path = resolveInside(toolsDir, LEDGER_SOURCES.cycles);
  const tail = await tailJsonl<Record<string, unknown>>(path, { maxBytes: 4 * 1024 * 1024 });
  const cycles = foldCycles(tail.rows).reverse();
  return { cycles: cycles.slice(0, limit), total: cycles.length };
}

function compactRun(row: Record<string, unknown>): LedgerRow {
  const keep = ['run_id', 'tool_id', 'status', 'recorded_at', 'duration_ms', 'emitted_counts', 'cost_units', 'artifact_status', 'ledger_hash', 'previous_ledger_hash', 'schema_version'];
  const out: Record<string, unknown> = {};
  for (const key of keep) if (key in row) out[key] = row[key];
  return out;
}

export async function readCycleDetail(toolsDir: string, cycleId: string): Promise<CycleDetailResponse> {
  if (!CYCLE_ID.test(cycleId)) throw new HttpError(400, 'cycle_id_invalid');
  const cyclesPath = resolveInside(toolsDir, LEDGER_SOURCES.cycles);
  const cycles = foldCycles((await tailJsonl<Record<string, unknown>>(cyclesPath, { maxBytes: 8 * 1024 * 1024 })).rows);
  const cycle = cycles.find((item) => item.cycleId === cycleId);
  if (cycle === undefined) throw new HttpError(404, 'cycle_not_found');
  const discoveryDir = resolveInside(toolsDir, LEDGER_SOURCES.discovery_dir, cycleId);
  const completionProof = asRecord(await readJsonFile(resolveInside(discoveryDir, 'COMPLETION_PROOF.json')));
  const repoFingerprint = asRecord(await readJsonFile(resolveInside(discoveryDir, 'REPO_FINGERPRINT.json')));
  const metricsRows = (await tailJsonl<Record<string, unknown>>(resolveInside(toolsDir, 'observability', 'cycle-metrics.jsonl'), { maxBytes: 4 * 1024 * 1024 })).rows;
  const metrics = [...metricsRows].reverse().find((row) => asString(row['cycle_id']) === cycleId) ?? null;
  const runs = (await tailJsonl<Record<string, unknown>>(resolveInside(toolsDir, LEDGER_SOURCES.runs), { maxBytes: 16 * 1024 * 1024 })).rows
    .filter((row) => asString(row['cycle_id']) === cycleId)
    .map(compactRun);
  const governance = (await tailJsonl<Record<string, unknown>>(resolveInside(toolsDir, LEDGER_SOURCES.governance), { maxBytes: 4 * 1024 * 1024 })).rows
    .map(toGovernanceRow)
    .filter((row) => asString((row.details ?? {})['cycle_id']) === cycleId)
    .slice(-200);
  return { cycle, discovery: { completionProof, repoFingerprint }, metrics, runs, governance };
}
