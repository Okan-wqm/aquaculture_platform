/* tslint:disable */
/* eslint-disable */
/**
 * The canonical default `==`/`!=` epsilon (`1e-4`), re-exported for callers.
 */
export function defaultEpsilon(): number;
/**
 * Evaluate whether `value` satisfies `operator` against `threshold` (within
 * `epsilon` for `==`/`!=`). Unknown operator ⇒ `false`.
 */
export function evaluateCondition(operator: string, value: number, threshold: number, epsilon: number): boolean;
/**
 * Return `true` when `value` is strictly past `threshold ± deadband` so an
 * active alarm may clear (exclusive hysteresis; `deadband == 0` ⇒ `true`).
 */
export function isOutsideDeadband(operator: string, value: number, threshold: number, deadband: number): boolean;
/**
 * Return `true` when `elapsed_ms >= delay_ms` (millisecond precision, no
 * integer-second truncation). Values are integer milliseconds passed as `f64`
 * (exact for any realistic duration).
 */
export function delayElapsed(elapsed_ms: number, delay_ms: number): boolean;
