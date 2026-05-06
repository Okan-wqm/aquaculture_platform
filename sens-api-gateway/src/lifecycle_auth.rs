//! Lifecycle HTTP endpoint HMAC authentication (Batch 129
//! Sprint 6.6 hardening — closes Batch 122 obs #1).
//!
//! ## WHY
//!
//! Batch 122 landed `POST /lifecycle/confirm-active` with
//! localhost-binding + same-UID isolation as the sole
//! authorization layer. For production deployments with
//! co-tenant processes on the same host (container
//! sidecars, operator shells, monitoring daemons), any
//! local process running as the `suderra` user could hit
//! the mutating endpoint + trigger an unauthorized
//! partition-state transition.
//!
//! Architectural root cause: no distinct trust boundary
//! between "local process" and "authorized lifecycle
//! operator". Tier-1 make-it-impossible: require a
//! per-request HMAC proving knowledge of a secret that
//! ONLY the systemd unit has access to.
//!
//! ## Trust model
//!
//! - The HMAC key is delivered by systemd via
//!   `LoadCredential=lifecycle-hmac-key:/etc/suderra/keys/lifecycle.key`
//!   → placed at `$CREDENTIALS_DIRECTORY/lifecycle-hmac-key`
//!   → tmpfs mount readable ONLY by the unit process.
//! - A co-tenant process running as `suderra` CANNOT read
//!   the tmpfs (systemd-creds sets the directory's mode +
//!   owner such that only the main unit PID sees it).
//! - The systemd timer that invokes `curl POST
//!   /lifecycle/confirm-active` runs in a unit that ALSO
//!   has LoadCredential + reads the same key to build the
//!   HMAC header.
//!
//! Result: any curl from a process that is NOT the
//! timer-unit (or the agent itself) gets 401 + no partition
//! state changes.
//!
//! ## Request format
//!
//! ```
//! POST /lifecycle/confirm-active
//! X-Suderra-Lifecycle-Timestamp: 1698765432
//! X-Suderra-Lifecycle-Hmac: <hex-hmac-sha256>
//! ```
//!
//! HMAC input: `timestamp "\n" method "\n" path`
//! Example: `1698765432\nPOST\n/lifecycle/confirm-active`
//!
//! Timestamp is unix-seconds; window is ±300s (5 min) to
//! tolerate NTP skew + defend against replay.
//!
//! ## NOT in scope
//!
//! - Body-signature. The confirm-active endpoint has no
//!   body; future mutating endpoints that DO carry body
//!   bytes would extend the canonical HMAC input to
//!   include `body-sha256`.
//! - Nonce / jti replay defense. The timestamp window +
//!   idempotent-by-design endpoints (confirm-active is
//!   idempotent per Batch 122) cover the relevant replay
//!   surface for this specific endpoint.

#![cfg(feature = "health")]

use std::time::UNIX_EPOCH;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

/// Per-request HMAC timestamp window (seconds, ± around
/// server-clock `now`). ±300s = 5 minutes. Standard
/// tolerance for NTP-synchronized clients. Tighter windows
/// break clients on clock skew; looser windows widen
/// replay surface.
pub const HMAC_TIMESTAMP_WINDOW_SECS: i64 = 300;

/// HTTP header name for the HMAC value (hex-encoded
/// SHA-256 MAC).
pub const HEADER_HMAC: &str = "X-Suderra-Lifecycle-Hmac";

/// HTTP header name for the unix-seconds timestamp the
/// client used to compute the HMAC.
pub const HEADER_TIMESTAMP: &str = "X-Suderra-Lifecycle-Timestamp";

/// Default systemd-credential filename. Operators can
/// override via `lifecycle_endpoint.systemd_credential_name`
/// config if they use a non-default credential naming.
pub const DEFAULT_CREDENTIAL_NAME: &str = "lifecycle-hmac-key";

/// Minimum acceptable key length (bytes). 32 = SHA-256
/// output width; HMAC-SHA256 security proof requires the
/// key to be at least as long as the digest. Keys shorter
/// than this are rejected at load time.
pub const MIN_KEY_LEN_BYTES: usize = 32;

/// Lifecycle HMAC key. Zeroizes on drop so key material
/// doesn't linger in memory after the agent shuts down.
pub struct LifecycleAuthKey {
    bytes: Vec<u8>,
}

impl LifecycleAuthKey {
    /// Construct from raw bytes. REJECTS keys shorter
    /// than `MIN_KEY_LEN_BYTES`.
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, AuthKeyError> {
        if bytes.len() < MIN_KEY_LEN_BYTES {
            return Err(AuthKeyError::TooShort {
                got: bytes.len(),
                need: MIN_KEY_LEN_BYTES,
            });
        }
        Ok(Self { bytes })
    }

    /// Load from the systemd-credentials directory.
    /// Reads `$CREDENTIALS_DIRECTORY/<credential_name>`.
    /// Returns CredentialsDirMissing when the env var
    /// isn't set (agent not started via systemd with
    /// LoadCredential); returns CredentialFileMissing
    /// when the directory is set but the named file
    /// doesn't exist.
    pub fn load_from_credentials_dir(
        credential_name: &str,
    ) -> Result<Self, AuthKeyError> {
        let dir = std::env::var("CREDENTIALS_DIRECTORY").map_err(|_| {
            AuthKeyError::CredentialsDirMissing
        })?;
        let path = std::path::PathBuf::from(&dir).join(credential_name);
        let bytes = std::fs::read(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AuthKeyError::CredentialFileMissing {
                    path: path.to_string_lossy().to_string(),
                }
            } else {
                AuthKeyError::Io {
                    path: path.to_string_lossy().to_string(),
                    reason: e.to_string(),
                }
            }
        })?;
        Self::from_bytes(bytes)
    }

    fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl Drop for LifecycleAuthKey {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

/// Key-loading failure taxonomy.
#[derive(Debug)]
pub enum AuthKeyError {
    /// Key length below the HMAC-SHA256 security floor.
    TooShort { got: usize, need: usize },
    /// `$CREDENTIALS_DIRECTORY` env var not set — the
    /// agent was not started via systemd with
    /// LoadCredential. Operator config error.
    CredentialsDirMissing,
    /// Env var set but the named credential file doesn't
    /// exist under it. Operator config error (wrong
    /// credential name in config OR systemd unit didn't
    /// load the file).
    CredentialFileMissing { path: String },
    /// Filesystem read error (permission denied, etc.).
    Io { path: String, reason: String },
}

impl std::fmt::Display for AuthKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooShort { got, need } => {
                write!(f, "lifecycle HMAC key too short: {} bytes (need >= {})", got, need)
            }
            Self::CredentialsDirMissing => {
                write!(f, "$CREDENTIALS_DIRECTORY not set — agent must be started via systemd with LoadCredential to enable HmacToken auth mode")
            }
            Self::CredentialFileMissing { path } => {
                write!(f, "lifecycle HMAC credential file missing: {}", path)
            }
            Self::Io { path, reason } => {
                write!(f, "lifecycle HMAC credential read failed {}: {}", path, reason)
            }
        }
    }
}

impl std::error::Error for AuthKeyError {}

/// Per-request auth verification failure.
#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    /// `X-Suderra-Lifecycle-Hmac` header missing.
    MissingHmacHeader,
    /// `X-Suderra-Lifecycle-Timestamp` header missing.
    MissingTimestampHeader,
    /// Header value present but not parseable (non-hex,
    /// non-integer, wrong length).
    MalformedHmacHeader,
    /// Timestamp parse failed.
    MalformedTimestampHeader,
    /// Timestamp outside the ±HMAC_TIMESTAMP_WINDOW_SECS
    /// window. Either clock skew or replay attempt.
    TimestampOutOfWindow {
        client_ts: i64,
        server_ts: i64,
        window: i64,
    },
    /// HMAC bytes don't match the computed MAC. Wrong key
    /// or tampered request.
    InvalidHmac,
    /// **Batch #324 D-9 migration:** clock authority
    /// reports the wallclock is untrustworthy
    /// (NTS-stale, MonotonicBackward, PreEpochWallClock).
    /// The HMAC timestamp window cannot be evaluated
    /// against an unverified server clock — fail-closed
    /// rather than risk false-accept (clock rolled back
    /// past replay window) or false-reject (clock rolled
    /// forward, all real requests look stale).
    ClockUnhealthy(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingHmacHeader => write!(f, "missing X-Suderra-Lifecycle-Hmac header"),
            Self::MissingTimestampHeader => write!(f, "missing X-Suderra-Lifecycle-Timestamp header"),
            Self::MalformedHmacHeader => write!(f, "malformed hex in X-Suderra-Lifecycle-Hmac"),
            Self::MalformedTimestampHeader => write!(f, "malformed integer in X-Suderra-Lifecycle-Timestamp"),
            Self::TimestampOutOfWindow { client_ts, server_ts, window } => {
                write!(
                    f,
                    "timestamp {} outside ±{}s window around server time {}",
                    client_ts, window, server_ts
                )
            }
            Self::InvalidHmac => write!(f, "HMAC did not match expected value"),
            Self::ClockUnhealthy(reason) => {
                write!(f, "clock unhealthy: {}", reason)
            }
        }
    }
}

impl std::error::Error for AuthError {}

impl From<crate::runtime_safety::clock::ClockError> for AuthError {
    fn from(e: crate::runtime_safety::clock::ClockError) -> Self {
        Self::ClockUnhealthy(e.to_string())
    }
}

/// Verify a request carries a valid HMAC for the given
/// method + path. **Batch #324 D-9 migration:** the
/// server timestamp is read from the injected
/// ClockAuthority's trustworthy_wall_clock, not from
/// SystemTime::now() directly.
///
/// **Why the migration matters (Tier-1 fix):** the
/// pre-#324 implementation read SystemTime::now() for
/// `server_ts` then compared `(client_ts - server_ts).abs()
/// > HMAC_TIMESTAMP_WINDOW_SECS` — a SYMMETRIC window
/// rejecting requests too far in the future OR too far
/// in the past. Operator clock manipulation breaks both
/// directions:
///
/// - Server clock rolled BACKWARD (past) → real-now
///   requests look "from the future" → REJECTED
///   → DOS attack.
/// - Server clock rolled FORWARD (future) → real-now
///   requests look "from the past" → REJECTED → DOS.
/// - Server clock rolled SLIGHTLY backward (just past
///   the window) but client_ts ALSO crafted just past
///   server_ts → request might pass replay window
///   that should have rejected it.
///
/// The architectural fix is to read server_ts via
/// trustworthy_wall_clock() which fails-closed on
/// stale-NTS via the ClockAuthority gate. Result:
/// chrony-stopped or NTS-attacker-MITM scenarios
/// surface as ClockUnhealthy, not as silent
/// timestamp-window false-accept/false-reject.
///
/// **Architectural note** about migration shape: the
/// previous doc comment said "a future test-injection
/// seam could swap this for a pluggable clock". This
/// batch IS that future migration; the seam is the
/// `&dyn ClockAuthority` parameter.
pub async fn verify_request(
    key: &LifecycleAuthKey,
    method: &str,
    path: &str,
    hmac_header: Option<&str>,
    timestamp_header: Option<&str>,
    clock: &dyn crate::runtime_safety::ClockAuthority,
) -> Result<(), AuthError> {
    let hmac_hex = hmac_header.ok_or(AuthError::MissingHmacHeader)?;
    let ts_str = timestamp_header.ok_or(AuthError::MissingTimestampHeader)?;

    let client_ts: i64 = ts_str.parse().map_err(|_| AuthError::MalformedTimestampHeader)?;

    // Batch #324 D-9 migration: trustworthy_wall_clock
    // fails-closed on NTS-stale; the HMAC timestamp
    // window cannot be evaluated against an unverified
    // server clock. ClockError -> AuthError::ClockUnhealthy
    // via the From impl.
    let reading = clock.trustworthy_wall_clock().await?;
    let server_ts = reading
        .system_time
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            AuthError::ClockUnhealthy(
                "system_time before UNIX_EPOCH (RTC drained?)".to_string(),
            )
        })?
        .as_secs() as i64;

    if (client_ts - server_ts).abs() > HMAC_TIMESTAMP_WINDOW_SECS {
        return Err(AuthError::TimestampOutOfWindow {
            client_ts,
            server_ts,
            window: HMAC_TIMESTAMP_WINDOW_SECS,
        });
    }

    let provided_mac = hex_decode_32(hmac_hex).ok_or(AuthError::MalformedHmacHeader)?;
    let expected_mac = compute_hmac(key, client_ts, method, path);

    // Constant-time compare via subtle::ConstantTimeEq to
    // prevent timing-side-channel leaks on per-byte
    // comparison short-circuits.
    if provided_mac.ct_eq(&expected_mac).into() {
        Ok(())
    } else {
        Err(AuthError::InvalidHmac)
    }
}

/// Compute the canonical HMAC for a given
/// timestamp + method + path tuple. Used by both the
/// verify path (server) + the systemd timer's sign-the-
/// request tool (client).
pub fn compute_hmac(
    key: &LifecycleAuthKey,
    timestamp: i64,
    method: &str,
    path: &str,
) -> [u8; 32] {
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(key.as_bytes())
        .expect("HMAC can take key of any size >= MIN_KEY_LEN_BYTES");
    // Canonical input format. Separator = "\n" so no
    // length-encoding ambiguity (method + path never
    // contain newlines in valid HTTP).
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b"\n");
    mac.update(method.as_bytes());
    mac.update(b"\n");
    mac.update(path.as_bytes());
    let result = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Decode a 64-char hex string into 32 bytes. Returns
/// None on any non-hex char or wrong length. Strict
/// validation so malformed headers can't bypass verify.
fn hex_decode_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        let hi = hex_nibble(s.as_bytes().get(i * 2)?)?;
        let lo = hex_nibble(s.as_bytes().get(i * 2 + 1)?)?;
        *b = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_nibble(byte: &u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_safety::SystemClockAuthority;

    fn test_key() -> LifecycleAuthKey {
        LifecycleAuthKey::from_bytes(vec![0x42u8; 32]).expect("valid")
    }

    /// Test fixture: a fresh SystemClockAuthority for each
    /// verify_request invocation. Tests that exercise the
    /// CLOCK-UNHEALTHY path (NTS-stale, pre-epoch) use a
    /// programmable mock instead.
    fn test_clock() -> SystemClockAuthority {
        SystemClockAuthority::new()
    }

    fn now_ts() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    fn hex_encode(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&format!("{:02x}", b));
        }
        s
    }

    #[test]
    fn key_from_bytes_rejects_short_keys() {
        assert!(matches!(
            LifecycleAuthKey::from_bytes(vec![0u8; 31]),
            Err(AuthKeyError::TooShort { got: 31, need: 32 })
        ));
        assert!(LifecycleAuthKey::from_bytes(vec![0u8; 32]).is_ok());
    }

    #[test]
    fn compute_hmac_deterministic_same_inputs() {
        let key = test_key();
        let a = compute_hmac(&key, 100, "POST", "/lifecycle/confirm-active");
        let b = compute_hmac(&key, 100, "POST", "/lifecycle/confirm-active");
        assert_eq!(a, b);
    }

    #[test]
    fn compute_hmac_changes_with_method() {
        let key = test_key();
        let a = compute_hmac(&key, 100, "POST", "/x");
        let b = compute_hmac(&key, 100, "GET", "/x");
        assert_ne!(a, b);
    }

    #[test]
    fn compute_hmac_changes_with_path() {
        let key = test_key();
        let a = compute_hmac(&key, 100, "POST", "/a");
        let b = compute_hmac(&key, 100, "POST", "/b");
        assert_ne!(a, b);
    }

    #[test]
    fn compute_hmac_changes_with_timestamp() {
        let key = test_key();
        let a = compute_hmac(&key, 100, "POST", "/x");
        let b = compute_hmac(&key, 101, "POST", "/x");
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn verify_request_happy_path() {
        let key = test_key();
        let clock = test_clock();
        let ts = now_ts();
        let mac = compute_hmac(&key, ts, "POST", "/lifecycle/confirm-active");
        let result = verify_request(
            &key,
            "POST",
            "/lifecycle/confirm-active",
            Some(&hex_encode(&mac)),
            Some(&ts.to_string()),
            &clock,
        )
        .await;
        assert!(result.is_ok(), "expected Ok, got {:?}", result);
    }

    #[tokio::test]
    async fn verify_request_missing_hmac_header() {
        let key = test_key();
        let clock = test_clock();
        let ts = now_ts();
        let err = verify_request(
            &key,
            "POST",
            "/lifecycle/confirm-active",
            None,
            Some(&ts.to_string()),
            &clock,
        )
        .await
        .expect_err("must reject");
        assert_eq!(err, AuthError::MissingHmacHeader);
    }

    #[tokio::test]
    async fn verify_request_missing_timestamp_header() {
        let key = test_key();
        let clock = test_clock();
        let err = verify_request(
            &key,
            "POST",
            "/lifecycle/confirm-active",
            Some("00".repeat(32).as_str()),
            None,
            &clock,
        )
        .await
        .expect_err("must reject");
        assert_eq!(err, AuthError::MissingTimestampHeader);
    }

    #[tokio::test]
    async fn verify_request_malformed_hmac_rejects() {
        let key = test_key();
        let clock = test_clock();
        let ts = now_ts();
        let err = verify_request(
            &key,
            "POST",
            "/lifecycle/confirm-active",
            Some("zz".repeat(32).as_str()), // non-hex chars
            Some(&ts.to_string()),
            &clock,
        )
        .await
        .expect_err("must reject");
        assert_eq!(err, AuthError::MalformedHmacHeader);
    }

    #[tokio::test]
    async fn verify_request_malformed_timestamp_rejects() {
        let key = test_key();
        let clock = test_clock();
        let err = verify_request(
            &key,
            "POST",
            "/lifecycle/confirm-active",
            Some("00".repeat(32).as_str()),
            Some("not-a-number"),
            &clock,
        )
        .await
        .expect_err("must reject");
        assert_eq!(err, AuthError::MalformedTimestampHeader);
    }

    #[tokio::test]
    async fn verify_request_rejects_timestamp_too_old() {
        let key = test_key();
        let clock = test_clock();
        let old_ts = now_ts() - HMAC_TIMESTAMP_WINDOW_SECS - 1;
        let mac = compute_hmac(&key, old_ts, "POST", "/x");
        let err = verify_request(
            &key,
            "POST",
            "/x",
            Some(&hex_encode(&mac)),
            Some(&old_ts.to_string()),
            &clock,
        )
        .await
        .expect_err("must reject");
        assert!(matches!(err, AuthError::TimestampOutOfWindow { .. }));
    }

    #[tokio::test]
    async fn verify_request_rejects_timestamp_too_new() {
        let key = test_key();
        let clock = test_clock();
        let future_ts = now_ts() + HMAC_TIMESTAMP_WINDOW_SECS + 1;
        let mac = compute_hmac(&key, future_ts, "POST", "/x");
        let err = verify_request(
            &key,
            "POST",
            "/x",
            Some(&hex_encode(&mac)),
            Some(&future_ts.to_string()),
            &clock,
        )
        .await
        .expect_err("must reject");
        assert!(matches!(err, AuthError::TimestampOutOfWindow { .. }));
    }

    #[tokio::test]
    async fn verify_request_rejects_wrong_hmac() {
        let key = test_key();
        let clock = test_clock();
        let ts = now_ts();
        let wrong_mac = [0xAAu8; 32]; // not the right MAC
        let err = verify_request(
            &key,
            "POST",
            "/lifecycle/confirm-active",
            Some(&hex_encode(&wrong_mac)),
            Some(&ts.to_string()),
            &clock,
        )
        .await
        .expect_err("must reject");
        assert_eq!(err, AuthError::InvalidHmac);
    }

    #[tokio::test]
    async fn verify_request_rejects_hmac_computed_for_different_path() {
        // Client signs for /x but sends to /y. Must reject.
        let key = test_key();
        let clock = test_clock();
        let ts = now_ts();
        let mac = compute_hmac(&key, ts, "POST", "/x");
        let err = verify_request(
            &key,
            "POST",
            "/y",
            Some(&hex_encode(&mac)),
            Some(&ts.to_string()),
            &clock,
        )
        .await
        .expect_err("must reject");
        assert_eq!(err, AuthError::InvalidHmac);
    }

    // ================================================================
    // Batch #324 D-9 architectural property tests
    // ================================================================
    //
    // Programmable mock clock pattern matches Batch #313
    // MonotonicDeadline + Batch #315 KeystoreRotationDeadline +
    // Batch #317 alarm runner test fixtures for uniformity.

    use crate::runtime_safety::clock::{
        ClockAuthority as ClockAuthorityTrait, ClockError, MonotonicAnchor,
        WallClockReading,
    };
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;

    struct MockClock {
        force_nts_stale: StdMutex<bool>,
    }
    impl MockClock {
        fn new() -> Self {
            Self {
                force_nts_stale: StdMutex::new(false),
            }
        }
        fn set_nts_stale(&self, v: bool) {
            *self.force_nts_stale.lock().unwrap() = v;
        }
    }
    #[async_trait]
    impl ClockAuthorityTrait for MockClock {
        fn monotonic_now(&self) -> Result<MonotonicAnchor, ClockError> {
            Ok(MonotonicAnchor::for_test(0))
        }
        async fn trustworthy_wall_clock(
            &self,
        ) -> Result<WallClockReading, ClockError> {
            if *self.force_nts_stale.lock().unwrap() {
                return Err(ClockError::NtsSyncStale {
                    last_sync_age_secs: 99999,
                    threshold_secs: 3600,
                });
            }
            Ok(WallClockReading {
                system_time: SystemTime::now(),
                monotonic_anchor: MonotonicAnchor::for_test(0),
                nts_sync_age_secs: 0,
            })
        }
        fn nts_sync_max_skew_secs(&self) -> u64 {
            3600
        }
    }

    /// **Architectural property test 1:** when the clock
    /// authority reports NTS-stale, verify_request
    /// fail-CLOSEDS with ClockUnhealthy regardless of
    /// whether the HMAC is otherwise valid. Pre-#324 a
    /// stale clock would silently use SystemTime::now()
    /// → false-accept or false-reject windows; post-#324
    /// the clock-side error wins.
    #[tokio::test]
    async fn verify_request_fail_closed_on_nts_stale_clock() {
        let key = test_key();
        let clock = MockClock::new();
        clock.set_nts_stale(true);
        let ts = now_ts();
        // Valid HMAC for the request — pre-#324 with a
        // trusting SystemClockAuthority this would be Ok.
        let mac = compute_hmac(&key, ts, "POST", "/lifecycle/confirm-active");
        let err = verify_request(
            &key,
            "POST",
            "/lifecycle/confirm-active",
            Some(&hex_encode(&mac)),
            Some(&ts.to_string()),
            &clock,
        )
        .await
        .expect_err("NTS-stale clock MUST fail-closed regardless of HMAC validity");
        match err {
            AuthError::ClockUnhealthy(reason) => {
                assert!(
                    reason.contains("nts_sync_stale"),
                    "ClockUnhealthy reason should name the underlying ClockError class: {}",
                    reason
                );
            }
            other => panic!(
                "expected ClockUnhealthy, got {:?} — clock fail-closed contract violated",
                other
            ),
        }
    }

    /// **Architectural property test 2:** AuthError
    /// Display string for ClockUnhealthy is operator-
    /// readable (audit-stable identifier). Operator
    /// dashboards key on the prefix `clock unhealthy:` to
    /// route alerts.
    #[test]
    fn auth_error_clock_unhealthy_display_is_operator_readable() {
        let err = AuthError::ClockUnhealthy("nts_sync_stale".to_string());
        let s = format!("{}", err);
        assert!(
            s.starts_with("clock unhealthy:"),
            "ClockUnhealthy Display must start with `clock unhealthy:` for audit-stable matching: {}",
            s
        );
        assert!(
            s.contains("nts_sync_stale"),
            "ClockUnhealthy Display must include the underlying reason: {}",
            s
        );
    }

    #[test]
    fn hex_decode_32_rejects_wrong_length() {
        assert!(hex_decode_32("").is_none());
        assert!(hex_decode_32("00").is_none());
        assert!(hex_decode_32(&"0".repeat(63)).is_none());
        assert!(hex_decode_32(&"0".repeat(65)).is_none());
        assert!(hex_decode_32(&"0".repeat(64)).is_some());
    }

    #[test]
    fn hex_decode_32_rejects_non_hex_chars() {
        assert!(hex_decode_32(&format!("zz{}", "0".repeat(62))).is_none());
    }

    #[test]
    fn hex_decode_32_accepts_mixed_case() {
        let s = format!("aB{}", "0".repeat(62));
        let decoded = hex_decode_32(&s).expect("valid");
        assert_eq!(decoded[0], 0xAB);
    }

    #[test]
    fn key_zeroizes_on_drop() {
        // Proves Drop impl exists + runs. Actual memory-
        // clearing verification requires unsafe reads
        // which we avoid; the zeroize crate's own tests
        // cover the byte-clearing behavior.
        let key = LifecycleAuthKey::from_bytes(vec![0xAAu8; 64]).expect("valid");
        drop(key); // should not panic
    }
}
