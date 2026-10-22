//! EDGE-MEDIUM-135 and EDGE-MEDIUM-077 through the real dispatch path: a payload
//! goes into `handle_command_message` (the commands arm, with no broker), and
//! the audit chain says what happened to it. Every refusal leaves exactly one
//! audit entry that names its code; a command the clock authority will not
//! vouch for is refused BEFORE anything is verified; a command that is run
//! leaves its own two entries and its redelivery one refusal.

use std::sync::Arc;

use async_trait::async_trait;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::AppState;
use crate::audit::{AuditHmacKey, AuditSink};
use crate::authz::policy::Ed25519SignatureBytes;
use crate::command_envelope::envelope::SignatureMode;
use crate::command_envelope::{
    CmdHash, CommandEnvelope, canonical_params, envelope_canonical_bytes,
};
use crate::mqtt::IncomingMessage;
use crate::runtime_safety::{
    ClockAuthority, ClockError, MonotonicAnchor, UnsyncedCause, WallClockReading,
};

use super::CommandHandler;

const TENANT: [u8; 16] = [0x42; 16];
const COMMANDS: &str = "tenants/t/devices/d/commands";

struct Rig {
    handler: CommandHandler,
    state: Arc<RwLock<AppState>>,
    sink: Arc<AuditSink>,
    log: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

/// A clock authority that will not vouch for the wall clock.
struct UnsyncedClock;

#[async_trait]
impl ClockAuthority for UnsyncedClock {
    fn monotonic_now(&self) -> Result<MonotonicAnchor, ClockError> {
        Ok(MonotonicAnchor::for_test(0))
    }

    async fn trustworthy_wall_clock(&self) -> Result<WallClockReading, ClockError> {
        Err(ClockError::Unsynced(UnsyncedCause::ReportedUnsynced))
    }

    fn nts_sync_max_skew_secs(&self) -> u64 {
        3600
    }
}

async fn rig_with(tenant: Option<[u8; 16]>) -> Rig {
    let config: crate::config::AgentConfig = serde_yaml::from_str(
        "device_id: \"123e4567-e89b-42d3-a456-426614174000\"\ndevice_code: \"REVPI-1\"\n\
         api_url: \"https://api.example.test\"\nmqtt:\n  broker: \"localhost\"\n  port: 1883\n",
    )
    .expect("a minimal configuration");
    let mut app = AppState::new(config);
    // The mode every Suderra OS agent compiles; the generic profile's default is
    // Permissive, so the unsigned-path tests below set it themselves.
    app.config.signature_mode = SignatureMode::Enforcing;
    app.tenant_id = tenant.map(|t| uuid::Uuid::from_bytes(t).to_string());
    let dir = tempfile::tempdir().expect("tempdir");
    let log = dir.path().join("audit.ndjson");
    let sink = Arc::new(
        AuditSink::open(&log, AuditHmacKey::from_bytes([0x11; 32])).expect("an audit sink"),
    );
    app.audit_sink = Some(sink.clone());
    let state = Arc::new(RwLock::new(app));
    let handler = CommandHandler::new(state.clone()).await;
    Rig {
        handler,
        state,
        sink,
        log,
        _dir: dir,
    }
}

async fn rig() -> Rig {
    rig_with(Some(TENANT)).await
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// A command envelope for `cmd`, valid between `iat` and `exp`, signed by `signer`.
fn envelope(cmd: &str, jti: &str, iat: i64, exp: i64, signer: Option<&SigningKey>) -> Vec<u8> {
    let params = serde_json::json!({});
    let canonical = canonical_params(cmd, &params).expect("canonical params");
    let mut env = CommandEnvelope {
        cmd: cmd.to_owned(),
        params,
        actor: [0x11; 16],
        tenant_id: TENANT,
        iat_unix_secs: iat,
        exp_unix_secs: exp,
        co_approver_actor: None,
        co_approver_signature: None,
        claimed_policy_version: 1,
        jti: jti.to_owned(),
        nonce: "refusal-test".to_owned(),
        cmd_hash: CmdHash::from_bytes(Sha256::digest(&canonical).into()),
        signature: None,
    };
    if let Some(key) = signer {
        let bytes = envelope_canonical_bytes(&env).expect("canonical bytes");
        env.signature = Some(Ed25519SignatureBytes::from_array(
            key.sign(&bytes).to_bytes(),
        ));
    }
    serde_json::to_vec(&env).expect("serializes")
}

fn fresh(cmd: &str, jti: &str, signer: Option<&SigningKey>) -> Vec<u8> {
    envelope(cmd, jti, now_secs() - 5, now_secs() + 55, signer)
}

fn message(payload: Vec<u8>, retain: bool) -> IncomingMessage {
    IncomingMessage {
        topic: COMMANDS.to_owned(),
        payload,
        retain,
    }
}

impl Rig {
    async fn send(&mut self, payload: Vec<u8>) {
        self.send_message(message(payload, false)).await;
    }

    async fn send_message(&mut self, message: IncomingMessage) {
        self.handler
            .handle_command_message(&message, COMMANDS)
            .await
            .expect("a refusal is an operational event, not a failure of the run loop");
    }

    /// How many entries the audit chain holds.
    fn entries(&self) -> u64 {
        self.sink.snapshot().0
    }

    /// The responses `refuse` has sent so far.
    fn responses(&self) -> Vec<serde_json::Value> {
        self.handler
            .refusal_responses
            .lock()
            .expect("the response log")
            .clone()
    }

    /// The audit log's lines.
    fn lines(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log)
            .expect("the audit log")
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// Send `payload`, and assert it left exactly one audit entry that names
    /// `code`, and that no command ran.
    async fn assert_one_refusal(&mut self, payload: Vec<u8>, code: &str) {
        let before = self.entries();
        let ran_before = self.handler.executed_command_ids.len();
        let answered_before = self.responses().len();
        self.send(payload).await;
        assert_eq!(
            self.handler.executed_command_ids.len(),
            ran_before,
            "{code}: a refused command is never executed"
        );
        assert_eq!(
            self.entries(),
            before + 1,
            "{code}: exactly one audit entry per refusal"
        );
        let last = self.lines().pop().expect("an entry");
        assert!(
            last.contains(&format!("refused={code}")),
            "{code}: the entry names the refusal: {last}"
        );
        // The sender is answered once, with the same code the audit entry names;
        // a duplicate's answer is the first execution's, and a retained message
        // has no sender.
        let responses = self.responses();
        if matches!(code, "duplicate-command" | "retained-command") {
            assert_eq!(responses.len(), answered_before, "{code}: not answered");
        } else {
            assert_eq!(
                responses.len(),
                answered_before + 1,
                "{code}: exactly one response per refusal"
            );
            let response = responses.last().expect("a response");
            assert_eq!(response["success"], false, "{code}");
            assert_eq!(response["result"]["rejected"], code, "{code}");
            assert_eq!(
                response["result"]["retryable"],
                matches!(code, "clock-unsynced" | "no-tenant-binding"),
                "{code}"
            );
            assert!(
                response["commandId"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty()),
                "{code}: the response correlates to a command id"
            );
        }
    }
}

#[tokio::test]
async fn a_retained_command_is_audited_and_never_run() {
    let mut rig = rig().await;
    let before = rig.entries();
    rig.send_message(message(fresh("ping", "retained-1", None), true))
        .await;
    assert_eq!(rig.entries(), before + 1);
    let last = rig.lines().pop().expect("an entry");
    assert!(last.contains("refused=retained-command"), "{last}");
    assert!(
        rig.responses().is_empty(),
        "a retained message has no sender"
    );
    assert!(
        rig.handler.executed_command_ids.is_empty(),
        "nothing ran: a retained message is a replay, not a command"
    );
}

#[tokio::test]
async fn a_payload_that_is_not_an_envelope_is_refused_where_only_envelopes_run() {
    let mut rig = rig().await;
    rig.assert_one_refusal(
        br#"{"command_id":"c-1","command":"ping","timestamp":"2026-10-22T00:00:00Z","params":{}}"#
            .to_vec(),
        "not-an-envelope",
    )
    .await;
    rig.assert_one_refusal(b"not json at all".to_vec(), "not-an-envelope")
        .await;
}

#[tokio::test]
async fn an_envelope_nobody_signed_for_is_refused_and_says_which_gate() {
    let mut rig = rig().await;
    let stranger = SigningKey::from_bytes(&[0x07; 32]);
    // `get_config` needs a signature; this key is in no RBAC manifest.
    rig.assert_one_refusal(
        fresh("get_config", "stranger-1", Some(&stranger)),
        "envelope-invalid",
    )
    .await;
    let last = rig.lines().pop().expect("an entry");
    assert!(last.contains("signature_invalid"), "{last}");
}

#[tokio::test]
async fn an_expired_envelope_is_refused() {
    let mut rig = rig().await;
    rig.assert_one_refusal(
        envelope(
            "ping",
            "expired-1",
            now_secs() - 200,
            now_secs() - 100,
            None,
        ),
        "envelope-invalid",
    )
    .await;
    let last = rig.lines().pop().expect("an entry");
    assert!(last.contains("expired"), "{last}");
}

/// The envelope's window is open (iat 1000 s ago, exp in a minute), so Gate 4
/// passes; the command's own replay window (300 s) does not.
#[tokio::test]
async fn a_command_outside_the_replay_window_is_refused() {
    let mut rig = rig().await;
    rig.assert_one_refusal(
        envelope("ping", "old-1", now_secs() - 1000, now_secs() + 60, None),
        "timestamp-stale",
    )
    .await;
}

/// EDGE-MEDIUM-077 / DEC-7.5: while the clock authority will not vouch for the
/// wall clock, a command is refused with the retryable `clock-unsynced` BEFORE
/// its signature is looked at — a payload that would fail verification still
/// reports the clock, because the clock came first and nothing was spent.
#[tokio::test]
async fn an_unsynced_clock_refuses_before_anything_is_verified() {
    let mut rig = rig().await;
    rig.state.write().await.clock_authority = Arc::new(UnsyncedClock);
    let stranger = SigningKey::from_bytes(&[0x07; 32]);
    rig.assert_one_refusal(
        fresh("get_config", "unsynced-1", Some(&stranger)),
        "clock-unsynced",
    )
    .await;
    let last = rig.lines().pop().expect("an entry");
    assert!(last.contains("detail=reported-unsynced"), "{last}");
    assert!(
        !last.contains("envelope-invalid"),
        "the signature must not have been looked at: {last}"
    );
    // Even a payload nobody could parse: the clock is the first gate.
    rig.assert_one_refusal(b"garbage".to_vec(), "clock-unsynced")
        .await;
}

/// A clock that syncs again is not remembered as unsynced: the next command
/// is judged on its merits.
#[tokio::test]
async fn a_clock_that_syncs_again_lets_commands_through_to_the_other_gates() {
    let mut rig = rig().await;
    rig.state.write().await.clock_authority = Arc::new(UnsyncedClock);
    rig.assert_one_refusal(fresh("ping", "back-1", None), "clock-unsynced")
        .await;
    rig.state.write().await.clock_authority =
        Arc::new(crate::runtime_safety::SystemClockAuthority::new());
    let before = rig.entries();
    rig.send(fresh("ping", "back-2", None)).await;
    assert_eq!(
        rig.entries(),
        before + 2,
        "a vouched clock lets the probe run: its own pre and post entries"
    );
}

/// A command that runs leaves its own audit entries (pre and post); its
/// redelivery is one refusal, and the sender is not sent a second, failed
/// response that could overwrite the first.
#[tokio::test]
async fn a_redelivered_command_is_audited_as_a_duplicate() {
    let mut rig = rig().await;
    let before = rig.entries();
    rig.send(fresh("ping", "dup-1", None)).await;
    assert_eq!(rig.entries(), before + 2, "pre and post of the first run");
    rig.assert_one_refusal(fresh("ping", "dup-1", None), "duplicate-command")
        .await;
}

#[cfg(feature = "suderra-os")]
#[tokio::test]
async fn a_device_without_a_tenant_binding_refuses_every_command() {
    let mut rig = rig_with(None).await;
    rig.assert_one_refusal(fresh("ping", "no-tenant-1", None), "no-tenant-binding")
        .await;
}

/// The generic profile's pre-provisioning fallback and Permissive mode keep the
/// legacy path; its gates refuse like the signed path's do.
#[cfg(not(feature = "suderra-os"))]
mod generic {
    use super::*;
    use crate::command_envelope::envelope::SignatureMode;

    fn legacy(command: &str, id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "commandId": id,
            "command": command,
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "params": {},
        }))
        .expect("serializes")
    }

    /// A command the catalog never lets run unsigned, in a mode that otherwise
    /// accepts the legacy path.
    fn never_unsigned() -> &'static str {
        super::super::catalog::COMMAND_CATALOG
            .iter()
            .map(|entry| entry.wire_name)
            .find(|name| {
                super::super::catalog::legacy_command_permitted(name, SignatureMode::Permissive)
                    .is_err()
            })
            .expect("the catalog denies some command on the unsigned path in every mode")
    }

    #[tokio::test]
    async fn a_forbidden_unsigned_command_is_refused_in_permissive_mode() {
        let mut rig = rig().await;
        rig.state.write().await.config.signature_mode = SignatureMode::Permissive;
        rig.assert_one_refusal(
            legacy(never_unsigned(), "legacy-1"),
            "unsigned-command-forbidden",
        )
        .await;
    }

    #[tokio::test]
    async fn a_payload_that_is_nothing_is_refused_as_unparseable_in_permissive_mode() {
        let mut rig = rig().await;
        rig.state.write().await.config.signature_mode = SignatureMode::Permissive;
        rig.assert_one_refusal(b"{\"unrelated\":true}".to_vec(), "unparseable-command")
            .await;
    }

    #[tokio::test]
    async fn the_pre_provisioning_fallback_refuses_what_it_cannot_run() {
        let mut rig = rig_with(None).await;
        rig.state.write().await.config.signature_mode = SignatureMode::Permissive;
        rig.assert_one_refusal(b"{\"unrelated\":true}".to_vec(), "unparseable-command")
            .await;
        rig.assert_one_refusal(
            legacy(never_unsigned(), "legacy-2"),
            "unsigned-command-forbidden",
        )
        .await;
    }
}
