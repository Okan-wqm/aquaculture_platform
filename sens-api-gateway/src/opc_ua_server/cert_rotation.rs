//! `CertRotation` — 3-phase OPC UA PKI rollout state machine.
//!
//! ## WHY this primitive exists
//!
//! Phase B-1 of the Faz 2 closure plan (`docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md` §B-1, Batch #267) layers a
//! 3-phase rollout discipline on top of [`super::pki_store::PkiStore`].
//! Operators migrating fleets from pre-B-1 `trust_client_certs(true)` TOFU
//! to fingerprint-pinned `StrictPinOnly` need a staged rollout — same
//! mental model as the MQTT mTLS 3-phase (`mtls::MtlsMode`) shipped in
//! ADR-029 + PR #227 Phase 1.1.4.
//!
//! See [`docs/adr/031-opc-ua-pki-lifecycle.md`](../../../docs/adr/031-opc-ua-pki-lifecycle.md)
//! §2 for the architectural decision record.
//!
//! ## State machine
//!
//! ```text
//! LegacyAccept   →  trust_client_certs(true) + log every cert presented
//! WarnOnMismatch →  trust_client_certs(true) + audit-warn on unpinned cert
//! StrictPinOnly  →  trust_client_certs(false) + ONLY PkiStore-trusted certs
//! ```
//!
//! The transition graph is **monotonically tightening** — operators can
//! ALWAYS promote (Legacy → Warn → Strict) but CANNOT downgrade. The
//! Tier-1 downgrade gate mirrors `MtlsVerifierState::rebuild` (PR #227
//! commit a2242f36): even an authenticated operator with a valid
//! signed manifest cannot silently roll the OPC UA fleet back to a
//! permissive mode. The only legitimate downgrade path is an
//! out-of-band emergency break-glass procedure outside this surface.
//!
//! ## Pin-set emptying gate
//!
//! `StrictPinOnly` with zero trusted fingerprints would lock out every
//! HMI — a fleet-stranding misconfig. The gate rejects entering Strict
//! while `PkiStore::trusted_count() == 0`. Operators must ADD trusted
//! certs first, then promote the phase.
//!
//! ## Audit anchoring
//!
//! Every successful transition appends a `LedgerEntry::PhaseTransition`
//! to the PkiStore ledger via [`super::pki_store::PkiStore::append_phase_transition`].
//! The HMAC-chain anchoring lets `audit-verify` CLI reconstruct the
//! rollout timeline offline.
//!
//! ## NOT in scope (Phase B-1)
//!
//! - **Cloud-signed manifest deser path** — `opc_ua_pki_manifest_v1`
//!   payload format + ed25519 verification + replay defense. Phase C
//!   ships that surface; Phase B-1 lands the AGENT-side state machine
//!   that the future `cmd_update_opc_ua_pki` MQTT command will drive.
//! - **72-hour rollback window** — ledger rollback discipline named in
//!   ADR-031 §2 requires a separate primitive that walks the ledger to
//!   identify reversible transitions. Phase B-1 lands the FORWARD path;
//!   the rollback walk is Phase B-1.5.
//! - **Per-handshake `OpcUaCertRejected` audit emit** — async-opcua 0.18
//!   does not expose a `ClientCertVerifier` callback hook on
//!   `ServerBuilder`. Phase B-2 layers a session-establishment
//!   interceptor or pursues an upstream PR.

#![cfg(feature = "opc-ua-server")]

use std::sync::{Arc, RwLock};

use super::pki_store::{LedgerEntry, PkiStore, PkiStoreError};

/// 3-phase rollout state. Stable wire shape — variant order is the
/// strictness ordering (Legacy < Warn < Strict).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpcUaPkiMode {
    /// `trust_client_certs(true)` + log every cert. Pre-B-1 default;
    /// operators stay here while building the trusted set.
    LegacyAccept,
    /// `trust_client_certs(true)` + audit-warn on fingerprint mismatch.
    /// Operators dry-run their pin set without rejecting yet.
    WarnOnMismatch,
    /// `trust_client_certs(false)` + ONLY PkiStore-trusted fingerprints.
    /// Production fleet steady state.
    StrictPinOnly,
}

impl OpcUaPkiMode {
    /// Strictness rank — strictly increasing. Used by the downgrade
    /// gate: a transition `from → to` is allowed IFF
    /// `to.strictness() >= from.strictness()`.
    pub const fn strictness(self) -> u8 {
        match self {
            Self::LegacyAccept => 0,
            Self::WarnOnMismatch => 1,
            Self::StrictPinOnly => 2,
        }
    }

    /// Whether this mode tells `ServerBuilder::trust_client_certs(...)`
    /// to ALSO accept clients whose fingerprint is not in the
    /// PkiStore-managed trusted set. `false` is the StrictPinOnly
    /// architectural floor — only pinned certs accept.
    pub const fn trust_unpinned_clients(self) -> bool {
        match self {
            Self::LegacyAccept | Self::WarnOnMismatch => true,
            Self::StrictPinOnly => false,
        }
    }

    /// Wire-stable string label — used in audit ledger entries +
    /// operator-facing log messages. Kept in sync with the
    /// `serde(rename_all = "snake_case")` pattern above.
    pub const fn wire_label(self) -> &'static str {
        match self {
            Self::LegacyAccept => "legacy_accept",
            Self::WarnOnMismatch => "warn_on_mismatch",
            Self::StrictPinOnly => "strict_pin_only",
        }
    }
}

/// Errors surfaced by [`CertRotation::transition_to`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CertRotationError {
    /// Transition would weaken the running policy floor — Tier-1
    /// architectural rejection. The only legitimate downgrade path is
    /// an out-of-band emergency break-glass procedure (signed
    /// emergency policy file) outside this surface.
    DowngradeRejected {
        from: OpcUaPkiMode,
        to: OpcUaPkiMode,
    },
    /// Operator attempted to enter `StrictPinOnly` with zero trusted
    /// fingerprints — every HMI would lock out. Add trusted certs
    /// first, then promote.
    StrictWithEmptyPinSet,
    /// Underlying PkiStore failed to record the transition (filesystem,
    /// chain, or lock failure). Old mode preserved.
    LedgerWriteFailed(String),
    /// Internal RwLock poisoned by previous panic.
    LockPoisoned,
}

impl std::fmt::Display for CertRotationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DowngradeRejected { from, to } => write!(
                f,
                "CertRotation: rejected downgrade {} → {} — Tier-1 \
                 architectural floor (ADR-031 §2). Operators can ALWAYS \
                 promote (Legacy → Warn → Strict) but never downgrade. \
                 The only legitimate roll-back is an out-of-band \
                 emergency break-glass procedure outside this command \
                 surface.",
                from.wire_label(),
                to.wire_label()
            ),
            Self::StrictWithEmptyPinSet => f.write_str(
                "CertRotation: cannot transition to StrictPinOnly with \
                 zero trusted fingerprints — every HMI would lock out. \
                 Add trusted certs to the PkiStore first, then promote \
                 the phase.",
            ),
            Self::LedgerWriteFailed(e) => write!(f, "CertRotation ledger write: {e}"),
            Self::LockPoisoned => f.write_str(
                "CertRotation RwLock poisoned (previous writer panicked); restart required",
            ),
        }
    }
}

impl std::error::Error for CertRotationError {}

impl From<PkiStoreError> for CertRotationError {
    fn from(e: PkiStoreError) -> Self {
        Self::LedgerWriteFailed(format!("{e}"))
    }
}

/// Outcome of a successful [`CertRotation::transition_to`] call. A
/// separate enum (rather than a boolean) so audit-stream consumers
/// can distinguish "no-op rebuild" from "real transition" without
/// inspecting timestamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionOutcome {
    /// Same mode requested; no ledger entry appended; in-memory state
    /// unchanged. Operator-facing API treats this as a successful
    /// no-op.
    NoChange,
    /// New mode different from current; ledger entry appended;
    /// in-memory mode updated atomically.
    Applied,
}

/// `CertRotation` — owns the active rollout phase + drives transitions
/// through [`PkiStore`].
///
/// Construction from boot config: [`Self::load_from_pki_store`] queries
/// the most recent `LedgerEntry::PhaseTransition` to recover the current
/// mode. First-boot defaults to `LegacyAccept` (matches the pre-B-1
/// agent's TOFU behavior — operators upgrade in place without a forced
/// fleet outage).
///
/// Concurrency: `Send + Sync`. `Arc<CertRotation>` stored on AppState;
/// the OPC UA server builder reads `mode()` once at boot. Future
/// `cmd_update_opc_ua_pki` MQTT command (Phase C) drives transitions
/// at runtime; the active server's `pki_dir` content updates live, no
/// async-opcua restart needed.
pub struct CertRotation {
    pki_store: Arc<PkiStore>,
    state: RwLock<OpcUaPkiMode>,
}

impl std::fmt::Debug for CertRotation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mode = self.state.read().ok().map(|g| *g);
        f.debug_struct("CertRotation")
            .field("mode", &mode)
            .finish_non_exhaustive()
    }
}

impl CertRotation {
    /// Test-time / hermetic constructor. `initial_mode` is the mode the
    /// instance starts in — production callers should prefer
    /// [`Self::load_from_pki_store`] which recovers the mode from the
    /// ledger walk. First-boot deployments with no `PhaseTransition`
    /// entry on the ledger default to `LegacyAccept` per the
    /// in-place-upgrade contract.
    pub fn new(pki_store: Arc<PkiStore>, initial_mode: Option<OpcUaPkiMode>) -> Self {
        Self {
            pki_store,
            state: RwLock::new(initial_mode.unwrap_or(OpcUaPkiMode::LegacyAccept)),
        }
    }

    /// Production boot-time constructor — Phase B-1.5 closure.
    ///
    /// Walks the on-disk PkiStore ledger via
    /// [`PkiStore::ledger_entries`], scans for the most recent
    /// `LedgerEntry::PhaseTransition`, and parses its `to_mode` wire
    /// label back into [`OpcUaPkiMode`]. If no `PhaseTransition` is
    /// recorded (first-boot or upgrade-in-place from pre-B-1), the
    /// instance starts in `LegacyAccept`.
    ///
    /// Returns `Err(CertRotationError::LedgerWriteFailed)` only if the
    /// ledger walk itself fails (chain corruption, IO error). An
    /// unparseable `to_mode` string in the ledger is also surfaced
    /// here — the wire labels are stable per
    /// [`OpcUaPkiMode::wire_label`], so an unparseable value indicates
    /// a tampered ledger or a wire-label drift that the operator must
    /// investigate.
    ///
    /// Pre-Phase-B-1.5 callers used `CertRotation::new(_, None)` which
    /// always defaulted to `LegacyAccept` regardless of any prior
    /// promotion. Production now uses this walker so a promoted fleet
    /// stays promoted across agent restarts.
    pub fn load_from_pki_store(pki_store: Arc<PkiStore>) -> Result<Self, CertRotationError> {
        let entries = pki_store.ledger_entries()?;
        let recovered_mode = scan_last_phase_transition(&entries)?;
        let initial = recovered_mode.unwrap_or(OpcUaPkiMode::LegacyAccept);
        Ok(Self {
            pki_store,
            state: RwLock::new(initial),
        })
    }

    /// Active mode. Cheap — read-lock + Copy.
    pub fn mode(&self) -> OpcUaPkiMode {
        self.state
            .read()
            .map(|g| *g)
            .unwrap_or(OpcUaPkiMode::LegacyAccept)
    }

    /// Apply a transition to a new mode.
    ///
    /// Gates:
    /// 1. **Downgrade gate** — `new.strictness() < cur.strictness()` rejected.
    /// 2. **Pin-set emptying gate** — `StrictPinOnly` + trusted_count == 0 rejected.
    /// 3. **Idempotent no-op** — same mode returns [`TransitionOutcome::NoChange`].
    ///
    /// On success, appends a `LedgerEntry::PhaseTransition` through
    /// [`PkiStore::append_phase_transition`]. On failure, preserves the
    /// previous mode + does NOT touch the ledger.
    pub fn transition_to(
        &self,
        new_mode: OpcUaPkiMode,
    ) -> Result<TransitionOutcome, CertRotationError> {
        let cur = {
            let guard = self
                .state
                .read()
                .map_err(|_| CertRotationError::LockPoisoned)?;
            *guard
        };
        if cur == new_mode {
            return Ok(TransitionOutcome::NoChange);
        }
        if new_mode.strictness() < cur.strictness() {
            return Err(CertRotationError::DowngradeRejected {
                from: cur,
                to: new_mode,
            });
        }
        if new_mode == OpcUaPkiMode::StrictPinOnly {
            let trusted_count = self.pki_store.trusted_count()?;
            if trusted_count == 0 {
                return Err(CertRotationError::StrictWithEmptyPinSet);
            }
        }
        // Append ledger BEFORE mutating in-memory state. If ledger
        // append fails, the previous mode is still observable through
        // mode() — fail-closed on the on-disk side first.
        self.pki_store
            .append_phase_transition(cur.wire_label(), new_mode.wire_label())?;
        let mut guard = self
            .state
            .write()
            .map_err(|_| CertRotationError::LockPoisoned)?;
        *guard = new_mode;
        Ok(TransitionOutcome::Applied)
    }
}

/// Reverse-scan the ledger entries for the most recent
/// `LedgerEntry::PhaseTransition`. Returns `Ok(Some(mode))` if found,
/// `Ok(None)` for first-boot ledgers (only Genesis + cert-trust
/// entries), or `Err(CertRotationError)` if the recorded `to_mode`
/// wire label is unparseable.
fn scan_last_phase_transition(
    entries: &[LedgerEntry],
) -> Result<Option<OpcUaPkiMode>, CertRotationError> {
    for entry in entries.iter().rev() {
        if let LedgerEntry::PhaseTransition { to_mode, .. } = entry {
            return parse_wire_label(to_mode).map(Some);
        }
    }
    Ok(None)
}

/// Parse a wire-label string back into [`OpcUaPkiMode`]. Stable round-
/// trip with [`OpcUaPkiMode::wire_label`] — drift between the two
/// surfaces this function as the failure point at boot rather than
/// silently converting unknown labels to LegacyAccept.
fn parse_wire_label(label: &str) -> Result<OpcUaPkiMode, CertRotationError> {
    match label {
        "legacy_accept" => Ok(OpcUaPkiMode::LegacyAccept),
        "warn_on_mismatch" => Ok(OpcUaPkiMode::WarnOnMismatch),
        "strict_pin_only" => Ok(OpcUaPkiMode::StrictPinOnly),
        other => Err(CertRotationError::LedgerWriteFailed(format!(
            "unparseable phase-transition wire label `{other}` — \
             must be one of: legacy_accept, warn_on_mismatch, \
             strict_pin_only. Tampered ledger or wire-label drift \
             between OpcUaPkiMode::wire_label() and parse_wire_label()."
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opc_ua_server::pki_store::CertFingerprint;
    use tempfile::TempDir;

    fn fresh_rotation_with_n_pins(n: usize) -> (TempDir, Arc<PkiStore>, CertRotation) {
        let tmp = TempDir::new().expect("tempdir");
        let pki = Arc::new(
            PkiStore::open_or_initialize(tmp.path(), "test-device-rotation".to_string())
                .expect("first-boot pki"),
        );
        for i in 0..n {
            let der = format!("CERT_{i}").into_bytes();
            pki.add_trusted_cert(&der, format!("hmi-{i}"))
                .expect("add cert");
        }
        let rot = CertRotation::new(pki.clone(), None);
        (tmp, pki, rot)
    }

    /// First-boot defaults to `LegacyAccept` — no forced fleet outage
    /// for in-place upgrades from pre-B-1.
    #[test]
    fn first_boot_is_legacy_accept() {
        let (_tmp, _pki, rot) = fresh_rotation_with_n_pins(0);
        assert_eq!(rot.mode(), OpcUaPkiMode::LegacyAccept);
    }

    /// Promotion Legacy → Warn → Strict succeeds in order, with one
    /// trusted cert pinned to satisfy the empty-pin-set gate at the
    /// Strict step.
    #[test]
    fn legacy_to_warn_to_strict_promotion() {
        let (_tmp, _pki, rot) = fresh_rotation_with_n_pins(1);
        assert_eq!(
            rot.transition_to(OpcUaPkiMode::WarnOnMismatch)
                .expect("warn ok"),
            TransitionOutcome::Applied
        );
        assert_eq!(rot.mode(), OpcUaPkiMode::WarnOnMismatch);
        assert_eq!(
            rot.transition_to(OpcUaPkiMode::StrictPinOnly)
                .expect("strict ok"),
            TransitionOutcome::Applied
        );
        assert_eq!(rot.mode(), OpcUaPkiMode::StrictPinOnly);
    }

    /// Same-mode rebuild is a no-op (no ledger entry).
    #[test]
    fn same_mode_is_noop() {
        let (_tmp, pki, rot) = fresh_rotation_with_n_pins(0);
        let pre_seq = pki.snapshot().expect("snap").last_sequence;
        let outcome = rot
            .transition_to(OpcUaPkiMode::LegacyAccept)
            .expect("noop ok");
        let post_seq = pki.snapshot().expect("snap").last_sequence;
        assert_eq!(outcome, TransitionOutcome::NoChange);
        assert_eq!(
            pre_seq, post_seq,
            "no-op transition must NOT append a ledger entry"
        );
    }

    /// Downgrade Strict → Warn rejected.
    #[test]
    fn strict_to_warn_rejected() {
        let (_tmp, _pki, rot) = fresh_rotation_with_n_pins(1);
        rot.transition_to(OpcUaPkiMode::WarnOnMismatch)
            .expect("warn");
        rot.transition_to(OpcUaPkiMode::StrictPinOnly)
            .expect("strict");
        let err = rot
            .transition_to(OpcUaPkiMode::WarnOnMismatch)
            .expect_err("downgrade must reject");
        assert!(matches!(
            err,
            CertRotationError::DowngradeRejected {
                from: OpcUaPkiMode::StrictPinOnly,
                to: OpcUaPkiMode::WarnOnMismatch,
            }
        ));
        // State unchanged.
        assert_eq!(rot.mode(), OpcUaPkiMode::StrictPinOnly);
    }

    /// Downgrade Strict → Legacy rejected.
    #[test]
    fn strict_to_legacy_rejected() {
        let (_tmp, _pki, rot) = fresh_rotation_with_n_pins(1);
        rot.transition_to(OpcUaPkiMode::WarnOnMismatch)
            .expect("warn");
        rot.transition_to(OpcUaPkiMode::StrictPinOnly)
            .expect("strict");
        let err = rot
            .transition_to(OpcUaPkiMode::LegacyAccept)
            .expect_err("downgrade must reject");
        assert!(matches!(
            err,
            CertRotationError::DowngradeRejected {
                from: OpcUaPkiMode::StrictPinOnly,
                to: OpcUaPkiMode::LegacyAccept,
            }
        ));
    }

    /// Downgrade Warn → Legacy rejected.
    #[test]
    fn warn_to_legacy_rejected() {
        let (_tmp, _pki, rot) = fresh_rotation_with_n_pins(1);
        rot.transition_to(OpcUaPkiMode::WarnOnMismatch)
            .expect("warn");
        let err = rot
            .transition_to(OpcUaPkiMode::LegacyAccept)
            .expect_err("downgrade must reject");
        assert!(matches!(
            err,
            CertRotationError::DowngradeRejected {
                from: OpcUaPkiMode::WarnOnMismatch,
                to: OpcUaPkiMode::LegacyAccept,
            }
        ));
    }

    /// Strict + zero pinned certs rejected as `StrictWithEmptyPinSet`.
    #[test]
    fn strict_with_empty_pin_set_rejected() {
        let (_tmp, _pki, rot) = fresh_rotation_with_n_pins(0);
        let err = rot
            .transition_to(OpcUaPkiMode::StrictPinOnly)
            .expect_err("must reject");
        assert!(matches!(err, CertRotationError::StrictWithEmptyPinSet));
        assert_eq!(rot.mode(), OpcUaPkiMode::LegacyAccept);
    }

    /// Strict + non-zero pinned certs accepted.
    #[test]
    fn strict_with_non_empty_pin_set_accepted() {
        let (_tmp, _pki, rot) = fresh_rotation_with_n_pins(2);
        rot.transition_to(OpcUaPkiMode::StrictPinOnly)
            .expect("ok with 2 pins");
        assert_eq!(rot.mode(), OpcUaPkiMode::StrictPinOnly);
    }

    /// `trust_unpinned_clients` matches the architectural intent table.
    #[test]
    fn trust_unpinned_clients_matrix() {
        assert!(OpcUaPkiMode::LegacyAccept.trust_unpinned_clients());
        assert!(OpcUaPkiMode::WarnOnMismatch.trust_unpinned_clients());
        assert!(!OpcUaPkiMode::StrictPinOnly.trust_unpinned_clients());
    }

    /// Strictness ordering matches the architectural rank.
    #[test]
    fn strictness_ordering_is_monotonic() {
        assert!(
            OpcUaPkiMode::LegacyAccept.strictness() < OpcUaPkiMode::WarnOnMismatch.strictness()
        );
        assert!(
            OpcUaPkiMode::WarnOnMismatch.strictness() < OpcUaPkiMode::StrictPinOnly.strictness()
        );
    }

    /// Wire labels match the serde snake_case rename + ledger entry
    /// from_mode/to_mode strings used by PkiStore::append_phase_transition.
    #[test]
    fn wire_labels_are_snake_case() {
        assert_eq!(OpcUaPkiMode::LegacyAccept.wire_label(), "legacy_accept");
        assert_eq!(
            OpcUaPkiMode::WarnOnMismatch.wire_label(),
            "warn_on_mismatch"
        );
        assert_eq!(OpcUaPkiMode::StrictPinOnly.wire_label(), "strict_pin_only");
    }

    /// Ledger entry fires on successful transition (sequence advances).
    #[test]
    fn successful_transition_appends_ledger() {
        let (_tmp, pki, rot) = fresh_rotation_with_n_pins(1);
        let pre_seq = pki.snapshot().expect("snap").last_sequence;
        rot.transition_to(OpcUaPkiMode::WarnOnMismatch).expect("ok");
        let post_seq = pki.snapshot().expect("snap").last_sequence;
        assert_eq!(post_seq, pre_seq + 1);
    }

    /// Failed transition (downgrade rejected) does NOT append a ledger
    /// entry — the audit chain reflects only successful applies.
    #[test]
    fn rejected_transition_does_not_append_ledger() {
        let (_tmp, pki, rot) = fresh_rotation_with_n_pins(1);
        rot.transition_to(OpcUaPkiMode::WarnOnMismatch).expect("ok");
        let pre_seq = pki.snapshot().expect("snap").last_sequence;
        let _ = rot
            .transition_to(OpcUaPkiMode::LegacyAccept)
            .expect_err("downgrade rejected");
        let post_seq = pki.snapshot().expect("snap").last_sequence;
        assert_eq!(
            pre_seq, post_seq,
            "rejected transition MUST NOT advance the ledger"
        );
    }

    /// `OpcUaPkiMode` JSON roundtrip stable — wire shape audited by
    /// future cloud manifest deser path.
    #[test]
    fn mode_json_roundtrip_snake_case() {
        for m in [
            OpcUaPkiMode::LegacyAccept,
            OpcUaPkiMode::WarnOnMismatch,
            OpcUaPkiMode::StrictPinOnly,
        ] {
            let json = serde_json::to_string(&m).expect("ser");
            let back: OpcUaPkiMode = serde_json::from_str(&json).expect("deser");
            assert_eq!(back, m);
            assert!(json.contains(m.wire_label()));
        }
    }

    /// Compile-time anchor for `CertFingerprint` linkage — exercises
    /// the public API at the rotation module boundary.
    #[test]
    fn fingerprint_module_link() {
        let fp = CertFingerprint::from_der(b"x");
        assert_eq!(fp.as_hex().len(), 64);
    }

    // ====================================================================
    // Phase B-1.5 — load_from_pki_store ledger walker tests
    // ====================================================================

    /// First-boot ledger (only Genesis entry, no PhaseTransition) yields
    /// `LegacyAccept` — the in-place-upgrade contract from pre-Phase-B-1.
    #[test]
    fn load_from_pki_store_first_boot_returns_legacy_accept() {
        let (_tmp, pki, _rot_old) = fresh_rotation_with_n_pins(0);
        // No transitions recorded — only Genesis.
        let rot = CertRotation::load_from_pki_store(pki.clone())
            .expect("walker must succeed on first-boot ledger");
        assert_eq!(rot.mode(), OpcUaPkiMode::LegacyAccept);
    }

    /// After a promotion to Warn, the walker recovers Warn on next boot.
    #[test]
    fn load_from_pki_store_recovers_warn_after_promotion() {
        let (_tmp, pki, rot) = fresh_rotation_with_n_pins(1);
        rot.transition_to(OpcUaPkiMode::WarnOnMismatch)
            .expect("promote to warn");
        // Drop the in-memory CertRotation; reload from ledger.
        drop(rot);
        let rot2 = CertRotation::load_from_pki_store(pki.clone()).expect("reload from ledger");
        assert_eq!(rot2.mode(), OpcUaPkiMode::WarnOnMismatch);
    }

    /// After Legacy → Warn → Strict, walker recovers Strict (most recent
    /// PhaseTransition wins).
    #[test]
    fn load_from_pki_store_recovers_strict_after_full_promotion() {
        let (_tmp, pki, rot) = fresh_rotation_with_n_pins(1);
        rot.transition_to(OpcUaPkiMode::WarnOnMismatch)
            .expect("warn");
        rot.transition_to(OpcUaPkiMode::StrictPinOnly)
            .expect("strict");
        drop(rot);
        let rot2 = CertRotation::load_from_pki_store(pki.clone()).expect("reload");
        assert_eq!(rot2.mode(), OpcUaPkiMode::StrictPinOnly);
    }

    /// Cert-trust entries between phase transitions don't affect the
    /// walker — only the most recent PhaseTransition matters.
    #[test]
    fn load_from_pki_store_ignores_cert_entries_after_phase() {
        let (_tmp, pki, rot) = fresh_rotation_with_n_pins(1);
        rot.transition_to(OpcUaPkiMode::WarnOnMismatch)
            .expect("warn");
        // Add another cert AFTER the transition — should not change
        // the recovered mode.
        pki.add_trusted_cert(b"POST_TRANSITION_CERT", "post".to_string())
            .expect("add post-transition cert");
        drop(rot);
        let rot2 = CertRotation::load_from_pki_store(pki.clone()).expect("reload");
        assert_eq!(rot2.mode(), OpcUaPkiMode::WarnOnMismatch);
    }

    /// `parse_wire_label` round-trips with [`OpcUaPkiMode::wire_label`]
    /// for all 3 variants — drift between the two functions surfaces
    /// at test time.
    #[test]
    fn parse_wire_label_round_trips_all_variants() {
        for m in [
            OpcUaPkiMode::LegacyAccept,
            OpcUaPkiMode::WarnOnMismatch,
            OpcUaPkiMode::StrictPinOnly,
        ] {
            let parsed = parse_wire_label(m.wire_label()).expect("round-trip must succeed");
            assert_eq!(parsed, m);
        }
    }

    /// An unknown wire label surfaces as
    /// `CertRotationError::LedgerWriteFailed` — fail-closed boot rather
    /// than silently treating it as `LegacyAccept`.
    #[test]
    fn parse_wire_label_rejects_unknown_string() {
        let err = parse_wire_label("future_phase_v2").expect_err("unknown label must fail");
        assert!(matches!(err, CertRotationError::LedgerWriteFailed(_)));
    }
}
