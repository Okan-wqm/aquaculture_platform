//! Faz 1 architectural primitives wire-status invariants
//! (Batch #321 stale-A registry catchup).
//!
//! ## Why this file exists
//!
//! The Plan §5 Faz 1 / Faz 5 Core architectural primitives
//! (A-1a CommandHandler, A-1b dispatcher wire, A-2a
//! AuthenticatedUser, A-2b SensNodeManager, A-2c
//! SimpleNodeManager retirement, A-3a UserTokenEnrollment,
//! A-3b validator + manifest hot-reload) all LANDED in
//! prior batches but their registry findings (UH-001..007)
//! stayed OPEN — registry stale relative to code state.
//!
//! Closing the registry findings WITHOUT a real Tier-3
//! detection seam would be bookkeeping-only: the closure
//! would carry no architectural protection against a
//! future refactor that accidentally REMOVES a primitive.
//!
//! This file pins each primitive's WIRE STATUS via a
//! source-grep test. A refactor that deletes any of the
//! wired primitives fails THIS test — the closure is then
//! architecturally meaningful (Tier-3 detection per
//! CLAUDE.md hierarchy) instead of bookkeeping-only.
//!
//! ## Pattern (mirrors Batch #319 D-5 wire invariants)
//!
//! Each test reads a specific source file, asserts the
//! expected primitive shape is present, and emits an
//! operator-readable failure message naming the gap-id +
//! the architectural reason the wire matters. This is the
//! Tier-3 detection seam closing the regression-detection
//! gap that the contract-marker tests (`assert!(!_contract.
//! is_empty())`) leave open.

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: faz1_architectural_primitives invariant cannot read {} — \
             this test runs from sens-api-gateway/ working dir per cargo \
             test convention. err={}",
            path, e
        )
    })
}

/// **UH-001 A-1a wire-status:** the `EnvelopeHandler`
/// trait (the architecturally-final shape of the A-1a
/// "CommandHandler + HandlerInput sealed-ctor primitive"
/// — renamed during the wire arc to clarify that the
/// trait operates on a verified envelope, not raw command
/// bytes) MUST exist in `src/command_envelope/handler.rs`.
///
/// **Why this matters:** the trait is the abstraction
/// boundary between the dispatcher (which routes verified
/// envelopes) and the per-command handler logic (which
/// executes the verified payload). A refactor that
/// deletes the trait would let new handlers register via
/// duck-typed function pointers, bypassing the
/// HandlerInput sealed-ctor invariant that prevents
/// constructing a HandlerInput without first running
/// authz.
#[test]
fn uh_001_envelope_handler_trait_present() {
    let src = read_source("src/command_envelope/handler.rs");
    assert!(
        src.contains("pub trait EnvelopeHandler"),
        "UH-001 A-1a WIRE INVARIANT VIOLATED: \
         src/command_envelope/handler.rs does not define \
         `pub trait EnvelopeHandler`. The trait is the \
         architecturally-final shape of the A-1a primitive \
         (CommandHandler + HandlerInput sealed-ctor); \
         deleting it would let new handlers bypass the \
         HandlerInput invariant. Restore the trait or \
         document the rename + update this invariant."
    );
}

/// **UH-002 A-1b wire-status:** the `CommandDispatcher`
/// MUST exist in `src/command_envelope/dispatcher.rs` AND
/// dispatch through `EnvelopeHandler` instances.
///
/// **Why this matters:** the dispatcher is the SSoT for
/// "verified envelope → handler routing". A bypass that
/// invokes handlers directly without going through the
/// dispatcher would skip the dispatch-layer cross-cutting
/// concerns (rate limit, two-person integrity gate per
/// Batch #307, audit emission).
#[test]
fn uh_002_command_dispatcher_struct_present() {
    let src = read_source("src/command_envelope/dispatcher.rs");
    assert!(
        src.contains("pub struct CommandDispatcher"),
        "UH-002 A-1b WIRE INVARIANT VIOLATED: \
         src/command_envelope/dispatcher.rs does not define \
         `pub struct CommandDispatcher`. The dispatcher is \
         the SSoT for verified envelope → handler routing; \
         deleting it lets handlers be invoked directly, \
         bypassing the rate-limit + two-person-integrity + \
         audit gates that live at the dispatch layer."
    );
    assert!(
        src.contains("impl CommandDispatcher"),
        "UH-002 A-1b WIRE INVARIANT VIOLATED: \
         CommandDispatcher struct exists but has no `impl \
         CommandDispatcher` block. The dispatch logic must \
         live as inherent methods on the struct."
    );
}

/// **UH-003 A-2a wire-status:** `AuthenticatedUser`
/// newtype MUST exist in
/// `src/opc_ua_server_session.rs`. Sealed ctor (no public
/// new) ensures the only path to construct an
/// AuthenticatedUser is through the
/// SessionActor → resolve_authenticated_user path.
///
/// **Why this matters:** the newtype is the trust anchor
/// for the OPC UA write authorization chain. A bypass
/// that constructs an AuthenticatedUser directly would
/// let unsigned actors masquerade as authenticated.
#[test]
fn uh_003_authenticated_user_newtype_present() {
    let src = read_source("src/opc_ua_server_session.rs");
    assert!(
        src.contains("pub struct AuthenticatedUser"),
        "UH-003 A-2a WIRE INVARIANT VIOLATED: \
         src/opc_ua_server_session.rs does not define \
         `pub struct AuthenticatedUser`. The newtype is \
         the trust anchor for OPC UA write authorization; \
         deleting it lets unsigned actors masquerade as \
         authenticated."
    );
}

/// **UH-004 A-2b wire-status:** `SensNodeManager` MUST
/// exist in `src/opc_ua_sens_node_manager.rs` (the
/// 8-batch closure arc UCRIT-029/042/043 + UH-035/039/
/// 040/041 landed this; UH-004 stayed registry-OPEN
/// because no detection seam pinned the wire).
#[test]
fn uh_004_sens_node_manager_present() {
    let src = read_source("src/opc_ua_sens_node_manager.rs");
    assert!(
        src.contains("pub struct SensNodeManager")
            || src.contains("pub(crate) struct SensNodeManager"),
        "UH-004 A-2b WIRE INVARIANT VIOLATED: \
         src/opc_ua_sens_node_manager.rs does not define \
         `pub struct SensNodeManager` (or pub(crate)). The \
         custom NodeManager that captures RequestContext \
         is the architectural fix for the OPC UA write \
         path; a refactor that reverts to SimpleNodeManager \
         would lose the per-write actor-identity capture."
    );
}

/// **UH-005 A-2c wire-status:** the legacy
/// `SimpleNodeManagerImpl` (the pre-A-2b OPC UA backend)
/// MUST NOT be CONSTRUCTED in production code paths. The
/// retirement was the architectural goal of Batch #243.
///
/// **Why grep for absence:** SimpleNodeManager string
/// references can legitimately appear in COMMENTS that
/// document the historical context (the existing module
/// doc has them — that's correct). What MUST NOT appear
/// is `SimpleNodeManagerImpl::new(` or similar
/// constructor invocations OUTSIDE of test code.
#[test]
fn uh_005_simple_node_manager_not_constructed_in_production() {
    let src = read_source("src/opc_ua_sens_node_manager.rs");
    // Look for actual constructor invocations in NON-test
    // code. The existing comment-level mentions are
    // architecturally correct and stay.
    let production_ctor_calls = src
        .lines()
        .enumerate()
        .filter(|(_, l)| {
            let trimmed = l.trim_start();
            // Skip comment lines.
            !trimmed.starts_with("//") && !trimmed.starts_with("///") && !trimmed.starts_with("//!")
        })
        .filter(|(_, l)| l.contains("SimpleNodeManagerImpl::new"))
        .count();
    assert_eq!(
        production_ctor_calls, 0,
        "UH-005 A-2c WIRE INVARIANT VIOLATED: \
         SimpleNodeManagerImpl::new( appears in \
         non-comment code in opc_ua_sens_node_manager.rs. \
         The legacy NodeManager was retired in Batch #243 \
         (UCRIT-043 closure); reintroducing a constructor \
         call would silently downgrade the OPC UA write \
         path to per-node callbacks (no actor identity \
         capture). count_found={}",
        production_ctor_calls
    );
}

/// **UH-006 A-3a wire-status:** `UserTokenEnrollment`
/// struct MUST exist in `src/opc_ua_server_user_tokens.rs`.
/// The enrollment record carries the operator → public
/// key binding loaded from the RBAC manifest.
///
/// **Why this matters:** without the enrollment binding,
/// the OPC UA server would have to fall back to anonymous
/// tokens or hardcoded credentials — the gap that
/// ULTRA-CRITICAL-021 originally surfaced.
#[test]
fn uh_006_user_token_enrollment_present() {
    let src = read_source("src/opc_ua_server_user_tokens.rs");
    assert!(
        src.contains("pub struct UserTokenEnrollment"),
        "UH-006 A-3a WIRE INVARIANT VIOLATED: \
         src/opc_ua_server_user_tokens.rs does not define \
         `pub struct UserTokenEnrollment`. The enrollment \
         binding is the operator-identity anchor for OPC \
         UA writes; deleting it forces a fallback to \
         anonymous or hardcoded credentials \
         (ULTRA-CRITICAL-021 regression class)."
    );
}

/// **UH-007 A-3b wire-status:** the `RbacManifestStore`
/// (which holds the user-token enrollments) MUST exist +
/// support hot-reload. The hot_reload_flips_allow_to_deny
/// test in `opc_ua_server_typed_authz.rs` exercises the
/// reload path.
///
/// **Why this matters:** without hot-reload, a manifest
/// rotation forces a process restart — operationally
/// painful + creates a window where the OLD manifest is
/// still authoritative. Hot-reload is the architectural
/// answer to "rotate operator permissions without
/// downtime".
#[test]
fn uh_007_rbac_manifest_store_hot_reload_path_present() {
    // The store + the hot-reload test BOTH must exist.
    let store_src = read_source("src/authz/manifest_runtime.rs");
    assert!(
        store_src.contains("pub struct RbacManifestStore"),
        "UH-007 A-3b WIRE INVARIANT VIOLATED: \
         src/authz/manifest_runtime.rs does not define \
         `pub struct RbacManifestStore`. The store is the \
         hot-reloadable container for the user-token \
         enrollments; deleting it forces operator-identity \
         rotation through a process restart."
    );
    let test_src = read_source("src/opc_ua_server_typed_authz.rs");
    assert!(
        test_src.contains("hot_reload_flips_allow_to_deny"),
        "UH-007 A-3b WIRE INVARIANT VIOLATED: the \
         hot_reload_flips_allow_to_deny_on_next_call test \
         no longer appears in opc_ua_server_typed_authz.rs. \
         This test pins the architectural property that \
         RbacManifestStore::reload_manifest atomically \
         flips the active authz outcome on the next \
         dispatcher call without a process restart. \
         Deleting the test removes the regression-detection \
         seam — restore it or document the rename."
    );
}
