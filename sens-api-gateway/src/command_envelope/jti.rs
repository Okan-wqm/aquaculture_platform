//! # Jti — replay defense via jti dedup cache (plan §4.10)
//!
//! Each `CommandEnvelope` carries a `jti` (JWT ID) — a unique UUIDv4-style
//! string minted by the signer. The edge maintains a sliding-window dedup
//! table: if a jti has been seen within the last 72 hours, the envelope is
//! rejected as a replay.
//!
//! Runtime impl (Sprint 6.4) is a two-tier store:
//! - Moka TTL cache (60 seconds, in-process, fast path for hot-window replay)
//! - SQLCipher persistent table (72 hours, survives reboot)
//!
//! The SQLCipher store uses `KeyPurpose::ReplayCache` (Batch 4b) so the
//! replay cache cannot be forged by an attacker with disk access.
//!
//! ## Scope of Batch 7 (this file)
//!
//! Types + trait. The [`JtiDedupTable`] trait is the Sprint 6.4 runtime's
//! contract — tests + supervisor code depend on the trait, not the impl.

use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// JWT ID — opaque unique-per-command string. Validated at parse boundary:
/// non-empty, bounded length (256 bytes max to fit UUIDv4 + structured
/// prefixes without unbounded growth).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Jti(String);

/// Tier-1 bound — jti length must fit in a sensible audit surface and
/// dedup cache key. 256 bytes accommodates UUIDv4 (36) + reasonable prefix
/// like `"tenant-42:op-7:cmd-"` without unbounded growth.
pub const MAX_JTI_BYTES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidJti {
    Empty,
    TooLong(usize),
    /// Contains a byte that is NOT ASCII printable (0x20..=0x7E). jti is
    /// transport-safe text; binary bytes indicate parse bug or hostile
    /// input.
    NonAsciiPrintable,
}

impl std::fmt::Display for InvalidJti {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => f.write_str("empty_jti"),
            Self::TooLong(n) => write!(f, "jti_too_long:{}", n),
            Self::NonAsciiPrintable => f.write_str("jti_non_ascii_printable"),
        }
    }
}

impl std::error::Error for InvalidJti {}

impl Jti {
    /// Validated parse ctor — non-empty, bounded, ASCII-printable.
    pub fn try_new(s: impl Into<String>) -> Result<Self, InvalidJti> {
        let s = s.into();
        if s.is_empty() {
            return Err(InvalidJti::Empty);
        }
        if s.len() > MAX_JTI_BYTES {
            return Err(InvalidJti::TooLong(s.len()));
        }
        for &byte in s.as_bytes() {
            if !(0x20..=0x7E).contains(&byte) {
                return Err(InvalidJti::NonAsciiPrintable);
            }
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Result of a dedup table `check_and_mark` operation. The verify path
/// treats `Duplicate` as a replay rejection; `Fresh` inserts and returns
/// `Ok`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DedupResult {
    /// jti was NOT present; now inserted with the supplied expiry.
    Fresh,
    /// jti WAS present with non-expired entry. Replay attempt.
    Duplicate,
}

/// Dedup table trait. The Sprint 6.4 runtime layers Moka + SQLCipher under
/// this abstraction. Consumers (command dispatcher) depend on the trait;
/// tests use an `InMemoryJtiDedupTable` mock.
///
/// **Async:** the persistent SQLCipher layer is async (tokio
/// `spawn_blocking` inside the impl). Moka-only implementations can return
/// `std::future::ready(...)`.
#[async_trait::async_trait]
pub trait JtiDedupTable: Send + Sync + 'static {
    /// Check if `jti` has been seen in the active window. If fresh, insert
    /// it with `expires_at` and return [`DedupResult::Fresh`]. Otherwise
    /// return [`DedupResult::Duplicate`] without modifying the table.
    ///
    /// `expires_at` is typically `received_at + 72h`; the dedup table sweeps
    /// expired entries lazily (on access) + eagerly (Sprint 6.4 task every
    /// 5 minutes).
    async fn check_and_mark(
        &self,
        jti: &Jti,
        expires_at: SystemTime,
    ) -> Result<DedupResult, DedupTableError>;

    /// Count of currently-live (non-expired) entries. Used for metrics
    /// cardinality + capacity alerts.
    async fn live_entry_count(&self) -> Result<usize, DedupTableError>;

    /// Evict all expired entries — explicit sweep, called by the
    /// background task. Returns the count evicted.
    async fn sweep_expired(&self, now: SystemTime) -> Result<usize, DedupTableError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DedupTableError {
    /// Underlying SQLCipher I/O failure (disk full, permission drift).
    StoreIoError,
    /// Clock skew — `expires_at <= now` at insert time (impossible under
    /// correct NTS clock; fail-closed).
    InvalidExpiry,
    /// Capacity bound exceeded — Sprint 6.4 sets a hard cap (e.g. 1M live
    /// entries) to defend against jti-flood exhaustion.
    CapacityExceeded,
}

impl std::fmt::Display for DedupTableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StoreIoError => f.write_str("store_io_error"),
            Self::InvalidExpiry => f.write_str("invalid_expiry"),
            Self::CapacityExceeded => f.write_str("capacity_exceeded"),
        }
    }
}

impl std::error::Error for DedupTableError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    /// WHY: Validated ctor accepts valid jti + rejects empty/oversized/binary.
    #[test]
    fn jti_try_new_accepts_valid() {
        let j = Jti::try_new("cmd-uuid-12345").expect("valid");
        assert_eq!(j.as_str(), "cmd-uuid-12345");
    }

    #[test]
    fn jti_try_new_rejects_empty() {
        let err = Jti::try_new("").expect_err("empty");
        assert_eq!(err, InvalidJti::Empty);
    }

    #[test]
    fn jti_try_new_rejects_oversized() {
        let s = "x".repeat(MAX_JTI_BYTES + 1);
        let err = Jti::try_new(s).expect_err("too long");
        assert_eq!(err, InvalidJti::TooLong(MAX_JTI_BYTES + 1));
    }

    #[test]
    fn jti_try_new_accepts_at_exact_bound() {
        let s = "a".repeat(MAX_JTI_BYTES);
        Jti::try_new(s).expect("at bound must accept");
    }

    #[test]
    fn jti_try_new_rejects_non_ascii_printable() {
        // Null byte
        let err = Jti::try_new("cmd\0uuid").expect_err("null");
        assert_eq!(err, InvalidJti::NonAsciiPrintable);
        // Newline
        let err = Jti::try_new("cmd\nuuid").expect_err("newline");
        assert_eq!(err, InvalidJti::NonAsciiPrintable);
        // Tab
        let err = Jti::try_new("cmd\tuuid").expect_err("tab");
        assert_eq!(err, InvalidJti::NonAsciiPrintable);
        // High-bit byte
        let err = Jti::try_new("cmd\u{00ff}uuid").expect_err("high byte");
        assert_eq!(err, InvalidJti::NonAsciiPrintable);
    }

    #[test]
    fn jti_accepts_common_uuid_and_structured_prefix_forms() {
        // UUIDv4 form
        Jti::try_new("550e8400-e29b-41d4-a716-446655440000").expect("uuidv4");
        // Structured prefix
        Jti::try_new("tenant-42:op-7:550e8400-e29b-41d4-a716-446655440000").expect("structured");
        // Underscore, dot, plus — all ASCII printable
        Jti::try_new("cmd_1.2+3").expect("underscore dot plus");
    }

    /// WHY: serde transparent — Jti serializes as bare string.
    #[test]
    fn jti_serde_transparent() {
        let j = Jti::try_new("abc").expect("ok");
        let json = serde_json::to_string(&j).expect("ok");
        assert_eq!(json, r#""abc""#);
    }

    /// WHY: Display format pinned for InvalidJti.
    #[test]
    fn invalid_jti_display_snake_case() {
        assert_eq!(format!("{}", InvalidJti::Empty), "empty_jti");
        assert_eq!(format!("{}", InvalidJti::TooLong(257)), "jti_too_long:257");
        assert_eq!(
            format!("{}", InvalidJti::NonAsciiPrintable),
            "jti_non_ascii_printable"
        );
    }

    /// WHY: DedupTableError Display format pinned.
    #[test]
    fn dedup_table_error_display_snake_case() {
        assert_eq!(
            format!("{}", DedupTableError::StoreIoError),
            "store_io_error"
        );
        assert_eq!(
            format!("{}", DedupTableError::InvalidExpiry),
            "invalid_expiry"
        );
        assert_eq!(
            format!("{}", DedupTableError::CapacityExceeded),
            "capacity_exceeded"
        );
    }

    /// WHY: Errors implement std::error::Error.
    #[test]
    fn errors_implement_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<InvalidJti>();
        assert_err::<DedupTableError>();
    }

    /// A minimal in-memory `JtiDedupTable` impl — used to verify the
    /// trait signature is sensible AND to exercise the Fresh/Duplicate
    /// semantics in an integration-like way without pulling Moka in.
    struct InMemoryJti {
        inner: Mutex<Vec<(Jti, SystemTime)>>,
    }

    impl InMemoryJti {
        fn new() -> Self {
            Self {
                inner: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl JtiDedupTable for InMemoryJti {
        async fn check_and_mark(
            &self,
            jti: &Jti,
            expires_at: SystemTime,
        ) -> Result<DedupResult, DedupTableError> {
            let now = SystemTime::now();
            if expires_at <= now {
                return Err(DedupTableError::InvalidExpiry);
            }
            let mut guard = self.inner.lock().expect("poison");
            // lazy sweep
            guard.retain(|(_, exp)| *exp > now);
            if guard.iter().any(|(j, _)| j == jti) {
                return Ok(DedupResult::Duplicate);
            }
            guard.push((jti.clone(), expires_at));
            Ok(DedupResult::Fresh)
        }

        async fn live_entry_count(&self) -> Result<usize, DedupTableError> {
            Ok(self.inner.lock().expect("poison").len())
        }

        async fn sweep_expired(&self, now: SystemTime) -> Result<usize, DedupTableError> {
            let mut guard = self.inner.lock().expect("poison");
            let before = guard.len();
            guard.retain(|(_, exp)| *exp > now);
            Ok(before - guard.len())
        }
    }

    /// WHY: Happy path — first check returns Fresh, second returns
    ///      Duplicate. Validates the trait semantics.
    #[tokio::test]
    async fn in_memory_check_and_mark_detects_replay() {
        let table = InMemoryJti::new();
        let jti = Jti::try_new("abc").expect("ok");
        let future = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(
            table.check_and_mark(&jti, future).await.expect("ok"),
            DedupResult::Fresh
        );
        assert_eq!(
            table.check_and_mark(&jti, future).await.expect("ok"),
            DedupResult::Duplicate
        );
    }

    /// WHY: Past expiry rejected — InvalidExpiry.
    #[tokio::test]
    async fn in_memory_check_and_mark_rejects_past_expiry() {
        let table = InMemoryJti::new();
        let jti = Jti::try_new("abc").expect("ok");
        let past = SystemTime::UNIX_EPOCH;
        let err = table.check_and_mark(&jti, past).await.expect_err("past");
        assert_eq!(err, DedupTableError::InvalidExpiry);
    }

    /// WHY: Trait object safety — `Arc<dyn JtiDedupTable>` must work.
    #[test]
    fn jti_dedup_table_is_trait_object_safe() {
        fn assert_object_safe(_: &dyn JtiDedupTable) {}
        let table = InMemoryJti::new();
        assert_object_safe(&table);
    }
}
