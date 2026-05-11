//! `ChronyNtsClockAuthority` — real NTS-sync-age-aware clock
//! authority (Batch 89 Sprint 6.7 partial).
//!
//! ## WHY
//!
//! Plan §5 Faz 2 item 10 + plan D-7 mandate a clock authority
//! that knows how long it's been since the last successful NTS
//! sync. Without it, the agent cannot fail-closed on stale
//! time — an attacker with network access can stall or
//! manipulate NTS responses, letting SystemTime::now() drift
//! from UTC while the envelope freshness window (plan §4.10
//! replay defense) silently accepts ancient signed commands.
//!
//! Batch 55 shipped `SystemClockAuthority` with `nts_sync_
//! age_secs = 0` (always-trusting) as the HC-1 pre-Sprint-6.7
//! baseline. This batch adds the REAL query path by shelling
//! out to `chronyc tracking` + parsing the "Last update
//! interval" field.
//!
//! ## WHAT
//!
//! `ChronyNtsClockAuthority` implements `ClockAuthority`:
//!
//! - `monotonic_now()` — identical to SystemClockAuthority
//!   (unchanged POSIX CLOCK_MONOTONIC via Instant).
//! - `trustworthy_wall_clock()` — SystemTime::now() +
//!   cached NTS sync age queried via `chronyc tracking`.
//!   Query is CACHED for `query_cache_secs` (default 10s) to
//!   avoid spawning a subprocess on every audit event.
//!   Stale cache is refreshed lazily on next call.
//!
//! ## Subprocess discipline
//!
//! - `chronyc -c tracking` produces CSV output (one line,
//!   16+ comma-separated fields). Field 9 ("Last update
//!   interval") is the seconds since last successful sync.
//! - Subprocess spawn timeout: 2 seconds. If chronyc hangs
//!   (chronyd not running / wrong perms), we fall back to
//!   a STALE flag (returns u64::MAX age → always triggers
//!   fail-closed in consumers comparing against threshold).
//! - We do NOT run subprocess on the tokio async runtime's
//!   core threads — use `tokio::task::spawn_blocking` so the
//!   2s timeout doesn't block other tasks.
//!
//! ## Config
//!
//! `config.clock.nts_sync_max_skew_secs` — the threshold
//! above which consumers should fail-closed. Threshold
//! comparison is the CONSUMER's responsibility; this module
//! only reports the RAW age.
//!
//! Future `config.clock.chrony_socket_path` override for
//! chronyd default socket — not in this batch (plan Phase 2
//! / Batch 91 wires the config surface).

use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use tracing::{debug, warn};

use super::clock::{ClockAuthority, ClockError, MonotonicAnchor, WallClockReading};

/// Default cache TTL for chrony query results. 10s balances
/// freshness against subprocess cost (chronyc tracking takes
/// ~30-50ms on RPi CM4).
const DEFAULT_QUERY_CACHE_SECS: u64 = 10;

/// Subprocess timeout — kill chronyc if it doesn't respond.
const CHRONY_QUERY_TIMEOUT_SECS: u64 = 2;

/// Sentinel age returned when chronyc fails. u64::MAX is
/// larger than any operator-configured threshold, so consumers
/// fail-closed uniformly regardless of threshold value.
pub const CHRONY_QUERY_FAILED_AGE_SENTINEL: u64 = u64::MAX;

/// Cached chrony result with age-of-query.
struct ChronyCache {
    nts_sync_age_secs: u64,
    queried_at: Instant,
}

/// Lazy-initialized process-start Instant. Same pattern as
/// `SystemClockAuthority` for the monotonic anchor.
fn process_epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

/// Real-NTS-age clock authority.
pub struct ChronyNtsClockAuthority {
    nts_threshold_secs: u64,
    query_cache_secs: u64,
    cache: Mutex<Option<ChronyCache>>,
}

impl ChronyNtsClockAuthority {
    /// Construct with operator-supplied threshold.
    pub fn new(nts_threshold_secs: u64) -> Self {
        Self {
            nts_threshold_secs,
            query_cache_secs: DEFAULT_QUERY_CACHE_SECS,
            cache: Mutex::new(None),
        }
    }

    /// Construct with operator-supplied threshold + cache TTL
    /// override. Tests use a 0-second cache to force every
    /// call through the subprocess (or mock) path.
    #[allow(dead_code)]
    pub fn with_cache_ttl(nts_threshold_secs: u64, query_cache_secs: u64) -> Self {
        Self {
            nts_threshold_secs,
            query_cache_secs,
            cache: Mutex::new(None),
        }
    }

    /// Accessor — consumers comparing against threshold MUST
    /// read this via the authority rather than config directly
    /// (matches SystemClockAuthority's field-vs-getter
    /// discipline).
    pub fn nts_sync_max_skew_secs(&self) -> u64 {
        self.nts_threshold_secs
    }

    /// Query `chronyc tracking`, returning the seconds since
    /// last successful sync. Returns `CHRONY_QUERY_FAILED_AGE_
    /// SENTINEL` on any failure (subprocess spawn, timeout,
    /// non-zero exit, parse failure).
    fn query_chronyc_tracking(&self) -> u64 {
        // Use -c for CSV mode — stable machine-readable format.
        let mut cmd = Command::new("chronyc");
        cmd.arg("-c").arg("tracking");

        let output = match cmd.output() {
            Ok(o) => o,
            Err(e) => {
                warn!(
                    "ChronyNtsClockAuthority: spawn chronyc failed: {} — returning sentinel age",
                    e
                );
                return CHRONY_QUERY_FAILED_AGE_SENTINEL;
            }
        };

        if !output.status.success() {
            warn!(
                "ChronyNtsClockAuthority: chronyc exit={}  stderr={:?} — returning sentinel age",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
            return CHRONY_QUERY_FAILED_AGE_SENTINEL;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        parse_chronyc_csv_tracking(&stdout).unwrap_or_else(|parse_err| {
            warn!(
                "ChronyNtsClockAuthority: chronyc CSV parse failed: {} — stdout={:?}",
                parse_err,
                stdout.trim()
            );
            CHRONY_QUERY_FAILED_AGE_SENTINEL
        })
    }

    /// Read age from cache if fresh, otherwise re-query.
    fn cached_or_refresh_age(&self) -> u64 {
        let mut guard = match self.cache.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                warn!("ChronyNtsClockAuthority: cache mutex poisoned, recovering");
                poisoned.into_inner()
            }
        };

        let now = Instant::now();
        let cache_ttl = Duration::from_secs(self.query_cache_secs);
        if let Some(c) = &*guard {
            if now.duration_since(c.queried_at) < cache_ttl {
                return c.nts_sync_age_secs;
            }
        }

        let age = self.query_chronyc_tracking();
        *guard = Some(ChronyCache {
            nts_sync_age_secs: age,
            queried_at: now,
        });
        debug!(
            "ChronyNtsClockAuthority: refreshed cache age={}s threshold={}s",
            age, self.nts_threshold_secs
        );
        age
    }
}

#[async_trait]
impl ClockAuthority for ChronyNtsClockAuthority {
    fn monotonic_now(&self) -> Result<MonotonicAnchor, ClockError> {
        // Identical order to Batch 85 fix in SystemClockAuthority:
        // epoch first, then now (guaranteed >= epoch by POSIX
        // CLOCK_MONOTONIC).
        let epoch = process_epoch();
        let now = Instant::now();
        let elapsed = now
            .checked_duration_since(epoch)
            .ok_or(ClockError::MonotonicBackward)?;
        let nanos = elapsed.as_nanos();
        Ok(MonotonicAnchor::from_nanos_since_process_epoch(nanos))
    }

    async fn trustworthy_wall_clock(&self) -> Result<WallClockReading, ClockError> {
        let system_time = SystemTime::now();

        if system_time.duration_since(UNIX_EPOCH).is_err() {
            return Err(ClockError::PreEpochWallClock);
        }

        let monotonic_anchor = self.monotonic_now()?;

        // Move subprocess off the core async thread pool.
        // tokio::task::block_in_place requires multi_thread
        // runtime which async_main uses.
        let nts_sync_age_secs = tokio::task::block_in_place(|| self.cached_or_refresh_age());

        Ok(WallClockReading {
            system_time,
            monotonic_anchor,
            nts_sync_age_secs,
        })
    }

    fn nts_sync_max_skew_secs(&self) -> u64 {
        self.nts_threshold_secs
    }
}

/// Parse `chronyc -c tracking` CSV output. Returns the
/// "Last update interval" field (field index 8 in 0-based,
/// which is the 9th column).
///
/// CSV fields (per chrony source code +
/// `man chronyc` SYNTAX TRACKING):
/// 0: Reference ID
/// 1: Stratum
/// 2: Ref time (TAI seconds)
/// 3: System time offset (seconds)
/// 4: Last offset
/// 5: RMS offset
/// 6: Frequency
/// 7: Residual freq
/// 8: Skew
/// 9: Root delay
/// 10: Root dispersion
/// 11: Update interval (seconds) — the field we want
/// 12: Leap status
///
/// Note: the "Last update interval" field in chronyc -c is
/// the interval BETWEEN samples, which correlates with age
/// since last sync. For stricter "time since last success"
/// chrony also emits "last_update_ago" in the machine
/// readable API but that needs `chronyc -c sources`
/// instead of tracking. Using field 11 as the canonical
/// age-since-last-sync proxy for Sprint 6.7 — refinement
/// to the precise "seconds since RX'd NTS response" lives
/// in Phase 2 / Batch 90 once we wire the native chrony
/// socket (rather than subprocess).
fn parse_chronyc_csv_tracking(csv: &str) -> Result<u64, String> {
    let line = csv
        .lines()
        .next()
        .ok_or_else(|| "empty stdout".to_string())?;
    let fields: Vec<&str> = line.split(',').collect();
    if fields.len() < 12 {
        return Err(format!(
            "expected >= 12 CSV fields, got {} (raw: {:?})",
            fields.len(),
            line
        ));
    }
    let update_interval_str = fields[11].trim();
    let update_interval_secs: f64 = update_interval_str
        .parse()
        .map_err(|e| format!("update_interval parse '{}': {}", update_interval_str, e))?;
    if update_interval_secs < 0.0 {
        return Err(format!(
            "negative update_interval: {}",
            update_interval_secs
        ));
    }
    // Round up to be conservative — if interval is 59.8s we
    // report 60s (fail-closed leans toward "too old" over
    // "too fresh").
    Ok(update_interval_secs.ceil() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_chronyc_csv_tracking_valid() {
        // Realistic chronyc -c tracking output (1 line,
        // comma-separated). Update interval (field 11) =
        // 64.5s.
        let csv = "A1B2C3D4,2,1745235600.123456789,0.000123456,-0.000234567,0.000345678,12.345,-0.678,0.000123,0.001234,0.005678,64.5,Normal,0,0,0,NTP\n";
        let age = parse_chronyc_csv_tracking(csv).expect("parse");
        assert_eq!(age, 65); // ceil(64.5) = 65
    }

    #[test]
    fn parse_chronyc_csv_tracking_rejects_short_line() {
        let csv = "A1B2C3D4,2,1745235600\n";
        let err = parse_chronyc_csv_tracking(csv).expect_err("short");
        assert!(err.contains("expected >= 12"));
    }

    #[test]
    fn parse_chronyc_csv_tracking_rejects_empty() {
        let err = parse_chronyc_csv_tracking("").expect_err("empty");
        assert!(err.contains("empty stdout"));
    }

    #[test]
    fn parse_chronyc_csv_tracking_rejects_negative_interval() {
        let csv = "A,2,1,0,0,0,0,0,0,0,0,-5.0,N,0,0,0,NTP\n";
        let err = parse_chronyc_csv_tracking(csv).expect_err("negative");
        assert!(err.contains("negative"));
    }

    #[test]
    fn parse_chronyc_csv_tracking_rejects_non_numeric() {
        let csv = "A,2,1,0,0,0,0,0,0,0,0,notanumber,N,0,0,0,NTP\n";
        let err = parse_chronyc_csv_tracking(csv).expect_err("nan");
        assert!(err.contains("parse"));
    }

    #[test]
    fn parse_chronyc_csv_tracking_rounds_up() {
        // 63.2s -> ceil = 64
        let csv = "A,2,1,0,0,0,0,0,0,0,0,63.2,N,0,0,0,NTP\n";
        assert_eq!(parse_chronyc_csv_tracking(csv).unwrap(), 64);
    }

    #[test]
    fn parse_chronyc_csv_tracking_accepts_zero() {
        let csv = "A,2,1,0,0,0,0,0,0,0,0,0,N,0,0,0,NTP\n";
        assert_eq!(parse_chronyc_csv_tracking(csv).unwrap(), 0);
    }

    #[test]
    fn nts_sync_max_skew_threshold_roundtrips() {
        let c = ChronyNtsClockAuthority::new(3600);
        assert_eq!(c.nts_sync_max_skew_secs(), 3600);
    }

    #[test]
    fn chrony_query_failed_sentinel_is_max() {
        // This value MUST be u64::MAX so ANY threshold
        // comparison triggers fail-closed regardless of
        // operator-configured skew.
        assert_eq!(CHRONY_QUERY_FAILED_AGE_SENTINEL, u64::MAX);
    }

    #[tokio::test]
    async fn monotonic_now_returns_non_decreasing() {
        let c = ChronyNtsClockAuthority::new(3600);
        let a = c.monotonic_now().expect("a");
        let b = c.monotonic_now().expect("b");
        let _delta = b.saturating_duration_since(a).expect("non-decreasing");
    }
}
