/**
 * The review's header counts, computed from its findings and scenarios — the
 * design document computed them the same way, so a finding added to the
 * content moves the counts with it instead of leaving a stale number.
 */
import type { FindingKind, ReviewSection, ScenarioRow, ScenarioStatus } from './types';

export type FindingCounts = Readonly<Record<FindingKind | 'total', number>>;

export function countFindings(sections: readonly ReviewSection[]): FindingCounts {
  const findings = sections.flatMap((section) => section.items);
  const ofKind = (kind: FindingKind): number => findings.filter(([k]) => k === kind).length;
  return { total: findings.length, c: ofKind('c'), b: ofKind('b'), k: ofKind('k'), u: ofKind('u') };
}

export function countScenarios(
  rows: readonly ScenarioRow[],
): Readonly<Record<ScenarioStatus, number>> {
  const withStatus = (status: ScenarioStatus): number =>
    rows.filter((row) => row[2] === status).length;
  return { ok: withStatus('ok'), part: withStatus('part'), no: withStatus('no') };
}
