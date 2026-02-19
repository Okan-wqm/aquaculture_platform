//! Resilience patterns for fault tolerance
//!
//! NOTE: Some helper methods are API-complete but not yet used by all consumers.
#![allow(dead_code)]
//!
//! Provides:
//! - Circuit Breaker pattern for failing services
//! - Timeout wrappers for async operations
//! - Rate limiting (Token Bucket)
//!
//! # IEC 62443 SL2 Compliance
//! - FR3: Input validation via circuit breakers
//! - FR5: Resource availability via rate limiting

mod circuit_breaker;
mod rate_limiter;
mod timeout;

pub use circuit_breaker::CircuitBreaker;
pub use rate_limiter::RateLimiter;
pub use timeout::with_timeout;

// ============================================================================
// Shared monotonic time source (MED-24)
// ============================================================================

use std::sync::OnceLock;
use std::time::Instant;

/// Single monotonic reference point shared by all resilience primitives.
///
/// Using one static prevents the subtle race where multiple OnceLock<Instant>
/// instances are initialised at slightly different wall-clock moments, causing
/// the circuit breaker and rate limiter to measure elapsed time from different
/// origins.  All callers in this crate import `crate::resilience::monotonic_millis`.
pub(crate) static BOOT_INSTANT: OnceLock<Instant> = OnceLock::new();

/// Monotonic milliseconds since process start — NTP-safe.
pub(crate) fn monotonic_millis() -> u64 {
    let boot = BOOT_INSTANT.get_or_init(Instant::now);
    boot.elapsed().as_millis() as u64
}
