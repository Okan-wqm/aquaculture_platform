//! Command-handler internal helpers (Batch 20b ARC-008 split).
//!
//! WHY: Pre-Batch-20 `commands.rs` was a 4392-line god-file per plan
//! §5 Faz 1 Step 5. Private helpers (RateLimiter + JSON param
//! extractors) were intermingled with 46 `cmd_*` handlers,
//! increasing cognitive load and frustrating domain isolation. Batch
//! 20b hoists these primitives to a dedicated module so each `cmd_*`
//! sub-module can re-import without circular deps.
//!
//! WHAT:
//! - `RateLimiter` — sliding-window rate-limit primitive used by
//!   `CommandHandler` to cap inbound command rate per remote
//!   tenant (Batch 6a mTLS-gated tenant identity). Internal to the
//!   `commands` module tree; not re-exported at crate root.
//! - `require_str_param` / `require_u64_param` — REQUIRED-field
//!   extractors that return the canonical `(false, Value::Null,
//!   Some(error))` triple on missing field, matching the
//!   `CommandResponse` contract used by every `cmd_*` handler.
//! - `get_str_param` / `get_u64_param` / `get_bool_param` — OPTIONAL-
//!   field extractors returning `Option<T>`, leaving the `None`-
//!   branch policy to each caller (default-value vs explicit-null-
//!   check).
//!
//! VISIBILITY: `pub(super)` scope — these helpers MUST NOT leak out
//! of the `commands` module tree. The tuple-typed error shape is an
//! internal-only protocol; external code should use
//! `CommandResponse` builder.

use serde_json::{Value, json};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Simple sliding window rate limiter.
///
/// WHY: Bounded memory (VecDeque capacity capped at `max_commands`)
/// + O(1) amortized amortized check. Used by `CommandHandler::run()`
/// to rate-limit inbound command rate per remote sender — prevents
/// a compromised tenant from flooding the dispatcher with commands.
///
/// Design choice: sliding-window over token-bucket because the
/// platform SLA is expressed as "N commands per minute" (operator-
/// intuitive), and token-bucket's burst-carryover semantics would
/// surprise operators monitoring command-rate metrics.
pub(super) struct RateLimiter {
    /// Timestamps of recent commands (monotonic `Instant`).
    ///
    /// WHY `Instant` over `SystemTime`: rate-limit decisions must
    /// NOT be perturbed by wall-clock jumps (NTP step, manual
    /// clock-set). `Instant` is monotonic by construction.
    timestamps: VecDeque<Instant>,

    /// Maximum allowed commands within the sliding window.
    max_commands: usize,

    /// Sliding-window duration. Entries older than this are evicted
    /// on every `check()` call.
    window: Duration,
}

impl RateLimiter {
    pub(super) fn new(max_commands: usize, window: Duration) -> Self {
        Self {
            timestamps: VecDeque::with_capacity(max_commands),
            max_commands,
            window,
        }
    }

    /// Check if a command should be allowed.
    ///
    /// Returns true if allowed (caller may proceed + the entry is
    /// recorded), false if rate-limited (caller must reject).
    ///
    /// Eviction: entries older than `self.window` are removed from
    /// the front of the deque lazily on each call. This keeps
    /// insertion O(1) amortized and avoids a background-eviction
    /// task.
    pub(super) fn check(&mut self) -> bool {
        let now = Instant::now();

        while let Some(&oldest) = self.timestamps.front() {
            if now.duration_since(oldest) > self.window {
                self.timestamps.pop_front();
            } else {
                break;
            }
        }

        if self.timestamps.len() < self.max_commands {
            self.timestamps.push_back(now);
            true
        } else {
            false
        }
    }

    /// Get current command count in window. Reserved for telemetry
    /// wire-up (Sprint 6.x — `rate_limiter_current_count{tenant}`
    /// Prometheus gauge).
    #[allow(dead_code)]
    pub(super) fn current_count(&self) -> usize {
        self.timestamps.len()
    }

    /// Accessor for the configured max-commands cap. Used by
    /// `CommandHandler::run()` when logging a rate-limit-exceeded
    /// warning (operator needs to see the CAP in the log line to
    /// understand what threshold was breached).
    pub(super) fn max_commands(&self) -> usize {
        self.max_commands
    }

    /// Accessor for the configured sliding-window duration. Used by
    /// `CommandHandler::run()` rate-limit-exceeded log line.
    pub(super) fn window(&self) -> Duration {
        self.window
    }
}

// ============================================================================
// Parameter Extraction Helpers
// ============================================================================
//
// WHY: Every `cmd_*` handler receives `params: &Value` and needs to
// extract typed fields. Inline `params.get("k").and_then(|v|
// v.as_str()).ok_or_else(...)` duplicated 30+ times pre-Batch-20
// produced inconsistent error messages. These helpers enforce the
// canonical `(false, Value::Null, Some("Missing required parameter:
// {key}"))` triple.

/// Helper to extract a REQUIRED string parameter from JSON params.
#[allow(dead_code)]
pub(super) fn require_str_param<'a>(
    params: &'a Value,
    key: &str,
) -> Result<&'a str, (bool, Value, Option<String>)> {
    params.get(key).and_then(|v| v.as_str()).ok_or_else(|| {
        (
            false,
            json!(null),
            Some(format!("Missing required parameter: {}", key)),
        )
    })
}

/// Helper to extract a REQUIRED u64 parameter from JSON params.
#[allow(dead_code)]
pub(super) fn require_u64_param(
    params: &Value,
    key: &str,
) -> Result<u64, (bool, Value, Option<String>)> {
    params.get(key).and_then(|v| v.as_u64()).ok_or_else(|| {
        (
            false,
            json!(null),
            Some(format!("Missing required parameter: {}", key)),
        )
    })
}

/// Helper to extract an OPTIONAL string parameter from JSON params.
#[allow(dead_code)]
pub(super) fn get_str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(|v| v.as_str())
}

/// Helper to extract an OPTIONAL u64 parameter from JSON params.
#[allow(dead_code)]
pub(super) fn get_u64_param(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}

/// Helper to extract an OPTIONAL bool parameter from JSON params.
#[allow(dead_code)]
pub(super) fn get_bool_param(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(|v| v.as_bool())
}
