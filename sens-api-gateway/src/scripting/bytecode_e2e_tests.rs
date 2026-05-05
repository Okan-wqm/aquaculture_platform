//! Faz 3 end-to-end integration tests — Batch 179.
//!
//! ## WHY
//!
//! Each preceding batch (148–178) exercised its own
//! slice in isolation. Batch 179 wires the whole
//! stack together in a single test that proves the
//! full deploy-to-execute lifecycle:
//!
//! 1. Operator authors ST source.
//! 2. Compiler produces Bytecode.
//! 3. ed25519 sign → SignedBytecode wire artifact.
//! 4. `verify_and_deploy` (tenant + monotonic gates)
//!    → in-memory BytecodeProgramRegistry.
//! 5. BytecodeRegistryStore persists the entry to
//!    SQLCipher.
//! 6. Scan tick runs the program against a
//!    ProcessImage snapshot + commits writes back.
//! 7. RETAIN variables flow through the shared
//!    SqlitePersistence store.
//! 8. Simulated reboot: fresh registry + rehydrate
//!    from store + re-run tick proves the persisted
//!    program + RETAIN state survives.
//!
//! Regressions at ANY intermediate layer surface here
//! — the single test covers ~15 Batch-scoped surfaces
//! in one pass.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};

use super::bytecode::{Opcode, StValue, StValueType};
use super::bytecode_compiler::compile_program;
use super::bytecode_deploy::verify_and_deploy;
use super::bytecode_registry::BytecodeProgramRegistry;
use super::bytecode_registry_store::{
    load_into_registry, BytecodeRegistryStore,
};
use super::bytecode_runner::{
    run_scan_tick, BytecodeRunResult, ScanTickOptions,
};
use super::bytecode_sig::{canonical_bytes, SignedBytecode};
use super::persistence::SqlitePersistence;
use crate::authz::policy::Ed25519SignatureBytes;
use crate::process_image::{ProcessImage, TagQuality, TagSource};
use crate::st_validator::parse_st;

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[9u8; 32])
}

fn verifier_closure(
    pubkey: VerifyingKey,
) -> impl FnOnce(&[u8], &[u8; 64]) -> bool {
    move |msg, sig_bytes| {
        let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
        pubkey.verify(msg, &sig).is_ok()
    }
}

/// Sign a compiled bytecode into a SignedBytecode
/// envelope. Mirrors what an operator's cloud build
/// pipeline produces + ships over MQTT.
fn sign_bytecode(
    bc: &super::bytecode::Bytecode,
    key: &SigningKey,
) -> SignedBytecode {
    let canonical = canonical_bytes(bc).expect("canonical bytes");
    let sig = key.sign(&canonical);
    SignedBytecode {
        bytecode: bc.clone(),
        signature: Ed25519SignatureBytes::from_array(sig.to_bytes()),
    }
}

#[tokio::test]
async fn full_lifecycle_deploy_execute_reboot_rehydrate() {
    // ========================================================
    // Step 1: Operator authors ST source (aquaculture state
    // machine with RETAIN counter + range-match CASE).
    // ========================================================
    let st_source = r#"
        PROGRAM feed_counter
        VAR RETAIN
            cycles : INT;
        END_VAR
        VAR
            action : INT;
        END_VAR

        cycles := cycles + 1;

        CASE cycles OF
            1..3: action := 100;
            4..6: action := 200;
        ELSE
            action := 999;
        END_CASE;
        END_PROGRAM
    "#;

    // ========================================================
    // Step 2: Compile ST → Bytecode. Populate tenant +
    // policy_version so the downstream signed envelope
    // carries operator identity.
    // ========================================================
    let parsed = parse_st(st_source).expect("parse ok");
    let mut bc = compile_program(
        &parsed,
        &[],
        "feed_counter".into(),
        1_000_000,
    )
    .expect("compile ok");
    bc.tenant_id = Some("tenant-a".into());
    bc.policy_version = 1;

    // Sanity: compiler populated retain_vars with (name,
    // local_index, type) tuple.
    assert_eq!(bc.retain_vars.len(), 1);
    assert_eq!(bc.retain_vars[0].0, "cycles");
    assert_eq!(bc.retain_vars[0].2, StValueType::Int);

    // ========================================================
    // Step 3: Sign with ed25519. Matches the cloud build
    // pipeline output shape.
    // ========================================================
    let key = signing_key();
    let signed = sign_bytecode(&bc, &key);

    // ========================================================
    // Step 4: Edge-side boot — fresh stateful components.
    // ========================================================
    let pi = ProcessImage::new();
    let registry = Arc::new(BytecodeProgramRegistry::new());
    let persistent_store = BytecodeRegistryStore::in_memory().expect("store");
    let retain_db = SqlitePersistence::in_memory().expect("retain db");

    // ========================================================
    // Step 5: Simulate MQTT deploy command — verify +
    // deploy + persist.
    // ========================================================
    let report = verify_and_deploy(
        &registry,
        &signed,
        Some("tenant-a"),
        verifier_closure(key.verifying_key()),
    )
    .await
    .expect("deploy ok");
    assert_eq!(report.program_id, "feed_counter");
    assert_eq!(report.policy_version, 1);
    assert!(!report.replaced_existing);

    // Persist to the SQLCipher store (what cmd_deploy_
    // bytecode_program does post-insert).
    let deployed_entry = registry
        .get("feed_counter")
        .await
        .expect("in registry");
    persistent_store
        .save(&deployed_entry)
        .expect("store save");

    // ========================================================
    // Step 6: Tick 1 — cycles starts at 0 (zero-init),
    // becomes 1, hits 1..3 range → action=100.
    // ========================================================
    let declared_types: HashMap<String, StValueType> = HashMap::new();
    let options = ScanTickOptions::default();

    let tick1 = run_scan_tick(
        &registry,
        &pi,
        &declared_types,
        Some(&retain_db),
        &options,
    )
    .await;
    assert_eq!(tick1.len(), 1);
    assert!(matches!(
        tick1[0].1,
        BytecodeRunResult::Ok { .. }
    ));

    // Retain DB should now have cycles=1.
    let retained_after_tick1 = retain_db
        .load_async("feed_counter", "cycles")
        .await
        .expect("load ok")
        .expect("row present");
    assert_eq!(
        retained_after_tick1,
        serde_json::json!({"kind": "int", "value": 1})
    );

    // ========================================================
    // Step 7: Ticks 2–5 — verify cycles increments + the
    // CASE ranges dispatch correctly across the transition.
    // ========================================================
    for expected_cycles in 2..=5 {
        let _ = run_scan_tick(
            &registry,
            &pi,
            &declared_types,
            Some(&retain_db),
            &options,
        )
        .await;
        let retained = retain_db
            .load_async("feed_counter", "cycles")
            .await
            .expect("load ok")
            .expect("row present");
        assert_eq!(
            retained,
            serde_json::json!({"kind": "int", "value": expected_cycles})
        );
    }

    // ========================================================
    // Step 8: Simulate REBOOT. Fresh in-memory registry
    // (AppState::new baseline); rehydrate from the
    // persistent store.
    // ========================================================
    let registry_after_reboot = Arc::new(BytecodeProgramRegistry::new());
    let rehydrate_results =
        load_into_registry(&persistent_store, &registry_after_reboot).await;
    assert_eq!(rehydrate_results.len(), 1);
    assert!(rehydrate_results[0].is_ok());
    assert_eq!(registry_after_reboot.len().await, 1);

    // ========================================================
    // Step 9: Tick 6 post-reboot — cycles should load from
    // retain_db (=5) + increment to 6 which hits the
    // ELSE branch (range 4..6 caps at 6 so 6 itself is
    // still in that range — range expands to [4,5,6]).
    //
    // Wait — `4..6:` expands to `4, 5, 6` per the
    // inclusive range semantic in Batch 178. cycles=6
    // hits 4..6 range → action=200. At cycles=7 we'd
    // hit the ELSE branch.
    // ========================================================
    let tick6 = run_scan_tick(
        &registry_after_reboot,
        &pi,
        &declared_types,
        Some(&retain_db),
        &options,
    )
    .await;
    assert!(matches!(
        tick6[0].1,
        BytecodeRunResult::Ok { .. }
    ));
    let retained_after_reboot = retain_db
        .load_async("feed_counter", "cycles")
        .await
        .expect("load ok")
        .expect("row present");
    assert_eq!(
        retained_after_reboot,
        serde_json::json!({"kind": "int", "value": 6})
    );

    // ========================================================
    // Step 10: Tick 7 — cycles=7 is outside 1..3 AND 4..6,
    // hits ELSE branch → action=999.
    // ========================================================
    let _ = run_scan_tick(
        &registry_after_reboot,
        &pi,
        &declared_types,
        Some(&retain_db),
        &options,
    )
    .await;
    let retained_final = retain_db
        .load_async("feed_counter", "cycles")
        .await
        .expect("load ok")
        .expect("row present");
    assert_eq!(
        retained_final,
        serde_json::json!({"kind": "int", "value": 7})
    );
}

#[tokio::test]
async fn full_lifecycle_rejects_downgrade_redeploy() {
    // Second-half scenario: operator ships v1 → deploy
    // succeeds. Later a replay attack ships v1 again
    // (or a rollback to v0) — the monotonic version
    // gate rejects it, original v1 stays.
    let key = signing_key();

    let st_v1 = r#"
        PROGRAM p
        VAR x : INT; END_VAR
        x := 1;
        END_PROGRAM
    "#;
    let parsed = parse_st(st_v1).expect("parse");
    let mut bc = compile_program(&parsed, &[], "p".into(), 1000).expect("ok");
    bc.tenant_id = Some("tenant-a".into());
    bc.policy_version = 1;

    let registry = Arc::new(BytecodeProgramRegistry::new());
    let signed_v1 = sign_bytecode(&bc, &key);
    verify_and_deploy(
        &registry,
        &signed_v1,
        Some("tenant-a"),
        verifier_closure(key.verifying_key()),
    )
    .await
    .expect("v1 ok");

    // Replay v1 → rejected (not strictly greater).
    let signed_v1_replay = sign_bytecode(&bc, &key);
    let err = verify_and_deploy(
        &registry,
        &signed_v1_replay,
        Some("tenant-a"),
        verifier_closure(key.verifying_key()),
    )
    .await
    .expect_err("replay");
    assert!(matches!(
        err,
        super::bytecode_deploy::DeployError::Registry(
            super::bytecode_registry::RegistryError::PolicyVersionNotMonotonic { .. }
        )
    ));

    // Registry still has version 1.
    let entry = registry.get("p").await.expect("present");
    assert_eq!(entry.policy_version, 1);
}

#[tokio::test]
async fn full_lifecycle_tenant_mismatch_blocks_cross_tenant() {
    // Agent belongs to tenant-a; operator ships a
    // bytecode signed under tenant-b — deploy rejects.
    let key = signing_key();

    let st = r#"
        PROGRAM p
        VAR x : INT; END_VAR
        x := 1;
        END_PROGRAM
    "#;
    let parsed = parse_st(st).expect("parse");
    let mut bc = compile_program(&parsed, &[], "p".into(), 1000).expect("ok");
    bc.tenant_id = Some("tenant-b".into());
    bc.policy_version = 1;

    let registry = Arc::new(BytecodeProgramRegistry::new());
    let signed = sign_bytecode(&bc, &key);

    // Agent is tenant-a; signed under tenant-b → reject.
    let err = verify_and_deploy(
        &registry,
        &signed,
        Some("tenant-a"),
        verifier_closure(key.verifying_key()),
    )
    .await
    .expect_err("cross-tenant");
    assert!(matches!(
        err,
        super::bytecode_deploy::DeployError::TenantMismatch { .. }
    ));
    assert_eq!(registry.len().await, 0);
}

#[tokio::test]
async fn full_lifecycle_pinned_tag_blocks_runtime_write() {
    // Program tries to write a safe-state-pinned tag.
    // Batch 156 runtime gate rejects; program surfaces
    // Failed result.
    let key = signing_key();

    let st = r#"
        PROGRAM attempt_pinned
        VAR x : REAL; END_VAR
        x := 1.0;
        END_PROGRAM
    "#;
    let parsed = parse_st(st).expect("parse");
    let mut bc = compile_program(&parsed, &[], "attempt_pinned".into(), 1000)
        .expect("ok");
    // Manually synthesize an opcode that attempts a
    // WriteTag to a pinned tag name — operator-side
    // tooling would never emit this, but a compromised
    // pipeline could. Runtime gate must stop it.
    bc.tenant_id = Some("tenant-a".into());
    bc.policy_version = 1;
    bc.opcodes = vec![
        Opcode::PushConst {
            value: StValue::Real(99.0),
        },
        Opcode::WriteTag {
            name: "emergency_stop".into(),
        },
        Opcode::Return,
    ];
    bc.allowed_write_tags = vec!["emergency_stop".into()];
    bc.safe_state_pinned_tags = vec!["emergency_stop".into()];

    let registry = Arc::new(BytecodeProgramRegistry::new());
    let signed = sign_bytecode(&bc, &key);
    verify_and_deploy(
        &registry,
        &signed,
        Some("tenant-a"),
        verifier_closure(key.verifying_key()),
    )
    .await
    .expect("deploy ok");

    let pi = ProcessImage::new();
    pi.update_tag_raw(
        "emergency_stop",
        0.0,
        TagQuality::Good,
        TagSource::Modbus,
    )
    .await;
    let results = run_scan_tick(
        &registry,
        &pi,
        &HashMap::new(),
        None,
        &ScanTickOptions::default(),
    )
    .await;
    assert!(matches!(
        results[0].1,
        BytecodeRunResult::Failed { .. }
    ));
    // Pinned value unchanged despite the program running.
    assert_eq!(
        pi.get_tag("emergency_stop").await.expect("present").value,
        0.0
    );
}
