//! Invariant: the MQTT legacy (non-envelope) command dispatch
//! path enforces the catalog `LegacyPolicy` against `signature_mode`.
//!
//! WHY (EDGE-CRITICAL-003): `handle_message` parses two kinds of
//! payload — signed `CommandEnvelope` (verified by the 7-gate
//! `verify_envelope`) and legacy `CommandMessage` JSON. Before this
//! fix the legacy arms dispatched the parsed command with ZERO
//! signature/mode/legacy-policy check, so an unsigned mutating
//! command (`write_modbus`/`set_output`/…) bypassed
//! `SignatureMode::Enforcing` entirely — an unauthenticated
//! actuator-control surface. Both legacy arms (the tenant-known
//! `NotEnvelopeFormat` arm and the pre-provisioning fallback) must
//! call `legacy_command_permitted` and reject on `Err`.
//!
//! WHY grep (Tier-3): exercising `handle_message` end-to-end needs a
//! full AppState + MQTT fixture; a source-read catches the
//! silent-regression class (a refactor drops the gate) at negligible
//! cost. The behavioral matrix of `legacy_command_permitted` itself
//! is unit-tested in `src/commands/catalog.rs`.

const DISPATCH_PATH: &str = "src/commands/mqtt_dispatch.rs";

fn read_dispatch() -> String {
    std::fs::read_to_string(DISPATCH_PATH).unwrap_or_else(|e| {
        panic!(
            "BUG: legacy-command-gate invariant cannot read {} — runs from the \
             sens-api-gateway/ working dir per cargo convention. err={}",
            DISPATCH_PATH, e
        )
    })
}

/// Both legacy-parse arms MUST gate through `legacy_command_permitted`.
/// The call appears once per arm (tenant-known + pre-provisioning).
#[test]
fn legacy_dispatch_arms_enforce_signature_policy() {
    let src = read_dispatch();
    let call_count = src.matches("legacy_command_permitted(").count();
    assert!(
        call_count >= 2,
        "EDGE-CRITICAL-003 regression: expected both legacy dispatch arms in {} \
         to call `legacy_command_permitted` (found {} call site(s)) — an unsigned \
         legacy command could again bypass signature_mode=Enforcing.",
        DISPATCH_PATH,
        call_count
    );
}

/// EDGE-HIGH-009: the verified (signed) command path MUST run the
/// RBAC authorization gate before dispatch. The signature proves
/// authN; `authorize_adapted` proves the actor's manifest role holds
/// the required permission (authZ). Before this wiring the permission
/// was computed and only logged, so any enrolled operator could run
/// any command.
#[test]
fn verified_dispatch_path_enforces_rbac_authorization() {
    let src = read_dispatch();
    assert!(
        src.contains("authorize_adapted("),
        "EDGE-HIGH-009 regression: {} no longer calls `authorize_adapted` on the \
         verified command path — RBAC role->permission enforcement was dropped, so \
         any enrolled operator could execute any command.",
        DISPATCH_PATH
    );
}
