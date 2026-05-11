/**
 * Finding Evidence Shape — Future-Only Tier-3 Invariant
 * ============================================================================
 *
 * Companion to `finding-registry-integrity.spec.ts`. Source plan:
 * `/tmp/ci-cleanup-plans/invariants-deferred.md` §2 Option A (recommended
 * by architectural-arbiter — see plan rationale).
 *
 * # Why a separate spec
 *
 * The schema at `docs/reviews/_registry/findings.jsonl.schema.json` used to
 * gate every evidence string against a path-shape regex:
 *
 *   ^[^\s:]+(:[^\s:]+(-[^\s:]+)?)?(\s*\(.*\))?(#[A-Za-z0-9._-]+)?$
 *
 * That regex rejected real-world evidence emitted by CATCHER agents in
 * five recurring classes (Rust `path::method` item-paths, CI run/log
 * references with prose, droplet diagnostic prose with embedded colons,
 * tail-after-paren context, special-char prefixes). 94 historical entries
 * across 46 findings predate the regex; the registry is hash-chained
 * append-only so we cannot rewrite them without invalidating the chain.
 *
 * The schema regex was therefore RELAXED (now `^\S(.*\S)?$` — non-empty,
 * no leading/trailing whitespace) so the integrity test passes for the
 * historical entries. To preserve the discipline the original regex
 * intended, this advisory invariant gates the OLD strict pattern but
 * scopes enforcement to entries with `created_at >= 2026-05-10`.
 *
 * # Effect
 *
 *   - Historical entries (created_at < 2026-05-10): grandfathered. No
 *     enforcement, no warnings — they passed the schema then, they pass
 *     now (relaxed schema), and this advisory ignores them entirely.
 *   - Future entries (created_at >= 2026-05-10): MUST match the strict
 *     path-shape regex. CATCHER agents have a clear cutover signal: any
 *     newly raised finding whose evidence drifts from the canonical shape
 *     fails this invariant and the build is red.
 *
 * # Tier
 *
 * Tier-3 in the architectural-approach hierarchy: detect drift at
 * build/test time. Not Tier-1 (impossible) because we cannot retroactively
 * make the historical chain match a tighter schema without rewriting
 * hashes; not Tier-2 (automatic) because the writer's schema isn't AJV
 * (CATCHER agents emit free strings then the registry CLI hashes them).
 *
 * # When this fails
 *
 *   - A finding raised on or after 2026-05-10 has an evidence string
 *     that doesn't fit the canonical CATCHER path-shape.
 *   - Fix at the WRITER side: rewrite the evidence to a canonical shape
 *     before the entry is hashed and appended. The plan documents the
 *     six shapes:
 *
 *       file              # path-only
 *       file:line         # canonical
 *       file:start-end    # line range
 *       file (test)       # parenthesized test ref (Rust suite)
 *       file#anchor       # markdown anchor
 *       file:line (test)  # combined
 *
 *   - For diagnostic context that isn't a path:line citation, use the
 *     `narrative` array on the finding instead of `evidence`. The
 *     narrative field exists exactly for this purpose (see
 *     findings.jsonl.schema.json `narrative` description).
 *
 * # References
 *
 *   - /tmp/ci-cleanup-plans/invariants-deferred.md §2 Option A
 *   - /var/aqua-saas/docs/reviews/_registry/findings.jsonl.schema.json
 *     (`evidence` description documents the relaxation)
 *   - tests/invariants/finding-registry-integrity.spec.ts
 *     (sibling — runs AJV against the relaxed pattern)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');

/**
 * Cutover date (UTC). Entries whose `created_at` parses to a date >= this
 * value are subject to the strict path-shape enforcement. Earlier entries
 * are grandfathered (the relaxed schema is the only check they face).
 *
 * Picked 2026-05-10 to match the day this advisory landed. New CATCHER
 * output from this date onward MUST follow the canonical shapes.
 */
const STRICT_PATTERN_CUTOVER_UTC = '2026-05-10T00:00:00.000Z';

/**
 * The original (pre-relaxation) schema regex that the JSON schema used to
 * enforce. We re-state it here as the authoritative future-only check so
 * the schema can stay relaxed for historical compatibility while drift
 * surface remains tight at the WRITER cutover boundary.
 *
 * Anchored start-to-end. Parses one of:
 *   file
 *   file:line
 *   file:start-end
 *   file (test)            (also `file:line (test)` via the optional groups)
 *   file#anchor            (also combinable with the colon/paren groups)
 *
 * Forbids whitespace and unescaped colons inside the path or test segment.
 */
const STRICT_PATH_SHAPE = /^[^\s:]+(:[^\s:]+(-[^\s:]+)?)?(\s*\(.*\))?(#[A-Za-z0-9._-]+)?$/;

interface FindingEntry {
  id: string;
  created_at?: string;
  evidence?: unknown;
}

function readEntries(): FindingEntry[] {
  if (!fs.existsSync(REGISTRY_PATH)) return [];
  const content = fs.readFileSync(REGISTRY_PATH, 'utf8').trim();
  if (content.length === 0) return [];
  return content.split('\n').map((line) => JSON.parse(line) as FindingEntry);
}

function isFutureEntry(entry: FindingEntry): boolean {
  if (typeof entry.created_at !== 'string') return false;
  const created = Date.parse(entry.created_at);
  if (Number.isNaN(created)) return false;
  return created >= Date.parse(STRICT_PATTERN_CUTOVER_UTC);
}

describe('finding evidence shape — future-only Tier-3 advisory', () => {
  const entries = readEntries();

  it('every entry created on or after 2026-05-10 has evidence in canonical path-shape', () => {
    const violations: Array<{ id: string; index: number; evidence: string }> = [];
    for (const entry of entries) {
      if (!isFutureEntry(entry)) continue;
      const evidence = entry.evidence;
      if (!Array.isArray(evidence)) continue;
      evidence.forEach((item, index) => {
        if (typeof item !== 'string') return;
        if (STRICT_PATH_SHAPE.test(item)) return;
        violations.push({ id: entry.id, index, evidence: item });
      });
    }
    if (violations.length > 0) {
      const lines = violations
        .map(
          (v) =>
            `  ${v.id} evidence[${v.index}]: ${JSON.stringify(v.evidence)}`,
        )
        .join('\n');
      throw new Error(
        `findings.jsonl contains ${violations.length} evidence string(s) on entries ` +
          `created on or after ${STRICT_PATTERN_CUTOVER_UTC} that do not match the canonical ` +
          `path-shape regex ${STRICT_PATH_SHAPE.toString()}.\n\n` +
          `Canonical shapes: 'file', 'file:line', 'file:start-end', ` +
          `'file (test)', 'file#anchor', 'file:line (test)'. ` +
          `Move non-citation prose into the entry's 'narrative' array (see schema).\n\n` +
          `Violations:\n${lines}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
