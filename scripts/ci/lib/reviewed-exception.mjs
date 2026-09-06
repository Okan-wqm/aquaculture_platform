/**
 * The shape of a REVIEWED EXCEPTION — a gate we are knowingly not enforcing.
 *
 * The repository has three of these now (dormant invariants, the affected-target
 * quarantine, npm advisories) and they kept being invented separately, each a
 * little weaker than the last: `invariant-reachability.dormant.json` carried the
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
 */

export const FINDING_ID = /^[A-Z]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3}$/;
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
  const problems = [];

  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`${where}: entry must be an object {owner, reason, expires_on, finding_id}`];
  }

  if (typeof entry.owner !== 'string' || entry.owner.trim().length === 0) {
    problems.push(`${where}: owner is required`);
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH) {
    problems.push(`${where}: reason must be at least ${MIN_REASON_LENGTH} characters`);
  }
  if (typeof entry.expires_on !== 'string' || !ISO_DATE.test(entry.expires_on)) {
    problems.push(`${where}: expires_on must be YYYY-MM-DD`);
  } else if (entry.expires_on < today) {
    problems.push(`${where}: expired ${entry.expires_on} (${entry.finding_id ?? 'no finding'})`);
  }
  if (typeof entry.finding_id !== 'string' || !FINDING_ID.test(entry.finding_id)) {
    problems.push(`${where}: finding_id must be a registry id like INFRA-HIGH-001`);
  }

  return problems;
}
