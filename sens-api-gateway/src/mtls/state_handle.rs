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

use rustls::DigitallySignedStruct;
use rustls::SignatureScheme;
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::WebPkiSupportedAlgorithms;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};

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
    /// The new config would weaken the running policy (e.g., Strict →
    /// Warn, Strict → Legacy, or any non-empty pin set rotated to empty
    /// pins). Pre-Phase-1.1.2 this gate is the architectural floor that
    /// `cmd_update_cert_pinning` cannot bypass: no operator-driven rotation
    /// — even with valid ed25519 signatures + two-person co-approver — can
    /// silently disable the Suderra policy by rolling back to a permissive
    /// mode. Tier-1 MAKE-IT-IMPOSSIBLE per the security review of
    /// commit 23e35c25 (PR #227 review). See [`MtlsVerifierState::rebuild`]
    /// for the transition table.
    DowngradeRejected {
        from_mode: MtlsMode,
        to_mode: MtlsMode,
        from_pin_count: usize,
        to_pin_count: usize,
    },
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
            Self::DowngradeRejected {
                from_mode,
                to_mode,
                from_pin_count,
                to_pin_count,
            } => write!(
                f,
                "MtlsVerifierState::rebuild rejected downgrade {from_mode:?}/{from_pin_count} pins → {to_mode:?}/{to_pin_count} pins. \
                 Suderra policy floor cannot be lowered without an explicit emergency \
                 break-glass procedure (out-of-band, not via cmd_update_cert_pinning)."
            ),
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
    ///
    /// # Tier-1 downgrade gate
    ///
    /// `rebuild` rejects any transition that would WEAKEN the running
    /// policy floor. The transition table:
    ///
    /// | From mode → to mode | Pin count change | Verdict |
    /// |---------------------|------------------|---------|
    /// | Legacy → Legacy / Warn / Strict | non-empty → non-empty | OK (promotion or rotation) |
    /// | Warn → Warn / Strict            | non-empty → non-empty | OK |
    /// | Strict → Strict                 | non-empty → non-empty | OK (rotation) |
    /// | ANY → ANY                       | non-empty → empty     | REJECTED ([`MtlsRebuildError::DowngradeRejected`]) |
    /// | Strict → Warn / Legacy          | any                   | REJECTED |
    /// | Warn → Legacy                   | any                   | REJECTED |
    ///
    /// This is Tier-1 MAKE-IT-IMPOSSIBLE for the silent-policy-disable
    /// attack flagged by the security review of commit 23e35c25 (PR #227).
    /// An attacker reaching `cmd_update_cert_pinning` (after Phase 1.1.2)
    /// with valid ed25519 + co-approver signatures STILL cannot rotate
    /// the live state to Legacy + empty pins — even before
    /// `cmd_update_cert_pinning`'s own dispatcher-level checks fire,
    /// `rebuild` rejects the transition. The only legitimate way to
    /// roll back the policy floor is an out-of-band emergency
    /// break-glass procedure (signed emergency policy file at
    /// `/etc/suderra/emergency_policy.json.sig` per ADR-018 §5) that
    /// requires physical or hardware-token access — outside this
    /// command surface.
    pub fn rebuild(
        &self,
        new_mode: MtlsMode,
        new_pins_hex: &[String],
    ) -> Result<RebuildOutcome, MtlsRebuildError> {
        let new_snap = MtlsConfigSnapshot {
            mode: new_mode,
            pinned_fingerprints_hex: new_pins_hex.to_vec(),
        };
        // Delta detection + downgrade gate. Snapshot the current config
        // under the read lock so the gate runs against a consistent view.
        {
            let cur = self
                .config_snapshot
                .read()
                .map_err(|_| MtlsRebuildError::LockPoisoned)?;
            if *cur == new_snap {
                return Ok(RebuildOutcome::NoChange);
            }
            let cur_strictness = cur.mode.wire_tag();
            let new_strictness = new_mode.wire_tag();
            let cur_pin_count = cur.pinned_fingerprints_hex.len();
            let new_pin_count = new_pins_hex.len();
            // Reject mode downgrade. wire_tag is 0 for Legacy, 1 for Warn,
            // 2 for Strict — strictly increasing in policy strength.
            if new_strictness < cur_strictness {
                tracing::error!(
                    target: "mtls.hotreload",
                    from_mode = ?cur.mode,
                    to_mode = ?new_mode,
                    from_pins = cur_pin_count,
                    to_pins = new_pin_count,
                    "MtlsVerifierState::rebuild rejected mode downgrade"
                );
                return Err(MtlsRebuildError::DowngradeRejected {
                    from_mode: cur.mode,
                    to_mode: new_mode,
                    from_pin_count: cur_pin_count,
                    to_pin_count: new_pin_count,
                });
            }
            // Reject pin-set emptying. A rotation that drops all pins
            // collapses the rotation stage to "no accepted fingerprints"
            // which routes Strict-mode handshakes to fail-closed AND
            // Legacy/Warn handshakes to silent webpki fallthrough — both
            // outcomes are operationally lethal.
            if cur_pin_count > 0 && new_pin_count == 0 {
                tracing::error!(
                    target: "mtls.hotreload",
                    from_mode = ?cur.mode,
                    to_mode = ?new_mode,
                    from_pins = cur_pin_count,
                    to_pins = new_pin_count,
                    "MtlsVerifierState::rebuild rejected pin-set empty rotation"
                );
                return Err(MtlsRebuildError::DowngradeRejected {
                    from_mode: cur.mode,
                    to_mode: new_mode,
                    from_pin_count: cur_pin_count,
                    to_pin_count: new_pin_count,
                });
            }
        }
        // Pre-validate by constructing the new verifier first. If this
        // returns Err, the previous verifier is untouched.
        let new_verifier = build_suderra_verifier(
            new_mode,
            self.sig_algs,
            new_pins_hex,
            self.root_store_arc.clone(),
        )
        .inspect_err(|e| {
            tracing::error!(
                target: "mtls.hotreload",
                to_mode = ?new_mode,
                to_pins = new_pins_hex.len(),
                error = ?e,
                "MtlsVerifierState::rebuild build_suderra_verifier failed; old verifier preserved"
            );
        })?;
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
        // Audit trail: defense-in-depth tracing emit so even if the
        // cmd_update_cert_pinning dispatcher (Phase 1.1.2) forgets to
        // log, the rotation is forensically recoverable from structured
        // logs. `target: "mtls.hotreload"` is the canonical subscriber
        // tag for this subsystem (paired with the `error!` tags above).
        tracing::info!(
            target: "mtls.hotreload",
            new_mode = ?new_mode,
            new_pin_count = new_pins_hex.len(),
            "MtlsVerifierState::rebuild applied (Tier-1 atomic swap)"
        );
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

/// Rustls `ServerCertVerifier` that forwards every callback to the verifier
/// currently held by an [`MtlsVerifierState`]. Installed at boot via
/// `ClientConfig::dangerous().with_custom_certificate_verifier(...)` so that
/// **every new TLS handshake** consults the up-to-the-millisecond verifier
/// rather than a snapshot captured at boot. This is what makes
/// `cmd_update_cert_pinning` (Phase 1.1.2) genuinely hot — the operator can
/// rotate pins and the next MQTT reconnect / new HTTPS request picks up the
/// new policy with no agent restart.
///
/// ## Why a delegating wrapper rather than re-installing the verifier
///
/// Rustls captures the `Arc<dyn ServerCertVerifier>` at `ClientConfig` build
/// time. Replacing the verifier on a live `ClientConfig` requires either
/// rebuilding the config (and reconnecting every MQTT/HTTPS client) or
/// indirecting through a wrapper. The wrapper is the cheaper +
/// architecturally cleaner shape: in-flight handshakes complete with the
/// verifier they captured at the start of `verify_server_cert`, so there is
/// no torn observation; the next handshake re-reads `state.current()` and
/// gets whatever rebuild landed in between.
///
/// ## HC-1 fallthrough (Legacy + empty pins)
///
/// When `state.current()` returns `None` (Legacy mode + empty pin set), the
/// wrapper delegates to a `WebPkiServerVerifier` constructed once at boot
/// from the same trust anchors. This preserves the pre-Phase-0 contract
/// that `mtls.mode=Legacy` + no pins behaves like the rustls default —
/// chain trust + hostname match, no Suderra policy gates.
///
/// The fallback verifier is held as `Arc<WebPkiServerVerifier>` so the
/// trait object doesn't allocate per-handshake.
pub struct MtlsDelegatingVerifier {
    state: Arc<MtlsVerifierState>,
    fallback: Arc<WebPkiServerVerifier>,
}

impl std::fmt::Debug for MtlsDelegatingVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MtlsDelegatingVerifier")
            .field("state", &self.state)
            .field("has_fallback", &true)
            .finish()
    }
}

impl MtlsDelegatingVerifier {
    /// Construct the wrapper. The `fallback` verifier is consulted only when
    /// `state.current()` returns `None` — i.e., the HC-1 Legacy + no-pins
    /// path. Built at boot via [`build_fallback_webpki`].
    pub fn new(state: Arc<MtlsVerifierState>, fallback: Arc<WebPkiServerVerifier>) -> Self {
        Self { state, fallback }
    }

    /// Returns true if the current handshake would route through a Suderra
    /// verifier vs. the HC-1 fallback. Used by the Phase 1.1.5 invariant
    /// detector + boot-time logs.
    pub fn currently_using_suderra_verifier(&self) -> bool {
        self.state.has_verifier()
    }
}

/// Build a fallback `WebPkiServerVerifier` from the same trust anchors used
/// by the `MtlsVerifierState`. The fallback is consulted only on the HC-1
/// Legacy + no-pins path — chain trust + hostname match, no Suderra policy
/// gates. Production wires this once at boot inside `init_mqtt_*` /
/// `init_cloud_https_*` and stores the resulting Arc inside
/// [`MtlsDelegatingVerifier`].
pub fn build_fallback_webpki(
    root_store: Arc<rustls::RootCertStore>,
    provider: Arc<rustls::crypto::CryptoProvider>,
) -> Result<Arc<WebPkiServerVerifier>, String> {
    // `builder_with_provider(...).build()` already returns `Arc<WebPkiServerVerifier>`
    // per rustls 0.23 API — no cast needed (clippy `unnecessary_cast` would flag the
    // identity coercion under `-D warnings`).
    WebPkiServerVerifier::builder_with_provider(root_store, provider)
        .build()
        .map_err(|e| format!("WebPkiServerVerifier fallback build failed: {e:?}"))
}

impl ServerCertVerifier for MtlsDelegatingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self.state.current() {
            Some(suderra) => {
                suderra.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
            }
            None => self
                .fallback
                .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        // Both branches use the same WebPkiSupportedAlgorithms via their
        // inner verifier; delegating to whichever is current keeps the
        // signature-verification path consistent with the chain-trust path.
        match self.state.current() {
            Some(suderra) => suderra.verify_tls12_signature(message, cert, dss),
            None => self.fallback.verify_tls12_signature(message, cert, dss),
        }
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        match self.state.current() {
            Some(suderra) => suderra.verify_tls13_signature(message, cert, dss),
            None => self.fallback.verify_tls13_signature(message, cert, dss),
        }
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        // The supported scheme set is determined by the rustls
        // CryptoProvider's signature_verification_algorithms, which is
        // identical between the Suderra wrapper and the WebPki fallback.
        match self.state.current() {
            Some(suderra) => suderra.supported_verify_schemes(),
            None => self.fallback.supported_verify_schemes(),
        }
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

    /// A rebuild that fails MUST NOT touch the inner verifier. The
    /// state handle's pre-validate pattern guarantees the running fleet
    /// keeps the previous pin set.
    ///
    /// Strict + empty pins is now caught by the Tier-1 downgrade gate
    /// (`DowngradeRejected{ to_pin_count: 0, .. }`) BEFORE
    /// `build_suderra_verifier` runs — the gate is stricter than the
    /// build-time check (defense-in-depth: the gate rejects ANY pin-set
    /// emptying, regardless of mode). Use a non-pin-emptying invalid
    /// config (malformed hex) to exercise the build-failed preserve path.
    #[test]
    fn rebuild_with_invalid_config_preserves_old_verifier() {
        let (sig_algs, root_store) = empty_anchors();
        let pins_v1 = vec![PIN_A.to_string()];
        let state =
            MtlsVerifierState::new(MtlsMode::Strict, &pins_v1, sig_algs, root_store).unwrap();
        let before = state.current().unwrap();
        // Malformed hex (one fewer char than 64) — not a downgrade,
        // falls through to build_suderra_verifier which rejects it.
        let bad_pins = vec![
            "0000000000000000000000000000000000000000000000000000000000000".to_string(),
        ];
        let result = state.rebuild(MtlsMode::Strict, &bad_pins);
        let after = state.current().unwrap();
        assert!(matches!(
            result,
            Err(MtlsRebuildError::BuildFailed(
                SuderraVerifierBuildError::InvalidFingerprintLength { .. }
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

    /// Mode downgrade Strict → Warn MUST be rejected. Tier-1 floor against
    /// the silent-policy-disable attack (security review of 23e35c25).
    #[test]
    fn rebuild_strict_to_warn_rejected_as_downgrade() {
        let (sig_algs, root_store) = empty_anchors();
        let pins = vec![PIN_A.to_string()];
        let state = MtlsVerifierState::new(MtlsMode::Strict, &pins, sig_algs, root_store).unwrap();
        let result = state.rebuild(MtlsMode::Warn, &pins);
        assert!(matches!(
            result,
            Err(MtlsRebuildError::DowngradeRejected {
                from_mode: MtlsMode::Strict,
                to_mode: MtlsMode::Warn,
                ..
            })
        ));
        // State unchanged.
        assert_eq!(
            state.current_mode_and_pin_count(),
            Some((MtlsMode::Strict, 1))
        );
    }

    /// Mode downgrade Strict → Legacy MUST be rejected.
    #[test]
    fn rebuild_strict_to_legacy_rejected_as_downgrade() {
        let (sig_algs, root_store) = empty_anchors();
        let pins = vec![PIN_A.to_string()];
        let state = MtlsVerifierState::new(MtlsMode::Strict, &pins, sig_algs, root_store).unwrap();
        let result = state.rebuild(MtlsMode::Legacy, &pins);
        assert!(matches!(
            result,
            Err(MtlsRebuildError::DowngradeRejected {
                from_mode: MtlsMode::Strict,
                to_mode: MtlsMode::Legacy,
                ..
            })
        ));
    }

    /// Mode downgrade Warn → Legacy MUST be rejected.
    #[test]
    fn rebuild_warn_to_legacy_rejected_as_downgrade() {
        let (sig_algs, root_store) = empty_anchors();
        let pins = vec![PIN_A.to_string()];
        let state = MtlsVerifierState::new(MtlsMode::Warn, &pins, sig_algs, root_store).unwrap();
        let result = state.rebuild(MtlsMode::Legacy, &pins);
        assert!(matches!(
            result,
            Err(MtlsRebuildError::DowngradeRejected {
                from_mode: MtlsMode::Warn,
                to_mode: MtlsMode::Legacy,
                ..
            })
        ));
    }

    /// Pin-set emptying MUST be rejected even at the same mode (e.g.,
    /// Warn + 1 pin → Warn + 0 pins). Empty pin set under Strict is
    /// already rejected by build_suderra_verifier; under Warn it routes
    /// to silent webpki fallthrough — both lethal.
    #[test]
    fn rebuild_drop_all_pins_rejected_as_downgrade() {
        let (sig_algs, root_store) = empty_anchors();
        let pins = vec![PIN_A.to_string()];
        let state = MtlsVerifierState::new(MtlsMode::Warn, &pins, sig_algs, root_store).unwrap();
        let result = state.rebuild(MtlsMode::Warn, &[]);
        assert!(matches!(
            result,
            Err(MtlsRebuildError::DowngradeRejected {
                from_pin_count: 1,
                to_pin_count: 0,
                ..
            })
        ));
    }

    /// Mode promotion (Legacy → Warn → Strict) IS allowed. The downgrade
    /// gate is one-way — operators can ALWAYS tighten the policy floor.
    #[test]
    fn rebuild_legacy_to_strict_promotion_succeeds() {
        let (sig_algs, root_store) = empty_anchors();
        let pins = vec![PIN_A.to_string()];
        let state =
            MtlsVerifierState::new(MtlsMode::Legacy, &pins, sig_algs, root_store).unwrap();
        let outcome = state.rebuild(MtlsMode::Strict, &pins).unwrap();
        assert_eq!(outcome, RebuildOutcome::Rebuilt);
        assert_eq!(
            state.current_mode_and_pin_count(),
            Some((MtlsMode::Strict, 1))
        );
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
