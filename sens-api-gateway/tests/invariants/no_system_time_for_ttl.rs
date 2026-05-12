#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::print_stderr,
    clippy::print_stdout,
    clippy::unwrap_used
)]

//! Faz 2 D-9 final invariant — Tier-3 baseline-drift
//! detector for `SystemTime::now()` in TTL-critical files
//! (Batch #326 — closes UH-021 D-9 parent finding).
//!
//! ## Why this file
//!
//! The D-9 architectural goal: ban `SystemTime::now()` in
//! TTL-class consumers — those that compute "is now past
//! expiry" or "did request arrive within the freshness
//! window". The TTL-class consumer migrations landed:
//!
//!   - Batch #313 — MonotonicDeadline primitive
//!   - Batch #314 — force_registry migration
//!   - Batch #324 — lifecycle_auth verify_request
//!     (clock-rollback DOS class closed)
//!   - Batch #325 — PolicyEngineOpcUaAdapter +
//!     SensNodeManager (StalePolicyVersion bypass class
//!     closed)
//!
//! After those 4 migrations the TTL-class consumer
//! backlog is EMPTY. But `SystemTime::now()` still
//! legitimately appears in many files for AUDIT-TIMESTAMP
//! purposes (cross-restart event correlation needs
//! wall-clock anchors, NOT process-bound monotonic ones
//! per ADR-026 calendar-time event discipline).
//!
//! A naive grep-everywhere ban would either:
//!
//!   (a) Fail on legitimate audit-timestamp call sites
//!       (false positive — pollutes the gate so it gets
//!       disabled in practice).
//!   (b) Allow new TTL-class regressions in already-
//!       migrated files (false negative — defeats the
//!       point of the gate).
//!
//! ## Architectural pattern: per-file baseline counters
//!
//! For each TTL-CRITICAL file (one that previously had
//! TTL-class `SystemTime::now()` usage AND has been
//! migrated to ClockAuthority), record the EXACT count
//! of remaining `SystemTime::now()` occurrences as a
//! BASELINE. The invariant fails if the count INCREASES.
//!
//! Refactor that adds a NEW `SystemTime::now()` to a
//! migrated file:
//!   - If it's a new audit-timestamp use: bump the
//!     baseline + document why the new use is NOT
//!     TTL-class.
//!   - If it's a new TTL-class regression: migrate it
//!     to ClockAuthority (the test fails until you do).
//!
//! Refactor that REMOVES a `SystemTime::now()` from a
//! migrated file (e.g., a future batch removes a stale
//! test helper): the count goes DOWN; the test still
//! passes (count <= baseline). Operator may tighten the
//! baseline at their discretion.
//!
//! ## What this file does NOT pin
//!
//! - Files NOT in the migrated list (audit sinks,
//!   updater paths, signed-bytes timestamps) have NO
//!   constraint on their `SystemTime::now()` count. They
//!   are AUDIT-TIMESTAMP class by design. If a future
//!   batch identifies a NEW TTL-class consumer in those
//!   files, that batch must add the file to this list
//!   AT THE MIGRATED-COUNT BASELINE (not the
//!   pre-migration count).
//! - The wire-status pin (Batch #322
//!   d9_clock_authority_wired) covers the trait surface
//!   + AppState shape. This file complements that with
//!   the consumer-level migration enforcement.

/// Per-file baseline: file path (relative to
/// sens-api-gateway/) + maximum allowed
/// `SystemTime::now()` occurrence count.
///
/// **How to update this list:**
///
/// 1. After landing a new TTL-class migration, run:
///    `grep -c "SystemTime::now" <path>` on the
///    migrated file.
/// 2. Add a `(path, count)` entry to this list with
///    a comment naming the migration batch + the
///    architectural reason any remaining occurrences
///    are NOT TTL-class (test helpers, audit emit,
///    documentation strings, etc.).
const TTL_CRITICAL_FILES_BASELINE: &[(&str, usize, &str)] = &[
    // Batch #324 closed lifecycle_auth verify_request
    // clock-rollback DOS class. Remaining 5 occurrences:
    // 1× test now_ts() helper (test fixture, not
    // production); 4× MockClock body's
    // SystemTime::now() in trustworthy_wall_clock impl
    // (test mock, NOT the verify_request hot path).
    (
        "src/lifecycle_auth.rs",
        5,
        "Batch #324 baseline — test helpers + MockClock fixtures",
    ),
    // Batch #325 closed PolicyEngineOpcUaAdapter +
    // SensNodeManager StalePolicyVersion bypass class.
    // Remaining 2 occurrences in opc_ua_server.rs are
    // legacy doc comments referencing the pre-#325
    // SystemTime::now() pattern + test fixtures.
    (
        "src/opc_ua_server.rs",
        2,
        "Batch #325 baseline — doc references + test fixtures",
    ),
    // Batch #325 closed SensNodeManager::write
    // received_at clock-rollback class. Remaining 1
    // occurrence is a doc-comment reference.
    (
        "src/opc_ua_sens_node_manager.rs",
        1,
        "Batch #325 baseline — doc references",
    ),
    // Batch #314 closed force_registry TTL countdown
    // class. Remaining 2 occurrences are unix_ms_now
    // helper (still uses SystemTime — but ONLY for the
    // rate-limit timestamp comparison which is a
    // last_apply gating, NOT a TTL countdown; see file
    // docs) + a test fixture.
    (
        "src/scripting/force_registry.rs",
        2,
        "Batch #314 baseline — unix_ms_now rate-limit helper + test fixture",
    ),
    // watch_sessions.rs has 1 SystemTime::now usage
    // for session expiry sweep — currently NOT
    // migrated (the sweep is similar to force_registry
    // pre-#314 and would benefit from MonotonicDeadline
    // adoption). Tracked as a future migration target;
    // baseline pinned at 1 so a refactor that ADDS more
    // SystemTime::now usage here fails the gate.
    (
        "src/scripting/watch_sessions.rs",
        1,
        "Pre-migration baseline — future batch should migrate to MonotonicDeadline",
    ),
];

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: no_system_time_for_ttl invariant cannot read {} — \
             this test runs from sens-api-gateway/ working dir per cargo \
             test convention. err={}",
            path, e
        )
    })
}

/// Count occurrences of `SystemTime::now` (substring
/// match) in a source file. Substring is sufficient
/// because Rust syntax does not allow other identifiers
/// that contain the literal `SystemTime::now` — every
/// match is a real call OR a doc-comment reference.
fn count_system_time_now(src: &str) -> usize {
    src.matches("SystemTime::now").count()
}

/// **D-9 baseline-drift invariant:** every TTL-CRITICAL
/// file MUST have at most the recorded baseline count of
/// `SystemTime::now` occurrences. A refactor that
/// introduces a new TTL-class `SystemTime::now` usage in
/// a migrated file fails this test.
#[test]
fn d9_no_new_system_time_now_in_ttl_critical_files() {
    let mut violations: Vec<String> = Vec::new();
    for (path, baseline, reason) in TTL_CRITICAL_FILES_BASELINE {
        let src = read_source(path);
        let count = count_system_time_now(&src);
        if count > *baseline {
            violations.push(format!(
                "  {} — count {} > baseline {} (baseline reason: {}). \
                 Refactor introduced new TTL-class SystemTime::now usage. \
                 Either migrate the new call site to ClockAuthority \
                 (preferred — see Batch #313/#314/#324/#325 patterns) \
                 OR document the new use as audit-timestamp class + bump \
                 the baseline + add a comment naming the new file's \
                 architectural reason.",
                path, count, baseline, reason
            ));
        }
    }
    assert!(
        violations.is_empty(),
        "D-9 BASELINE-DRIFT INVARIANT VIOLATED in {} TTL-critical file(s):\n\
         \n\
         {}\n\
         \n\
         The Plan §5 Faz 2 D-9 architectural property is that \
         TTL-class consumers (those computing \"is now past expiry\" \
         or \"did request arrive within the freshness window\") use \
         ClockAuthority's trustworthy_wall_clock gate, NOT raw \
         SystemTime::now() reads. The baseline counts were captured \
         immediately after each migration batch landed; an increase \
         indicates a regression.",
        violations.len(),
        violations.join("\n\n")
    );
}

/// **D-9 baseline-drift invariant (downward direction):**
/// helpful diagnostic — if a refactor REDUCES the
/// `SystemTime::now()` count in a migrated file (e.g.,
/// removed a stale test helper), this test logs the
/// drop so operators can tighten the baseline. Does NOT
/// fail; just suggests an improvement.
#[test]
fn d9_baseline_drift_downward_suggests_tightening() {
    let mut suggestions: Vec<String> = Vec::new();
    for (path, baseline, _reason) in TTL_CRITICAL_FILES_BASELINE {
        let src = read_source(path);
        let count = count_system_time_now(&src);
        if count < *baseline {
            suggestions.push(format!(
                "  {} — count {} < baseline {}. Consider tightening \
                 the baseline to {} so the gate catches future \
                 regressions at the new floor.",
                path, count, baseline, count
            ));
        }
    }
    if !suggestions.is_empty() {
        // Print to stdout (not stderr — non-failing
        // diagnostic). Operators see this in `cargo test
        // --nocapture`.
        eprintln!(
            "D-9 baseline-drift downward — informational, NOT a failure:\n\n{}",
            suggestions.join("\n\n")
        );
    }
}

/// **D-9 wire-status invariant:** the TTL-class
/// migrations landed (Batch #313/#314/#324/#325) must
/// have introduced specific shape signatures in the
/// migrated files. This test verifies those signatures
/// are still present (a refactor that REMOVES the
/// migration plumbing must update this test).
#[test]
fn d9_consumer_migrations_have_clock_dependency_injection() {
    // lifecycle_auth.rs verify_request takes &dyn
    // ClockAuthority — Batch #324 signature.
    let lifecycle_auth = read_source("src/lifecycle_auth.rs");
    assert!(
        lifecycle_auth.contains("clock: &dyn crate::runtime_safety::ClockAuthority"),
        "D-9 MIGRATION VIOLATED: lifecycle_auth.rs verify_request \
         no longer carries the `clock: &dyn ClockAuthority` parameter \
         (Batch #324 migration). The clock-rollback DOS class would \
         silently reopen if this signature is reverted."
    );

    // opc_ua_server.rs PolicyEngineOpcUaAdapter has
    // clock field — Batch #325 signature.
    let opc_ua_server = read_source("src/opc_ua_server.rs");
    assert!(
        opc_ua_server.contains("clock: std::sync::Arc<dyn crate::runtime_safety::ClockAuthority>"),
        "D-9 MIGRATION VIOLATED: PolicyEngineOpcUaAdapter no longer \
         carries the `clock: Arc<dyn ClockAuthority>` field (Batch \
         #325 migration). The StalePolicyVersion bypass class would \
         silently reopen if this field is removed."
    );

    // opc_ua_sens_node_manager.rs SensNodeManager has
    // clock field — Batch #325 signature.
    let opc_ua_nm = read_source("src/opc_ua_sens_node_manager.rs");
    assert!(
        opc_ua_nm.contains("clock: Arc<dyn crate::runtime_safety::ClockAuthority>"),
        "D-9 MIGRATION VIOLATED: SensNodeManager no longer carries \
         the `clock: Arc<dyn ClockAuthority>` field (Batch #325 \
         migration). The write-path StalePolicyVersion bypass class \
         would silently reopen if this field is removed."
    );

    // force_registry.rs apply takes &dyn ClockAuthority
    // — Batch #314 signature.
    let force_registry = read_source("src/scripting/force_registry.rs");
    assert!(
        force_registry.contains("clock: &dyn ClockAuthority"),
        "D-9 MIGRATION VIOLATED: force_registry.rs apply no longer \
         carries the `clock: &dyn ClockAuthority` parameter (Batch \
         #314 migration). The TTL-countdown clock-rollback class \
         would silently reopen if this signature is reverted."
    );
}
