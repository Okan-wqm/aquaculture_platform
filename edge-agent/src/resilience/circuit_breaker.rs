//! Circuit Breaker implementation
//!
//! Prevents cascading failures by temporarily stopping requests to failing services.
//! States: Closed -> Open -> HalfOpen -> Closed

use std::sync::atomic::{AtomicU32, AtomicU8, Ordering};
use std::sync::RwLock;
use std::time::{Duration, Instant};

/// Circuit breaker states
const STATE_CLOSED: u8 = 0;
const STATE_OPEN: u8 = 1;
const STATE_HALF_OPEN: u8 = 2;

/// Thread-safe circuit breaker
pub struct CircuitBreaker {
    name: String,
    state: AtomicU8,
    failure_count: AtomicU32,
    success_count: AtomicU32,
    failure_threshold: u32,
    success_threshold: u32,
    recovery_timeout: Duration,
    last_failure: RwLock<Option<Instant>>,
}

impl CircuitBreaker {
    /// Create a new circuit breaker
    ///
    /// # Arguments
    /// * `name` - Identifier for logging
    /// * `failure_threshold` - Number of failures before opening
    /// * `recovery_timeout` - Time to wait before trying again
    pub fn new(name: impl Into<String>, failure_threshold: u32, recovery_timeout: Duration) -> Self {
        Self {
            name: name.into(),
            state: AtomicU8::new(STATE_CLOSED),
            failure_count: AtomicU32::new(0),
            success_count: AtomicU32::new(0),
            failure_threshold,
            success_threshold: 2, // 2 successes to close from half-open
            recovery_timeout,
            last_failure: RwLock::new(None),
        }
    }

    /// Check if circuit is open (requests should be rejected)
    pub fn is_open(&self) -> bool {
        match self.state.load(Ordering::SeqCst) {
            STATE_CLOSED => false,
            STATE_OPEN => {
                // Check if recovery timeout has passed
                if let Some(last) = *self.last_failure.read().unwrap() {
                    if last.elapsed() >= self.recovery_timeout {
                        // Transition to half-open
                        self.state.store(STATE_HALF_OPEN, Ordering::SeqCst);
                        self.success_count.store(0, Ordering::SeqCst);
                        tracing::info!(
                            "Circuit breaker '{}' transitioning to half-open",
                            self.name
                        );
                        return false;
                    }
                }
                true
            }
            STATE_HALF_OPEN => false, // Allow one request through
            _ => false,
        }
    }

    /// Record a successful operation
    pub fn record_success(&self) {
        let current_state = self.state.load(Ordering::SeqCst);

        match current_state {
            STATE_HALF_OPEN => {
                let count = self.success_count.fetch_add(1, Ordering::SeqCst) + 1;
                if count >= self.success_threshold {
                    // Transition to closed
                    self.state.store(STATE_CLOSED, Ordering::SeqCst);
                    self.failure_count.store(0, Ordering::SeqCst);
                    tracing::info!("Circuit breaker '{}' closed after recovery", self.name);
                }
            }
            STATE_CLOSED => {
                // Reset failure count on success
                self.failure_count.store(0, Ordering::SeqCst);
            }
            _ => {}
        }
    }

    /// Record a failed operation
    pub fn record_failure(&self) {
        let current_state = self.state.load(Ordering::SeqCst);

        match current_state {
            STATE_CLOSED => {
                let count = self.failure_count.fetch_add(1, Ordering::SeqCst) + 1;
                if count >= self.failure_threshold {
                    self.open_circuit();
                }
            }
            STATE_HALF_OPEN => {
                // Immediately open on failure in half-open state
                self.open_circuit();
            }
            _ => {}
        }
    }

    /// Open the circuit
    fn open_circuit(&self) {
        self.state.store(STATE_OPEN, Ordering::SeqCst);
        *self.last_failure.write().unwrap() = Some(Instant::now());
        tracing::warn!(
            "Circuit breaker '{}' opened after {} failures",
            self.name,
            self.failure_count.load(Ordering::SeqCst)
        );
    }

    /// Get current state as string (for debugging/metrics)
    pub fn state_name(&self) -> &'static str {
        match self.state.load(Ordering::SeqCst) {
            STATE_CLOSED => "closed",
            STATE_OPEN => "open",
            STATE_HALF_OPEN => "half_open",
            _ => "unknown",
        }
    }

    /// Get failure count
    pub fn failure_count(&self) -> u32 {
        self.failure_count.load(Ordering::SeqCst)
    }

    /// Reset the circuit breaker
    pub fn reset(&self) {
        self.state.store(STATE_CLOSED, Ordering::SeqCst);
        self.failure_count.store(0, Ordering::SeqCst);
        self.success_count.store(0, Ordering::SeqCst);
        *self.last_failure.write().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_circuit_breaker_opens_after_threshold() {
        let cb = CircuitBreaker::new("test", 3, Duration::from_secs(30));

        assert!(!cb.is_open());
        cb.record_failure();
        cb.record_failure();
        assert!(!cb.is_open()); // Still 2 failures

        cb.record_failure();
        assert!(cb.is_open()); // Now 3, should open
    }

    #[test]
    fn test_success_resets_failure_count() {
        let cb = CircuitBreaker::new("test", 3, Duration::from_secs(30));

        cb.record_failure();
        cb.record_failure();
        cb.record_success();

        assert_eq!(cb.failure_count(), 0);
        assert!(!cb.is_open());
    }

    #[test]
    fn test_half_open_closes_after_successes() {
        let cb = CircuitBreaker::new("test", 1, Duration::from_millis(1));

        // Open the circuit
        cb.record_failure();
        assert!(cb.is_open());

        // Wait for recovery timeout
        std::thread::sleep(Duration::from_millis(5));

        // Should be half-open now
        assert!(!cb.is_open());

        // Record successes to close
        cb.record_success();
        cb.record_success();

        assert_eq!(cb.state_name(), "closed");
    }
}
