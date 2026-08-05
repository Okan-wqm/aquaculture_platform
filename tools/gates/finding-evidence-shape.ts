/**
 * Canonical path-shape contract for structured finding evidence.
 *
 * Free-form diagnostic context belongs in `narrative`; `evidence` is kept
 * machine-addressable so registry consumers can resolve files, lines, tests,
 * and anchors without parsing prose.
 */
export const CANONICAL_FINDING_EVIDENCE_PATTERN =
  /^[^\s:]+(:[^\s:]+(-[^\s:]+)?)?(\s*\(.*\))?(#[A-Za-z0-9._-]+)?$/;

/** Historical rows before this instant retain the schema accepted when written. */
export const STRICT_FINDING_EVIDENCE_CUTOVER_UTC = '2026-05-10T00:00:00.000Z';

export function requiresCanonicalFindingEvidence(createdAt: unknown): boolean {
  if (typeof createdAt !== 'string') return false;
  const timestamp = Date.parse(createdAt);
  return !Number.isNaN(timestamp) && timestamp >= Date.parse(STRICT_FINDING_EVIDENCE_CUTOVER_UTC);
}

export interface NonCanonicalFindingEvidence {
  readonly index: number;
  readonly evidence: string;
}

export function findNonCanonicalFindingEvidence(
  evidence: readonly unknown[] | undefined,
): NonCanonicalFindingEvidence[] {
  const violations: NonCanonicalFindingEvidence[] = [];
  for (const [index, item] of (evidence ?? []).entries()) {
    if (typeof item !== 'string' || CANONICAL_FINDING_EVIDENCE_PATTERN.test(item)) continue;
    violations.push({ index, evidence: item });
  }
  return violations;
}
