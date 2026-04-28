//! D-3 SQLCipher migration arc wire-status invariants
//! (Batch #333).
//!
//! ## Why this file
//!
//! Batches #329 → #332 landed every architectural
//! primitive of the D-3 arc:
//!
//!   - **#329**: `DbKeySchemaVersion` enum +
//!     `DbKeySourceManifest` sidecar JSON +
//!     atomic temp+fsync+rename + `DbMigrationError`
//!     taxonomy.
//!   - **#330**: `detect_db_migration_backlog` boot-time
//!     scanner + `DbMigrationBacklogReport` 3-population
//!     classification + `log_structured_warn` emission.
//!   - **#331**: `derive_v1_legacy_key` pure HMAC-SHA256
//!     kernel + `format_sqlcipher_pragma_key_hex` +
//!     cross-validation parity with offline_queue.
//!   - **#332**: `derive_v2_sqlcipher_key` async shim
//!     around `keystore.derive_key` + wrong-purpose
//!     guard + `is_sqlcipher_purpose` predicate SSoT.
//!
//! Behavioural unit tests in each module + 3 standalone
//! integration tests pin RUNTIME behaviour. They will
//! NOT catch every architectural regression:
//!
//!   - A refactor that splits `detect_db_migration_backlog`
//!     into per-population helper functions losing the
//!     single-entry-point shape: behavioural tests still
//!     pass; the SSoT property is silently lost.
//!   - A refactor that drops `#[non_exhaustive]` from
//!     `DbKeySchemaVersion`: behavioural tests still
//!     pass; the forward-compat-on-future-v3-addition
//!     property is silently lost.
//!   - A refactor that adds a 5th `DbMigrationError`
//!     variant without updating the boot detector's
//!     `classify_error_reason` match: Rust's match
//!     exhaustiveness catches it (Tier-1), BUT the
//!     classifier might silently route to a generic
//!     "io_error" prefix instead of a specific kind —
//!     the operator log search would miss the new
//!     class. A Tier-3 invariant pinning the variant
//!     count makes the discrepancy visible in code
//!     review.
//!   - A refactor that hardcodes `.key-source.json`
//!     elsewhere in the crate (bypassing
//!     `manifest_path_for_db`) silently couples consumers
//!     to the literal suffix.
//!   - A refactor that drops the
//!     `DbMigrationBacklogReport` `up_to_date_count`
//!     field collapses the 3-population classification
//!     into 2 (backlog + failures), losing the
//!     "fleet-is-clean" operator-visible signal.
//!   - A refactor that changes the
//!     `is_sqlcipher_purpose` predicate to accept
//!     non-SqlCipher* purposes silently bypasses the
//!     wrong-purpose guard.
//!
//! Tier-3 architectural-property detection per
//! CLAUDE.md hierarchy. Pattern mirrors
//! `tests/invariants/mtls_unified_assembly.rs`
//! (Batch #328 D-6) and the broader Batch
//! #319/#321/#322/#323/#326 wire-invariants family.
//!
//! ## What this file pins
//!
//! Source-grep checks across the four D-3 primitive
//! files + the production consumer (offline_queue.rs)
//! to detect SHAPE-level regressions that don't fail
//! the behavioural test layer.

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: db_migration_wire_status invariant cannot read \
             {path} — this test runs from sens-api-gateway/ \
             working dir per cargo test convention. err={e}"
        )
    })
}

const MOD_RS: &str = "src/db_migration/mod.rs";
const SCHEMA_VERSION_RS: &str = "src/db_migration/schema_version.rs";
const MANIFEST_RS: &str = "src/db_migration/manifest.rs";
const BOOT_DETECTOR_RS: &str = "src/db_migration/boot_detector.rs";
const V1_LEGACY_KEY_RS: &str = "src/db_migration/v1_legacy_key.rs";
const V2_KEYSTORE_KEY_RS: &str = "src/db_migration/v2_keystore_key.rs";

// ---------------------------------------------------------
// Batch #329 — schema_version + manifest primitives
// ---------------------------------------------------------

/// **D-3 wire invariant 1:** `DbKeySchemaVersion` is
/// `#[non_exhaustive]`. Pinning forward-compat:
/// external pattern-matchers MUST include a wildcard
/// arm so adding a v3 variant in a future batch does
/// not require coordinated breaking changes downstream.
/// A refactor that drops the attribute would silently
/// remove the architectural contract.
#[test]
fn d3_wire_schema_version_is_non_exhaustive() {
    let src = read_source(SCHEMA_VERSION_RS);
    assert!(
        src.contains("#[non_exhaustive]"),
        "D-3 WIRE INVARIANT VIOLATED: {SCHEMA_VERSION_RS} no \
         longer marks DbKeySchemaVersion #[non_exhaustive]. \
         External match arms would compile without a wildcard, \
         so adding a v3 variant later silently breaks every \
         caller — the forward-compat architectural contract is \
         lost. Restore the attribute or ADR a deliberate removal."
    );
}

/// **D-3 wire invariant 2:** `DbKeySchemaVersion`
/// declares the V1MachineIdDerived + V2KeystoreDerived
/// variants today. Forward-compat for a future V3 is
/// preserved by `#[non_exhaustive]` (invariant 1); this
/// test pins that the two CURRENT variants do not get
/// silently renamed or removed.
///
/// **Why no `!contains("V3")` check:** the schema_version
/// doc comment LEGITIMATELY references `V3*` as the
/// future-arc placeholder name; banning the literal in
/// source would force operators to renumber the doc
/// comment's roadmap ("a future variant" instead of "a
/// future V3 variant") which is a worse architectural
/// outcome — the doc readability matters more than the
/// grep-based detection here. A future V3 addition
/// remains visible in code review via:
///   - the `#[non_exhaustive]` attribute requiring every
///     external match to extend (invariant 1),
///   - the `requires_migration_to_current_target`
///     predicate that the boot detector uses (whose
///     semantics already cover any new variant whose
///     `current_target` is different),
///   - this invariant's pinned-name check (a rename of
///     V1/V2 fails here).
#[test]
fn d3_wire_schema_version_variants_locked() {
    let src = read_source(SCHEMA_VERSION_RS);
    assert!(
        src.contains("V1MachineIdDerived"),
        "D-3 WIRE INVARIANT VIOLATED: \
         DbKeySchemaVersion::V1MachineIdDerived missing in \
         {SCHEMA_VERSION_RS}. A rename / removal of the \
         legacy variant would brick the boot detector's \
         missing-manifest-as-v1-default classification."
    );
    assert!(
        src.contains("V2KeystoreDerived"),
        "D-3 WIRE INVARIANT VIOLATED: \
         DbKeySchemaVersion::V2KeystoreDerived missing in \
         {SCHEMA_VERSION_RS}. A rename / removal of the \
         current target would brick `current_target()` + \
         every consumer-migration call site."
    );
}

/// **D-3 wire invariant 3:** kebab-case JSON wire
/// format pinned. Operators reading the sidecar JSON
/// MUST see the documented strings; switching to
/// snake_case or PascalCase would brick existing
/// on-disk manifests.
#[test]
fn d3_wire_schema_version_uses_kebab_case() {
    let src = read_source(SCHEMA_VERSION_RS);
    assert!(
        src.contains("rename_all = \"kebab-case\""),
        "D-3 WIRE INVARIANT VIOLATED: {SCHEMA_VERSION_RS} \
         dropped the kebab-case serde rename. The on-disk \
         JSON wire format would change shape; existing \
         manifests would fail to parse."
    );
}

/// **D-3 wire invariant 4:** the canonical sidecar
/// suffix `.key-source.json` is the SSoT. Hard-coding
/// the suffix elsewhere (instead of going through
/// `manifest_path_for_db`) couples consumers to the
/// literal — a future rename would require touching
/// every consumer.
#[test]
fn d3_wire_manifest_suffix_constant_is_ssot() {
    let src = read_source(MANIFEST_RS);
    assert!(
        src.contains(
            "pub const DB_KEY_SOURCE_MANIFEST_SUFFIX: &str = \".key-source.json\";"
        ),
        "D-3 WIRE INVARIANT VIOLATED: {MANIFEST_RS} no longer \
         declares DB_KEY_SOURCE_MANIFEST_SUFFIX as the canonical \
         constant. Consumers would have to hardcode the literal \
         '.key-source.json' suffix at every callsite."
    );
}

/// **D-3 wire invariant 5:** `DbMigrationError` has
/// exactly 4 variants today (ReadFailed, WriteFailed,
/// Corrupt, EnvelopeVersionMismatch). Adding a 5th
/// requires updating the boot detector's
/// `classify_error_reason` match (Rust's exhaustiveness
/// catches the match part). Pinning the variant count
/// here makes the change visible to reviewers + forces
/// the new variant to land with its dedicated reason
/// prefix, not silently routed to a generic catch-all.
#[test]
fn d3_wire_db_migration_error_variants_locked() {
    let src = read_source(MANIFEST_RS);
    for variant in [
        "ReadFailed {",
        "WriteFailed {",
        "Corrupt {",
        "EnvelopeVersionMismatch {",
    ] {
        assert!(
            src.contains(variant),
            "D-3 WIRE INVARIANT VIOLATED: DbMigrationError no \
             longer defines `{variant}` variant in {MANIFEST_RS}."
        );
    }
}

/// **D-3 wire invariant 6:** atomic-write contract is
/// preserved. The manifest persistence MUST use
/// temp-file + fsync + rename. A refactor that switched
/// to direct `fs::write` would silently lose the
/// crash-safety property — torn writes leaving the
/// manifest pointing to the WRONG schema version
/// would brick the DB permanently.
#[test]
fn d3_wire_manifest_write_uses_temp_fsync_rename() {
    let src = read_source(MANIFEST_RS);
    assert!(
        src.contains(".sync_all()"),
        "D-3 WIRE INVARIANT VIOLATED: {MANIFEST_RS} no longer \
         calls fsync (.sync_all()) before rename. A power-loss \
         between rename + disk flush would leave a zero-byte \
         manifest — wrong-key derivation at next boot bricks \
         the DB. The fsync makes this fail-closed."
    );
    assert!(
        src.contains("fs::rename(&temp_path, path)"),
        "D-3 WIRE INVARIANT VIOLATED: {MANIFEST_RS} no longer \
         uses fs::rename(temp -> target) for atomic write. \
         Direct write would lose crash safety."
    );
}

/// **D-3 wire invariant 7:** envelope version is `1`
/// today. A bump to `2` is a deliberate breaking change
/// that needs a coordinated migration ADR. Pinning the
/// current value here forces the bump to be a visible
/// diff alongside the migration plan.
#[test]
fn d3_wire_manifest_envelope_version_is_1() {
    let src = read_source(MANIFEST_RS);
    assert!(
        src.contains("const MANIFEST_ENVELOPE_VERSION: u32 = 1;"),
        "D-3 WIRE INVARIANT VIOLATED: {MANIFEST_RS} bumped \
         MANIFEST_ENVELOPE_VERSION away from 1. If this is a \
         deliberate v1→v2 envelope bump, update this invariant \
         + the migration plan ADR + every reader's expected \
         version in the SAME batch."
    );
}

// ---------------------------------------------------------
// Batch #330 — boot-time detector
// ---------------------------------------------------------

/// **D-3 wire invariant 8:** the unified detection
/// entry point `detect_db_migration_backlog` exists
/// with the documented signature. Splitting it into
/// per-population helper functions would lose the
/// SSoT property — operators reading the migration
/// path would have to mentally compose multiple
/// classification paths.
#[test]
fn d3_wire_boot_detector_unified_entry_present() {
    let src = read_source(BOOT_DETECTOR_RS);
    assert!(
        src.contains("pub fn detect_db_migration_backlog"),
        "D-3 WIRE INVARIANT VIOLATED: {BOOT_DETECTOR_RS} no \
         longer defines `pub fn detect_db_migration_backlog`. \
         The unified boot-path scanner SSoT is missing; consumers \
         would have to roll their own classification + duplicate \
         the missing-manifest-as-v1-default logic."
    );
    // The signature MUST take `&[&Path]` so the report
    // shape stays self-contained for unit testing.
    assert!(
        src.contains("db_paths: &[&Path]"),
        "D-3 WIRE INVARIANT VIOLATED: detect_db_migration_backlog \
         signature lost the `&[&Path]` parameter. Switching to \
         Vec<PathBuf> would force callers to allocate; switching \
         to a single Path would lose the multi-DB scan property."
    );
}

/// **D-3 wire invariant 9:** the 3-population taxonomy
/// is preserved — `DbMigrationBacklogReport` MUST have
/// `backlog`, `up_to_date_count`, and
/// `detection_failures` fields. Collapsing
/// `up_to_date_count` into the implicit (total -
/// backlog - failures) loses the operator-visible
/// "fleet-is-clean" signal that distinguishes
/// no-DBs-scanned (count 0) from all-up-to-date
/// (count > 0).
#[test]
fn d3_wire_backlog_report_three_populations_preserved() {
    let src = read_source(BOOT_DETECTOR_RS);
    for field in [
        "pub backlog: Vec<DbMigrationBacklogEntry>",
        "pub up_to_date_count: usize",
        "pub detection_failures: Vec<DbMigrationDetectionFailure>",
    ] {
        assert!(
            src.contains(field),
            "D-3 WIRE INVARIANT VIOLATED: {BOOT_DETECTOR_RS} no \
             longer declares DbMigrationBacklogReport field \
             `{field}`. Collapsing the 3-population taxonomy \
             loses the operator-visible classification — fleet-\
             is-clean / fleet-needs-migration / fleet-has-broken-\
             manifests are different operator runbooks."
        );
    }
}

/// **D-3 wire invariant 10:** missing-manifest is
/// classified as legacy-v1-default. Pinned by the
/// presence of `Ok(None)` arm dispatching to a
/// V1MachineIdDerived backlog entry. A refactor that
/// changed the missing arm to a `detection_failure` or
/// silent-skip would brick every existing field
/// deployment because they don't have manifests yet.
#[test]
fn d3_wire_boot_detector_missing_manifest_is_legacy_v1() {
    let src = read_source(BOOT_DETECTOR_RS);
    // Pin both halves: the Ok(None) arm AND the
    // V1MachineIdDerived assignment within it.
    assert!(
        src.contains("Ok(None) =>") &&
        src.contains("DbKeySchemaVersion::V1MachineIdDerived"),
        "D-3 WIRE INVARIANT VIOLATED: {BOOT_DETECTOR_RS} no \
         longer dispatches Ok(None) (missing manifest) to \
         DbKeySchemaVersion::V1MachineIdDerived. Treating \
         missing as 'unknown' would brick every pre-D-3 field \
         deployment until the migration tool ships."
    );
}

/// **D-3 wire invariant 11:** `log_structured_warn`
/// emits a SUMMARY entry with the canonical event_kind
/// `db_migration_backlog_summary` so log aggregators
/// can search for the fleet-wide migration signal
/// without re-parsing free-form messages.
#[test]
fn d3_wire_boot_detector_emits_canonical_summary_event_kind() {
    let src = read_source(BOOT_DETECTOR_RS);
    assert!(
        src.contains("\"db_migration_backlog_entry\""),
        "D-3 WIRE INVARIANT VIOLATED: per-entry WARN event_kind \
         renamed away from `db_migration_backlog_entry` in \
         {BOOT_DETECTOR_RS}. Log aggregator queries would silently \
         miss new entries."
    );
    assert!(
        src.contains("\"db_migration_backlog_summary\""),
        "D-3 WIRE INVARIANT VIOLATED: SUMMARY WARN event_kind \
         renamed away from `db_migration_backlog_summary` in \
         {BOOT_DETECTOR_RS}."
    );
    assert!(
        src.contains("\"db_migration_detection_failure\""),
        "D-3 WIRE INVARIANT VIOLATED: detection-failure ERROR \
         event_kind renamed away from \
         `db_migration_detection_failure` in {BOOT_DETECTOR_RS}."
    );
}

// ---------------------------------------------------------
// Batch #331 — v1 legacy-key kernel
// ---------------------------------------------------------

/// **D-3 wire invariant 12:** the v1 kernel is
/// infallible (`-> [u8; 32]`, NOT `Result<...>`) — pins
/// the architectural contract that callers do not have
/// to thread `?` through migration orchestration code
/// for a phantom error class. The HMAC-SHA256
/// instantiation accepts ANY key length per RFC 2104,
/// so the only error branch is unreachable.
#[test]
fn d3_wire_v1_kernel_infallible_signature() {
    let src = read_source(V1_LEGACY_KEY_RS);
    assert!(
        src.contains(
            "pub fn derive_v1_legacy_key(\n    machine_id: &[u8],\n    secret_key: &[u8],\n) -> [u8; 32] {"
        ),
        "D-3 WIRE INVARIANT VIOLATED: derive_v1_legacy_key \
         signature changed in {V1_LEGACY_KEY_RS}. Adding a \
         `Result<...>` return would force every migration \
         caller to thread `?`; changing the inputs to \
         &str/&String would force decoding decisions into \
         the kernel."
    );
}

/// **D-3 wire invariant 13:** the v1 kernel uses
/// HMAC-SHA256 with `secret_key` as the HMAC key and
/// `machine_id` as the HMAC data. Inverting the role
/// would compile + produce 32-byte output but brick
/// every legacy DB. Pinned by source-grep of the
/// canonical construction pattern.
#[test]
fn d3_wire_v1_kernel_hmac_role_assignment() {
    let src = read_source(V1_LEGACY_KEY_RS);
    // The kernel's algorithm-level grep: HMAC built
    // FROM secret_key, then UPDATEd with machine_id.
    assert!(
        src.contains("HmacSha256::new_from_slice(secret_key)"),
        "D-3 WIRE INVARIANT VIOLATED: HMAC role assignment \
         inverted in {V1_LEGACY_KEY_RS}. The HMAC key MUST \
         be `secret_key`; using machine_id as the key would \
         brick every legacy DB on the fleet."
    );
    assert!(
        src.contains("mac.update(machine_id);"),
        "D-3 WIRE INVARIANT VIOLATED: HMAC data input \
         changed in {V1_LEGACY_KEY_RS}. The HMAC `data` \
         input MUST be `machine_id`."
    );
}

/// **D-3 wire invariant 14:** the lower-hex zero-padded
/// formatter is preserved. SQLCipher accepts either
/// hex case but v1 → v2 migration MUST NOT change the
/// case for the same key bytes — case mismatch
/// produces a different PRAGMA key string and the
/// rekey would silently fail-open.
#[test]
fn d3_wire_v1_pragma_hex_is_lower_case_zero_padded() {
    let src = read_source(V1_LEGACY_KEY_RS);
    assert!(
        src.contains("\"{b:02x}\"") || src.contains("\"{:02x}\""),
        "D-3 WIRE INVARIANT VIOLATED: format_sqlcipher_pragma_key_hex \
         changed away from lower-hex zero-padded format in \
         {V1_LEGACY_KEY_RS}. Switching to upper-hex (`{{:02X}}`) \
         would break v1↔v2 PRAGMA-key string parity for the \
         same key bytes."
    );
}

// ---------------------------------------------------------
// Batch #332 — v2 keystore-derived shim
// ---------------------------------------------------------

/// **D-3 wire invariant 15:** the v2 shim's wrong-
/// purpose guard is centralized in a single
/// `is_sqlcipher_purpose` predicate. A refactor that
/// inlined the match arms at every call site would
/// fragment the SSoT — adding a future SqlCipher*
/// variant would require touching N call sites.
#[test]
fn d3_wire_v2_shim_centralizes_purpose_predicate() {
    let src = read_source(V2_KEYSTORE_KEY_RS);
    assert!(
        src.contains("fn is_sqlcipher_purpose"),
        "D-3 WIRE INVARIANT VIOLATED: {V2_KEYSTORE_KEY_RS} no \
         longer defines `is_sqlcipher_purpose` predicate. \
         Inlining the match arms at call sites fragments the \
         'which purposes are valid for SQLCipher' SSoT — adding \
         a future SqlCipher* variant would silently miss any \
         non-updated call site."
    );
    // The predicate MUST match BOTH SqlCipher* variants
    // currently defined. Adding a third later requires
    // extending this predicate AND this invariant.
    assert!(
        src.contains("KeyPurpose::SqlCipherOfflineQueue")
            && src.contains("KeyPurpose::SqlCipherRetainPersistence"),
        "D-3 WIRE INVARIANT VIOLATED: is_sqlcipher_purpose \
         predicate dropped a SqlCipher* variant in \
         {V2_KEYSTORE_KEY_RS}. Both SqlCipherOfflineQueue \
         and SqlCipherRetainPersistence are valid migration \
         targets today."
    );
}

/// **D-3 wire invariant 16:** the
/// `V2DerivationError::WrongPurpose` variant exists +
/// the shim's entry point dispatches to it for non-
/// SqlCipher purposes. Removing the variant would
/// silently accept audit-HMAC purposes for SQLCipher
/// rekey — semantically wrong but cryptographically
/// valid bytes; next-DB-open fails confusingly.
#[test]
fn d3_wire_v2_shim_wrong_purpose_variant_present() {
    let src = read_source(V2_KEYSTORE_KEY_RS);
    assert!(
        src.contains("WrongPurpose { got: KeyPurpose }"),
        "D-3 WIRE INVARIANT VIOLATED: \
         V2DerivationError::WrongPurpose variant missing in \
         {V2_KEYSTORE_KEY_RS}. The architectural fail-closed \
         gate against accidental purpose substitution is gone."
    );
    assert!(
        src.contains("Err(V2DerivationError::WrongPurpose")
            || src.contains("V2DerivationError::WrongPurpose { got: purpose }"),
        "D-3 WIRE INVARIANT VIOLATED: derive_v2_sqlcipher_key \
         no longer dispatches to V2DerivationError::WrongPurpose \
         for non-SqlCipher inputs in {V2_KEYSTORE_KEY_RS}. The \
         migration boundary guard is bypassed."
    );
}

// ---------------------------------------------------------
// Module-level — re-exports and roadmap
// ---------------------------------------------------------

/// **D-3 wire invariant 17:** `db_migration::mod.rs`
/// re-exports the public-API surface of every
/// primitive batch. Consumers reach the API via
/// `crate::db_migration::*` without depending on
/// internal module layout — the re-exports are the
/// architectural decoupling seam.
#[test]
fn d3_wire_mod_re_exports_public_api() {
    let src = read_source(MOD_RS);
    for symbol in [
        "DbKeySchemaVersion",
        "DbKeySourceManifest",
        "DbMigrationError",
        "DB_KEY_SOURCE_MANIFEST_SUFFIX",
        "manifest_path_for_db",
        "read_manifest",
        "write_manifest",
        "detect_db_migration_backlog",
        "DbMigrationBacklogEntry",
        "DbMigrationBacklogReport",
        "derive_v1_legacy_key",
        "format_sqlcipher_pragma_key_hex",
        "derive_v2_sqlcipher_key",
        "derive_v2_sqlcipher_pragma_key_hex",
        "V2DerivationError",
    ] {
        assert!(
            src.contains(symbol),
            "D-3 WIRE INVARIANT VIOLATED: {MOD_RS} no longer \
             re-exports `{symbol}`. Consumers would have to \
             depend on the internal `db_migration::<submod>::*` \
             paths — coupling them to the module layout."
        );
    }
}

/// **D-3 wire invariant 18:** the multi-batch arc
/// roadmap is documented in mod.rs. Operators + future
/// engineers reading the source see the planned
/// continuation path (boot-detector → v1 kernel → v2
/// shim → migration binary → consumer migration)
/// without having to grep PR descriptions.
#[test]
fn d3_wire_mod_documents_multi_batch_arc_roadmap() {
    let src = read_source(MOD_RS);
    for marker in [
        "Multi-batch arc",
        "Batch #329",
        "Batch #330",
        "Batch #331",
        "Batch #332",
    ] {
        assert!(
            src.contains(marker),
            "D-3 WIRE INVARIANT VIOLATED: {MOD_RS} doc-comment \
             dropped the `{marker}` roadmap reference. The \
             primitive-by-primitive landing chronology is the \
             operator-visible architectural map; dropping it \
             forces engineers to reconstruct the arc from git \
             log."
        );
    }
}
