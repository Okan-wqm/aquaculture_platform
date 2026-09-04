// Raw findings projection with operator feedback joined in.
//
// WHY: raw-findings.jsonl is the adapter output the kernel admitted (pointer +
// fingerprint + summary); findings.jsonl carries the operator/judge verdicts.
// The console joins them by fingerprint so a row shows what was found AND what
// a human or judge said about it.
// WHAT: tail raw findings (the summary object holds rule/severity/path/message),
// fold feedback rows by fingerprint or id, apply severity/status/tool filters.

import type { FindingView, FindingsResponse } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import { resolveInside } from '../fsafe.ts';
import { asNumber, asRecord, asString, asStringArray, countJsonlRows, tailJsonl } from '../jsonl.ts';

export interface FindingsFilter {
  readonly limit: number;
  readonly severity: string | null;
  readonly status: string | null;
  readonly tool: string | null;
}

type Feedback = 'true_positive' | 'false_positive';

function feedbackVerdict(row: Record<string, unknown>): Feedback | null {
  const verdict = asString(row['verdict']) ?? asString(row['label']) ?? asString(row['feedback']);
  return verdict === 'true_positive' || verdict === 'false_positive' ? verdict : null;
}

function evidencePaths(summary: Record<string, unknown>): ReadonlyArray<string> {
  const evidence = summary['evidence'];
  if (!Array.isArray(evidence)) return asStringArray(summary['evidence_refs']);
  const refs: string[] = [];
  for (const item of evidence) {
    if (typeof item === 'string') refs.push(item);
    const record = asRecord(item);
    const path = record === null ? null : asString(record['path']) ?? asString(record['ref']);
    if (path !== null) refs.push(asNumber(record?.['line']) === null ? path : `${path}:${String(record?.['line'])}`);
  }
  return refs;
}

export function toFindingView(row: Record<string, unknown>, feedback: ReadonlyMap<string, Feedback>): FindingView {
  const summary = asRecord(row['finding_summary']) ?? {};
  const fingerprint = asString(row['finding_fingerprint']);
  const findingId = asString(row['finding_id']);
  const id = findingId ?? (asString(summary['id']) || null) ?? fingerprint ?? `${asString(row['run_id']) ?? 'run'}${asString(row['json_pointer']) ?? ''}`;
  return {
    id,
    toolId: asString(row['tool_id']),
    runId: asString(row['run_id']),
    cycleId: asString(row['cycle_id']),
    rule: asString(summary['rule']),
    severity: asString(summary['severity']) ?? asString(row['severity']),
    path: asString(summary['path']),
    line: asNumber(summary['line']),
    message: asString(summary['message']) ?? asString(row['reason_code']),
    evidenceRefs: evidencePaths(summary),
    at: asString(row['recorded_at']),
    feedback: (fingerprint !== null ? feedback.get(fingerprint) : undefined) ?? (findingId !== null ? feedback.get(findingId) : undefined) ?? null,
  };
}

export async function readFindings(toolsDir: string, filter: FindingsFilter): Promise<FindingsResponse> {
  const rawPath = resolveInside(toolsDir, LEDGER_SOURCES.raw_findings);
  const feedbackPath = resolveInside(toolsDir, LEDGER_SOURCES.findings_feedback);
  const feedback = new Map<string, Feedback>();
  for (const row of (await tailJsonl<Record<string, unknown>>(feedbackPath, { maxBytes: 4 * 1024 * 1024 })).rows) {
    const verdict = feedbackVerdict(row);
    if (verdict === null) continue;
    for (const key of [asString(row['finding_fingerprint']), asString(row['finding_id'])]) {
      if (key !== null) feedback.set(key, verdict);
    }
  }
  const tail = await tailJsonl<Record<string, unknown>>(rawPath, { maxBytes: 8 * 1024 * 1024 });
  let views = tail.rows.map((row) => toFindingView(row, feedback));
  if (filter.tool !== null) views = views.filter((view) => view.toolId === filter.tool);
  if (filter.severity !== null) views = views.filter((view) => view.severity === filter.severity);
  if (filter.status !== null) {
    const status = filter.status;
    const statusOf = new Map(tail.rows.map((row) => [row, asString(row['status'])] as const));
    views = tail.rows
      .filter((row) => statusOf.get(row) === status)
      .map((row) => toFindingView(row, feedback))
      .filter((view) => (filter.tool === null || view.toolId === filter.tool) && (filter.severity === null || view.severity === filter.severity));
  }
  const bySeverity: Record<string, number> = {};
  for (const view of views) {
    const key = view.severity ?? 'unknown';
    bySeverity[key] = (bySeverity[key] ?? 0) + 1;
  }
  const limited = views.length > filter.limit ? views.slice(views.length - filter.limit) : views;
  return { findings: limited.reverse(), total: (await countJsonlRows(rawPath)) ?? 0, bySeverity };
}
