/**
 * The finding-state vocabulary, in one place.
 *
 * PROC-HIGH-020. Seven hand-copied unions of this list existed across
 * `tools/` and `libs/backend-common/`, and no test forced them to agree — the
 * Potemkin-SSoT shape this repo has been burned by before. They are collapsed
 * here so a state can only be added or removed once, and
 * `tools/gates/finding-state-authority.spec.ts` asserts parity against the
 * remaining declarations and the JSON schema.
 *
 * `STALE` is deliberately absent. It was only ever written by the daily sweep's
 * age branch, from `created_at` and the clock, with no reader of the code and
 * no record of a decision — and it never reached `main` (the registry holds
 * zero STALE rows in its entire history). Removing the value from the union
 * makes the transition a calendar alone could author unrepresentable rather
 * than merely unwritten.
 *
 * `BLOCKED` survives because it names a real human act — escalation with an
 * owner and a decision document — and one legitimate row uses it. What changes
 * is who may write it: `cmdBlock`, on the same evidence `cmdWaive` demands,
 * never a passing date.
 */

export const FINDING_STATES = ['OPEN', 'IN-PROGRESS', 'RESOLVED', 'BLOCKED', 'WAIVED'] as const;

export type FindingState = (typeof FINDING_STATES)[number];

/** The only state a finding may be born in — see `buildFinding`. */
export const FINDING_BIRTH_STATE: FindingState = 'OPEN';

/**
 * States that mean "this defect is no longer asking for work".
 *
 * RESOLVED is evidence-backed (a merged commit whose message names the id).
 * WAIVED is decision-backed (an owner, a decision document and a review date
 * that puts the row back in the neglect report). Everything else is active,
 * which is what `findings:list --active` prints and what a human owes an
 * answer for.
 */
export const FINDING_SETTLED_STATES: readonly FindingState[] = ['RESOLVED', 'WAIVED'];

export function isFindingState(value: string): value is FindingState {
  return (FINDING_STATES as readonly string[]).includes(value);
}

export function isActiveFindingState(value: FindingState): boolean {
  return !FINDING_SETTLED_STATES.includes(value);
}
