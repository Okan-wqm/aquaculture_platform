//! wasm-bindgen bindings over `alarm-core`.
//!
//! WHY: `alarm-core` is the drift-zero alarm decision SSoT. The edge engine
//! consumes it natively; the NestJS SCADA runtime consumes THIS WebAssembly
//! build, so both evaluate the identical condition / deadband / delay math. No
//! native ABI (ADR-025 rejected NAPI-RS), memory-isolated, no shared crash
//! domain. Mirrors `protocol-codec-wasm`.
#![forbid(unsafe_code)]

use wasm_bindgen::prelude::wasm_bindgen;

/// The canonical default `==`/`!=` epsilon (`1e-4`), re-exported for callers.
#[wasm_bindgen(js_name = defaultEpsilon)]
#[must_use]
pub fn default_epsilon() -> f64 {
    alarm_core::DEFAULT_EPSILON
}

/// Evaluate whether `value` satisfies `operator` against `threshold` (within
/// `epsilon` for `==`/`!=`). Unknown operator ⇒ `false`.
#[wasm_bindgen(js_name = evaluateCondition)]
#[must_use]
pub fn evaluate_condition(operator: &str, value: f64, threshold: f64, epsilon: f64) -> bool {
    alarm_core::evaluate_condition(operator, value, threshold, epsilon)
}

/// Return `true` when `value` is strictly past `threshold ± deadband` so an
/// active alarm may clear (exclusive hysteresis; `deadband == 0` ⇒ `true`).
#[wasm_bindgen(js_name = isOutsideDeadband)]
#[must_use]
pub fn is_outside_deadband(operator: &str, value: f64, threshold: f64, deadband: f64) -> bool {
    alarm_core::is_outside_deadband(operator, value, threshold, deadband)
}

/// Return `true` when `elapsed_ms >= delay_ms` (millisecond precision, no
/// integer-second truncation). Values are integer milliseconds passed as `f64`
/// (exact for any realistic duration).
///
/// The `f64 → u64` conversion is saturating and floors: `.max(0.0)` maps
/// negatives AND `NaN` to `0`, and `as u64` saturates at `u64::MAX` (no UB, no
/// panic). Under the integer-millisecond contract this is a no-op; a *fractional*
/// `delay_ms` would be floored (fire up to ~1 ms early), which callers avoid by
/// passing whole milliseconds.
#[wasm_bindgen(js_name = delayElapsed)]
#[must_use]
pub fn delay_elapsed(elapsed_ms: f64, delay_ms: f64) -> bool {
    let elapsed = elapsed_ms.max(0.0) as u64;
    let delay = delay_ms.max(0.0) as u64;
    alarm_core::delay_elapsed(elapsed, delay)
}
