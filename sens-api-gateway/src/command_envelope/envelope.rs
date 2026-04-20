//! # CommandEnvelope wire format + SignatureMode state machine
//!
//! The envelope is the MQTT/HTTP payload. Every incoming command is parsed
//! into a [`CommandEnvelope`]; then [`verify_envelope`] runs the Zero-Trust
//! verification gates (plan §4.10) and produces either an accepted
//! `(actor, cmd_name, params)` triple or a structured rejection.
//!
//! ## Envelope fields (plan §4.10)
//!
//! ```text
//! { cmd, params, actor, tenant_id, iat, exp, jti, nonce, sig, cmd_hash }
//! ```
//!
//! - `cmd` — command name string (e.g. `"write_tag"`).
//! - `params` — operator-facing JSON object (flat; nested objects rejected
//!   per `canonical::canonical_params` — Batch 7 scope).
//! - `actor` — OperatorId bytes (16) claim; enrolled in the active RBAC
//!   manifest. The signature verifies against the operator's pubkey from
//!   the manifest.
//! - `tenant_id` — TenantId bytes (16) claim; must equal device's
//!   provisioning-bound tenant.
//! - `iat` / `exp` — UNIX seconds freshness window. iat > exp or now
//!   outside `[iat, exp]` → reject.
//! - `jti` — unique identifier (validated `Jti` type). Dedup 72h.
//! - `nonce` — optional anti-replay nonce (distinct from jti; jti is the
//!   primary replay key, nonce is an operator-visible correlator).
//! - `sig` — 64-byte ed25519 signature over canonical envelope bytes.
//! - `cmd_hash` — SHA-256 of `canonical_params(cmd, params)`. Binds cmd+
//!   params to signature; an attacker who swaps params bypasses the
//!   signature only by breaking SHA-256.
//!
//! ## SignatureMode state machine (plan §2 HC-6 rollout discipline)
//!
//! - `Disabled` — legacy v1.6.0 behavior: any well-formed envelope accepted.
//!   Used only during initial deploy to prove parse parity; operator flag
//!   required.
//! - `Permissive` — envelopes WITHOUT a signature are logged as violations
//!   but still accepted; envelopes WITH a signature MUST verify. Intended
//!   for 7-day rollout window while the cloud signer fleet migrates.
//! - `Enforcing` — envelopes for mutating commands (per
//!   `super::mutating::is_mutating`) MUST have a valid signature. Read-only
//!   commands (ping, health_check) still accepted unsigned. Production
//!   default.

use serde::{Deserialize, Serialize};

use super::canonical::{canonical_params, CanonicalParamsError, CmdHash};
use super::jti::{InvalidJti, Jti};
use super::mutating::is_mutating;
use crate::authz::policy::Ed25519SignatureBytes;

/// Tier-1 parse-level bound on command name length (BATCH-007-FU-03 closure).
/// `MUTATING_COMMANDS` entries are ≤ 22 chars; 128 gives ample headroom for
/// future additions + structured prefixes without unbounded growth. Enforced
/// at Gate 1a of `verify_envelope` — catches attacker-supplied 4GB cmd
/// strings BEFORE any canonicalization allocates.
pub const MAX_CMD_NAME_BYTES: usize = 128;

/// Signature enforcement state machine (plan §2 HC-6). The mode is set by
/// config.yaml `signature_mode` (Batch 45) and hot-reloaded on SIGHUP.
///
/// Batch 45: `Default::default()` returns `Disabled` to preserve HC-1
/// backward compat — operators running pre-Batch-45 configs (no field)
/// get the same de-facto behavior. Explicit Permissive/Enforcing
/// migration comes from operator-editable config.yaml.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureMode {
    /// Legacy compatibility. Any envelope accepted. Operator opt-in only.
    #[default]
    Disabled,
    /// Transitional. Unsigned mutating commands logged but accepted; signed
    /// envelopes MUST verify.
    Permissive,
    /// Production default. Unsigned mutating commands rejected.
    Enforcing,
}

/// Wire-format command envelope. Field names match plan §4.10 but renamed
/// for Rust idiom where applicable (snake_case, explicit types).
///
/// **Serialization:** JSON on the wire (MQTT + HTTP). Fields are required
/// UNLESS noted optional; `signature` is optional for unsigned commands in
/// Disabled/Permissive modes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandEnvelope {
    pub cmd: String,
    pub params: serde_json::Value,
    /// Actor (operator) UUID bytes. Length-validated at wire parse; 16 bytes.
    #[serde(with = "uuid_bytes_serde")]
    pub actor: [u8; 16],
    /// Tenant UUID bytes. 16 bytes.
    #[serde(with = "uuid_bytes_serde")]
    pub tenant_id: [u8; 16],
    pub iat_unix_secs: i64,
    pub exp_unix_secs: i64,
    pub jti: String,
    /// Operator-visible correlator (distinct from jti which is the primary
    /// replay key). Bounded length (256).
    pub nonce: String,
    /// SHA-256 of canonical_params — 32 bytes wrapped in the [`CmdHash`]
    /// newtype (BATCH-007-FU-02 closure) so consumers cannot accidentally
    /// compare the hash against an unrelated 32-byte value (HMAC output,
    /// ed25519 public key, TPM PCR digest). serde renders it transparently
    /// as an array of ints on the wire.
    pub cmd_hash: CmdHash,
    /// Optional ed25519 signature (64 bytes). None for unsigned envelopes
    /// in Disabled / Permissive modes; MUST be Some for mutating commands
    /// in Enforcing mode.
    #[serde(default)]
    pub signature: Option<Ed25519SignatureBytes>,
}

/// Serde helper — `[u8; 16]` as JSON array of ints (default serde shape
/// for fixed-size arrays). Separate module so the attribute is readable.
mod uuid_bytes_serde {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(b: &[u8; 16], s: S) -> Result<S::Ok, S::Error> {
        b.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 16], D::Error> {
        <[u8; 16]>::deserialize(d)
    }
}

/// Errors from envelope verification. Distinct layers: parse errors,
/// freshness errors, dedup errors, signature errors, mode-specific
/// rejections. Each variant fires BEFORE any more-expensive gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvelopeVerifyError {
    // -- Parse / validation --
    EmptyCmd,
    CmdNameTooLong(usize),
    InvalidJti(InvalidJti),
    NonceTooLong(usize),
    // -- Freshness --
    InvalidFreshnessWindow { iat: i64, exp: i64 },
    NotYetValid { now_unix_secs: i64, iat: i64 },
    Expired { now_unix_secs: i64, exp: i64 },
    InvalidNow,
    // -- Tenant --
    TenantMismatch,
    // -- cmd_hash binding --
    CmdHashMismatch,
    CanonicalParamsFailed(CanonicalParamsError),
    // -- Signature --
    SignatureRequiredInEnforcingMode,
    SignatureInvalid,
    // -- Replay --
    JtiReplay,
}

impl std::fmt::Display for EnvelopeVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyCmd => f.write_str("empty_cmd"),
            Self::CmdNameTooLong(_) => f.write_str("cmd_name_too_long"),
            Self::InvalidJti(_) => f.write_str("invalid_jti"),
            Self::NonceTooLong(_) => f.write_str("nonce_too_long"),
            Self::InvalidFreshnessWindow { .. } => f.write_str("invalid_freshness_window"),
            Self::NotYetValid { .. } => f.write_str("not_yet_valid"),
            Self::Expired { .. } => f.write_str("expired"),
            Self::InvalidNow => f.write_str("invalid_now"),
            Self::TenantMismatch => f.write_str("tenant_mismatch"),
            Self::CmdHashMismatch => f.write_str("cmd_hash_mismatch"),
            Self::CanonicalParamsFailed(_) => f.write_str("canonical_params_failed"),
            Self::SignatureRequiredInEnforcingMode => {
                f.write_str("signature_required_in_enforcing_mode")
            }
            Self::SignatureInvalid => f.write_str("signature_invalid"),
            Self::JtiReplay => f.write_str("jti_replay"),
        }
    }
}

impl std::error::Error for EnvelopeVerifyError {}

impl From<CanonicalParamsError> for EnvelopeVerifyError {
    fn from(e: CanonicalParamsError) -> Self {
        Self::CanonicalParamsFailed(e)
    }
}

impl From<InvalidJti> for EnvelopeVerifyError {
    fn from(e: InvalidJti) -> Self {
        Self::InvalidJti(e)
    }
}

/// Maximum nonce length — same bound as jti per plan §4.10 discipline.
pub const MAX_NONCE_BYTES: usize = 256;

/// Verify an envelope AGAINST the expected tenant + current time + mode.
/// Returns the validated `Jti` on success (the caller then hands it to the
/// `JtiDedupTable::check_and_mark`); on failure, returns the structured
/// reason.
///
/// **Gate ordering (cheapest-first, crypto-last, matches Batch 5b
/// verify_manifest pattern):**
///
/// 1. EmptyCmd + InvalidJti + NonceTooLong (parse-level O(1))
/// 2. InvalidFreshnessWindow (i64 compare, `iat <= exp`)
/// 3. InvalidNow (SystemTime >= UNIX_EPOCH)
/// 4. NotYetValid / Expired (window bounds vs now)
/// 5. TenantMismatch (16-byte compare)
/// 6. cmd_hash binding: canonical_params + SHA-256 (closure-injected) +
///    CmdHashMismatch if recomputed hash != envelope.cmd_hash
/// 7. Signature presence per SignatureMode + is_mutating
/// 8. Signature cryptographic verify (closure-injected, most expensive)
///
/// The jti dedup check is NOT part of this function — it is the caller's
/// job to call `dedup_table.check_and_mark(&jti, ...)` AFTER successful
/// verify. Reason: dedup + verify are async-ordered differently in the
/// Sprint 6.4 dispatcher (dedup goes through mutex; verify is CPU-bound).
///
/// **Closures (injection to keep Batch 7 crypto-dep-free):**
/// - `compute_cmd_hash(canonical_bytes) -> [u8; 32]` — SHA-256. Sprint 6.4
///   wires `sha2::Sha256::new().chain_update(b).finalize()`.
/// - `verify_signature(canonical_envelope_bytes, &[u8; 64]) -> bool` — ed25519
///   verify against the actor's pubkey from the RBAC manifest.
pub fn verify_envelope(
    env: &CommandEnvelope,
    expected_tenant: &[u8; 16],
    now_unix_secs: i64,
    mode: SignatureMode,
    compute_cmd_hash: impl FnOnce(&[u8]) -> [u8; 32],
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<Jti, EnvelopeVerifyError> {
    // Gate 1a — cmd non-empty AND bounded (BATCH-007-FU-03 closure).
    if env.cmd.is_empty() {
        return Err(EnvelopeVerifyError::EmptyCmd);
    }
    if env.cmd.len() > MAX_CMD_NAME_BYTES {
        return Err(EnvelopeVerifyError::CmdNameTooLong(env.cmd.len()));
    }
    // Gate 1b — jti validated newtype.
    let jti = Jti::try_new(env.jti.clone())?;
    // Gate 1c — nonce bounded.
    if env.nonce.len() > MAX_NONCE_BYTES {
        return Err(EnvelopeVerifyError::NonceTooLong(env.nonce.len()));
    }

    // Gate 2 — iat <= exp.
    if env.iat_unix_secs > env.exp_unix_secs {
        return Err(EnvelopeVerifyError::InvalidFreshnessWindow {
            iat: env.iat_unix_secs,
            exp: env.exp_unix_secs,
        });
    }

    // Gate 3 — now sanity.
    if now_unix_secs < 0 {
        return Err(EnvelopeVerifyError::InvalidNow);
    }

    // Gate 4 — freshness window covers now (inclusive both ends).
    if now_unix_secs < env.iat_unix_secs {
        return Err(EnvelopeVerifyError::NotYetValid {
            now_unix_secs,
            iat: env.iat_unix_secs,
        });
    }
    if now_unix_secs > env.exp_unix_secs {
        return Err(EnvelopeVerifyError::Expired {
            now_unix_secs,
            exp: env.exp_unix_secs,
        });
    }

    // Gate 5 — tenant match.
    if &env.tenant_id != expected_tenant {
        return Err(EnvelopeVerifyError::TenantMismatch);
    }

    // Gate 6 — cmd_hash binds cmd + params to signature.
    let canonical = canonical_params(&env.cmd, &env.params)?;
    let recomputed = compute_cmd_hash(&canonical);
    if &recomputed != env.cmd_hash.as_bytes() {
        return Err(EnvelopeVerifyError::CmdHashMismatch);
    }

    // Gate 7 — signature presence per mode + is_mutating.
    match (mode, env.signature.as_ref(), is_mutating(&env.cmd)) {
        // Disabled — any envelope passes; no signature verify.
        (SignatureMode::Disabled, _, _) => {}
        // Enforcing + mutating + no signature → reject.
        (SignatureMode::Enforcing, None, true) => {
            return Err(EnvelopeVerifyError::SignatureRequiredInEnforcingMode);
        }
        // Enforcing + read-only + no signature → accept (read-only path).
        (SignatureMode::Enforcing, None, false) => {}
        // Permissive + no signature → accept (audit at sink-side).
        (SignatureMode::Permissive, None, _) => {}
        // Any mode + signature present → verify (Gate 8).
        (_, Some(sig), _) => {
            let envelope_bytes = envelope_canonical_bytes(env)?;
            if !verify_signature(&envelope_bytes, sig.as_bytes()) {
                return Err(EnvelopeVerifyError::SignatureInvalid);
            }
        }
    }

    Ok(jti)
}

/// Canonical bytes over the envelope fields that the signature covers.
/// Length-prefix framing; excludes `signature` (signatures cannot cover
/// themselves).
///
/// **Encoding (v1):**
///
/// ```text
/// be_u32(cmd.len()) || cmd ||
/// be_u32(canonical_params.len()) || canonical_params ||
/// actor (16 fixed) ||
/// tenant_id (16 fixed) ||
/// be_i64(iat) || be_i64(exp) ||
/// be_u32(jti.len()) || jti ||
/// be_u32(nonce.len()) || nonce ||
/// cmd_hash (32 fixed) ||
/// b"command-envelope-sig-v1"
/// ```
///
/// Note the canonical params are INCLUDED (not just their hash). Two reasons:
/// (1) defense in depth — a SHA-256 collision (astronomically unlikely but
/// theoretically possible under a future cryptanalytic break) can't pivot
/// to a valid signature when the full params bytes are in the signed
/// transcript. (2) Simpler audit reproducibility: signer + verifier
/// produce the same `envelope_canonical_bytes` input from the wire fields
/// without re-deriving canonical params.
fn envelope_canonical_bytes(
    env: &CommandEnvelope,
) -> Result<Vec<u8>, EnvelopeVerifyError> {
    let cmd_bytes = env.cmd.as_bytes();
    let cmd_len = u32::try_from(cmd_bytes.len())
        .map_err(|_| EnvelopeVerifyError::CanonicalParamsFailed(CanonicalParamsError::CmdNameLengthOverflow))?;

    let params_bytes = canonical_params(&env.cmd, &env.params)?;
    let params_len = u32::try_from(params_bytes.len()).map_err(|_| {
        EnvelopeVerifyError::CanonicalParamsFailed(CanonicalParamsError::CmdNameLengthOverflow)
    })?;

    let jti_bytes = env.jti.as_bytes();
    let jti_len = u32::try_from(jti_bytes.len()).map_err(|_| {
        EnvelopeVerifyError::CanonicalParamsFailed(CanonicalParamsError::CmdNameLengthOverflow)
    })?;

    let nonce_bytes = env.nonce.as_bytes();
    let nonce_len = u32::try_from(nonce_bytes.len()).map_err(|_| {
        EnvelopeVerifyError::CanonicalParamsFailed(CanonicalParamsError::CmdNameLengthOverflow)
    })?;

    let mut out = Vec::with_capacity(
        4 + cmd_bytes.len()
            + 4
            + params_bytes.len()
            + 32
            + 16
            + 4
            + jti_bytes.len()
            + 4
            + nonce_bytes.len()
            + 32
            + 22,
    );
    out.extend_from_slice(&cmd_len.to_be_bytes());
    out.extend_from_slice(cmd_bytes);
    out.extend_from_slice(&params_len.to_be_bytes());
    out.extend_from_slice(&params_bytes);
    out.extend_from_slice(&env.actor);
    out.extend_from_slice(&env.tenant_id);
    out.extend_from_slice(&env.iat_unix_secs.to_be_bytes());
    out.extend_from_slice(&env.exp_unix_secs.to_be_bytes());
    out.extend_from_slice(&jti_len.to_be_bytes());
    out.extend_from_slice(jti_bytes);
    out.extend_from_slice(&nonce_len.to_be_bytes());
    out.extend_from_slice(nonce_bytes);
    out.extend_from_slice(env.cmd_hash.as_bytes());
    out.extend_from_slice(b"command-envelope-sig-v1");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_env(cmd: &str, iat: i64, exp: i64) -> CommandEnvelope {
        let params = json!({"x": 1});
        // Pre-compute cmd_hash with a trivial "first-32-bytes-XOR-0x55" mock
        // that the verifier's closure mirrors.
        let canonical = canonical_params(cmd, &params).expect("ok");
        let mut cmd_hash_bytes = [0u8; 32];
        for (i, b) in canonical.iter().take(32).enumerate() {
            cmd_hash_bytes[i] = *b ^ 0x55;
        }
        CommandEnvelope {
            cmd: cmd.to_string(),
            params,
            actor: [0x07u8; 16],
            tenant_id: [0x42u8; 16],
            iat_unix_secs: iat,
            exp_unix_secs: exp,
            jti: "cmd-uuid-abc".to_string(),
            nonce: "nonce-1".to_string(),
            cmd_hash: CmdHash::from_bytes(cmd_hash_bytes),
            signature: None,
        }
    }

    fn mock_hash(input: &[u8]) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, b) in input.iter().take(32).enumerate() {
            out[i] = *b ^ 0x55;
        }
        out
    }

    /// WHY: Happy path — Disabled mode accepts unsigned non-mutating envelope.
    #[test]
    fn disabled_mode_accepts_unsigned_envelope() {
        let env = make_env("ping", 1_000, 9_000);
        let jti = verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect("disabled accepts unsigned");
        assert_eq!(jti.as_str(), "cmd-uuid-abc");
    }

    /// WHY: Enforcing mode + mutating command + no signature → reject.
    #[test]
    fn enforcing_mode_rejects_unsigned_mutating_command() {
        let env = make_env("write_tag", 1_000, 9_000);
        let err = verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Enforcing,
            mock_hash,
            |_, _| true,
        )
        .expect_err("unsigned mutating");
        assert_eq!(err, EnvelopeVerifyError::SignatureRequiredInEnforcingMode);
    }

    /// WHY: Enforcing mode + read-only command + no signature → accept.
    ///      Read-only commands (ping, health_check) have no authority.
    #[test]
    fn enforcing_mode_accepts_unsigned_read_only_command() {
        let env = make_env("ping", 1_000, 9_000);
        verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Enforcing,
            mock_hash,
            |_, _| true,
        )
        .expect("read-only accepted");
    }

    /// WHY: Permissive mode + unsigned mutating → accept (legacy rollout).
    #[test]
    fn permissive_mode_accepts_unsigned_mutating() {
        let env = make_env("write_tag", 1_000, 9_000);
        verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Permissive,
            mock_hash,
            |_, _| true,
        )
        .expect("permissive accepts");
    }

    /// WHY: Signature present but verify closure returns false → Invalid.
    #[test]
    fn signed_envelope_with_bad_signature_rejected() {
        let mut env = make_env("write_tag", 1_000, 9_000);
        env.signature = Some(Ed25519SignatureBytes::from_array([0u8; 64]));
        let err = verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Enforcing,
            mock_hash,
            |_, _| false,
        )
        .expect_err("bad sig");
        assert_eq!(err, EnvelopeVerifyError::SignatureInvalid);
    }

    /// WHY: Signature present + verify closure passes → OK.
    #[test]
    fn signed_envelope_with_good_signature_accepted() {
        let mut env = make_env("write_tag", 1_000, 9_000);
        env.signature = Some(Ed25519SignatureBytes::from_array([0u8; 64]));
        verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Enforcing,
            mock_hash,
            |_, _| true,
        )
        .expect("good sig");
    }

    /// WHY: Tenant mismatch fires before crypto verify.
    #[test]
    fn rejects_tenant_mismatch() {
        let env = make_env("ping", 1_000, 9_000);
        let err = verify_envelope(
            &env,
            &[0x99u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect_err("tenant");
        assert_eq!(err, EnvelopeVerifyError::TenantMismatch);
    }

    /// WHY: Freshness window invariants.
    #[test]
    fn rejects_inverted_freshness_window() {
        let env = make_env("ping", 9_000, 1_000);
        let err = verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect_err("inverted");
        assert_eq!(
            err,
            EnvelopeVerifyError::InvalidFreshnessWindow { iat: 9_000, exp: 1_000 }
        );
    }

    #[test]
    fn rejects_not_yet_valid() {
        let env = make_env("ping", 5_000, 9_000);
        let err = verify_envelope(
            &env,
            &[0x42u8; 16],
            1_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect_err("future");
        assert!(matches!(err, EnvelopeVerifyError::NotYetValid { .. }));
    }

    #[test]
    fn rejects_expired() {
        let env = make_env("ping", 1_000, 5_000);
        let err = verify_envelope(
            &env,
            &[0x42u8; 16],
            9_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect_err("expired");
        assert!(matches!(err, EnvelopeVerifyError::Expired { .. }));
    }

    /// WHY: Inclusive boundaries (now == iat and now == exp both accepted).
    #[test]
    fn accepts_now_exactly_at_iat() {
        let env = make_env("ping", 5_000, 9_000);
        verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect("now == iat must pass");
    }

    #[test]
    fn accepts_now_exactly_at_exp() {
        let env = make_env("ping", 1_000, 5_000);
        verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect("now == exp must pass");
    }

    #[test]
    fn rejects_negative_now() {
        let env = make_env("ping", 1_000, 9_000);
        let err = verify_envelope(
            &env,
            &[0x42u8; 16],
            -1,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect_err("negative now");
        assert_eq!(err, EnvelopeVerifyError::InvalidNow);
    }

    /// WHY: cmd_hash mismatch rejected.
    #[test]
    fn rejects_cmd_hash_mismatch() {
        let mut env = make_env("ping", 1_000, 9_000);
        // Flip one byte of cmd_hash — requires unpacking the newtype.
        let mut bad_bytes = *env.cmd_hash.as_bytes();
        bad_bytes[0] ^= 0xff;
        env.cmd_hash = CmdHash::from_bytes(bad_bytes);
        let err = verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect_err("cmd_hash mismatch");
        assert_eq!(err, EnvelopeVerifyError::CmdHashMismatch);
    }

    /// WHY: Empty cmd rejected.
    #[test]
    fn rejects_empty_cmd() {
        let mut env = make_env("ping", 1_000, 9_000);
        env.cmd = String::new();
        let err = verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect_err("empty");
        assert_eq!(err, EnvelopeVerifyError::EmptyCmd);
    }

    /// WHY: Invalid jti rejected.
    #[test]
    fn rejects_invalid_jti() {
        let mut env = make_env("ping", 1_000, 9_000);
        env.jti = String::new();
        let err = verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect_err("empty jti");
        assert!(matches!(err, EnvelopeVerifyError::InvalidJti(_)));
    }

    /// WHY: Nonce length bounded.
    #[test]
    fn rejects_oversized_nonce() {
        let mut env = make_env("ping", 1_000, 9_000);
        env.nonce = "x".repeat(MAX_NONCE_BYTES + 1);
        let err = verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect_err("nonce too long");
        assert_eq!(
            err,
            EnvelopeVerifyError::NonceTooLong(MAX_NONCE_BYTES + 1)
        );
    }

    /// WHY: SignatureMode JSON wire format is snake_case.
    #[test]
    fn signature_mode_serde_snake_case() {
        assert_eq!(
            serde_json::to_string(&SignatureMode::Disabled).expect("ok"),
            r#""disabled""#
        );
        assert_eq!(
            serde_json::to_string(&SignatureMode::Permissive).expect("ok"),
            r#""permissive""#
        );
        assert_eq!(
            serde_json::to_string(&SignatureMode::Enforcing).expect("ok"),
            r#""enforcing""#
        );
    }

    /// WHY: Envelope JSON round-trip.
    #[test]
    fn envelope_json_roundtrip() {
        let env = make_env("ping", 1_000, 9_000);
        let json = serde_json::to_string(&env).expect("serialize");
        let back: CommandEnvelope = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, env);
    }

    /// WHY: Signed envelope JSON round-trip.
    #[test]
    fn signed_envelope_json_roundtrip() {
        let mut env = make_env("write_tag", 1_000, 9_000);
        env.signature = Some(Ed25519SignatureBytes::from_array([0x11u8; 64]));
        let json = serde_json::to_string(&env).expect("serialize");
        let back: CommandEnvelope = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, env);
    }

    /// WHY: Verifier closure receives envelope canonical bytes (non-empty).
    #[test]
    fn verifier_receives_envelope_canonical_bytes() {
        let mut env = make_env("write_tag", 1_000, 9_000);
        env.signature = Some(Ed25519SignatureBytes::from_array([0u8; 64]));
        let mut received_len = 0usize;
        let _ = verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Enforcing,
            mock_hash,
            |bytes, _| {
                received_len = bytes.len();
                true
            },
        );
        assert!(received_len > 64, "envelope bytes must be substantial");
    }

    /// WHY: EnvelopeVerifyError Display format for each variant.
    #[test]
    fn envelope_verify_error_display_snake_case() {
        assert_eq!(format!("{}", EnvelopeVerifyError::EmptyCmd), "empty_cmd");
        assert_eq!(
            format!("{}", EnvelopeVerifyError::InvalidJti(InvalidJti::Empty)),
            "invalid_jti"
        );
        assert_eq!(
            format!("{}", EnvelopeVerifyError::NonceTooLong(500)),
            "nonce_too_long"
        );
        assert_eq!(
            format!(
                "{}",
                EnvelopeVerifyError::InvalidFreshnessWindow { iat: 1, exp: 0 }
            ),
            "invalid_freshness_window"
        );
        assert_eq!(
            format!(
                "{}",
                EnvelopeVerifyError::NotYetValid { now_unix_secs: 0, iat: 1 }
            ),
            "not_yet_valid"
        );
        assert_eq!(
            format!("{}", EnvelopeVerifyError::Expired { now_unix_secs: 2, exp: 1 }),
            "expired"
        );
        assert_eq!(format!("{}", EnvelopeVerifyError::InvalidNow), "invalid_now");
        assert_eq!(
            format!("{}", EnvelopeVerifyError::TenantMismatch),
            "tenant_mismatch"
        );
        assert_eq!(
            format!("{}", EnvelopeVerifyError::CmdHashMismatch),
            "cmd_hash_mismatch"
        );
        assert_eq!(
            format!(
                "{}",
                EnvelopeVerifyError::CanonicalParamsFailed(
                    CanonicalParamsError::EmptyCmdName
                )
            ),
            "canonical_params_failed"
        );
        assert_eq!(
            format!("{}", EnvelopeVerifyError::SignatureRequiredInEnforcingMode),
            "signature_required_in_enforcing_mode"
        );
        assert_eq!(
            format!("{}", EnvelopeVerifyError::SignatureInvalid),
            "signature_invalid"
        );
        assert_eq!(format!("{}", EnvelopeVerifyError::JtiReplay), "jti_replay");
    }

    /// WHY: Error implements std::error::Error for `?` interop.
    #[test]
    fn envelope_verify_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<EnvelopeVerifyError>();
    }

    /// WHY (BATCH-007-FU-03 closure): Gate 1a MUST reject cmd name exceeding
    ///      MAX_CMD_NAME_BYTES. Catches attacker-supplied 4GB cmd strings
    ///      BEFORE any canonicalization allocation work.
    #[test]
    fn rejects_cmd_name_exceeding_max_length() {
        let mut env = make_env("ping", 1_000, 9_000);
        env.cmd = "x".repeat(MAX_CMD_NAME_BYTES + 1);
        // Need to match cmd_hash against the NEW (long) cmd name for the
        // test to reach Gate 1a; recompute with the same mock.
        let canonical = canonical_params(&env.cmd, &env.params).expect("ok");
        let mut hash = [0u8; 32];
        for (i, b) in canonical.iter().take(32).enumerate() {
            hash[i] = *b ^ 0x55;
        }
        env.cmd_hash = CmdHash::from_bytes(hash);
        let err = verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect_err("oversized cmd");
        assert_eq!(
            err,
            EnvelopeVerifyError::CmdNameTooLong(MAX_CMD_NAME_BYTES + 1)
        );
    }

    #[test]
    fn accepts_cmd_name_at_exact_max_length() {
        let mut env = make_env("ping", 1_000, 9_000);
        env.cmd = "a".repeat(MAX_CMD_NAME_BYTES);
        let canonical = canonical_params(&env.cmd, &env.params).expect("ok");
        let mut hash = [0u8; 32];
        for (i, b) in canonical.iter().take(32).enumerate() {
            hash[i] = *b ^ 0x55;
        }
        env.cmd_hash = CmdHash::from_bytes(hash);
        verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| true,
        )
        .expect("at bound must accept");
    }

    /// WHY (BATCH-007-FU-04 closure): pin Disabled-mode behaviour as
    ///      "accept even when signature closure returns false". Disabled
    ///      is legacy compat for initial deploy parity; any enforcement
    ///      there would break the migration path. Documents the
    ///      match-arm-1 short-circuit per SignatureMode::Disabled docstring.
    #[test]
    fn disabled_mode_ignores_invalid_signature() {
        let mut env = make_env("write_tag", 1_000, 9_000);
        env.signature = Some(Ed25519SignatureBytes::from_array([0u8; 64]));
        // Closure returns false — if Disabled mode were to verify, we'd
        // get SignatureInvalid. Instead the arm-1 short-circuit accepts.
        verify_envelope(
            &env,
            &[0x42u8; 16],
            5_000,
            SignatureMode::Disabled,
            mock_hash,
            |_, _| false,
        )
        .expect("Disabled mode accepts regardless of signature");
    }

    /// WHY: CmdNameTooLong Display format pinned.
    #[test]
    fn cmd_name_too_long_display_format() {
        assert_eq!(
            format!("{}", EnvelopeVerifyError::CmdNameTooLong(129)),
            "cmd_name_too_long"
        );
    }

    /// WHY (BATCH-007-FU-02 regression guard): CmdHash newtype round-trips
    ///      via serde_json transparent — wire format unchanged from raw
    ///      [u8; 32] (array of ints).
    #[test]
    fn cmd_hash_serde_transparent_roundtrip() {
        let h = CmdHash::from_bytes([0xabu8; 32]);
        let json = serde_json::to_string(&h).expect("ok");
        // serde emits fixed arrays as JSON array of ints.
        assert!(json.starts_with("[171,171,171"));
        let back: CmdHash = serde_json::from_str(&json).expect("ok");
        assert_eq!(back, h);
    }
}
