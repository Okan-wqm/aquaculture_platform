/**
 * The shape of a REVIEWED EXCEPTION — a gate we are knowingly not enforcing.
 *
 * Three exception files share this shape (dormant invariants, the affected-target
 * quarantine, npm advisories; more lists are listed at the end of this header,
 * not yet in it). They kept being invented separately, each a little weaker
 * than the last: `invariant-reachability.dormant.json` carried the
 * four fields, `affected-target-policy.json` carried a bare reason string, and
 * the npm audit gate carried no exception mechanism at all — so a single
 * unfixable advisory turned the whole required check red and everyone learned
 * to scroll past it.
 *
 * An exception with no clock is not an exception, it is a silent policy change.
 * Four fields make it one:
 *
 *   owner       — a person or agent, so the debt has somewhere to go back to
 *   reason      — long enough to be an argument rather than a label
 *   expires_on  — the forcing function; the gate fails CLOSED the day it passes
 *   finding_id  — the registry row that tracks the real fix
 *
 * PROC-MEDIUM-025 is what this shape is for: nineteen `test` projects sat
 * downgraded to warnings for four months behind bare strings with no owner, no
 * clock and no finding.
 *
 * This module is the ONE statement of these rules. The three files above are
 * checked through it, never through a copy: the npm advisories by
 * npm-audit-gate.mjs and the affected-target quarantine by
 * lib/affected-target-policy.mjs (both run on the committed file by their
 * invariant specs), and the dormant-invariant manifest by
 * validateReviewedExceptions below, called from
 * tests/invariants/invariant-reachability.spec.ts. The manifest's consumer is
 * tests/invariants/jest.config.ts, which leaves the specs it names out of
 * layer-1 without validating it; the reachability spec runs in that same
 * layer-1 run and fails it on a malformed or expired entry. The specs used to
 * re-type the rules, and the dormant copy accepted a waiver with reason "tbd"
 * and finding_id "TODO" (INFRA-LOW-229).
 *
 * Not yet checked through it: scripts/ci/lint-all-exclusions.json, whose bare
 * reason strings carry no owner, expiry or finding (INFRA-LOW-231), and the
 * {owner, reason, expiry, findingId} lists under .claude/allowlists/, which
 * seven invariant specs check with rules of their own (INFRA-LOW-232).
 */

// The registry's finding-id grammar (tools/gates/finding-id-grammar.ts owns it). This file is
// plain ESM that CI runs with `node` and cannot import the owner, so the pattern is held to the
// one table both owners are held to by tests/invariants/finding-id-reviewed-exception.spec.ts.
export const FINDING_ID =
  /^[A-Z][A-Z0-9]*-(?:CRITICAL|HIGH|MEDIUM|LOW)-(?:[1-9][0-9]{3}|[0-9]{3})$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MIN_REASON_LENGTH = 30;

/**
 * Validate one entry. Returns the problems rather than throwing, so a caller
 * can report EVERY malformed entry in one pass instead of one per CI run.
 *
 * @param {unknown} entry     the candidate exception
 * @param {string}  where     human-readable location, used in each message
 * @param {string}  today     ISO date; expiry is compared as a string
 * @returns {string[]}        empty when the entry is well formed and live
 */
export function validateReviewedException(entry, where, today) {
  const problems = reviewedExceptionShapeProblems(entry, where);
  if (isReviewedExceptionExpired(entry, today)) {
    problems.push(`${where}: expired ${entry.expires_on} (${entry.finding_id ?? 'no finding'})`);
  }
  return problems;
}

/**
 * Validate every entry of a `{ where: entry }` map, shape and expiry, the way
 * validateReviewedException validates one.
 *
 * @param {unknown} entries the parsed exception file, keyed by location
 * @param {string}  today   ISO date
 * @returns {string[]}      empty when every entry is well formed and live
 */
export function validateReviewedExceptions(entries, today) {
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    return ['the exception file must be an object {where: entry}'];
  }
  return Object.entries(entries).flatMap(([where, entry]) =>
    validateReviewedException(entry, where, today),
  );
}

/**
 * Every problem with an entry's SHAPE, its expiry left out. A malformed
 * entry is an authoring error a commit introduced; an expired one is a well
 * formed entry whose clock ran out, and a gate may answer the two
 * differently (scripts/ci/lib/affected-target-policy.mjs gates the project
 * of an expired entry instead of refusing the whole file).
 *
 * @param {unknown} entry
 * @param {string}  where
 * @returns {string[]}
 */
export function reviewedExceptionShapeProblems(entry, where) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`${where}: entry must be an object {owner, reason, expires_on, finding_id}`];
  }

  const problems = [];
  if (typeof entry.owner !== 'string' || entry.owner.trim().length === 0) {
    problems.push(`${where}: owner is required`);
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH) {
    problems.push(`${where}: reason must be at least ${MIN_REASON_LENGTH} characters`);
  }
  if (typeof entry.expires_on !== 'string' || !ISO_DATE.test(entry.expires_on)) {
    problems.push(`${where}: expires_on must be YYYY-MM-DD`);
  }
  if (typeof entry.finding_id !== 'string' || !FINDING_ID.test(entry.finding_id)) {
    problems.push(`${where}: finding_id must be a registry id like INFRA-HIGH-001`);
  }
  return problems;
}

/**
 * Whether a dated entry is past its expiry on `today` (ISO dates compare as
 * strings). An entry with no valid date is not "expired"; it is malformed,
 * which reviewedExceptionShapeProblems reports.
 *
 * @param {unknown} entry
 * @param {string}  today
 * @returns {boolean}
 */
export function isReviewedExceptionExpired(entry, today) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.expires_on === 'string' &&
    ISO_DATE.test(entry.expires_on) &&
    entry.expires_on < today
  );
}
