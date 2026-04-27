//! Keystore selector — boot-time backend resolution
//! (Batch #312 closes ULTRA-HIGH-015 D-1a parent finding).
//!
//! ## Why a selector exists
//!
//! ADR-018 §4 + ADR-019 §7 mandate a backend priority order:
//!
//!   1. TPM NV-sealed (highest trust)            — Batch #308 TpmKeystore primitive split,
//!                                                 #309 RealTpmDevice (lands in a
//!                                                 future batch — needs libtss2-dev
//!                                                 build environment + swtpm CI).
//!   2. systemd-creds (medium trust)             — not yet implemented; ADR-018 §4
//!                                                 backend slot reserved.
//!   3. File-backed Argon2id (operator-gated)    — Batch #82 FileBackedKeystore.
//!
//! The `KeystoreSelector` is the single source of truth that
//! picks the right backend at boot. Its consumers (audit sink,
//! offline_queue, replay-cache, license verifier, signed
//! command envelope verifier) see only `Arc<dyn Keystore>` —
//! they never know or care which backend produced the master.
//!
//! ## Architectural fall-back rules
//!
//! Two concerns drive the fall-back policy: (a) a selector that
//! silently downgrades on ANY TPM failure would mask a tamper
//! signal (an attacker who fakes `PolicyUnsatisfied` could push
//! the system to a weaker backend); (b) a selector that
//! NEVER falls back forces operators with no TPM hardware to
//! deploy without a keystore (worse posture).
//!
//! The compromise: fall-back is allowed ONLY on a NARROW set
//! of `TpmUnavailable` causes (no /dev/tpm device, kernel
//! ENOSYS, factory not provided). It is NOT allowed on
//! `MasterUnsealFailed` (PCR mismatch / NV counter rollback /
//! sealed blob tampered) — those signal active compromise and
//! the selector hard-fails so the operator notices.
//!
//! See `FallbackPolicy` for the exact rules + the
//! `policy_explanation()` helper for operator messaging.
//!
//! ## Why the factory abstraction
//!
//! The selector takes a `TpmDeviceFactory` trait object so:
//!
//! - Default-feature builds use `NullTpmDeviceFactory` (returns
//!   None, selector skips TPM, picks FileBacked).
//! - `--features tpm` builds will use a `RealTpmDeviceFactory`
//!   that wraps tss-esapi (lands in a future batch when
//!   libtss2-dev is in the build env).
//! - Tests use `MockTpmDeviceFactory` constructing a
//!   `MockTpmDevice` per the Batch #308 mock pattern.
//!
//! The factory returns `Option<Arc<dyn TpmDevice>>` —
//! `None` means "no TPM available, skip"; `Some(_)` means
//! "TPM available, proceed". This decouples device probing
//! from device construction at the type level.

use std::path::PathBuf;
use std::sync::Arc;

use tracing::{info, warn};

use super::acceptance::FileBackedAcceptance;
use super::error::{KeystoreError, KeystoreErrorKind};
use super::file_backed::{Argon2idParams, FileBackedKeystore};
use super::tpm_backed::{TpmDevice, TpmKeystore, TpmKeystoreConfig};
use super::Keystore;

/// Trait abstraction for "construct a TPM device if one is
/// available on this host". Returns `None` when no TPM is
/// reachable; returns `Some(Arc<dyn TpmDevice>)` when the
/// caller should proceed with TPM-backed keystore.
///
/// The factory itself does NOT do the keystore-level open
/// (that's `TpmKeystore::open`'s responsibility); it only
/// ensures device-level reachability.
pub trait TpmDeviceFactory: Send + Sync + 'static {
    fn try_create(
        &self,
        config: &TpmKeystoreConfig,
    ) -> Option<Arc<dyn TpmDevice>>;
}

/// `NullTpmDeviceFactory` — always returns None. Used by
/// default-feature builds (no `--features tpm`) and by
/// "FileBacked only" deployment configurations.
pub struct NullTpmDeviceFactory;

impl TpmDeviceFactory for NullTpmDeviceFactory {
    fn try_create(
        &self,
        _config: &TpmKeystoreConfig,
    ) -> Option<Arc<dyn TpmDevice>> {
        None
    }
}

/// Fall-back policy controlling how the selector behaves
/// when the higher-trust backend is unavailable or fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackPolicy {
    /// Strict TPM-only: factory MUST return Some + TpmKeystore::open
    /// MUST succeed. Any failure aborts boot. Used by deployments
    /// with TPM-mandatory regulatory requirements (IEC 62443 SL-3
    /// candidates).
    TpmOnly,

    /// Prefer TPM, fall back to FileBacked on
    /// `TpmUnavailable` (factory returned None, or device
    /// probe ENOSYS).
    ///
    /// CRITICAL: do NOT fall back on `MasterUnsealFailed` —
    /// PCR mismatch / NV counter rollback / sealed blob
    /// tampered are tamper signals; falling back would
    /// downgrade an attacker-induced state into a weaker
    /// backend silently. The selector hard-fails instead so
    /// the operator notices in the journal.
    PreferTpmFallbackToFileBackedOnTpmUnavailable,

    /// FileBacked only — used when TPM is not part of the
    /// deployment posture. Skips TPM entirely; goes straight
    /// to FileBacked + acceptance check.
    FileBackedOnly,
}

impl FallbackPolicy {
    /// Operator-readable one-line explanation of the policy.
    /// Used in boot-log lines + audit emission so the runtime
    /// posture is documented from the journal alone.
    pub fn policy_explanation(self) -> &'static str {
        match self {
            Self::TpmOnly => {
                "TPM-only — any TPM unavailability aborts boot \
                 (regulatory deployment posture)"
            }
            Self::PreferTpmFallbackToFileBackedOnTpmUnavailable => {
                "Prefer TPM; fall back to FileBacked ONLY on \
                 TPM unavailable (NEVER on tamper signals \
                 like PCR mismatch / counter rollback)"
            }
            Self::FileBackedOnly => {
                "FileBacked only (TPM not part of deployment \
                 posture); requires valid acceptance token"
            }
        }
    }
}

/// Configuration for `KeystoreSelector::resolve`. Owns paths +
/// optional source-specific configs + the fallback policy.
///
/// Construction note: most fields are `Option<>` so deployments
/// that don't need TPM (e.g., dev environments) can omit
/// `tpm_config`; deployments that don't need FileBacked (e.g.,
/// strict TPM-only) can omit `file_backed_passphrase_path` etc.
/// `validate()` enforces "at least one viable backend per the
/// fallback policy".
pub struct KeystoreSelectorConfig {
    /// TPM-side config — `None` means "no TPM in this
    /// deployment". When `Some`, the factory is asked to
    /// create a TpmDevice + TpmKeystore::open is invoked.
    pub tpm_config: Option<TpmKeystoreConfig>,

    /// Path to the operator-supplied passphrase file
    /// (FileBacked path). `None` means "no FileBacked in
    /// this deployment".
    pub file_backed_passphrase_path: Option<PathBuf>,
    /// Path to the salt file (FileBacked path).
    pub file_backed_salt_path: Option<PathBuf>,
    /// Argon2id parameters (FileBacked path).
    pub file_backed_argon2_params: Argon2idParams,
    /// Operator-signed acceptance token (FileBacked path).
    /// FileBackedKeystore::open hard-fails without it.
    pub file_backed_acceptance: Option<FileBackedAcceptance>,

    /// Fall-back policy controlling priority + fall-through
    /// behaviour.
    pub policy: FallbackPolicy,
}

impl KeystoreSelectorConfig {
    /// Validate that the config is internally consistent
    /// with the chosen policy:
    ///
    /// - `TpmOnly` requires `tpm_config: Some`.
    /// - `FileBackedOnly` requires the FileBacked path
    ///   triple + acceptance.
    /// - `PreferTpmFallbackToFileBackedOnTpmUnavailable`
    ///   requires the FileBacked path triple + acceptance
    ///   (so the fall-back is actually reachable) AND
    ///   `tpm_config: Some` (so the preferred path is
    ///   reachable).
    pub fn validate(&self) -> Result<(), String> {
        match self.policy {
            FallbackPolicy::TpmOnly => {
                if self.tpm_config.is_none() {
                    return Err(
                        "policy=TpmOnly requires tpm_config Some".to_string(),
                    );
                }
            }
            FallbackPolicy::FileBackedOnly => {
                self.require_file_backed_complete("policy=FileBackedOnly")?;
            }
            FallbackPolicy::PreferTpmFallbackToFileBackedOnTpmUnavailable => {
                if self.tpm_config.is_none() {
                    return Err(
                        "policy=PreferTpmFallbackToFileBackedOnTpmUnavailable \
                         requires tpm_config Some (preferred path unreachable)"
                            .to_string(),
                    );
                }
                self.require_file_backed_complete(
                    "policy=PreferTpmFallbackToFileBackedOnTpmUnavailable",
                )?;
            }
        }
        // TPM config validation (when present).
        if let Some(t) = &self.tpm_config {
            t.validate()
                .map_err(|e| format!("tpm_config invalid: {}", e))?;
        }
        // FileBacked params validation (when present).
        if self.file_backed_passphrase_path.is_some() {
            self.file_backed_argon2_params.validate().map_err(|e| {
                format!("file_backed_argon2_params invalid: {}", e)
            })?;
        }
        Ok(())
    }

    fn require_file_backed_complete(&self, label: &str) -> Result<(), String> {
        if self.file_backed_passphrase_path.is_none() {
            return Err(format!(
                "{} requires file_backed_passphrase_path Some",
                label
            ));
        }
        if self.file_backed_salt_path.is_none() {
            return Err(format!(
                "{} requires file_backed_salt_path Some",
                label
            ));
        }
        if self.file_backed_acceptance.is_none() {
            return Err(format!(
                "{} requires file_backed_acceptance Some \
                 (operator MUST sign acceptance token; \
                 unsigned fallback is FORBIDDEN per ADR-018 §5)",
                label
            ));
        }
        Ok(())
    }
}

/// Selector facade. Holds the `KeystoreSelectorConfig` + a
/// `TpmDeviceFactory` reference and exposes `resolve()` which
/// applies the policy + returns `Arc<dyn Keystore>` or a
/// structured error.
pub struct KeystoreSelector<'a, F: TpmDeviceFactory> {
    pub config: KeystoreSelectorConfig,
    pub tpm_factory: &'a F,
}

impl<'a, F: TpmDeviceFactory> KeystoreSelector<'a, F> {
    pub fn new(
        config: KeystoreSelectorConfig,
        tpm_factory: &'a F,
    ) -> Result<Self, KeystoreError> {
        config.validate().map_err(|e| {
            KeystoreError::new(
                KeystoreErrorKind::Configuration,
                format!("KeystoreSelectorConfig invalid: {}", e),
            )
        })?;
        Ok(Self {
            config,
            tpm_factory,
        })
    }

    /// Apply the fall-back policy + return the selected
    /// keystore. See module-level docs for the exact rules.
    pub fn resolve(self) -> Result<Arc<dyn Keystore>, KeystoreError> {
        info!(
            "KeystoreSelector resolving: policy={:?} ({})",
            self.config.policy,
            self.config.policy.policy_explanation()
        );

        match self.config.policy {
            FallbackPolicy::TpmOnly => self.try_tpm_strict(),
            FallbackPolicy::FileBackedOnly => self.try_file_backed_strict(),
            FallbackPolicy::PreferTpmFallbackToFileBackedOnTpmUnavailable => {
                self.try_tpm_with_fallback()
            }
        }
    }

    fn try_tpm_strict(self) -> Result<Arc<dyn Keystore>, KeystoreError> {
        let tpm_cfg = self.config.tpm_config.ok_or_else(|| {
            KeystoreError::new(
                KeystoreErrorKind::Configuration,
                "TpmOnly policy but tpm_config is None (validate() bug?)".to_string(),
            )
        })?;
        let device = self.tpm_factory.try_create(&tpm_cfg).ok_or_else(|| {
            KeystoreError::new(
                KeystoreErrorKind::TpmUnavailable,
                "TpmOnly policy: factory returned None — no TPM device \
                 reachable. Aborting boot per regulatory posture."
                    .to_string(),
            )
        })?;
        let keystore = TpmKeystore::open(device, tpm_cfg)?;
        info!("KeystoreSelector resolved: backend=Tpm (strict)");
        Ok(Arc::new(keystore))
    }

    fn try_file_backed_strict(self) -> Result<Arc<dyn Keystore>, KeystoreError> {
        let passphrase = self
            .config
            .file_backed_passphrase_path
            .ok_or_else(|| {
                KeystoreError::new(
                    KeystoreErrorKind::Configuration,
                    "FileBackedOnly policy but passphrase_path is None \
                     (validate() bug?)"
                        .to_string(),
                )
            })?;
        let salt = self.config.file_backed_salt_path.ok_or_else(|| {
            KeystoreError::new(
                KeystoreErrorKind::Configuration,
                "FileBackedOnly policy but salt_path is None (validate() bug?)"
                    .to_string(),
            )
        })?;
        let acceptance = self.config.file_backed_acceptance.ok_or_else(|| {
            KeystoreError::new(
                KeystoreErrorKind::FileBackedAcceptanceMissing,
                "FileBackedOnly policy but acceptance is None — \
                 operator MUST sign acceptance token per ADR-018 §5"
                    .to_string(),
            )
        })?;
        let keystore = FileBackedKeystore::open(
            &passphrase,
            &salt,
            self.config.file_backed_argon2_params,
            acceptance,
        )?;
        info!("KeystoreSelector resolved: backend=FileBacked (strict)");
        Ok(Arc::new(keystore))
    }

    fn try_tpm_with_fallback(self) -> Result<Arc<dyn Keystore>, KeystoreError> {
        // Borrow what we need; consume self's fields piecewise
        // because self::resolve consumed `self`.
        let tpm_cfg = self
            .config
            .tpm_config
            .clone()
            .expect("validate() guarantees Some");

        // Try TPM device factory first.
        let device_opt = self.tpm_factory.try_create(&tpm_cfg);
        if let Some(device) = device_opt {
            // Device reachable — try TpmKeystore::open. If
            // PolicyUnsatisfied / MasterUnsealFailed, hard-fail
            // (do NOT fall back — those are tamper signals).
            // If MasterMissing (NotProvisioned) or
            // TpmUnavailable, also do NOT fall back: an
            // operator who provided tpm_config expects a
            // provisioned + reachable TPM; falling back would
            // mask a misconfiguration.
            //
            // Architectural trade-off: this batch's
            // PreferTpm... policy falls back ONLY when the
            // factory itself returns None (device
            // unreachable). Once we have a device, we commit
            // to it.
            let keystore = TpmKeystore::open(device, tpm_cfg)?;
            info!("KeystoreSelector resolved: backend=Tpm (preferred + reached)");
            return Ok(Arc::new(keystore));
        }

        // Factory returned None — TPM device unreachable. Fall
        // back to FileBacked.
        warn!(
            "KeystoreSelector: TPM factory returned None — \
             falling back to FileBacked per policy. Operators \
             should verify the TPM hardware is connected + \
             /dev/tpmrm0 readable; falling back to a weaker \
             backend in production is a posture downgrade."
        );
        // Re-construct a strict-FileBacked selector locally
        // and run its resolve.
        let fallback_cfg = KeystoreSelectorConfig {
            tpm_config: None,
            file_backed_passphrase_path: self.config.file_backed_passphrase_path,
            file_backed_salt_path: self.config.file_backed_salt_path,
            file_backed_argon2_params: self.config.file_backed_argon2_params,
            file_backed_acceptance: self.config.file_backed_acceptance,
            policy: FallbackPolicy::FileBackedOnly,
        };
        // Skip re-validation (we just constructed it from
        // already-validated fields).
        let fallback = KeystoreSelector {
            config: fallback_cfg,
            tpm_factory: self.tpm_factory,
        };
        fallback.try_file_backed_strict()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::tpm_backed::{MockTpmDevice, NvCounterValue};
    use std::path::PathBuf;
    use std::time::SystemTime;

    /// `MockTpmDeviceFactory` — always returns
    /// `Some(Arc::new(MockTpmDevice))`. Use the
    /// `pre_provisioned` flag to control whether the mock
    /// has a master sealed in it.
    struct MockTpmDeviceFactory {
        pre_provisioned: bool,
        master: [u8; 32],
        counter: NvCounterValue,
    }

    impl TpmDeviceFactory for MockTpmDeviceFactory {
        fn try_create(
            &self,
            _config: &TpmKeystoreConfig,
        ) -> Option<Arc<dyn TpmDevice>> {
            let device = if self.pre_provisioned {
                MockTpmDevice::pre_provisioned(self.master, self.counter)
            } else {
                MockTpmDevice::new()
            };
            Some(Arc::new(device))
        }
    }

    /// Always-None factory — simulates "no TPM reachable".
    struct UnreachableTpmDeviceFactory;
    impl TpmDeviceFactory for UnreachableTpmDeviceFactory {
        fn try_create(
            &self,
            _config: &TpmKeystoreConfig,
        ) -> Option<Arc<dyn TpmDevice>> {
            None
        }
    }

    fn fixtures_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "suderra-selector-test-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    fn write_passphrase_and_salt(dir: &std::path::Path) -> (PathBuf, PathBuf) {
        let pp = dir.join("passphrase");
        let salt = dir.join("salt");
        std::fs::write(&pp, b"correct horse battery staple").unwrap();
        std::fs::write(&salt, [0xa5u8; 32]).unwrap();
        (pp, salt)
    }

    fn build_acceptance() -> FileBackedAcceptance {
        // Mirrors the file_backed.rs test fixture pattern —
        // injected verify_signature returns true; the
        // selector tests do not exercise crypto, only the
        // backend-resolution flow.
        use super::super::acceptance::AcceptanceToken;
        let token = AcceptanceToken {
            operator_id: "op-42".to_string(),
            expires_at_unix_secs: i64::MAX,
            device_id: "dev-123".to_string(),
            signature: vec![0u8; 64],
        };
        FileBackedAcceptance::try_from_parts(
            &token,
            "op-42",
            "dev-123",
            SystemTime::UNIX_EPOCH,
            |_, _| true,
        )
        .expect("valid acceptance for selector test fixture")
    }

    fn cheap_argon2() -> Argon2idParams {
        // OWASP-floor params keep the test fast while
        // exercising the same code path as production.
        Argon2idParams {
            memory_kib: 19_456,
            iterations: 2,
            parallelism: 1,
        }
    }

    #[test]
    fn fallback_policy_explanation_strings_pinned() {
        // Audit-stable identifiers — operator dashboards key
        // on these.
        assert!(FallbackPolicy::TpmOnly
            .policy_explanation()
            .contains("TPM-only"));
        assert!(
            FallbackPolicy::PreferTpmFallbackToFileBackedOnTpmUnavailable
                .policy_explanation()
                .contains("Prefer TPM")
        );
        assert!(FallbackPolicy::FileBackedOnly
            .policy_explanation()
            .contains("FileBacked only"));
    }

    #[test]
    fn validate_rejects_tpm_only_without_tpm_config() {
        let cfg = KeystoreSelectorConfig {
            tpm_config: None,
            file_backed_passphrase_path: None,
            file_backed_salt_path: None,
            file_backed_argon2_params: Argon2idParams::default(),
            file_backed_acceptance: None,
            policy: FallbackPolicy::TpmOnly,
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("TpmOnly") && err.contains("tpm_config Some"));
    }

    #[test]
    fn validate_rejects_file_backed_only_without_acceptance() {
        let cfg = KeystoreSelectorConfig {
            tpm_config: None,
            file_backed_passphrase_path: Some(PathBuf::from("/tmp/x")),
            file_backed_salt_path: Some(PathBuf::from("/tmp/y")),
            file_backed_argon2_params: Argon2idParams::default(),
            file_backed_acceptance: None,
            policy: FallbackPolicy::FileBackedOnly,
        };
        let err = cfg.validate().unwrap_err();
        assert!(
            err.contains("acceptance Some"),
            "expected acceptance-required error: {}",
            err
        );
        assert!(err.contains("ADR-018"));
    }

    #[test]
    fn validate_rejects_prefer_tpm_without_both_sides_complete() {
        // Missing tpm_config.
        let cfg = KeystoreSelectorConfig {
            tpm_config: None,
            file_backed_passphrase_path: Some(PathBuf::from("/tmp/x")),
            file_backed_salt_path: Some(PathBuf::from("/tmp/y")),
            file_backed_argon2_params: Argon2idParams::default(),
            file_backed_acceptance: Some(build_acceptance()),
            policy: FallbackPolicy::PreferTpmFallbackToFileBackedOnTpmUnavailable,
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("tpm_config Some"));

        // Missing file_backed_acceptance (preferred path
        // requires the fallback to be reachable too).
        let cfg2 = KeystoreSelectorConfig {
            tpm_config: Some(TpmKeystoreConfig::production_default()),
            file_backed_passphrase_path: Some(PathBuf::from("/tmp/x")),
            file_backed_salt_path: Some(PathBuf::from("/tmp/y")),
            file_backed_argon2_params: Argon2idParams::default(),
            file_backed_acceptance: None,
            policy: FallbackPolicy::PreferTpmFallbackToFileBackedOnTpmUnavailable,
        };
        let err2 = cfg2.validate().unwrap_err();
        assert!(err2.contains("acceptance Some"));
    }

    /// TpmOnly happy path: factory provides a pre-provisioned
    /// mock, selector resolves to a TPM-backed Arc<dyn Keystore>.
    #[test]
    fn tpm_only_resolves_with_provided_factory() {
        let cfg = KeystoreSelectorConfig {
            tpm_config: Some(TpmKeystoreConfig::production_default()),
            file_backed_passphrase_path: None,
            file_backed_salt_path: None,
            file_backed_argon2_params: Argon2idParams::default(),
            file_backed_acceptance: None,
            policy: FallbackPolicy::TpmOnly,
        };
        let factory = MockTpmDeviceFactory {
            pre_provisioned: true,
            master: [0x33u8; 32],
            counter: NvCounterValue(7),
        };
        let selector = KeystoreSelector::new(cfg, &factory).unwrap();
        let ks = selector.resolve().expect("resolve succeeds");
        assert_eq!(ks.backend(), super::super::KeyBackend::Tpm);
    }

    /// TpmOnly hard-fail path: factory returns None — selector
    /// MUST abort with TpmUnavailable + a structured operator
    /// message naming the regulatory posture.
    #[test]
    fn tpm_only_hard_fails_on_unreachable_factory() {
        let cfg = KeystoreSelectorConfig {
            tpm_config: Some(TpmKeystoreConfig::production_default()),
            file_backed_passphrase_path: None,
            file_backed_salt_path: None,
            file_backed_argon2_params: Argon2idParams::default(),
            file_backed_acceptance: None,
            policy: FallbackPolicy::TpmOnly,
        };
        let factory = UnreachableTpmDeviceFactory;
        let selector = KeystoreSelector::new(cfg, &factory).unwrap();
        // Use match (not unwrap_err) — Arc<dyn Keystore>
        // does not implement Debug; adding Debug as a
        // supertrait of Keystore would force every backend
        // to ship a manual redaction-Debug impl. The match
        // shape is the architectural fit for tests on a
        // trait-object Result.
        let err = match selector.resolve() {
            Ok(_) => panic!("expected resolve to fail"),
            Err(e) => e,
        };
        assert_eq!(err.kind, KeystoreErrorKind::TpmUnavailable);
        assert!(err.context.contains("regulatory"));
    }

    /// FileBackedOnly happy path: passphrase + salt + acceptance
    /// all provided; selector resolves to FileBacked Arc<dyn Keystore>.
    #[test]
    fn file_backed_only_resolves_with_complete_config() {
        let dir = fixtures_dir();
        let (pp, salt) = write_passphrase_and_salt(&dir);
        let cfg = KeystoreSelectorConfig {
            tpm_config: None,
            file_backed_passphrase_path: Some(pp),
            file_backed_salt_path: Some(salt),
            file_backed_argon2_params: cheap_argon2(),
            file_backed_acceptance: Some(build_acceptance()),
            policy: FallbackPolicy::FileBackedOnly,
        };
        let factory = NullTpmDeviceFactory;
        let selector = KeystoreSelector::new(cfg, &factory).unwrap();
        let ks = selector.resolve().expect("resolve succeeds");
        assert_eq!(ks.backend(), super::super::KeyBackend::FileBacked);
    }

    /// PreferTpmFallback happy path: factory provides a TPM,
    /// selector picks TPM (does NOT fall through to FileBacked).
    #[test]
    fn prefer_tpm_picks_tpm_when_reachable() {
        let dir = fixtures_dir();
        let (pp, salt) = write_passphrase_and_salt(&dir);
        let cfg = KeystoreSelectorConfig {
            tpm_config: Some(TpmKeystoreConfig::production_default()),
            file_backed_passphrase_path: Some(pp),
            file_backed_salt_path: Some(salt),
            file_backed_argon2_params: cheap_argon2(),
            file_backed_acceptance: Some(build_acceptance()),
            policy: FallbackPolicy::PreferTpmFallbackToFileBackedOnTpmUnavailable,
        };
        let factory = MockTpmDeviceFactory {
            pre_provisioned: true,
            master: [0x99u8; 32],
            counter: NvCounterValue(1),
        };
        let selector = KeystoreSelector::new(cfg, &factory).unwrap();
        let ks = selector.resolve().expect("resolve succeeds");
        assert_eq!(ks.backend(), super::super::KeyBackend::Tpm);
    }

    /// PreferTpmFallback fall-through path: factory returns
    /// None (TPM unreachable), selector falls through to
    /// FileBacked. Operator-visible warn log is emitted (not
    /// asserted in unit test; behavior pinned in module-level
    /// architectural docs).
    #[test]
    fn prefer_tpm_falls_through_to_file_backed_on_unreachable_factory() {
        let dir = fixtures_dir();
        let (pp, salt) = write_passphrase_and_salt(&dir);
        let cfg = KeystoreSelectorConfig {
            tpm_config: Some(TpmKeystoreConfig::production_default()),
            file_backed_passphrase_path: Some(pp),
            file_backed_salt_path: Some(salt),
            file_backed_argon2_params: cheap_argon2(),
            file_backed_acceptance: Some(build_acceptance()),
            policy: FallbackPolicy::PreferTpmFallbackToFileBackedOnTpmUnavailable,
        };
        let factory = UnreachableTpmDeviceFactory;
        let selector = KeystoreSelector::new(cfg, &factory).unwrap();
        let ks = selector.resolve().expect("fallback succeeds");
        assert_eq!(ks.backend(), super::super::KeyBackend::FileBacked);
    }

    /// PreferTpmFallback DOES NOT fall through on a tamper
    /// signal: factory returns Some + the TpmKeystore::open
    /// rejects with MasterUnsealFailed (rolled-back blob).
    /// Selector MUST hard-fail with the same error class —
    /// silent downgrade would mask the tamper signal.
    #[test]
    fn prefer_tpm_hard_fails_on_tamper_signal_does_not_downgrade() {
        let dir = fixtures_dir();
        let (pp, salt) = write_passphrase_and_salt(&dir);
        let cfg = KeystoreSelectorConfig {
            tpm_config: Some(TpmKeystoreConfig::production_default()),
            file_backed_passphrase_path: Some(pp),
            file_backed_salt_path: Some(salt),
            file_backed_argon2_params: cheap_argon2(),
            file_backed_acceptance: Some(build_acceptance()),
            policy: FallbackPolicy::PreferTpmFallbackToFileBackedOnTpmUnavailable,
        };
        // Mock device pre-provisioned at counter=2 but on-chip
        // counter=9 (attacker restored old backup; on-chip
        // advanced). TpmKeystore::open will reject with
        // MasterUnsealFailed(rollback_detected).
        struct TamperingFactory;
        impl TpmDeviceFactory for TamperingFactory {
            fn try_create(
                &self,
                _: &TpmKeystoreConfig,
            ) -> Option<Arc<dyn TpmDevice>> {
                let dev = MockTpmDevice::pre_provisioned(
                    [0u8; 32],
                    NvCounterValue(2),
                );
                dev.force_on_chip_counter(NvCounterValue(9));
                Some(Arc::new(dev))
            }
        }
        let factory = TamperingFactory;
        let selector = KeystoreSelector::new(cfg, &factory).unwrap();
        let err = match selector.resolve() {
            Ok(_) => panic!("expected tamper-signal hard-fail; resolve returned Ok"),
            Err(e) => e,
        };
        assert_eq!(
            err.kind,
            KeystoreErrorKind::MasterUnsealFailed,
            "tamper signal MUST hard-fail; got {:?}",
            err
        );
        assert!(err.context.contains("rollback_detected"));
    }

    /// NullTpmDeviceFactory always returns None — used by
    /// default-feature builds (no --features tpm) and by
    /// FileBackedOnly deployments.
    #[test]
    fn null_tpm_device_factory_returns_none() {
        let f = NullTpmDeviceFactory;
        let cfg = TpmKeystoreConfig::production_default();
        assert!(f.try_create(&cfg).is_none());
    }
}
