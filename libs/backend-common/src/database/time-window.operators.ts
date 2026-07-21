import { FindOperator, LessThan, MoreThanOrEqual } from 'typeorm';

/**
 * Intent-named time-window `FindOperator` helpers (APA-319).
 *
 * A recency window ("rows WITHIN the last N ms") and a retention/staleness
 * window ("rows OLDER than N ms ago") are mirror opposites. Built inline they
 * look almost identical — `MoreThanOrEqual(now - ms)` vs `LessThan(now - ms)` —
 * and the only thing distinguishing them at the call site was a `// Last hour`
 * style comment the type system cannot check. That comment-as-contract drift
 * shipped an inverted predicate on a SUPER_ADMIN health widget (the slow-query
 * check counted rows OLDER than an hour under a "last hour" comment).
 *
 * These helpers encode the DIRECTION in the name, so the wrong window is
 * visibly wrong where it is read and the idiom has exactly one spelling
 * platform-wide. The inline `<Op>(new Date(Date.now() …))` form is frozen out
 * of `apps/**` by `tests/invariants/time-window-operator-usage.spec.ts`; this
 * module is the single sanctioned home for the raw operators.
 */

/**
 * Matches rows whose `Date` column falls WITHIN the last `windowMs`
 * (recency): `column >= now - windowMs`.
 */
export function withinLast(windowMs: number): FindOperator<Date> {
  return MoreThanOrEqual(new Date(Date.now() - windowMs));
}

/**
 * Matches rows whose `Date` column is OLDER than `windowMs` ago
 * (retention / staleness): `column < now - windowMs`.
 */
export function olderThan(windowMs: number): FindOperator<Date> {
  return LessThan(new Date(Date.now() - windowMs));
}
