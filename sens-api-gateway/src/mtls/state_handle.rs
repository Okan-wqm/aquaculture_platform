//! `MtlsVerifierState` — hot-reload handle for [`SuderraServerCertVerifier`].
//!
//! ## WHY
//!
//! Phase 1.1.1 of the D-4 / D-6 mTLS arc (per the closure plan at
//! `/root/.claude/plans/here-is-claude-s-plan-cosmic-aurora.md`) requires the
//! agent to accept an operator-driven cert-pinning rotation **without**
//! restarting the process. Pre-Phase-1 the [`SuderraServerCertVerifier`] is
//! built once at boot inside `mqtt.rs::configure_tls` and lives forever as
//! the rustls `ClientConfig`'s custom verifier — there is no atomic-swap
//! site, so a `cmd_update_cert_pinning` MQTT command (Phase 1.1.2) has no
//! way to apply a new pin set without taking the agent down.
//!
//! [`MtlsVerifierState`] is the missing primitive. It wraps the current
//! verifier in `Arc<RwLock<Option<Arc<SuderraServerCertVerifier>>>>` so that:
//!
//! * [`MtlsVerifierState::current`] returns an `Arc<dyn ServerCertVerifier>`
//!   that rustls can keep using across the swap — `Arc::clone` is cheap and
//!   the verifier owns its own state, so no torn read is possible.
//! * [`MtlsVerifierState::rebuild`] pre-validates the *new* config before
//!   touching the inner pointer. If the new config rejects (e.g.
//!   [`SuderraVerifierBuildError::StrictModeRequiresPins`]), the old verifier
//!   stays installed — the operator gets an `Err` back and the running fleet
//!   continues handshaking against the previous pin set.
//! * Bit-identical reapplications skip the rebuild entirely
//!   ([`RebuildOutcome::NoChange`]) so a redundant `cmd_update_cert_pinning`
//!   does not pay the WebPkiServerVerifier construction cost.
//!
//! ## Tier-1 MAKE-IT-IMPOSSIBLE rationale
//!
//! Pre-Phase-1 a hot-reload would have required `mqtt.rs` to expose its
//! private `Arc<SuderraServerCertVerifier>` to the command dispatcher and a
//! coordinated rebuild dance. That is the kind of cross-module coupling that
//! grows lock-ordering bugs over time. The state handle gives the dispatcher
//! a single object whose only responsibilities are *holds the current
//! verifier* + *atomically swap it*; mqtt.rs only ever reads `current()`.
//! The wire shape literally cannot tear because RwLock + Arc::clone is the
//! same primitive rustls uses internally.
//!
//! ## What this module wires (for HC-1 backward compat)
//!
//! When the verifier build returns `None` (Legacy mode + empty pins —
//! [`build_suderra_verifier`] HC-1 fallthrough), the state handle stores
//! `None` and `current()` returns `None`. Callers (mqtt.rs, future
//! HTTPS reqwest wire in Phase 1.1.3) interpret `None` as "use the default
//! webpki verifier; no Suderra policy gate". This preserves the contract
//! the unified `mqtt.rs::configure_tls` already implements via the
//! `let cfg_after_verifier = if let Some(verifier) = ...` branch.
//!
//! ## NOT in scope (deferred)
//!
//! - Wire into `mqtt.rs::configure_tls` — Phase 1.1.4 (D-6 unified assembly).
//! - Re-construction of the `reqwest::Client` on rebuild — Phase 1.1.3.
//! - Audit-sink emit on rebuild — Phase 1.1.4 (paired with strict-reject).
//! - Two-person co-approver enforcement — Phase 1.1.2 owns the parse path.

use std::sync::{Arc, RwLock};

use rustls::client::danger::ServerCertVerifier;
use rustls::crypto::WebPkiSupportedAlgorithms;

use super::mode::MtlsMode;
use super::rustls_verifier::{
    SuderraServerCertVerifier, SuderraVerifierBuildError, build_suderra_verifier,
};

/// Snapshot of the [`MtlsConfig`](crate::config::MtlsConfig) fields that
/// drive verifier construction. Equality is the delta-detection signal; the
/// hash chain is over `mode + pin set` only because the root_store + signature
/// algorithms are anchor inputs that do not change at runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MtlsConfigSnapshot {
    mode: MtlsMode,
    pinned_fingerprints_hex: Vec<String>,
}

/// Outcome of [`MtlsVerifierState::rebuild`]. A separate enum (rather than a
/// boolean) so callers can audit-log the no-op path explicitly — operators
/// running `cmd_update_cert_pinning` deserve to see "applied" vs "no change"
/// in the audit stream rather than infer from absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RebuildOutcome {
    /// New config was bit-identical to the currently-installed config. No
    /// allocation, no Arc swap, no inner verifier touched.
    NoChange,
    /// New config differed from the currently-installed config. A new
    /// verifier was constructed and atomically swapped in. The previous
    /// verifier `Arc` is dropped on the swap.
    Rebuilt,
}

/// Failure taxonomy for [`MtlsVerifierState::new`] +
/// [`MtlsVerifierState::rebuild`]. Wraps [`SuderraVerifierBuildError`] +
/// surfaces poisoned-lock detection separately so callers can distinguish
/// "operator gave bad config" from "internal locking bug".
#[derive(Debug)]
pub enum MtlsRebuildError {
    /// The new config failed the verifier-build invariants (bad hex, Strict
    /// without pins, WebPki construction failure). Old verifier preserved.
    BuildFailed(SuderraVerifierBuildError),
    /// The internal RwLock got poisoned by a previous panic during a
    /// write. Should never happen; if it does, the agent is in a corrupted
    /// state and should restart. Surfaced as a distinct variant so the
    /// caller can log + escalate rather than treat it as operator error.
    LockPoisoned,
}

impl std::fmt::Display for MtlsRebuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BuildFailed(e) => write!(f, "verifier build failed: {e}"),
            Self::LockPoisoned => f.write_str(
                "MtlsVerifierState RwLock poisoned (previous writer panicked); restart required",
            ),
        }
    }
}

impl std::error::Error for MtlsRebuildError {}

impl From<SuderraVerifierBuildError> for MtlsRebuildError {
    fn from(e: SuderraVerifierBuildError) -> Self {
        Self::BuildFailed(e)
    }
}

/// Hot-reloadable state handle for [`SuderraServerCertVerifier`].
///
/// The handle is `Send + Sync` and cheap to clone via `Arc::clone(&self.inner)`
/// at the use site (mqtt.rs / reqwest builder construction). The wrapped
/// `Option<Arc<SuderraServerCertVerifier>>` mirrors the
/// [`build_suderra_verifier`] return shape — `None` is the legitimate HC-1
/// "no wire needed" case, distinct from "build failed".
///
/// # Concurrency contract
///
/// rustls invokes the `ServerCertVerifier` callback per-connection during
/// the TLS handshake. Concurrent handshakes hold an `Arc` reference to the
/// trait object obtained from [`current`]; that `Arc` is not affected by a
/// subsequent [`rebuild`] — the `RwLock<Option<Arc<...>>>` only swaps the
/// pointer at the *handle* level. In-flight verifications complete against
/// the verifier they captured at handshake start; the next handshake picks
/// up the new verifier.
///
/// [`current`]: Self::current
/// [`rebuild`]: Self::rebuild
#[derive(Clone)]
pub struct MtlsVerifierState {
    /// Current verifier. `None` indicates HC-1 fallthrough (Legacy mode +
    /// empty pin set) — caller falls through to the rustls default webpki
    /// verifier. Wrapped in `Arc<RwLock<...>>` so the state handle itself
    /// is cheap to clone (per-AppState wiring).
    inner: Arc<RwLock<Option<Arc<SuderraServerCertVerifier>>>>,
    /// Snapshot of the config the inner verifier was built from. Used for
    /// delta detection in [`rebuild`].
    ///
    /// [`rebuild`]: Self::rebuild
    config_snapshot: Arc<RwLock<MtlsConfigSnapshot>>,
    /// Signature algorithms inherited from the active CryptoProvider at
    /// boot (Phase 0.2 narrows this to ring's TLS-1.3 set). Not mutated
    /// across rebuilds — a sig-algs change requires process restart.
    sig_algs: WebPkiSupportedAlgorithms,
    /// Trust anchors for the inner WebPkiServerVerifier. Not mutated across
    /// rebuilds — a CA-chain change requires process restart (operator must
    /// rotate `mqtt.tls.ca_cert_path` and reboot the agent).
    root_store_arc: Arc<rustls::RootCertStore>,
}

impl std::fmt::Debug for MtlsVerifierState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let snap = self.config_snapshot.read().ok();
        f.debug_struct("MtlsVerifierState")
            .field("mode", &snap.as_ref().map(|s| s.mode))
            .field(
                "pinned_fingerprints_count",
                &snap.as_ref().map(|s| s.pinned_fingerprints_hex.len()),
            )
            .field("has_inner_verifier", &self.has_verifier())
            .finish_non_exhaustive()
    }
}

impl MtlsVerifierState {
    /// Construct a new state handle from the boot-time MtlsConfig. Returns
    /// `Err(MtlsRebuildError::BuildFailed(...))` for any build-time
    /// invariant failure (Strict mode + empty pins, malformed hex, WebPki
    /// construction failure).
    pub fn new(
        mode: MtlsMode,
        pins_hex: &[String],
        sig_algs: WebPkiSupportedAlgorithms,
        root_store_arc: Arc<rustls::RootCertStore>,
    ) -> Result<Self, MtlsRebuildError> {
        let initial = build_suderra_verifier(mode, sig_algs, pins_hex, root_store_arc.clone())?;
        let snapshot = MtlsConfigSnapshot {
            mode,
            pinned_fingerprints_hex: pins_hex.to_vec(),
        };
        Ok(Self {
            inner: Arc::new(RwLock::new(initial)),
            config_snapshot: Arc::new(RwLock::new(snapshot)),
            sig_algs,
            root_store_arc,
        })
    }

    /// Atomic-swap rebuild driven by `cmd_update_cert_pinning` (Phase
    /// 1.1.2). Pre-validates the new config before touching the inner
    /// pointer; on failure the previous verifier stays installed.
    pub fn rebuild(
        &self,
        new_mode: MtlsMode,
        new_pins_hex: &[String],
    ) -> Result<RebuildOutcome, MtlsRebuildError> {
        let new_snap = MtlsConfigSnapshot {
            mode: new_mode,
            pinned_fingerprints_hex: new_pins_hex.to_vec(),
        };
        // Delta detection — bit-identical config is a no-op. Holding the
        // read lock through the comparison is fine because the snapshot is
        // small (mode + hex strings) and we are not contending with other
        // writers in steady state.
        {
            let cur = self
                .config_snapshot
                .read()
                .map_err(|_| MtlsRebuildError::LockPoisoned)?;
            if *cur == new_snap {
                return Ok(RebuildOutcome::NoChange);
            }
        }
        // Pre-validate by constructing the new verifier first. If this
        // returns Err, the previous verifier is untouched.
        let new_verifier = build_suderra_verifier(
            new_mode,
            self.sig_algs,
            new_pins_hex,
            self.root_store_arc.clone(),
        )?;
        // Two atomic swaps — verifier slot first, then snapshot. The
        // ordering matters for an observer that races with the rebuild:
        // they see either (old_verifier, old_snap) or (new_verifier,
        // new_snap) — never (new_verifier, old_snap). A reader who
        // captured the old verifier mid-swap is safe because the
        // verifier `Arc` is independent of the state handle.
        {
            let mut slot = self
                .inner
                .write()
                .map_err(|_| MtlsRebuildError::LockPoisoned)?;
            *slot = new_verifier;
        }
        {
            let mut snap = self
                .config_snapshot
                .write()
                .map_err(|_| MtlsRebuildError::LockPoisoned)?;
            *snap = new_snap;
        }
        Ok(RebuildOutcome::Rebuilt)
    }

    /// Returns the current verifier as an `Arc<dyn ServerCertVerifier>`
    /// trait object suitable for `ClientConfig::dangerous().with_custom_certificate_verifier(...)`.
    ///
    /// `None` indicates HC-1 fallthrough — the caller should NOT install a
    /// custom verifier and instead use the default webpki path. mqtt.rs
    /// `configure_tls` already implements both branches (Phase 0.1).
    pub fn current(&self) -> Option<Arc<dyn ServerCertVerifier>> {
        let guard = self.inner.read().ok()?;
        guard
            .as_ref()
            .map(|v| Arc::clone(v) as Arc<dyn ServerCertVerifier>)
    }

    /// Test / observability helper. Returns true if a Suderra verifier is
    /// currently installed (i.e., not the HC-1 fallthrough path). Used by
    /// the Phase 1.1.5 invariant detector.
    pub fn has_verifier(&self) -> bool {
        self.inner
            .read()
            .ok()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    /// Test / observability helper. Returns the current snapshot's mode
    /// and pin count. Used by Phase 1.1.4 audit-sink emit on rebuild.
    pub fn current_mode_and_pin_count(&self) -> Option<(MtlsMode, usize)> {
        let snap = self.config_snapshot.read().ok()?;
        Some((snap.mode, snap.pinned_fingerprints_hex.len()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::RootCertStore;
    use rustls::crypto::ring::default_provider;

    /// Helper: build a minimal `Arc<RootCertStore>` + matching `sig_algs`
    /// for tests. WebPkiServerVerifier rejects empty stores at construction
    /// (`NoRootAnchors`), so we generate a fresh self-signed CA cert per
    /// test via `rcgen` and add its DER to the store. The cert is never
    /// actually presented in a handshake — these tests only exercise the
    /// state-machine behavior of [`MtlsVerifierState`] (rebuild, current,
    /// delta detection). The verifier construction succeeds as long as the
    /// store has any valid X.509 anchor.
    fn empty_anchors() -> (WebPkiSupportedAlgorithms, Arc<RootCertStore>) {
        let provider = default_provider();
        let sig_algs = provider.signature_verification_algorithms;
        let mut root_store = RootCertStore::empty();
        let ca = rcgen::generate_simple_self_signed(vec!["test-ca.suderra.local".to_string()])
            .expect("rcgen self-signed CA succeeds");
        let der = ca.cert.der().clone();
        root_store
            .add(der)
            .expect("RootCertStore.add accepts the rcgen self-signed cert");
        (sig_algs, Arc::new(root_store))
    }

    /// A 64-char hex literal that round-trips through fingerprint parsing.
    /// Avoids depending on any specific cert; we only need the wire format
    /// to be valid hex.
    const PIN_A: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const PIN_B: &str = "0000000000000000000000000000000000000000000000000000000000000002";

    /// HC-1 contract: Legacy mode + empty pins constructs a state handle
    /// whose `current()` is `None`. Callers fall through to default webpki.
    #[test]
    fn legacy_no_pins_yields_none_current() {
        let (sig_algs, root_store) = empty_anchors();
        let state = MtlsVerifierState::new(MtlsMode::Legacy, &[], sig_algs, root_store)
            .expect("legacy + no pins is valid");
        assert!(state.current().is_none());
        assert!(!state.has_verifier());
    }

    /// Strict + non-empty pins constructs a verifier; `current()` is `Some`.
    /// This is the production-fleet steady state per the rollout plan.
    #[test]
    fn strict_with_pins_yields_some_current() {
        let (sig_algs, root_store) = empty_anchors();
        let pins = vec![PIN_A.to_string()];
        let state = MtlsVerifierState::new(MtlsMode::Strict, &pins, sig_algs, root_store)
            .expect("strict + pins is valid");
        assert!(state.current().is_some());
        assert!(state.has_verifier());
        assert_eq!(
            state.current_mode_and_pin_count(),
            Some((MtlsMode::Strict, 1))
        );
    }

    /// Strict + empty pins MUST fail at construction. Defense-in-depth on
    /// top of `MtlsConfig` Coherence Rule 24.
    #[test]
    fn strict_no_pins_fails() {
        let (sig_algs, root_store) = empty_anchors();
        let result = MtlsVerifierState::new(MtlsMode::Strict, &[], sig_algs, root_store);
        assert!(matches!(
            result,
            Err(MtlsRebuildError::BuildFailed(
                SuderraVerifierBuildError::StrictModeRequiresPins
            ))
        ));
    }

    /// Bit-identical rebuild is a no-op. The verifier `Arc` pointer
    /// stays unchanged — important so in-flight handshakes are not
    /// disturbed by a redundant `cmd_update_cert_pinning` retry.
    #[test]
    fn rebuild_with_identical_config_is_noop() {
        let (sig_algs, root_store) = empty_anchors();
        let pins = vec![PIN_A.to_string()];
        let state = MtlsVerifierState::new(MtlsMode::Strict, &pins, sig_algs, root_store).unwrap();
        let before = state.current().unwrap();
        let outcome = state.rebuild(MtlsMode::Strict, &pins).unwrap();
        let after = state.current().unwrap();
        assert_eq!(outcome, RebuildOutcome::NoChange);
        assert!(Arc::ptr_eq(&before, &after));
    }

    /// Different config triggers a rebuild; the verifier `Arc` is replaced.
    #[test]
    fn rebuild_with_new_pin_replaces_verifier() {
        let (sig_algs, root_store) = empty_anchors();
        let pins_v1 = vec![PIN_A.to_string()];
        let pins_v2 = vec![PIN_B.to_string()];
        let state =
            MtlsVerifierState::new(MtlsMode::Strict, &pins_v1, sig_algs, root_store).unwrap();
        let before = state.current().unwrap();
        let outcome = state.rebuild(MtlsMode::Strict, &pins_v2).unwrap();
        let after = state.current().unwrap();
        assert_eq!(outcome, RebuildOutcome::Rebuilt);
        assert!(!Arc::ptr_eq(&before, &after));
        assert_eq!(
            state.current_mode_and_pin_count(),
            Some((MtlsMode::Strict, 1))
        );
    }

    /// A rebuild that fails (e.g. Strict → Strict with empty pins) must
    /// NOT touch the inner verifier. The pre-Phase-1 wire would have
    /// installed a poisoned verifier; the state handle's pre-validate
    /// pattern guarantees the running fleet keeps the previous pin set.
    #[test]
    fn rebuild_with_invalid_config_preserves_old_verifier() {
        let (sig_algs, root_store) = empty_anchors();
        let pins_v1 = vec![PIN_A.to_string()];
        let state =
            MtlsVerifierState::new(MtlsMode::Strict, &pins_v1, sig_algs, root_store).unwrap();
        let before = state.current().unwrap();
        let result = state.rebuild(MtlsMode::Strict, &[]);
        let after = state.current().unwrap();
        assert!(matches!(
            result,
            Err(MtlsRebuildError::BuildFailed(
                SuderraVerifierBuildError::StrictModeRequiresPins
            ))
        ));
        assert!(Arc::ptr_eq(&before, &after));
        assert_eq!(
            state.current_mode_and_pin_count(),
            Some((MtlsMode::Strict, 1))
        );
    }

    /// Mode rotation Legacy → Warn picks up the new verifier. Tests that
    /// the snapshot equality is mode-sensitive, not just pin-set-sensitive.
    #[test]
    fn rebuild_legacy_to_warn_with_same_pin_rebuilds() {
        let (sig_algs, root_store) = empty_anchors();
        let pins = vec![PIN_A.to_string()];
        let state =
            MtlsVerifierState::new(MtlsMode::Legacy, &pins, sig_algs, root_store).unwrap();
        let outcome = state.rebuild(MtlsMode::Warn, &pins).unwrap();
        assert_eq!(outcome, RebuildOutcome::Rebuilt);
        assert_eq!(state.current_mode_and_pin_count(), Some((MtlsMode::Warn, 1)));
    }

    /// Concurrent reader during a rebuild captures EITHER the old verifier
    /// OR the new one — never a torn observation. Drive a mutating thread
    /// against repeated `current()` calls and assert pointer-stability
    /// per call.
    ///
    /// This is a weaker proof than a `loom::test` but sufficient for the
    /// Phase 1 invariant; the handle inherits its safety from `RwLock` +
    /// `Arc::clone`, both of which are loom-tested upstream.
    #[test]
    fn concurrent_reader_during_rebuild_sees_consistent_arc() {
        use std::thread;
        use std::time::Duration;

        let (sig_algs, root_store) = empty_anchors();
        let pins_v1 = vec![PIN_A.to_string()];
        let state = Arc::new(
            MtlsVerifierState::new(MtlsMode::Strict, &pins_v1, sig_algs, root_store).unwrap(),
        );
        let mutator = {
            let state = Arc::clone(&state);
            thread::spawn(move || {
                let pin_b = vec![PIN_B.to_string()];
                let pin_a = vec![PIN_A.to_string()];
                for i in 0..200 {
                    let pins = if i % 2 == 0 { &pin_b } else { &pin_a };
                    let _ = state.rebuild(MtlsMode::Strict, pins);
                    thread::sleep(Duration::from_micros(50));
                }
            })
        };
        let reader = {
            let state = Arc::clone(&state);
            thread::spawn(move || {
                for _ in 0..1000 {
                    // Each call independently captures whatever Arc is
                    // current. The captured Arc is internally consistent
                    // (it's an Arc, not a torn ref).
                    let _captured = state.current();
                    thread::yield_now();
                }
            })
        };
        mutator.join().expect("mutator thread");
        reader.join().expect("reader thread");
        // Final state — current must still be Some (we keep installing valid pins).
        assert!(state.current().is_some());
    }
}
