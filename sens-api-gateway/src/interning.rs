//! String Interning Module
//!
//! Provides memory-efficient storage for frequently used strings
//! such as device IDs, topic names, and register names.
//!
//! # Features
//! - Thread-safe using lasso's ThreadedRodeo
//! - Lazy initialization with OnceLock
//! - Zero-allocation string lookups after interning
//!
//! # Memory Optimization (IEC 62443 FR5: Resource Availability)
//! String interning reduces memory footprint by storing only one copy
//! of each unique string, particularly useful for:
//! - Device IDs that appear in many log messages
//! - MQTT topic patterns used repeatedly
//! - Modbus register names polled every cycle

// v1.2.4: API reserved for future memory optimization - silence dead_code warnings
#![allow(dead_code)]

use lasso::{Spur, ThreadedRodeo};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

/// EDGE-MEDIUM-002: Maximum number of unique strings the interner will accept.
/// Beyond this limit, new strings are not interned and a sentinel key is returned.
/// 10K entries covers a generous deployment (hundreds of devices * dozens of
/// topics/registers each) while preventing unbounded memory growth on long-running
/// edge agents that encounter transient unique MQTT topics (e.g., from scanners).
const MAX_INTERNER_ENTRIES: usize = 10_000;

/// Whether the capacity warning has been logged (log once, not per-call)
static CAPACITY_WARNING_LOGGED: AtomicBool = AtomicBool::new(false);

/// Global string interner (thread-safe, lazy-initialized)
static INTERNER: OnceLock<ThreadedRodeo> = OnceLock::new();

/// Get or create the global interner
///
/// The interner is lazily initialized on first access and shared
/// across all threads.
pub fn interner() -> &'static ThreadedRodeo {
    INTERNER.get_or_init(ThreadedRodeo::default)
}

/// Intern a string, returning its key
///
/// If the string was already interned, returns the existing key.
/// Otherwise, stores the string and returns a new key.
///
/// # EDGE-MEDIUM-002: Bounded capacity
/// If the interner has reached `MAX_INTERNER_ENTRIES` unique strings,
/// new (previously unseen) strings are rejected and `None` is returned.
/// Already-interned strings always succeed regardless of capacity.
///
/// # Example
/// ```ignore
/// let key1 = intern("device-001");
/// let key2 = intern("device-001"); // Same key as key1
/// assert_eq!(key1, key2);
/// ```
pub fn intern(s: &str) -> Spur {
    let rodeo = interner();

    // Fast path: string already interned — always succeeds
    if let Some(key) = rodeo.get(s) {
        return key;
    }

    // EDGE-MEDIUM-002: Check capacity before interning a new string.
    // ThreadedRodeo::len() is O(1) (atomic counter internally).
    if rodeo.len() >= MAX_INTERNER_ENTRIES {
        if !CAPACITY_WARNING_LOGGED.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                "String interner capacity reached ({} entries). \
                 New unique strings will not be interned. \
                 This may indicate a topic pattern explosion.",
                MAX_INTERNER_ENTRIES,
            );
        }
        // Return a sentinel: intern a fixed overflow marker so callers
        // always get a valid Spur. The resolved string will be "<overflow>"
        // instead of the original, which is acceptable for logging/metrics.
        return rodeo.get_or_intern("<interner-overflow>");
    }

    rodeo.get_or_intern(s)
}

/// Get interned string by key
///
/// # Panics
/// Panics if the key is not valid (was not returned by `intern`).
pub fn resolve(key: Spur) -> &'static str {
    interner().resolve(&key)
}

/// Try to get interned string by key
///
/// Returns None if the key is not valid.
pub fn try_resolve(key: Spur) -> Option<&'static str> {
    interner().try_resolve(&key)
}

/// Intern a device ID
///
/// Convenience function for interning device identifiers.
#[inline]
pub fn intern_device_id(device_id: &str) -> Spur {
    intern(device_id)
}

/// Intern an MQTT topic
///
/// Convenience function for interning topic strings.
#[inline]
pub fn intern_topic(topic: &str) -> Spur {
    intern(topic)
}

/// Intern a register name
///
/// Convenience function for interning Modbus register names.
#[inline]
pub fn intern_register_name(name: &str) -> Spur {
    intern(name)
}

/// Get statistics about the interner
pub struct InternerStats {
    /// Number of unique strings interned
    pub string_count: usize,
}

/// Get current interner statistics
pub fn stats() -> InternerStats {
    InternerStats {
        string_count: interner().len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_interning_same_string() {
        let key1 = intern("test-device-001");
        let key2 = intern("test-device-001");

        // Same string should return same key
        assert_eq!(key1, key2);

        // Should resolve back to original string
        assert_eq!(resolve(key1), "test-device-001");
    }

    #[test]
    fn test_interning_different_strings() {
        let key1 = intern("device-a");
        let key2 = intern("device-b");

        // Different strings should return different keys
        assert_ne!(key1, key2);

        // Should resolve to correct strings
        assert_eq!(resolve(key1), "device-a");
        assert_eq!(resolve(key2), "device-b");
    }

    #[test]
    fn test_convenience_functions() {
        let device_key = intern_device_id("my-device");
        let topic_key = intern_topic("sensors/temperature");
        let register_key = intern_register_name("water_temp");

        assert_eq!(resolve(device_key), "my-device");
        assert_eq!(resolve(topic_key), "sensors/temperature");
        assert_eq!(resolve(register_key), "water_temp");
    }

    #[test]
    fn test_stats() {
        // Intern some strings to ensure counter works
        let _ = intern("stats-test-1");
        let _ = intern("stats-test-2");

        let s = stats();
        // Should have at least 2 strings (plus any from other tests)
        assert!(s.string_count >= 2);
    }

    #[test]
    fn test_try_resolve() {
        let key = intern("try-resolve-test");

        // Valid key should resolve
        assert_eq!(try_resolve(key), Some("try-resolve-test"));
    }
}
