//! The edge agent's verifier of the signed statements it relies on
//! (statements.json `verifiers.agent`).
//!
//! `verification_order` runs first and stops at the first failure; after the
//! schema every check of the statement is evaluated and every failing one is
//! reported (statements.json `evaluation`). Each function pins exactly one
//! statement type.
//!
//! The agent has no view of root's key-epoch ratchets, accepted sequences or
//! installed manifest, so the checks a statement's `verified_by.agent.omits`
//! lists are not evaluated: every agent-verified type omits
//! `key-epoch-below-ratchet`, which is why this verifier takes no ratchet at
//! all. For the site config and the RBAC manifest the agent keeps its own
//! version gate (`gates`, persisted under the policy cache, DEC-4.10,
//! DEC-9.9) with the contract's sequence rule: a higher sequence is a new
//! acceptance, an equal sequence is accepted only for the identical
//! statement and is then a re-verification (its window is not applied
//! again), anything else is `sequence-replay`.

use std::collections::{BTreeMap, BTreeSet};

use super::dsse::{Envelope, pae, verify_strict};
use super::encoding::{decode_base64_array, parse_version_core, sha256_hex};
use super::keys::{KeyEntry, KeyStore, KeyView};
use super::registry::{Arch, BoardProfile, EqualSeq, Purpose, Reason, SitePath, StatementType, naming};
use super::statements::{
    ActivationReceipt, Anchor, DeviceBinding, EdgeRelease, RbacManifest, SiteConfig, Statement,
    TrustAnchors, parse_payload,
};

/// Tenant and device the device is bound to: the identity root recorded at
/// first provisioning, which the OS mirrors to the agent (DEC-3.6, DEC-22).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    /// Tenant UUID.
    pub tenant_id: String,
    /// Device UUID.
    pub device_id: String,
}

/// The agent's own version gate of one sequenced statement type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accepted {
    /// Sequence value of the accepted statement.
    pub seq: u64,
    /// Its statement digest.
    pub statement_digest: String,
}

/// The device as the agent sees it.
#[derive(Debug, Clone)]
pub struct AgentDevice {
    /// Board profile of the OS image.
    pub board: BoardProfile,
    /// Its architecture.
    pub arch: Arch,
    /// The device's own hardware binding record (DEC-3.6).
    pub binding: DeviceBinding,
    /// The recorded tenant and device identity.
    pub identity: Identity,
}

/// What the running OS offers an agent release (statements.json
/// `compatibility`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsCompat {
    /// VERSION_ID as an integer tuple.
    pub version: (u64, u64, u64),
    /// Inclusive SUDERRA_AGENT_ABI range.
    pub abi: (u64, u64),
    /// Kernel symbols with a =y or =m line.
    pub kernel_config: BTreeSet<String>,
}

/// Everything one verification is evaluated against.
#[derive(Debug, Clone, Copy)]
pub struct Scope<'a> {
    /// Keys pinned in the OS image.
    pub os_keys: &'a KeyStore,
    /// The device.
    pub device: &'a AgentDevice,
    /// The agent's version gates by statement type.
    pub gates: &'a BTreeMap<StatementType, Accepted>,
    /// Evaluation time (contract timestamp form).
    pub now: &'a str,
}

/// A statement whose envelope, signature and schema verified.
#[derive(Debug, Clone)]
pub struct Verified<T> {
    /// The typed payload.
    pub statement: T,
    /// Statement digest (SHA-256 of the payload bytes).
    pub digest: String,
    /// Epoch of the key that verified it.
    pub key_epoch: u16,
    /// The statement is the identical one the agent's gate already holds:
    /// a re-verification, so the gate is not advanced.
    pub reverified: bool,
}

/// Outcome of one statement verification.
#[derive(Debug, Clone)]
pub struct Verdict<T> {
    /// Every failing reason (empty when accepted).
    pub reasons: BTreeSet<Reason>,
    /// The payload, when verification got past the schema.
    pub verified: Option<Verified<T>>,
}

impl<T> Verdict<T> {
    fn halted(reason: Reason) -> Self {
        Self {
            reasons: BTreeSet::from([reason]),
            verified: None,
        }
    }

    /// The verified statement when no reason failed.
    pub fn accepted(self) -> Result<Verified<T>, BTreeSet<Reason>> {
        match self.verified {
            Some(v) if self.reasons.is_empty() => Ok(v),
            _ => Err(self.reasons),
        }
    }
}

/// Site file bytes by fixed path.
pub type SiteFiles = BTreeMap<SitePath, Vec<u8>>;

/// Whether the agent evaluates check `reason` for statements of type `t`.
fn agent_checks(t: StatementType, reason: Reason) -> bool {
    let spec = t.spec();
    spec.checks.contains(&reason) && !spec.agent_omits.unwrap_or(&[]).contains(&reason)
}

/// Runs `verification_order` for a payload of type `T`.
fn open<T: Statement>(env: &Envelope, keys: KeyView<'_>) -> Result<Verified<T>, Reason> {
    if env.payload_type != T::TYPE.payload_type() {
        return Err(Reason::PayloadTypeMismatch);
    }
    let key: &KeyEntry = keys.get(&env.keyid).ok_or(Reason::KeyUnknown)?;
    if key.purpose != T::TYPE.spec().signing_purpose {
        return Err(Reason::KeyPurposeMismatch);
    }
    // key-epoch-below-ratchet: omitted by the agent for every type it
    // verifies (statements.json verified_by.agent.omits).
    if !verify_strict(&key.raw, &pae(&env.payload_type, &env.payload), &env.signature) {
        return Err(Reason::SignatureInvalid);
    }
    let statement = parse_payload::<T>(&env.payload)?;
    Ok(Verified {
        statement,
        digest: env.statement_digest(),
        key_epoch: key.epoch,
        reverified: false,
    })
}

/// Window, sequence, binding and identity checks shared by every type.
fn generic_checks<T: Statement>(
    v: &mut Verified<T>,
    scope: &Scope<'_>,
    reasons: &mut BTreeSet<Reason>,
) {
    let t = T::TYPE;
    let spec = t.spec();
    if let (true, Some(rule), Some(last)) = (
        agent_checks(t, Reason::SequenceReplay),
        spec.sequence,
        scope.gates.get(&t),
    ) {
        match v.statement.sequence() {
            Some(value) if value > last.seq => {}
            Some(value)
                if value == last.seq
                    && rule.equal == EqualSeq::IdenticalOnly
                    && last.statement_digest == v.digest =>
            {
                // An identical re-presentation is a re-verification.
                v.reverified = true;
            }
            _ => {
                reasons.insert(Reason::SequenceReplay);
            }
        }
    }
    if !v.reverified {
        if let Some((not_before, expires_at)) = v.statement.window() {
            if agent_checks(t, Reason::NotYetValid) && scope.now < not_before {
                reasons.insert(Reason::NotYetValid);
            }
            if agent_checks(t, Reason::Expired) && scope.now >= expires_at {
                reasons.insert(Reason::Expired);
            }
        }
    }
    let device = scope.device;
    if agent_checks(t, Reason::DeviceBindingMismatch)
        && v.statement.binding() != Some(&device.binding)
    {
        reasons.insert(Reason::DeviceBindingMismatch);
    }
    if agent_checks(t, Reason::DeviceIdMismatch)
        && v.statement.device_id() != Some(device.identity.device_id.as_str())
    {
        reasons.insert(Reason::DeviceIdMismatch);
    }
    if agent_checks(t, Reason::TenantMismatch)
        && v.statement.tenant_id() != Some(device.identity.tenant_id.as_str())
    {
        reasons.insert(Reason::TenantMismatch);
    }
}

/// An integer member of an unverified payload, for digest-reference checks.
fn loose_u64(payload: &[u8], field: &str) -> Option<u64> {
    serde_json::from_slice::<serde_json::Value>(payload)
        .ok()?
        .get(field)?
        .as_u64()
}

// ------------------------------------------------------------------ release

/// Verifies a suderra.edge-release.v1 statement against the agent's board
/// (DEC-8.5) and the running OS (DEC-23).
pub fn verify_release(env: &Envelope, scope: &Scope<'_>, os: &OsCompat) -> Verdict<EdgeRelease> {
    let keys = KeyView {
        os: scope.os_keys,
        bundle: None,
    };
    let mut v = match open::<EdgeRelease>(env, keys) {
        Ok(v) => v,
        Err(reason) => return Verdict::halted(reason),
    };
    let mut reasons = BTreeSet::new();
    generic_checks(&mut v, scope, &mut reasons);
    let r = &v.statement;
    let board = r.board_profile.spec();
    let features: BTreeSet<_> = r.cargo_features.iter().copied().collect();
    let expected: BTreeSet<_> = board.cargo_features.iter().copied().collect();
    if r.arch != board.arch
        || r.agent_profile != board.agent_profile
        || features != expected
        || r.artifact.name != naming::artifact_name(&r.version, r.board_profile, r.arch)
    {
        reasons.insert(Reason::ReleaseProfileMismatch);
    }
    if r.board_profile != scope.device.board || r.arch != scope.device.arch {
        reasons.insert(Reason::BoardMismatch);
    }
    match parse_version_core(&r.min_os_version) {
        Some(min) if os.version >= min => {}
        _ => {
            reasons.insert(Reason::OsVersionTooOld);
        }
    }
    if r.agent_abi < os.abi.0 || r.agent_abi > os.abi.1 {
        reasons.insert(Reason::AgentAbiUnsupported);
    }
    if r.required_kernel_config
        .iter()
        .any(|symbol| !os.kernel_config.contains(symbol))
    {
        reasons.insert(Reason::KernelConfigMissing);
    }
    Verdict {
        reasons,
        verified: Some(v),
    }
}

// ------------------------------------------------------------ trust anchors

/// Bundle-only anchors of a bundle, as a key store; `None` when two anchors
/// share a keyid or a slot.
pub fn bundle_keys(bundle: &TrustAnchors) -> Option<KeyStore> {
    let mut keys = Vec::new();
    for anchor in &bundle.anchors {
        let Anchor::Ed25519(a) = anchor else { continue };
        if !a.purpose.bundle_only() {
            continue;
        }
        keys.push(KeyEntry {
            purpose: a.purpose,
            epoch: u16::try_from(a.epoch).ok()?,
            raw: decode_base64_array::<32>(&a.public_key)?,
        });
    }
    KeyStore::from_entries(keys).ok()
}

/// The PEM root certificates of the bundle's `mqtt-ca` anchor (DEC-10.6).
pub fn mqtt_ca_certificates(bundle: &TrustAnchors) -> Vec<&str> {
    bundle
        .anchors
        .iter()
        .filter_map(|anchor| match anchor {
            Anchor::X509(a) => Some(a.certificates.iter().map(String::as_str)),
            Anchor::Ed25519(_) => None,
        })
        .flatten()
        .collect()
}

/// Verifies a suderra.trust-anchors.v1 bundle against the fleet-root pin
/// (DEC-3.7).
pub fn verify_trust_anchors(env: &Envelope, scope: &Scope<'_>) -> Verdict<TrustAnchors> {
    let keys = KeyView {
        os: scope.os_keys,
        bundle: None,
    };
    let mut v = match open::<TrustAnchors>(env, keys) {
        Ok(v) => v,
        Err(reason) => return Verdict::halted(reason),
    };
    let mut reasons = BTreeSet::new();
    generic_checks(&mut v, scope, &mut reasons);
    if !v
        .statement
        .tenant_scope
        .contains(&scope.device.identity.tenant_id)
    {
        reasons.insert(Reason::TenantScopeMismatch);
    }
    let mut slots = BTreeSet::new();
    let mut keyids = BTreeSet::new();
    for anchor in &v.statement.anchors {
        let Anchor::Ed25519(a) = anchor else { continue };
        let raw = decode_base64_array::<32>(&a.public_key);
        let consistent = raw.is_some_and(|raw| sha256_hex(&raw) == a.keyid);
        // One keyid resolves to one (purpose, epoch): a key anchored twice is
        // as ambiguous as a slot anchored twice.
        if !consistent || !slots.insert((a.purpose, a.epoch)) || !keyids.insert(&a.keyid) {
            reasons.insert(Reason::AnchorInvalid);
        }
        if !a.purpose.bundle_only() {
            let pinned = scope.os_keys.get(&a.keyid);
            if pinned.is_none_or(|p| p.purpose != a.purpose || u64::from(p.epoch) != a.epoch) {
                reasons.insert(Reason::AnchorNotOsPinned);
            }
        }
    }
    Verdict {
        reasons,
        verified: Some(v),
    }
}

/// Verifies `ta` and returns its bundle-only keys, merging its reasons.
fn bundle_first(
    ta: &Envelope,
    scope: &Scope<'_>,
    reasons: &mut BTreeSet<Reason>,
) -> Option<KeyStore> {
    let bundle = verify_trust_anchors(ta, scope);
    reasons.extend(bundle.reasons.iter().copied());
    match bundle.accepted() {
        Ok(v) => bundle_keys(&v.statement).or_else(|| {
            reasons.insert(Reason::AnchorInvalid);
            None
        }),
        Err(_) => None,
    }
}

// ------------------------------------------------------------- RBAC manifest

/// Verifies a suderra.rbac-manifest.v1 statement against a verified
/// bundle's anchors (DEC-9.4, DEC-9.9).
pub fn verify_rbac(env: &Envelope, scope: &Scope<'_>, bundle: &KeyStore) -> Verdict<RbacManifest> {
    let keys = KeyView {
        os: scope.os_keys,
        bundle: Some(bundle),
    };
    let mut v = match open::<RbacManifest>(env, keys) {
        Ok(v) => v,
        Err(reason) => return Verdict::halted(reason),
    };
    let mut reasons = BTreeSet::new();
    generic_checks(&mut v, scope, &mut reasons);
    for actor in &v.statement.actors {
        let raw = decode_base64_array::<32>(&actor.public_key);
        let anchored = bundle.get(&actor.keyid);
        let ok = raw.is_some_and(|raw| {
            sha256_hex(&raw) == actor.keyid
                && anchored.is_some_and(|a| a.purpose == Purpose::Command && a.raw == raw)
        });
        if !ok {
            reasons.insert(Reason::ActorKeyNotAnchored);
        }
    }
    Verdict {
        reasons,
        verified: Some(v),
    }
}

/// Verifies an RBAC manifest whose anchors come from `ta`, verified first
/// (statements.json key resolution).
pub fn verify_rbac_with_bundle(
    env: &Envelope,
    ta: &Envelope,
    scope: &Scope<'_>,
) -> Verdict<RbacManifest> {
    if env.payload_type != StatementType::RbacManifest.payload_type() {
        return Verdict::halted(Reason::PayloadTypeMismatch);
    }
    let mut reasons = BTreeSet::new();
    let Some(keys) = bundle_first(ta, scope, &mut reasons) else {
        return Verdict {
            reasons,
            verified: None,
        };
    };
    let mut verdict = verify_rbac(env, scope, &keys);
    verdict.reasons.extend(reasons);
    verdict
}

// --------------------------------------------------------------- site config

/// Verifies a suderra.site-config.v1 statement, its RBAC manifest and the
/// delivered site files against a verified bundle's anchors (DEC-4.10).
pub fn verify_site_config(
    env: &Envelope,
    scope: &Scope<'_>,
    bundle: &KeyStore,
    rbac: &Envelope,
    files: &SiteFiles,
) -> (Verdict<SiteConfig>, Option<Verdict<RbacManifest>>) {
    let keys = KeyView {
        os: scope.os_keys,
        bundle: Some(bundle),
    };
    let mut v = match open::<SiteConfig>(env, keys) {
        Ok(v) => v,
        Err(reason) => return (Verdict::halted(reason), None),
    };
    let mut reasons = BTreeSet::new();
    generic_checks(&mut v, scope, &mut reasons);
    let named = &v.statement.files;
    let files_ok = named.keys().eq(files.keys())
        && named.iter().all(|(path, entry)| {
            files.get(path).is_some_and(|bytes| {
                sha256_hex(bytes) == entry.digest.sha256
                    && u64::try_from(bytes.len()).is_ok_and(|n| n == entry.size_bytes)
            })
        });
    if !files_ok {
        reasons.insert(Reason::SiteFileDigestMismatch);
    }
    let rbac_verdict = verify_rbac(rbac, scope, bundle);
    reasons.extend(rbac_verdict.reasons.iter().copied());
    let reference = &v.statement.rbac_manifest;
    let policy_version = rbac_verdict
        .verified
        .as_ref()
        .map(|r| r.statement.policy_version)
        .or_else(|| loose_u64(&rbac.payload, "policy_version"));
    if reference.digest.sha256 != rbac.statement_digest()
        || policy_version != Some(reference.policy_version)
    {
        reasons.insert(Reason::RbacManifestDigestMismatch);
    }
    (
        Verdict {
            reasons,
            verified: Some(v),
        },
        Some(rbac_verdict),
    )
}

/// Verifies a site config whose anchors come from `ta`, verified first.
pub fn verify_site_config_with_bundle(
    env: &Envelope,
    ta: &Envelope,
    scope: &Scope<'_>,
    rbac: &Envelope,
    files: &SiteFiles,
) -> Verdict<SiteConfig> {
    if env.payload_type != StatementType::SiteConfig.payload_type() {
        return Verdict::halted(Reason::PayloadTypeMismatch);
    }
    let mut reasons = BTreeSet::new();
    let Some(keys) = bundle_first(ta, scope, &mut reasons) else {
        return Verdict {
            reasons,
            verified: None,
        };
    };
    let (mut verdict, _) = verify_site_config(env, scope, &keys, rbac, files);
    verdict.reasons.extend(reasons);
    verdict
}

// ------------------------------------------------------- activation receipt

/// Verifies a suderra.edge-activation-receipt.v1 before the agent writes it
/// for root (DEC-5.8). `manifest-digest-mismatch` is root's check: the agent
/// cannot see which manifest root installed.
pub fn verify_receipt(env: &Envelope, scope: &Scope<'_>) -> Verdict<ActivationReceipt> {
    let keys = KeyView {
        os: scope.os_keys,
        bundle: None,
    };
    let mut v = match open::<ActivationReceipt>(env, keys) {
        Ok(v) => v,
        Err(reason) => return Verdict::halted(reason),
    };
    let mut reasons = BTreeSet::new();
    generic_checks(&mut v, scope, &mut reasons);
    Verdict {
        reasons,
        verified: Some(v),
    }
}
