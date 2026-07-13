/**
 * `@platform/alarm-core` — typed TypeScript façade over the `alarm-core` Rust
 * crate compiled to WebAssembly.
 *
 * WHY: the alarm decision predicates (condition test, deadband hysteresis, delay
 * gate) are the drift-zero SSoT (`crates/alarm-core`). The edge alarm engine
 * consumes the crate natively; the NestJS SCADA runtime consumes THIS wasm build
 * so both evaluate identical math — the epsilon / boundary / delay drift that
 * existed between the two hand-written engines becomes structurally impossible.
 *
 * The generated bindings under `./generated` are produced by
 * `scripts/build-wasm.sh` (cargo + wasm-bindgen `--target nodejs`): the embedded
 * `.wasm` loads synchronously via `require`, so every function here is a plain
 * synchronous call with no async init.
 */

import {
  defaultEpsilon as wasmDefaultEpsilon,
  evaluateCondition as wasmEvaluateCondition,
  isOutsideDeadband as wasmIsOutsideDeadband,
  delayElapsed as wasmDelayElapsed,
} from './generated/alarm_core_wasm';

/** Comparison operators a rule may use, as stored on the wire. */
export type AlarmOperator = '<' | '>' | '<=' | '>=' | '==' | '!=';

/** The canonical default `==`/`!=` tolerance for sensor floats (`1e-4`). */
export const DEFAULT_EPSILON: number = wasmDefaultEpsilon();

/**
 * Evaluate whether `value` satisfies `operator` against `threshold`. `==`/`!=`
 * compare within `epsilon` (defaults to {@link DEFAULT_EPSILON}). An unknown
 * operator returns `false`.
 */
export function evaluateCondition(
  operator: string,
  value: number,
  threshold: number,
  epsilon: number = DEFAULT_EPSILON,
): boolean {
  return wasmEvaluateCondition(operator, value, threshold, epsilon);
}

/**
 * Return `true` when `value` is strictly past `threshold ± deadband` so an
 * active alarm may clear (exclusive hysteresis). `deadband === 0` means no
 * hysteresis and returns `true`; an unknown operator returns `true`.
 */
export function isOutsideDeadband(
  operator: string,
  value: number,
  threshold: number,
  deadband: number,
): boolean {
  return wasmIsOutsideDeadband(operator, value, threshold, deadband);
}

/**
 * Return `true` once a met condition has persisted long enough to trigger:
 * `elapsedMs >= delayMs` (millisecond precision, no integer-second truncation).
 */
export function delayElapsed(elapsedMs: number, delayMs: number): boolean {
  return wasmDelayElapsed(elapsedMs, delayMs);
}
