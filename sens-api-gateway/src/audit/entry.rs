//! # AuditEntry — data model for one audit record (ADR-020 §1, §3)
//!
//! Every regulated action produces TWO audit entries: one `AuditPhase::Pre`
//! emitted BEFORE command handler execution (captures the authorization
//! decision, the intended action, the inputs), and one `AuditPhase::Post`
//! emitted AFTER (captures the outcome, any side effects, durations).
//!
//! The two-phase pattern solves a specific attack: a handler that crashes
//! mid-execution would leave no audit record if we only logged post-exec.
//! Pre-exec logging + durable fsync'd sink (Sprint 6.2) means the audit log
//! records the intent even if the handler never completes.
//!
//! ## Canonical bytes = HMAC input
//!
//! `AuditEntry::canonical_bytes()` produces the byte sequence fed to the
//! HMAC chain (`HmacChainEntry::compute_current_hmac(prev_hmac, entry_bytes,
//! chain_key)`). Length-prefix framing per the established project discipline
//! (Batch 4b / 5b); no NUL separators.

use serde::{Deserialize, Serialize};

use crate::authz::permission::{Permission, TenantId};

/// Phase of the command lifecycle the entry captures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditPhase {
    /// Emitted BEFORE command handler runs. Captures intent + authorization.
    Pre,
    /// Emitted AFTER command handler completes (success or failure).
    Post,
}

impl AuditPhase {
    const fn wire_tag(self) -> u8 {
        match self {
            Self::Pre => 0,
            Self::Post => 1,
        }
    }
}

/// Outcome discriminator on post-phase entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditOutcome {
    /// Command handler completed without error. Pre entries carry this
    /// value but it is meaningless there (pre always "succeeded" in the
    /// trivial sense that it logged before handler execution).
    Success,
    /// Handler returned an error. Error detail is in `AuditEntry::detail`.
    Failure,
    /// Authorization denied — handler never ran. Used for pre-entries
    /// emitted when `PolicyEngine::authorize` returns Deny.
    AuthorizationDenied,
}

impl AuditOutcome {
    const fn wire_tag(self) -> u8 {
        match self {
            Self::Success => 0,
            Self::Failure => 1,
            Self::AuthorizationDenied => 2,
        }
    }
}

/// The actor identity captured in the audit entry. This is a PROJECTION of
/// [`crate::authz::ActorIdentity`] — we serialize the audit-safe LABEL
/// (operator IDs redacted; machine issuer cert CN surfaced) rather than
/// carrying the raw sealed identity bytes.
///
/// **Why projection, not pass-through:** the audit log is durable on disk +
/// relayed to cloud. Storing raw `OperatorId` bytes would leak PII at rest
/// + in transit. The label format is stable audit surface (`op:<operator>`
/// / `svc:<cn>`) matching `ActorIdentity::audit_label()`.
///
/// **Construction surface (EDGE-MEDIUM-004 closure):** the preferred path is
/// [`AuditActor::from_actor_identity`], which goes through the
/// `ActorIdentity::audit_label()` redaction helper. The raw `new()` ctor is
/// retained for system-initiated events (boot, shutdown, watchdog) where
/// there is no authenticated actor — those paths use a code-constant label
/// like `"system:boot"` with no PII risk. Bounded length at canonical-bytes
/// time via `MAX_ACTOR_LABEL_BYTES`; empty label rejected there too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditActor {
    pub label: String,
}

impl AuditActor {
    /// Direct label construction — for system-initiated events only. Caller
    /// is responsible for the label being a code-constant short string with
    /// no PII. Canonical-bytes enforces a length bound.
    pub fn new(label: impl Into<String>) -> Self {
        Self { label: label.into() }
    }

    /// Preferred path: project an authenticated [`crate::authz::ActorIdentity`]
    /// through its `audit_label()` redaction. Operator UUIDs become
    /// `"op:<operator>"`; machine issuers become `"svc:<cn>"`.
    pub fn from_actor_identity(actor: &crate::authz::ActorIdentity) -> Self {
        Self { label: actor.audit_label() }
    }
}

/// Exhaustive taxonomy of auditable actions on the edge. Adding a variant is
/// an ADR-level decision because audit-verify CLI + cloud-side analytics
/// index on these variant names.
///
/// **Stability contract:** serde `rename_all = "snake_case"` so wire JSON uses
/// stable lowercase names. The wire_tag() helper assigns a byte discriminator
/// for canonical bytes serialization — adding a variant appends at the end;
/// renaming a variant OR changing its wire_tag is a breaking change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditAction {
    // -- Command dispatch --
    CommandAuthorized,
    CommandExecuted,
    CommandRejected,

    // -- Tag writes (ADR-024 actuator class context carries in resource) --
    TagRead,
    TagWrite,
    ForceValueApplied,
    ForceValueRevoked,

    // -- RBAC / policy --
    PolicyUpdateReceived,
    PolicyUpdateApplied,
    PolicyUpdateRejected,

    // -- Firmware + deploy --
    FirmwareDeployRequested,
    FirmwareDeployApplied,
    FirmwareDeployRollback,
    ProgramDeployRequested,
    ProgramDeployApplied,
    ProgramDeployRollback,

    // -- Safety --
    SafeStateTriggered,
    SafeStateCleared,
    WatchdogTripped,
    EmergencyOverrideInvoked,

    // -- Keystore + crypto --
    MasterKeyRotated,
    DerivedKeyRequested,
    AcceptanceTokenAccepted,

    // -- Tenant lifecycle --
    TenantProvisioned,
    TenantDeprovisioned,

    // -- Network + MQTT --
    MqttReconnected,
    MqttCertRotated,
    MqttCertRotationRolledBack,

    // -- Operational --
    ShutdownInitiated,
    BootCompleted,

    // -- mTLS forensic surface (Phase 1.1.5 / ORPHAN-MEDIUM-036/037 closure) --
    /// Strict-mode handshake rejected by SuderraServerCertVerifier policy
    /// gates (chain depth, validity window, age cap, fingerprint pinning).
    /// Forensic post-mortem queryability for handshake-abort events that
    /// happen OUTSIDE the command-dispatch pipeline. Not a security
    /// boundary — the handshake-abort is the primary security action;
    /// this audit emit is for HMAC-chain-anchored forensic evidence so
    /// auditors can reconstruct the rejected-handshake timeline offline.
    MtlsHandshakeRejectStrict,
    /// Custom CA bundle parse loop completed with partial success
    /// (`parse_errs > 0 && added > 0`). Pre-Phase-1.1.5 the partial-fix
    /// path emitted only `tracing::error!`; this audit-action wires the
    /// same event through the HMAC chain. Operators running tampered
    /// or operator-typo'd CA bundle files see the partial-load event in
    /// the audit stream alongside the running cert anchors snapshot.
    MtlsCaBundleParsePartial,
}

impl AuditAction {
    /// Stable byte discriminator used in canonical-bytes serialization.
    /// **Never reorder** — adding a variant appends at the end with the next
    /// integer value; renaming/removing is a breaking change for audit-verify.
    pub const fn wire_tag(self) -> u8 {
        match self {
            Self::CommandAuthorized => 0,
            Self::CommandExecuted => 1,
            Self::CommandRejected => 2,
            Self::TagRead => 3,
            Self::TagWrite => 4,
            Self::ForceValueApplied => 5,
            Self::ForceValueRevoked => 6,
            Self::PolicyUpdateReceived => 7,
            Self::PolicyUpdateApplied => 8,
            Self::PolicyUpdateRejected => 9,
            Self::FirmwareDeployRequested => 10,
            Self::FirmwareDeployApplied => 11,
            Self::FirmwareDeployRollback => 12,
            Self::ProgramDeployRequested => 13,
            Self::ProgramDeployApplied => 14,
            Self::ProgramDeployRollback => 15,
            Self::SafeStateTriggered => 16,
            Self::SafeStateCleared => 17,
            Self::WatchdogTripped => 18,
            Self::EmergencyOverrideInvoked => 19,
            Self::MasterKeyRotated => 20,
            Self::DerivedKeyRequested => 21,
            Self::AcceptanceTokenAccepted => 22,
            Self::TenantProvisioned => 23,
            Self::TenantDeprovisioned => 24,
            Self::MqttReconnected => 25,
            Self::MqttCertRotated => 26,
            Self::MqttCertRotationRolledBack => 27,
            Self::ShutdownInitiated => 28,
            Self::BootCompleted => 29,
            // Phase 1.1.5 / ORPHAN-MEDIUM-036/037 — append at next free
            // wire_tag. Wire-stability contract per the doc comment above:
            // these tags are byte discriminators in canonical bytes; never
            // reorder, never reuse a removed tag's number.
            Self::MtlsHandshakeRejectStrict => 30,
            Self::MtlsCaBundleParsePartial => 31,
        }
    }
}

/// Structured reference to the resource acted upon. Variants match the common
/// resource classes; a generic `Other` carries arbitrary labels for
/// infrequent cases (watchdog trip, boot, shutdown). The AuditAction +
/// AuditResource pair is the semantic key of the record.
///
/// **Wire-stability contract (EDGE-HIGH-001 closure):** canonical-bytes
/// serialization does NOT go through serde / bincode on this enum. Instead,
/// each variant has a `wire_tag()` byte discriminator (same discipline as
/// [`AuditAction::wire_tag`]) AND the manual encoding in
/// [`AuditResource::append_canonical_bytes`] below. `#[serde(tag = "kind")]`
/// is deliberately NOT applied — serde persistence uses default externally-
/// tagged representation for JSON, which bincode handles; canonical bytes
/// never touch bincode for this enum.
///
/// Why the manual encoding: `#[serde(tag = "kind")]` produces bincode output
/// keyed on textual variant names (`"tag"`, `"program"`, ...) via a map-
/// encoded internally-tagged representation. Renaming a variant in a future
/// refactor would silently invalidate every historical audit entry's HMAC
/// chain. Manual wire_tag bytes give adjacent-tag stability equivalent to
/// AuditAction's discipline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditResource {
    Tag { name: String },
    Permission { permission: Permission },
    Program { program_id: String },
    FirmwareImage { image_digest_hex: String },
    PolicyManifestVersion { version: u64 },
    Keystore { purpose_label: String },
    Tenant { tenant: TenantId },
    Other { label: String },
}

impl AuditResource {
    /// Stable byte discriminator for canonical-bytes serialization. Never
    /// reorder — adding a variant appends at the next integer; removing is
    /// a breaking change for audit-verify CLI retroactive chain walk.
    pub const fn wire_tag(&self) -> u8 {
        match self {
            Self::Tag { .. } => 0,
            Self::Permission { .. } => 1,
            Self::Program { .. } => 2,
            Self::FirmwareImage { .. } => 3,
            Self::PolicyManifestVersion { .. } => 4,
            Self::Keystore { .. } => 5,
            Self::Tenant { .. } => 6,
            Self::Other { .. } => 7,
        }
    }

    /// Append the variant's canonical bytes to `out`. Layout per variant:
    ///
    /// ```text
    /// Tag:                    u8(0) || be_u32(name.len()) || name.as_bytes()
    /// Permission:             u8(1) || be_u32(bincode_bytes.len()) || bincode_bytes
    ///                         (Permission is default-serde-tagged, bincode-compatible)
    /// Program:                u8(2) || be_u32(id.len()) || id.as_bytes()
    /// FirmwareImage:          u8(3) || be_u32(hex.len()) || hex.as_bytes()
    /// PolicyManifestVersion:  u8(4) || be_u64(version)
    /// Keystore:               u8(5) || be_u32(label.len()) || label.as_bytes()
    /// Tenant:                 u8(6) || tenant.as_bytes() (fixed 16)
    /// Other:                  u8(7) || be_u32(label.len()) || label.as_bytes()
    /// ```
    fn append_canonical_bytes(
        &self,
        out: &mut Vec<u8>,
    ) -> Result<(), AuditEntryCanonicalBytesError> {
        out.push(self.wire_tag());
        match self {
            Self::Tag { name } => {
                let b = name.as_bytes();
                out.extend_from_slice(&u32_len(b.len())?.to_be_bytes());
                out.extend_from_slice(b);
            }
            Self::Permission { permission } => {
                // Permission uses default serde external tagging (bincode-
                // compatible). The outer u32 length prefix insulates from
                // bincode-internal-format drift across patch versions.
                let pb = bincode::serialize(permission)
                    .map_err(|_| AuditEntryCanonicalBytesError::FieldEncodeFailed)?;
                out.extend_from_slice(&u32_len(pb.len())?.to_be_bytes());
                out.extend_from_slice(&pb);
            }
            Self::Program { program_id } => {
                let b = program_id.as_bytes();
                out.extend_from_slice(&u32_len(b.len())?.to_be_bytes());
                out.extend_from_slice(b);
            }
            Self::FirmwareImage { image_digest_hex } => {
                let b = image_digest_hex.as_bytes();
                out.extend_from_slice(&u32_len(b.len())?.to_be_bytes());
                out.extend_from_slice(b);
            }
            Self::PolicyManifestVersion { version } => {
                out.extend_from_slice(&version.to_be_bytes());
            }
            Self::Keystore { purpose_label } => {
                let b = purpose_label.as_bytes();
                out.extend_from_slice(&u32_len(b.len())?.to_be_bytes());
                out.extend_from_slice(b);
            }
            Self::Tenant { tenant } => {
                out.extend_from_slice(tenant.as_bytes());
            }
            Self::Other { label } => {
                let b = label.as_bytes();
                out.extend_from_slice(&u32_len(b.len())?.to_be_bytes());
                out.extend_from_slice(b);
            }
        }
        Ok(())
    }
}

/// A single audit record. Immutable after construction; `canonical_bytes`
/// produces deterministic HMAC input.
///
/// **Required + optional fields:** `correlation_id` is REQUIRED (even
/// system-initiated events carry a UUIDv4 generated at action entry).
/// `detail` is free-form operator-facing JSON — cloud-side analytics may
/// parse it but canonical bytes include it length-prefixed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    /// Monotonic-safe wall-clock timestamp (UNIX seconds, signed for
    /// pre-epoch guard). Upstream uses NTS-authenticated clock per plan D-7.
    pub timestamp_unix_secs: i64,
    /// Nanoseconds within the second (0..=999_999_999). Separate field
    /// keeps the canonical bytes layout stable as two fixed-width integers.
    pub timestamp_nanos: u32,
    /// Command correlation — UUIDv4 string. Links pre + post entries for
    /// the same command AND correlates across cloud telemetry.
    pub correlation_id: String,
    /// Phase (pre/post).
    pub phase: AuditPhase,
    /// The actor (audit-safe label projection per [`AuditActor`]).
    pub actor: AuditActor,
    /// Tenant the action was scoped to — sealed newtype carried as-is
    /// because tenant IDs are NOT PII in this threat model.
    pub tenant: TenantId,
    /// Policy version active when the action was authorized.
    pub policy_version: u64,
    /// Two-person-integrity flag (from AuthorizedContext).
    pub two_person_integrity_verified: bool,
    /// What happened (pre = intent, post = outcome).
    pub action: AuditAction,
    /// What it happened to.
    pub resource: AuditResource,
    /// Outcome discriminator. On pre entries, typically `Success` unless
    /// auth denied; on post entries, reflects handler result.
    pub outcome: AuditOutcome,
    /// Free-form human/operator-facing detail (JSON-escaped string). May
    /// include an error message on Failure outcome. Bounded to 4 KiB at
    /// ingestion time (enforced in Sprint 6.2 `sink.rs`).
    pub detail: String,
}

/// Tier-1 size bounds on variable-length fields — enforced at canonical-bytes
/// time so the HMAC chain cannot be fed oversized input (EDGE-HIGH-002).
pub const MAX_DETAIL_BYTES: usize = 4096;
pub const MAX_CORRELATION_ID_BYTES: usize = 128;
pub const MAX_ACTOR_LABEL_BYTES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditEntryCanonicalBytesError {
    /// A length field exceeded `u32::MAX`. Surfaces only for hostile or
    /// fuzzed `detail` or `correlation_id` inputs; sink enforces 4 KiB
    /// bound separately.
    LengthExceedsU32,
    /// bincode-encode of `Permission` or `TenantId` failed. Indicates an
    /// upstream invariant violation.
    FieldEncodeFailed,
    /// Timestamp nanos exceeded 999_999_999. Upstream must normalize.
    InvalidTimestampNanos(u32),
    /// Timestamp seconds is negative (pre-epoch wall clock). Upstream must
    /// clamp to UNIX_EPOCH-safe values.
    NegativeTimestamp,
    /// `detail` field exceeded [`MAX_DETAIL_BYTES`] (EDGE-HIGH-002 closure).
    DetailTooLong(usize),
    /// `correlation_id` exceeded [`MAX_CORRELATION_ID_BYTES`].
    CorrelationIdTooLong(usize),
    /// `actor.label` exceeded [`MAX_ACTOR_LABEL_BYTES`].
    ActorLabelTooLong(usize),
    /// `correlation_id` empty — UUIDv4 or equivalent REQUIRED.
    EmptyCorrelationId,
    /// `actor.label` empty — ActorIdentity projection must produce a label.
    EmptyActorLabel,
}

impl std::fmt::Display for AuditEntryCanonicalBytesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LengthExceedsU32 => f.write_str("length_exceeds_u32"),
            Self::FieldEncodeFailed => f.write_str("field_encode_failed"),
            Self::InvalidTimestampNanos(n) => write!(f, "invalid_timestamp_nanos:{}", n),
            Self::NegativeTimestamp => f.write_str("negative_timestamp"),
            Self::DetailTooLong(n) => write!(f, "detail_too_long:{}", n),
            Self::CorrelationIdTooLong(n) => write!(f, "correlation_id_too_long:{}", n),
            Self::ActorLabelTooLong(n) => write!(f, "actor_label_too_long:{}", n),
            Self::EmptyCorrelationId => f.write_str("empty_correlation_id"),
            Self::EmptyActorLabel => f.write_str("empty_actor_label"),
        }
    }
}

impl std::error::Error for AuditEntryCanonicalBytesError {}

fn u32_len(n: usize) -> Result<u32, AuditEntryCanonicalBytesError> {
    u32::try_from(n).map_err(|_| AuditEntryCanonicalBytesError::LengthExceedsU32)
}

impl AuditEntry {
    /// Canonical bytes — deterministic serialization fed to HMAC chain.
    ///
    /// **Encoding (v1, length-prefix framing):**
    ///
    /// ```text
    /// be_i64(timestamp_unix_secs) ||
    /// be_u32(timestamp_nanos) ||
    /// be_u32(correlation_id.len()) || correlation_id.as_bytes() ||
    /// u8(phase.wire_tag()) ||
    /// be_u32(actor.label.len()) || actor.label.as_bytes() ||
    /// tenant.as_bytes() (fixed 16 bytes) ||
    /// be_u64(policy_version) ||
    /// u8(two_person_integrity_verified ? 1 : 0) ||
    /// u8(action.wire_tag()) ||
    /// be_u32(resource_bytes.len()) || resource_bytes (bincode) ||
    /// u8(outcome.wire_tag()) ||
    /// be_u32(detail.len()) || detail.as_bytes() ||
    /// b"audit-entry-v1"
    /// ```
    ///
    /// Domain-separation tag `b"audit-entry-v1"` distinguishes audit-entry
    /// bytes from rbac-manifest bytes / acceptance-token bytes — a signer
    /// cannot cross-substitute a valid signature across protocols.
    ///
    /// **Tier-1 sanity guards:** negative timestamp + nanos > 999_999_999
    /// rejected at serialize time (surfaces upstream clock-correctness bugs).
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, AuditEntryCanonicalBytesError> {
        // Tier-1 guards — reject upstream invariant violations at the
        // signing boundary so the HMAC chain is never fed oversized or
        // semantically invalid input (EDGE-HIGH-002 closure).
        if self.timestamp_unix_secs < 0 {
            return Err(AuditEntryCanonicalBytesError::NegativeTimestamp);
        }
        if self.timestamp_nanos >= 1_000_000_000 {
            return Err(AuditEntryCanonicalBytesError::InvalidTimestampNanos(
                self.timestamp_nanos,
            ));
        }
        if self.correlation_id.is_empty() {
            return Err(AuditEntryCanonicalBytesError::EmptyCorrelationId);
        }
        if self.correlation_id.len() > MAX_CORRELATION_ID_BYTES {
            return Err(AuditEntryCanonicalBytesError::CorrelationIdTooLong(
                self.correlation_id.len(),
            ));
        }
        if self.actor.label.is_empty() {
            return Err(AuditEntryCanonicalBytesError::EmptyActorLabel);
        }
        if self.actor.label.len() > MAX_ACTOR_LABEL_BYTES {
            return Err(AuditEntryCanonicalBytesError::ActorLabelTooLong(
                self.actor.label.len(),
            ));
        }
        if self.detail.len() > MAX_DETAIL_BYTES {
            return Err(AuditEntryCanonicalBytesError::DetailTooLong(self.detail.len()));
        }

        let mut out = Vec::with_capacity(
            128 + self.detail.len() + self.correlation_id.len() + self.actor.label.len(),
        );

        out.extend_from_slice(&self.timestamp_unix_secs.to_be_bytes());
        out.extend_from_slice(&self.timestamp_nanos.to_be_bytes());

        let cid_bytes = self.correlation_id.as_bytes();
        out.extend_from_slice(&u32_len(cid_bytes.len())?.to_be_bytes());
        out.extend_from_slice(cid_bytes);

        out.push(self.phase.wire_tag());

        let actor_bytes = self.actor.label.as_bytes();
        out.extend_from_slice(&u32_len(actor_bytes.len())?.to_be_bytes());
        out.extend_from_slice(actor_bytes);

        out.extend_from_slice(self.tenant.as_bytes());

        out.extend_from_slice(&self.policy_version.to_be_bytes());

        out.push(if self.two_person_integrity_verified { 1 } else { 0 });

        out.push(self.action.wire_tag());

        // Manual resource encoding (EDGE-HIGH-001 closure) — replaces
        // bincode-over-internally-tagged path.
        self.resource.append_canonical_bytes(&mut out)?;

        out.push(self.outcome.wire_tag());

        let detail_bytes = self.detail.as_bytes();
        out.extend_from_slice(&u32_len(detail_bytes.len())?.to_be_bytes());
        out.extend_from_slice(detail_bytes);

        out.extend_from_slice(b"audit-entry-v1");
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::permission::TenantId;

    fn tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn canned_entry() -> AuditEntry {
        AuditEntry {
            timestamp_unix_secs: 1_700_000_000,
            timestamp_nanos: 42_000_000,
            correlation_id: "cmd-uuid-abc".to_string(),
            phase: AuditPhase::Pre,
            actor: AuditActor::new("op:<operator>"),
            tenant: tenant(),
            policy_version: 7,
            two_person_integrity_verified: false,
            action: AuditAction::TagWrite,
            resource: AuditResource::Tag { name: "pond3_aerator".to_string() },
            outcome: AuditOutcome::Success,
            detail: "".to_string(),
        }
    }

    /// WHY: Canonical bytes deterministic across calls.
    #[test]
    fn canonical_bytes_deterministic() {
        let e = canned_entry();
        let a = e.canonical_bytes().expect("ok");
        let b = e.canonical_bytes().expect("ok");
        assert_eq!(a, b);
    }

    /// WHY: Domain-separation tag at END (prevents cross-protocol signature
    ///      collision with rbac-manifest-v1 / file-backed-acceptance-v2).
    #[test]
    fn canonical_bytes_ends_with_audit_entry_v1_tag() {
        let e = canned_entry();
        let bytes = e.canonical_bytes().expect("ok");
        let tag = b"audit-entry-v1";
        assert!(bytes.ends_with(tag));
    }

    /// WHY: Sensitivity to every field — changing any field must change
    ///      canonical bytes.
    #[test]
    fn canonical_bytes_sensitive_to_fields() {
        let base = canned_entry();
        let base_bytes = base.canonical_bytes().expect("ok");

        let mut ts = base.clone();
        ts.timestamp_unix_secs += 1;
        assert_ne!(base_bytes, ts.canonical_bytes().expect("ok"));

        let mut nanos = base.clone();
        nanos.timestamp_nanos += 1;
        assert_ne!(base_bytes, nanos.canonical_bytes().expect("ok"));

        let mut cid = base.clone();
        cid.correlation_id = "cmd-uuid-xyz".to_string();
        assert_ne!(base_bytes, cid.canonical_bytes().expect("ok"));

        let mut phase = base.clone();
        phase.phase = AuditPhase::Post;
        assert_ne!(base_bytes, phase.canonical_bytes().expect("ok"));

        let mut actor = base.clone();
        actor.actor = AuditActor::new("svc:billing-service");
        assert_ne!(base_bytes, actor.canonical_bytes().expect("ok"));

        let mut pv = base.clone();
        pv.policy_version += 1;
        assert_ne!(base_bytes, pv.canonical_bytes().expect("ok"));

        let mut tpi = base.clone();
        tpi.two_person_integrity_verified = true;
        assert_ne!(base_bytes, tpi.canonical_bytes().expect("ok"));

        let mut act = base.clone();
        act.action = AuditAction::TagRead;
        assert_ne!(base_bytes, act.canonical_bytes().expect("ok"));

        let mut res = base.clone();
        res.resource = AuditResource::Tag { name: "pond3_feeder".to_string() };
        assert_ne!(base_bytes, res.canonical_bytes().expect("ok"));

        let mut outcome = base.clone();
        outcome.outcome = AuditOutcome::Failure;
        assert_ne!(base_bytes, outcome.canonical_bytes().expect("ok"));

        let mut detail = base.clone();
        detail.detail = "nonempty detail".to_string();
        assert_ne!(base_bytes, detail.canonical_bytes().expect("ok"));
    }

    /// WHY: Negative timestamp rejected — upstream clock-correctness bug.
    #[test]
    fn rejects_negative_timestamp() {
        let mut e = canned_entry();
        e.timestamp_unix_secs = -1;
        let err = e.canonical_bytes().expect_err("negative");
        assert_eq!(err, AuditEntryCanonicalBytesError::NegativeTimestamp);
    }

    /// WHY: nanos >= 1_000_000_000 rejected.
    #[test]
    fn rejects_invalid_nanos() {
        let mut e = canned_entry();
        e.timestamp_nanos = 1_000_000_000;
        let err = e.canonical_bytes().expect_err("nanos overflow");
        assert_eq!(
            err,
            AuditEntryCanonicalBytesError::InvalidTimestampNanos(1_000_000_000)
        );
    }

    /// WHY: Length-prefix framing prevents resource field collision — a
    ///      `Tag { name: "x" }` with detail "y" must NOT collide with
    ///      `Tag { name: "xy" }` with detail "".
    #[test]
    fn canonical_bytes_framing_resists_detail_resource_collision() {
        let mut a = canned_entry();
        a.resource = AuditResource::Tag { name: "x".to_string() };
        a.detail = "y".to_string();

        let mut b = canned_entry();
        b.resource = AuditResource::Tag { name: "xy".to_string() };
        b.detail = "".to_string();

        assert_ne!(
            a.canonical_bytes().expect("ok"),
            b.canonical_bytes().expect("ok")
        );
    }

    /// WHY: JSON serde round-trip — the audit log sink will store JSON
    ///      (NOT bincode — JSON is grep-/jq-friendly for incident response).
    #[test]
    fn audit_entry_json_roundtrip() {
        let e = canned_entry();
        let json = serde_json::to_string(&e).expect("serialize");
        let back: AuditEntry = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, e);
    }

    /// WHY: AuditAction wire_tag values are a stability contract — pin a
    ///      sample to catch accidental reordering.
    #[test]
    fn audit_action_wire_tags_stable() {
        assert_eq!(AuditAction::CommandAuthorized.wire_tag(), 0);
        assert_eq!(AuditAction::TagWrite.wire_tag(), 4);
        assert_eq!(AuditAction::ForceValueApplied.wire_tag(), 5);
        assert_eq!(AuditAction::SafeStateTriggered.wire_tag(), 16);
        assert_eq!(AuditAction::MasterKeyRotated.wire_tag(), 20);
        assert_eq!(AuditAction::MqttCertRotated.wire_tag(), 26);
        assert_eq!(AuditAction::MqttCertRotationRolledBack.wire_tag(), 27);
        assert_eq!(AuditAction::ShutdownInitiated.wire_tag(), 28);
        assert_eq!(AuditAction::BootCompleted.wire_tag(), 29);
        // Phase 1.1.5 / ORPHAN-MEDIUM-036/037 — pin appended variants.
        assert_eq!(AuditAction::MtlsHandshakeRejectStrict.wire_tag(), 30);
        assert_eq!(AuditAction::MtlsCaBundleParsePartial.wire_tag(), 31);
    }

    /// WHY (EDGE-HIGH-001 closure): AuditResource wire_tag stability pin.
    ///      Parallel to AuditAction discipline — byte discriminators are a
    ///      stability contract for audit-verify CLI retroactive chain walk.
    #[test]
    fn audit_resource_wire_tags_stable() {
        let t = AuditResource::Tag { name: "x".to_string() };
        let p = AuditResource::Permission {
            permission: Permission::ReadTag,
        };
        let pg = AuditResource::Program { program_id: "x".to_string() };
        let fi = AuditResource::FirmwareImage { image_digest_hex: "x".to_string() };
        let pv = AuditResource::PolicyManifestVersion { version: 1 };
        let ks = AuditResource::Keystore { purpose_label: "x".to_string() };
        let tn = AuditResource::Tenant { tenant: tenant() };
        let o = AuditResource::Other { label: "x".to_string() };

        assert_eq!(t.wire_tag(), 0);
        assert_eq!(p.wire_tag(), 1);
        assert_eq!(pg.wire_tag(), 2);
        assert_eq!(fi.wire_tag(), 3);
        assert_eq!(pv.wire_tag(), 4);
        assert_eq!(ks.wire_tag(), 5);
        assert_eq!(tn.wire_tag(), 6);
        assert_eq!(o.wire_tag(), 7);
    }

    /// WHY (EDGE-HIGH-001 regression guard): AuditResource canonical-bytes
    ///      output must NOT depend on textual variant names (the failed
    ///      bincode-internally-tagged path). Two different variants with
    ///      identical payload strings must produce different canonical
    ///      bytes via the wire_tag byte discriminator.
    #[test]
    fn audit_resource_canonical_bytes_distinguishes_variants_by_wire_tag() {
        let tag = AuditResource::Tag { name: "same".to_string() };
        let program = AuditResource::Program { program_id: "same".to_string() };
        let mut a = Vec::new();
        let mut b = Vec::new();
        tag.append_canonical_bytes(&mut a).expect("ok");
        program.append_canonical_bytes(&mut b).expect("ok");
        assert_ne!(a, b);
        assert_eq!(a[0], 0); // Tag wire_tag
        assert_eq!(b[0], 2); // Program wire_tag
    }

    /// WHY (Batch 6 re-audit NIT closure): end-to-end regression guard for
    ///      the `AuditResource::Permission` variant bincode payload path.
    ///      Verifies byte 0 is wire_tag=1 AND the immediate 4-byte BE u32
    ///      length prefix is nonzero (bincode encoding of Permission is
    ///      always at least a few bytes). Catches a future Permission
    ///      serde-shape change that would silently alter canonical bytes.
    #[test]
    fn audit_resource_permission_variant_encodes_via_wire_tag_and_length_prefix() {
        let res = AuditResource::Permission {
            permission: Permission::ReadTag,
        };
        let mut out = Vec::new();
        res.append_canonical_bytes(&mut out).expect("ok");
        // Byte 0: wire_tag for Permission = 1.
        assert_eq!(out[0], 1, "Permission wire_tag must be 1");
        // Bytes 1..5: be_u32 length of bincode payload. Must be nonzero
        // (Permission bincode always produces at least variant tag + inner).
        let len_bytes: [u8; 4] = out[1..5].try_into().expect("4-byte window");
        let len = u32::from_be_bytes(len_bytes);
        assert!(len > 0, "Permission bincode length prefix must be > 0");
        // Total length sanity: 1 (wire_tag) + 4 (len prefix) + len (payload).
        assert_eq!(out.len(), 1 + 4 + len as usize);
    }

    /// WHY: Full AuditEntry with `AuditResource::Permission` round-trips
    ///      through canonical_bytes without error AND produces a length
    ///      that includes both the resource prefix AND the v1 end-tag.
    #[test]
    fn audit_entry_with_permission_resource_canonical_bytes_ok() {
        let mut e = canned_entry();
        e.resource = AuditResource::Permission {
            permission: Permission::ReadTag,
        };
        let bytes = e.canonical_bytes().expect("permission resource ok");
        assert!(bytes.ends_with(b"audit-entry-v1"));
    }

    /// WHY: Display of canonical bytes error for audit-grep.
    #[test]
    fn canonical_bytes_error_display_snake_case() {
        assert_eq!(
            format!("{}", AuditEntryCanonicalBytesError::NegativeTimestamp),
            "negative_timestamp"
        );
        assert_eq!(
            format!(
                "{}",
                AuditEntryCanonicalBytesError::InvalidTimestampNanos(1_000_000_000)
            ),
            "invalid_timestamp_nanos:1000000000"
        );
        assert_eq!(
            format!("{}", AuditEntryCanonicalBytesError::LengthExceedsU32),
            "length_exceeds_u32"
        );
        assert_eq!(
            format!("{}", AuditEntryCanonicalBytesError::FieldEncodeFailed),
            "field_encode_failed"
        );
    }

    /// WHY: Error implements std::error::Error for `?` interop.
    #[test]
    fn canonical_bytes_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<AuditEntryCanonicalBytesError>();
    }

    /// WHY: AuditPhase / AuditOutcome wire tags are stable ints.
    #[test]
    fn phase_and_outcome_wire_tags_stable() {
        assert_eq!(AuditPhase::Pre.wire_tag(), 0);
        assert_eq!(AuditPhase::Post.wire_tag(), 1);
        assert_eq!(AuditOutcome::Success.wire_tag(), 0);
        assert_eq!(AuditOutcome::Failure.wire_tag(), 1);
        assert_eq!(AuditOutcome::AuthorizationDenied.wire_tag(), 2);
    }

    /// WHY (EDGE-HIGH-003 closure): empty correlation_id rejected at
    ///      canonical-bytes time. The docstring invariant "REQUIRED"
    ///      is enforced by Tier-1 gate, not by documentation.
    #[test]
    fn rejects_empty_correlation_id() {
        let mut e = canned_entry();
        e.correlation_id = String::new();
        let err = e.canonical_bytes().expect_err("empty correlation_id");
        assert_eq!(err, AuditEntryCanonicalBytesError::EmptyCorrelationId);
    }

    /// WHY: empty actor label rejected — projection must produce a label.
    #[test]
    fn rejects_empty_actor_label() {
        let mut e = canned_entry();
        e.actor = AuditActor::new("");
        let err = e.canonical_bytes().expect_err("empty actor label");
        assert_eq!(err, AuditEntryCanonicalBytesError::EmptyActorLabel);
    }

    /// WHY (EDGE-HIGH-002 closure): correlation_id length bounded to
    ///      MAX_CORRELATION_ID_BYTES. Rejects HMAC DoS surface.
    #[test]
    fn rejects_oversized_correlation_id() {
        let mut e = canned_entry();
        e.correlation_id = "x".repeat(MAX_CORRELATION_ID_BYTES + 1);
        let err = e.canonical_bytes().expect_err("oversized cid");
        assert_eq!(
            err,
            AuditEntryCanonicalBytesError::CorrelationIdTooLong(MAX_CORRELATION_ID_BYTES + 1)
        );
    }

    /// WHY: detail length bounded to MAX_DETAIL_BYTES.
    #[test]
    fn rejects_oversized_detail() {
        let mut e = canned_entry();
        e.detail = "y".repeat(MAX_DETAIL_BYTES + 1);
        let err = e.canonical_bytes().expect_err("oversized detail");
        assert_eq!(
            err,
            AuditEntryCanonicalBytesError::DetailTooLong(MAX_DETAIL_BYTES + 1)
        );
    }

    /// WHY: actor label length bounded to MAX_ACTOR_LABEL_BYTES.
    #[test]
    fn rejects_oversized_actor_label() {
        let mut e = canned_entry();
        e.actor = AuditActor::new("z".repeat(MAX_ACTOR_LABEL_BYTES + 1));
        let err = e.canonical_bytes().expect_err("oversized actor label");
        assert_eq!(
            err,
            AuditEntryCanonicalBytesError::ActorLabelTooLong(MAX_ACTOR_LABEL_BYTES + 1)
        );
    }

    /// WHY: At the bound, accepts. At bound+1, rejects. Pin inclusivity.
    #[test]
    fn accepts_correlation_id_at_exact_bound() {
        let mut e = canned_entry();
        e.correlation_id = "x".repeat(MAX_CORRELATION_ID_BYTES);
        e.canonical_bytes().expect("at bound must accept");
    }

    #[test]
    fn accepts_detail_at_exact_bound() {
        let mut e = canned_entry();
        e.detail = "y".repeat(MAX_DETAIL_BYTES);
        e.canonical_bytes().expect("at bound must accept");
    }

    /// WHY (EDGE-MEDIUM-004 closure): from_actor_identity projects
    ///      ActorIdentity through audit_label redaction.
    #[test]
    fn audit_actor_from_actor_identity_redacts_operator() {
        use crate::authz::{permission::OperatorId, ActorIdentity};
        let actor = ActorIdentity::Operator(OperatorId::new_from_verified([0x07u8; 16]));
        let aa = AuditActor::from_actor_identity(&actor);
        assert_eq!(aa.label, "op:<operator>");
    }

    #[test]
    fn audit_actor_from_actor_identity_surfaces_machine_issuer_cn() {
        use crate::authz::ActorIdentity;
        let actor = ActorIdentity::MachineIssuer {
            subject_cn: "billing-service".to_string(),
        };
        let aa = AuditActor::from_actor_identity(&actor);
        assert_eq!(aa.label, "svc:billing-service");
    }

    /// WHY: Newly-added error Display variants pinned.
    #[test]
    fn new_error_variants_display_format() {
        assert_eq!(
            format!("{}", AuditEntryCanonicalBytesError::EmptyCorrelationId),
            "empty_correlation_id"
        );
        assert_eq!(
            format!("{}", AuditEntryCanonicalBytesError::EmptyActorLabel),
            "empty_actor_label"
        );
        assert_eq!(
            format!(
                "{}",
                AuditEntryCanonicalBytesError::DetailTooLong(4097)
            ),
            "detail_too_long:4097"
        );
        assert_eq!(
            format!(
                "{}",
                AuditEntryCanonicalBytesError::CorrelationIdTooLong(129)
            ),
            "correlation_id_too_long:129"
        );
        assert_eq!(
            format!(
                "{}",
                AuditEntryCanonicalBytesError::ActorLabelTooLong(257)
            ),
            "actor_label_too_long:257"
        );
    }
}
