//! Faz 2 D-9 clock-authority wire-status invariants
//! (Batch #322 — partial UH-021 D-9 parent closure).
//!
//! ## Why this file
//!
//! The Plan §5 Faz 2 D-9 clock authority arc has two
//! independent halves:
//!
//!   1. The PRIMITIVES — ClockAuthority trait +
//!      MonotonicAnchor + WallClockReading + ClockError
//!      (Batch 10 + 55 + 313). ✅ landed.
//!   2. The IMPLEMENTATIONS — SystemClockAuthority
//!      (HC-1 trusting baseline) + ChronyNtsClockAuthority
//!      (real chronyc-tracking query, Sprint 6.7 wire).
//!      ✅ landed.
//!
//! Both halves are present in code; their registry
//! finding (UH-021 D-9 parent) stayed OPEN because no
//! detection seam pinned the wire at the boot path. A
//! refactor that:
//!
//!   - Removes `init_clock_authority` from main() boot
//!   - Or hardcodes `Arc::new(SystemClockAuthority::new())`
//!     instead of selecting by config
//!   - Or constructs SystemClockAuthority with a 0-age
//!     trusting default in production
//!
//! …would silently restore the pre-D-9 vulnerability
//! (TTL gates trust an unverified wallclock) without
//! the existing prose contract markers detecting it.
//!
//! This file pins the wire status via grep-based source
//! assertions following the Batch #319 D-5 + Batch #321
//! Faz 1 architectural pattern.
//!
//! ## What this file does NOT close
//!
//! UH-021 D-9 parent finding stays OPEN even after this
//! batch because the SECOND half of D-9 closure — the
//! 9 remaining `SystemTime::now()` TTL-consumer
//! migrations (license_cache, lifecycle, lifecycle_auth,
//! mqtt, mqtt_failover, outbound_publisher,
//! opc_ua_server session timeout, opc_ua_sens_node_manager)
//! — is tracked in ORPHAN-MEDIUM-030 + needs a
//! per-consumer migration batch. This batch's closure
//! contribution is the WIRE-STATUS detection seam; the
//! per-consumer migration is the bug-class remediation.

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: d9_clock_authority_wired invariant cannot read {} — \
             this test runs from sens-api-gateway/ working dir per cargo \
             test convention. err={}",
            path, e
        )
    })
}

/// **D-9 wire-status invariant 1:** AppState MUST define
/// `init_clock_authority` AND main.rs MUST call it BEFORE
/// init_keystore (the keystore depends on the clock for
/// the rotation marker init).
///
/// **Why this matters:** the clock_authority is the trust
/// anchor for the rotation marker AND every TTL consumer.
/// Constructing the keystore (or any TTL consumer) before
/// the clock_authority is initialized would either crash
/// (None deref) OR worse — silently fall back to a default
/// that bypasses the chrony NTS gate.
#[test]
fn d9_init_clock_authority_called_before_init_keystore() {
    let main_rs = read_source("src/main.rs");

    // The CALL sites — not the method definitions. We
    // search for the invocation pattern (`.init_*(` after a
    // state_guard or self) so doc-comment mentions of
    // these names in OTHER methods don't anchor the
    // position check at the wrong byte.
    //
    // CALL site shape from main.rs cold-boot (line 3357
    // pattern):
    //   state_guard.init_keystore().await
    // Plus the init_clock_authority call invoked in the
    // earlier cold-boot block.
    let init_clock_call_idx = main_rs
        .find("init_clock_authority();")
        .or_else(|| main_rs.find("init_clock_authority()"))
        .unwrap_or_else(|| panic!(
            "D-9 WIRE INVARIANT VIOLATED: main.rs has no \
             `init_clock_authority()` CALL site. The clock authority \
             is the trust anchor for every TTL-bearing subsystem; \
             without the call the field stays at the default \
             SystemClockAuthority::default() (trusting-0-age) AND \
             the operator-config selection (chrony query enable) \
             is dead code. Restore the call or document the rename \
             + update this invariant."
        ));
    let init_keystore_call_idx = main_rs
        .find("init_keystore().await")
        .or_else(|| {
            // Find the FIRST CALL — must come after the
            // method definition. Method def is at the same
            // pattern but inside `pub async fn init_keystore`,
            // so we skip past the `fn` decl.
            let fn_decl = main_rs.find("pub async fn init_keystore");
            if let Some(decl_idx) = fn_decl {
                // Skip past the fn body — find the next
                // call-site after the closing `}` of the fn.
                // Easier: search the whole file for the
                // .await invocation.
                let after_decl = &main_rs[decl_idx..];
                after_decl
                    .find(".init_keystore()")
                    .map(|rel| decl_idx + rel)
            } else {
                None
            }
        })
        .unwrap_or_else(|| panic!(
            "D-9 wire invariant locator: `init_keystore().await` (or \
             `.init_keystore()` call site) not found in main.rs — the \
             locator-anchor was renamed; this test needs an updated \
             anchor."
        ));
    assert!(
        init_clock_call_idx < init_keystore_call_idx,
        "D-9 WIRE INVARIANT VIOLATED: the `init_clock_authority()` \
         CALL site MUST appear in main.rs BEFORE the \
         `init_keystore().await` CALL site (the keystore depends on \
         the clock for the rotation marker init at boot). Got \
         init_clock_authority call at byte {} and init_keystore \
         call at byte {}. Note: this test compares CALL SITES, not \
         method definition order.",
        init_clock_call_idx,
        init_keystore_call_idx
    );
}

/// **D-9 wire-status invariant 2:** init_clock_authority
/// MUST select between SystemClockAuthority +
/// ChronyNtsClockAuthority based on
/// `config.clock.enable_chrony_query`. A hardcoded
/// SystemClockAuthority::new() with no threshold + no
/// config gate would silently disable the chrony NTS
/// query path.
#[test]
fn d9_init_clock_authority_selects_by_config_enable_chrony_query() {
    let main_rs = read_source("src/main.rs");
    let needle = "config.clock.enable_chrony_query";
    assert!(
        main_rs.contains(needle),
        "D-9 WIRE INVARIANT VIOLATED: main.rs does not branch on \
         `{}`. The clock authority impl MUST be config-selected so \
         operators can opt into ChronyNtsClockAuthority on devices \
         with chronyd running. Hardcoding either impl would \
         silently disable the operator-config knob.",
        needle
    );
    // Both impl ctors must appear in the selector.
    assert!(
        main_rs.contains("ChronyNtsClockAuthority::new("),
        "D-9 WIRE INVARIANT VIOLATED: main.rs does not construct \
         `ChronyNtsClockAuthority::new(`. The Sprint 6.7 real NTS \
         query path is the ARCHITECTURAL goal of D-9; without the \
         ctor call the agent always uses the trusting-0-age \
         SystemClockAuthority baseline + the chrony query is \
         dead code."
    );
    assert!(
        main_rs.contains("SystemClockAuthority::with_nts_threshold("),
        "D-9 WIRE INVARIANT VIOLATED: main.rs does not construct \
         `SystemClockAuthority::with_nts_threshold(`. The HC-1 \
         backward-compat path MUST honor the operator-configured \
         threshold; using `SystemClockAuthority::new()` (default \
         3600) instead would silently override the operator's \
         config when the chrony query is disabled."
    );
}

/// **D-9 wire-status invariant 3:** AppState MUST hold
/// `clock_authority: Arc<dyn ClockAuthority>` (NOT
/// Option<>, NOT a concrete type). The trait-object shape
/// is the architectural seam that lets every TTL consumer
/// take `&dyn ClockAuthority` without knowing which impl
/// is active.
#[test]
fn d9_app_state_clock_authority_field_is_arc_dyn_trait() {
    let main_rs = read_source("src/main.rs");
    // The exact Type literal — multi-line tolerant.
    let needle_a = "clock_authority";
    let needle_b = "Arc<dyn crate::runtime_safety::ClockAuthority>";
    assert!(
        main_rs.contains(needle_a),
        "D-9 WIRE INVARIANT VIOLATED: AppState does not declare a \
         `clock_authority` field. The clock-authority Arc is the \
         shared trust anchor for every TTL-bearing subsystem; the \
         field MUST be present + named for grep-discoverability."
    );
    assert!(
        main_rs.contains(needle_b),
        "D-9 WIRE INVARIANT VIOLATED: clock_authority field type does \
         not match `{}`. The trait-object shape (Arc<dyn ...>) is the \
         architectural seam that lets every TTL consumer take \
         `&dyn ClockAuthority` without knowing which impl is active. \
         A concrete-type field (Arc<SystemClockAuthority>) would \
         force every consumer to either know the impl or take a \
         second generic parameter — anti-pattern.",
        needle_b
    );
}

/// **D-9 wire-status invariant 4:** the ClockAuthority
/// trait MUST be `Send + Sync + 'static` so an
/// `Arc<dyn ClockAuthority>` is shareable across tokio
/// tasks. Removing the `Send + Sync + 'static` bounds
/// would prevent the trait object from being shared,
/// breaking every consumer that holds an
/// Arc<dyn ClockAuthority>.
#[test]
fn d9_clock_authority_trait_is_send_sync_static() {
    let src = read_source("src/runtime_safety/clock.rs");
    let needle = "pub trait ClockAuthority: Send + Sync + 'static";
    assert!(
        src.contains(needle),
        "D-9 WIRE INVARIANT VIOLATED: src/runtime_safety/clock.rs \
         does not declare `{}`. Removing the Send + Sync + 'static \
         bounds would prevent the trait object from being shared \
         across tokio tasks; every consumer that holds an \
         Arc<dyn ClockAuthority> would fail to compile.",
        needle
    );
}

/// **D-9 wire-status invariant 5:** MonotonicDeadline
/// (Batch #313 anti-rollback primitive) MUST exist in
/// `src/runtime_safety/clock.rs`. Without this, TTL
/// consumers cannot adopt the rollback-safe path; the
/// force_registry migration (Batch #314) AND every
/// ORPHAN-MEDIUM-030 future migration depend on this
/// primitive.
#[test]
fn d9_monotonic_deadline_primitive_present() {
    let src = read_source("src/runtime_safety/clock.rs");
    assert!(
        src.contains("pub struct MonotonicDeadline"),
        "D-9 WIRE INVARIANT VIOLATED: src/runtime_safety/clock.rs \
         does not define `pub struct MonotonicDeadline`. The \
         primitive (Batch #313) is the type-system-enforced \
         anti-clock-rollback wrapper; without it TTL consumers \
         cannot migrate off the SystemTime::now-vulnerable \
         pattern. Restore the type or document the rename + \
         update this invariant."
    );
    // The two construction paths MUST exist:
    //   from_wallclock_target — capture a SystemTime target.
    //   from_duration_now — capture a Duration-from-now.
    assert!(
        src.contains("pub async fn from_wallclock_target"),
        "D-9 WIRE INVARIANT VIOLATED: MonotonicDeadline lacks the \
         from_wallclock_target ctor. This is the architectural \
         entry for migrating SystemTime-bound expiry timestamps \
         (e.g., JWT exp claims) to the rollback-safe path."
    );
    assert!(
        src.contains("pub async fn from_duration_now"),
        "D-9 WIRE INVARIANT VIOLATED: MonotonicDeadline lacks the \
         from_duration_now ctor. This is the architectural entry \
         for migrating TTL-from-now patterns (e.g., session \
         timeout) to the rollback-safe path."
    );
}

/// **D-9 wire-status invariant 6:** the operator
/// runbook + Sprint 6.7 wire docs reference the
/// chronyc-tracking source. This is a documentation
/// invariant — pins that the OPERATOR-FACING explanation
/// of how to enable the real NTS query exists in code
/// (currently as doc comments on the config field, since
/// the runbook file is a future deliverable).
#[test]
fn d9_chrony_setup_doc_reference_present() {
    let config_src = read_source("src/config.rs");
    assert!(
        config_src.contains("chronyc"),
        "D-9 WIRE INVARIANT VIOLATED: src/config.rs has no \
         `chronyc` reference in the clock config doc comments. \
         Operators reading the config struct MUST see how to \
         enable the chrony query path; without this they may \
         deploy with the trusting-0-age baseline thinking it \
         is the secure default."
    );
    assert!(
        config_src.contains("chronyd"),
        "D-9 WIRE INVARIANT VIOLATED: src/config.rs has no \
         `chronyd` reference. The daemon name is the \
         deployment-side prerequisite for chronyc query path; \
         the doc must mention it."
    );
}
