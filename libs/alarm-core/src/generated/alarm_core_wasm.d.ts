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
 *
 * The `f64 → u64` conversion is saturating and floors: `.max(0.0)` maps
 * negatives AND `NaN` to `0`, and `as u64` saturates at `u64::MAX` (no UB, no
 * panic). Under the integer-millisecond contract this is a no-op; a *fractional*
 * `delay_ms` would be floored (fire up to ~1 ms early), which callers avoid by
 * passing whole milliseconds.
 */
export function delayElapsed(elapsed_ms: number, delay_ms: number): boolean;
