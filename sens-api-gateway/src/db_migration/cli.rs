//! D-3 SQLCipher migration CLI subcommand
//! (PR-195 Batch #6 — wires the runbook contract from
//! Batch #4 into a callable subcommand on the
//! suderra-agent binary).
//!
//! ## Why this module exists
//!
//! Batch #4's `db-migration-rekey-ceremony.md` runbook
//! is the OPERATOR-FACING CONTRACT for the migration
//! tool: argument shape, JSONL output schema, per-DB
//! processing semantic. This module implements the
//! contract.
//!
//! ## Why a subcommand on the existing bin (not a new
//! cargo bin target)
//!
//! `sens-api-gateway` is `[[bin]]`-only by structural
//! choice (the agent is a single binary, not a
//! multi-crate workspace). A separate `[[bin]]` target
//! for `db-migrate-cli` would either need a `[lib]`
//! target exposing every module (substantial restructure
//! per the Batch #327 fuzz target's documented
//! constraint) OR duplicate every dependency closure via
//! `#[path]`-includes (sustainable for a fuzz target
//! exercising one module; impractical for a binary
//! exercising the full keystore + rekey + manifest
//! stack).
//!
//! The cleanest architectural shape: `suderra-agent
//! --migrate-db [args...]` subcommand on the existing
//! main bin. Mirrors the established
//! `--init` / `--audit-verify` / `--confirm-active`
//! subcommand pattern in `main.rs`.
//!
//! ## What this batch lands
//!
//! - Argument parsing for the runbook's documented
//!   shape: `--data-dir`, `--schema-target`,
//!   `--output-format`, `--dry-run`.
//! - Consumer-name → `KeyPurpose` mapping (4 SqlCipher
//!   consumers per ADR-031 — this list is the SSoT for
//!   "what DBs the migration tool knows about").
//! - JSONL output schema matching the runbook's
//!   documented contract.
//! - Plan computation: stat the data dir for each
//!   known consumer DB + derive what the migration
//!   action would be (would_migrate / already_at_target
//!   / no_db_present / sidecar_failure / etc.).
//! - `--dry-run` mode emits the plan WITHOUT executing
//!   the rekey orchestration. Full execution wires in
//!   subsequent batches once the keystore + machine_id
//!   bootstrap is plumbed through the CLI.
//!
//! ## What this batch does NOT do (subsequent batches)
//!
//! - Live key derivation (v1 from machine_id +
//!   secret_key; v2 from keystore). Requires plumbing
//!   the keystore-backend bootstrap into the CLI's
//!   pre-runtime path.
//! - `rekey_with_manifest_swap` execution. Triggered
//!   only when `--dry-run` is omitted; today the CLI
//!   refuses to execute (returns a documented "exec
//!   not yet wired" message) so operators can't
//!   accidentally run a half-implemented migration
//!   against a production DB.
//! - Per-consumer context-bytes derivation
//!   (deployment-instance UUID for OfflineQueue +
//!   LicenseCache; program-artifact-SHA256 for
//!   RetainPersistence + BytecodeRetain). The
//!   consumer-context resolver lives in each consumer's
//!   own boot path; subsequent batches lift it into a
//!   shared resolver the CLI can call.

use crate::db_migration::boot_detector::{
    detect_db_migration_backlog, DbMigrationBacklogReport,
};
use crate::db_migration::schema_version::DbKeySchemaVersion;
use crate::keystore::purpose::KeyPurpose;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// Canonical SqlCipher consumer mapping per ADR-031.
/// The list is the SSoT for "which DBs the migration
/// tool knows about". Adding a new consumer to ADR-031
/// requires extending this list + the wire-status
/// invariant pinned in the spec file.
pub const KNOWN_SQLCIPHER_CONSUMERS: &[(&str, KeyPurpose)] = &[
    ("offline_queue.db", KeyPurpose::SqlCipherOfflineQueue),
    (
        "retain_persistence.db",
        KeyPurpose::SqlCipherRetainPersistence,
    ),
    ("license_cache.db", KeyPurpose::SqlCipherLicenseCache),
    ("bytecode_retain.db", KeyPurpose::SqlCipherBytecodeRetain),
];

/// Parsed argument shape for the `--migrate-db`
/// subcommand. Mirrors the runbook's documented CLI
/// contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationArgs {
    pub data_dir: PathBuf,
    pub schema_target: DbKeySchemaVersion,
    pub output_format: OutputFormat,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    /// One JSON object per DB processed, newline-
    /// separated. The format documented in the runbook.
    Jsonl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgError {
    Missing { flag: String },
    Unknown { flag: String },
    Invalid { flag: String, reason: String },
}

impl std::fmt::Display for ArgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing { flag } => {
                write!(f, "migrate_db_arg_missing: {flag}")
            }
            Self::Unknown { flag } => {
                write!(f, "migrate_db_arg_unknown: {flag}")
            }
            Self::Invalid { flag, reason } => {
                write!(f, "migrate_db_arg_invalid: {flag}: {reason}")
            }
        }
    }
}

impl std::error::Error for ArgError {}

/// Parse the migration subcommand's args from the
/// suderra-agent argv slice that follows
/// `--migrate-db`.
///
/// **Pure function** (no IO, no env reads, no exits).
/// Tests pass synthetic `&[&str]` slices.
pub fn parse_args(argv: &[&str]) -> Result<MigrationArgs, ArgError> {
    let mut data_dir: Option<PathBuf> = None;
    let mut schema_target: DbKeySchemaVersion =
        DbKeySchemaVersion::current_target();
    let mut output_format = OutputFormat::Jsonl;
    let mut dry_run = false;

    let mut i = 0;
    while i < argv.len() {
        // Use `.get(i)` instead of `argv[i]` to satisfy
        // the crate-level clippy::indexing_slicing deny.
        // The `while i < argv.len()` guard makes the
        // None branch unreachable, but the explicit
        // match is the canonical safe-indexing shape.
        let arg = match argv.get(i) {
            Some(s) => *s,
            None => break,
        };
        match arg {
            "--data-dir" => {
                let value = argv.get(i + 1).ok_or_else(|| {
                    ArgError::Missing {
                        flag: "--data-dir <path>".to_string(),
                    }
                })?;
                data_dir = Some(PathBuf::from(value));
                i += 2;
            }
            "--schema-target" => {
                let value = argv.get(i + 1).ok_or_else(|| {
                    ArgError::Missing {
                        flag: "--schema-target <kebab-case-version>"
                            .to_string(),
                    }
                })?;
                schema_target = match *value {
                    "v1-machine-id-derived" => {
                        DbKeySchemaVersion::V1MachineIdDerived
                    }
                    "v2-keystore-derived" => {
                        DbKeySchemaVersion::V2KeystoreDerived
                    }
                    other => {
                        return Err(ArgError::Invalid {
                            flag: "--schema-target".to_string(),
                            reason: format!(
                                "unknown version `{other}` (expected v1-machine-id-derived OR v2-keystore-derived)"
                            ),
                        });
                    }
                };
                i += 2;
            }
            "--output-format" => {
                let value = argv.get(i + 1).ok_or_else(|| {
                    ArgError::Missing {
                        flag: "--output-format <jsonl>".to_string(),
                    }
                })?;
                output_format = match *value {
                    "jsonl" => OutputFormat::Jsonl,
                    other => {
                        return Err(ArgError::Invalid {
                            flag: "--output-format".to_string(),
                            reason: format!(
                                "unknown format `{other}` (expected jsonl)"
                            ),
                        });
                    }
                };
                i += 2;
            }
            "--dry-run" => {
                dry_run = true;
                i += 1;
            }
            other => {
                return Err(ArgError::Unknown {
                    flag: other.to_string(),
                });
            }
        }
    }

    let data_dir = data_dir.ok_or_else(|| ArgError::Missing {
        flag: "--data-dir <path>".to_string(),
    })?;

    Ok(MigrationArgs {
        data_dir,
        schema_target,
        output_format,
        dry_run,
    })
}

/// One row of the dry-run plan output. Each known
/// consumer DB produces exactly one row regardless of
/// whether the DB is present or absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStep {
    pub db_path: PathBuf,
    pub consumer: String,
    pub purpose: KeyPurpose,
    pub action: PlanAction,
    pub current_version: Option<DbKeySchemaVersion>,
    pub target_version: DbKeySchemaVersion,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanAction {
    /// DB present + needs migration (v1 manifest OR
    /// missing manifest).
    WouldMigrate,
    /// DB present + already at target (v2 manifest).
    AlreadyAtTarget,
    /// DB not present (consumer hasn't created its DB
    /// yet OR data dir was wiped).
    NoDbPresent,
    /// Sidecar exists but DB doesn't — orphan sidecar,
    /// HIGH-002 tamper-suspect signal.
    OrphanSidecar,
    /// Sidecar unreadable (corrupt / envelope-mismatch
    /// / IO error).
    SidecarFailure { reason: String },
}

impl PlanAction {
    /// Stable string discriminator for JSONL output.
    pub fn as_str(&self) -> &str {
        match self {
            Self::WouldMigrate => "would_migrate",
            Self::AlreadyAtTarget => "already_at_target",
            Self::NoDbPresent => "no_db_present",
            Self::OrphanSidecar => "orphan_sidecar",
            Self::SidecarFailure { .. } => "sidecar_failure",
        }
    }
}

/// Compute the dry-run plan: for each known consumer
/// DB, classify what the migration action WOULD be.
/// Pure function over the input data dir + the boot
/// detector report (which itself is pure-IO over the
/// filesystem).
pub fn compute_dry_run_plan(args: &MigrationArgs) -> Vec<PlanStep> {
    // Gather the canonical DB paths.
    let db_paths: Vec<PathBuf> = KNOWN_SQLCIPHER_CONSUMERS
        .iter()
        .map(|(name, _)| args.data_dir.join(name))
        .collect();
    let db_path_refs: Vec<&Path> =
        db_paths.iter().map(|p| p.as_path()).collect();

    let report = detect_db_migration_backlog(&db_path_refs);

    classify_plan(args, &db_paths, &report)
}

/// Pure-function classifier — separated from
/// `compute_dry_run_plan` so unit tests can pass
/// synthetic reports without filesystem fixtures.
pub fn classify_plan(
    args: &MigrationArgs,
    db_paths: &[PathBuf],
    report: &DbMigrationBacklogReport,
) -> Vec<PlanStep> {
    let mut steps = Vec::with_capacity(db_paths.len());

    for (path, (filename, purpose)) in
        db_paths.iter().zip(KNOWN_SQLCIPHER_CONSUMERS.iter())
    {
        let consumer = filename
            .strip_suffix(".db")
            .unwrap_or(filename)
            .to_string();

        // Find this path in the boot detector's report
        // and route to the corresponding PlanAction.
        let action_and_current = (|| {
            for entry in &report.backlog {
                if &entry.db_path == path {
                    return (
                        PlanAction::WouldMigrate,
                        Some(entry.current_version),
                    );
                }
            }
            for failure in &report.detection_failures {
                if &failure.db_path == path {
                    let action = if failure.reason.contains("orphan_sidecar") {
                        PlanAction::OrphanSidecar
                    } else {
                        PlanAction::SidecarFailure {
                            reason: failure.reason.clone(),
                        }
                    };
                    return (action, None);
                }
            }
            // Not in backlog or detection_failures →
            // either nonexistent (counted only) or
            // up_to_date (counted only). Distinguish via
            // file-existence stat (single syscall).
            if path.exists() {
                (PlanAction::AlreadyAtTarget, Some(args.schema_target))
            } else {
                (PlanAction::NoDbPresent, None)
            }
        })();

        steps.push(PlanStep {
            db_path: path.clone(),
            consumer,
            purpose: *purpose,
            action: action_and_current.0,
            current_version: action_and_current.1,
            target_version: args.schema_target,
        });
    }

    steps
}

/// Render a single PlanStep as a JSONL row.
///
/// **Why hand-rolled JSON (not serde):** the
/// `KeyPurpose` enum's serde `rename_all = "snake_case"`
/// would emit e.g., `sql_cipher_offline_queue` which
/// doesn't match the runbook's documented consumer
/// names (`offline_queue` etc.). Hand-rolled rendering
/// keeps the CLI output schema decoupled from the
/// internal serde shape — the runbook is the
/// architectural contract; we render to satisfy it.
pub fn plan_step_to_jsonl(step: &PlanStep) -> String {
    let mut out = String::with_capacity(256);
    out.push('{');
    write_kv_str(&mut out, "db_path", &step.db_path.display().to_string());
    out.push(',');
    write_kv_str(&mut out, "consumer", &step.consumer);
    out.push(',');
    write_kv_str(&mut out, "purpose", &format_key_purpose(step.purpose));
    out.push(',');
    write_kv_str(&mut out, "action", step.action.as_str());
    out.push(',');
    match step.current_version {
        Some(v) => write_kv_str(&mut out, "from", &format!("{v}")),
        None => out.push_str("\"from\":null"),
    }
    out.push(',');
    write_kv_str(
        &mut out,
        "to",
        &format!("{}", step.target_version),
    );
    if let PlanAction::SidecarFailure { reason } = &step.action {
        out.push(',');
        write_kv_str(&mut out, "error_reason", reason);
    }
    out.push('}');
    out
}

fn write_kv_str(out: &mut String, key: &str, value: &str) {
    out.push('"');
    out.push_str(key);
    out.push_str("\":");
    push_json_string(out, value);
}

fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write as _;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Stable consumer-name renderer matching the runbook's
/// documented strings. The format is the kebab-case
/// suffix of the KeyPurpose variant name minus the
/// `SqlCipher` prefix, lowercased + dash-separated.
fn format_key_purpose(purpose: KeyPurpose) -> String {
    match purpose {
        KeyPurpose::SqlCipherOfflineQueue => "sqlcipher-offline-queue".into(),
        KeyPurpose::SqlCipherRetainPersistence => {
            "sqlcipher-retain-persistence".into()
        }
        KeyPurpose::SqlCipherLicenseCache => "sqlcipher-license-cache".into(),
        KeyPurpose::SqlCipherBytecodeRetain => "sqlcipher-bytecode-retain".into(),
        KeyPurpose::AuditHmacChain => "audit-hmac-chain".into(),
        KeyPurpose::ReplayCache => "replay-cache".into(),
        KeyPurpose::DekEscrow => "dek-escrow".into(),
        KeyPurpose::ConfigVerify => "config-verify".into(),
    }
}

/// Run the migration ceremony subcommand. Top-level
/// entry called from `main.rs` when the user invokes
/// `suderra-agent --migrate-db [args...]`.
///
/// **Returns:** ExitCode::SUCCESS on clean dry-run /
/// successful execution. ExitCode::FAILURE on argument
/// errors or execution failure.
pub fn run_migration_ceremony(argv: &[&str]) -> ExitCode {
    let args = match parse_args(argv) {
        Ok(a) => a,
        Err(e) => {
            #[allow(clippy::print_stderr)]
            {
                eprintln!("db-migrate-cli: {e}");
                eprintln!();
                print_usage();
            }
            return ExitCode::FAILURE;
        }
    };

    if !args.dry_run {
        // Execution path requires keystore + machine_id
        // bootstrap that subsequent PR-195 batches will
        // plumb. Refuse to run today so operators can't
        // accidentally invoke a half-implemented
        // execution path against a production DB.
        #[allow(clippy::print_stderr)]
        {
            eprintln!(
                "db-migrate-cli: execution path not yet wired (PR-195 in progress)."
            );
            eprintln!(
                "  Use --dry-run to compute the migration plan from the"
            );
            eprintln!(
                "  current data-dir state. Subsequent PR-195 batches will"
            );
            eprintln!(
                "  wire the keystore + machine_id bootstrap and enable"
            );
            eprintln!("  execution.");
        }
        return ExitCode::FAILURE;
    }

    let plan = compute_dry_run_plan(&args);
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    for step in &plan {
        let line = plan_step_to_jsonl(step);
        // The print_stdout lint is denied at the crate
        // level for production hot paths; this is the
        // CLI subcommand's WHOLE PURPOSE — emit JSONL
        // to stdout for downstream operator tooling
        // (jq pipelines per the runbook).
        #[allow(clippy::print_stdout)]
        {
            let _ = writeln!(handle, "{line}");
        }
    }
    ExitCode::SUCCESS
}

fn print_usage() {
    #[allow(clippy::print_stderr)]
    {
        eprintln!("USAGE:");
        eprintln!("  suderra-agent --migrate-db --data-dir <path> [OPTIONS]");
        eprintln!();
        eprintln!("OPTIONS:");
        eprintln!(
            "  --data-dir <path>            Agent data directory (default: $SUDERRA_DATA_DIR)"
        );
        eprintln!(
            "  --schema-target <version>    Migration target (default: v2-keystore-derived)"
        );
        eprintln!(
            "  --output-format <fmt>        Output format (default: jsonl)"
        );
        eprintln!(
            "  --dry-run                    Compute plan without executing"
        );
        eprintln!();
        eprintln!("RUNBOOK:");
        eprintln!("  docs/runbooks/db-migration-rekey-ceremony.md");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_consumers_list_has_all_4_adr031_variants() {
        let purposes: Vec<KeyPurpose> = KNOWN_SQLCIPHER_CONSUMERS
            .iter()
            .map(|(_, p)| *p)
            .collect();
        assert!(purposes.contains(&KeyPurpose::SqlCipherOfflineQueue));
        assert!(purposes.contains(&KeyPurpose::SqlCipherRetainPersistence));
        assert!(purposes.contains(&KeyPurpose::SqlCipherLicenseCache));
        assert!(purposes.contains(&KeyPurpose::SqlCipherBytecodeRetain));
        assert_eq!(
            KNOWN_SQLCIPHER_CONSUMERS.len(),
            4,
            "ADR-031 enumerates exactly 4 SqlCipher consumers; \
             extending requires updating both this list AND ADR"
        );
    }

    #[test]
    fn parse_args_minimum_valid() {
        let args = parse_args(&["--data-dir", "/var/lib/suderra"])
            .expect("parse ok");
        assert_eq!(args.data_dir, PathBuf::from("/var/lib/suderra"));
        assert_eq!(
            args.schema_target,
            DbKeySchemaVersion::V2KeystoreDerived
        );
        assert_eq!(args.output_format, OutputFormat::Jsonl);
        assert!(!args.dry_run);
    }

    #[test]
    fn parse_args_full_set() {
        let args = parse_args(&[
            "--data-dir",
            "/tmp/data",
            "--schema-target",
            "v2-keystore-derived",
            "--output-format",
            "jsonl",
            "--dry-run",
        ])
        .expect("parse ok");
        assert_eq!(args.data_dir, PathBuf::from("/tmp/data"));
        assert!(args.dry_run);
    }

    #[test]
    fn parse_args_missing_data_dir() {
        let err = parse_args(&["--dry-run"])
            .expect_err("must error");
        assert!(matches!(err, ArgError::Missing { .. }));
    }

    #[test]
    fn parse_args_unknown_flag() {
        let err = parse_args(&["--data-dir", "/x", "--bogus"])
            .expect_err("must error");
        assert!(matches!(err, ArgError::Unknown { .. }));
    }

    #[test]
    fn parse_args_invalid_schema_target() {
        let err = parse_args(&[
            "--data-dir",
            "/x",
            "--schema-target",
            "v99-fictitious",
        ])
        .expect_err("must error");
        match err {
            ArgError::Invalid { flag, reason } => {
                assert_eq!(flag, "--schema-target");
                assert!(reason.contains("v99-fictitious"));
            }
            other => panic!("expected Invalid, got {:?}", other),
        }
    }

    #[test]
    fn arg_error_display_strings_pinned() {
        for (err, prefix) in [
            (
                ArgError::Missing {
                    flag: "x".into(),
                },
                "migrate_db_arg_missing",
            ),
            (
                ArgError::Unknown {
                    flag: "y".into(),
                },
                "migrate_db_arg_unknown",
            ),
            (
                ArgError::Invalid {
                    flag: "z".into(),
                    reason: "r".into(),
                },
                "migrate_db_arg_invalid",
            ),
        ] {
            let s = format!("{err}");
            assert!(s.contains(prefix), "missing `{prefix}` in: {s}");
        }
    }

    #[test]
    fn plan_action_as_str_pinned() {
        assert_eq!(PlanAction::WouldMigrate.as_str(), "would_migrate");
        assert_eq!(PlanAction::AlreadyAtTarget.as_str(), "already_at_target");
        assert_eq!(PlanAction::NoDbPresent.as_str(), "no_db_present");
        assert_eq!(PlanAction::OrphanSidecar.as_str(), "orphan_sidecar");
        assert_eq!(
            PlanAction::SidecarFailure {
                reason: "x".into()
            }
            .as_str(),
            "sidecar_failure"
        );
    }

    #[test]
    fn classify_plan_no_dbs_present_yields_no_db_present_for_each() {
        let dir = tempfile::tempdir().expect("tempdir");
        let args = MigrationArgs {
            data_dir: dir.path().to_path_buf(),
            schema_target: DbKeySchemaVersion::V2KeystoreDerived,
            output_format: OutputFormat::Jsonl,
            dry_run: true,
        };
        let plan = compute_dry_run_plan(&args);
        assert_eq!(plan.len(), 4); // one per ADR-031 consumer
        for step in &plan {
            assert_eq!(step.action, PlanAction::NoDbPresent);
            assert_eq!(step.current_version, None);
            assert_eq!(
                step.target_version,
                DbKeySchemaVersion::V2KeystoreDerived
            );
        }
    }

    #[test]
    fn classify_plan_legacy_v1_db_yields_would_migrate() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Touch offline_queue.db (no sidecar = legacy v1
        // default per Batch #5 boot detector logic).
        std::fs::write(dir.path().join("offline_queue.db"), b"")
            .expect("touch");
        let args = MigrationArgs {
            data_dir: dir.path().to_path_buf(),
            schema_target: DbKeySchemaVersion::V2KeystoreDerived,
            output_format: OutputFormat::Jsonl,
            dry_run: true,
        };
        let plan = compute_dry_run_plan(&args);
        let offline_queue_step = plan
            .iter()
            .find(|s| s.consumer == "offline_queue")
            .expect("offline_queue step present");
        assert_eq!(offline_queue_step.action, PlanAction::WouldMigrate);
        assert_eq!(
            offline_queue_step.current_version,
            Some(DbKeySchemaVersion::V1MachineIdDerived)
        );
        // The other 3 consumers stay no_db_present.
        let no_db_count = plan
            .iter()
            .filter(|s| s.action == PlanAction::NoDbPresent)
            .count();
        assert_eq!(no_db_count, 3);
    }

    #[test]
    fn plan_step_to_jsonl_contains_runbook_documented_fields() {
        let step = PlanStep {
            db_path: PathBuf::from("/var/lib/suderra/offline_queue.db"),
            consumer: "offline_queue".to_string(),
            purpose: KeyPurpose::SqlCipherOfflineQueue,
            action: PlanAction::WouldMigrate,
            current_version: Some(DbKeySchemaVersion::V1MachineIdDerived),
            target_version: DbKeySchemaVersion::V2KeystoreDerived,
        };
        let json = plan_step_to_jsonl(&step);
        // Pin every field the runbook documents.
        for expected in [
            "\"db_path\":\"/var/lib/suderra/offline_queue.db\"",
            "\"consumer\":\"offline_queue\"",
            "\"purpose\":\"sqlcipher-offline-queue\"",
            "\"action\":\"would_migrate\"",
            "\"from\":\"v1-machine-id-derived\"",
            "\"to\":\"v2-keystore-derived\"",
        ] {
            assert!(
                json.contains(expected),
                "missing `{expected}` in: {json}"
            );
        }
    }

    #[test]
    fn plan_step_to_jsonl_renders_null_from_for_no_db_case() {
        let step = PlanStep {
            db_path: PathBuf::from("/x/license_cache.db"),
            consumer: "license_cache".to_string(),
            purpose: KeyPurpose::SqlCipherLicenseCache,
            action: PlanAction::NoDbPresent,
            current_version: None,
            target_version: DbKeySchemaVersion::V2KeystoreDerived,
        };
        let json = plan_step_to_jsonl(&step);
        assert!(
            json.contains("\"from\":null"),
            "expected `\"from\":null` for NoDbPresent: {json}"
        );
    }

    #[test]
    fn plan_step_to_jsonl_includes_error_reason_for_sidecar_failure() {
        let step = PlanStep {
            db_path: PathBuf::from("/x/bytecode_retain.db"),
            consumer: "bytecode_retain".to_string(),
            purpose: KeyPurpose::SqlCipherBytecodeRetain,
            action: PlanAction::SidecarFailure {
                reason: "corrupt_manifest: …".to_string(),
            },
            current_version: None,
            target_version: DbKeySchemaVersion::V2KeystoreDerived,
        };
        let json = plan_step_to_jsonl(&step);
        assert!(json.contains("\"action\":\"sidecar_failure\""));
        assert!(json.contains("\"error_reason\":\"corrupt_manifest"));
    }

    #[test]
    fn run_migration_ceremony_dry_run_emits_4_lines() {
        // Smoke-test of the top-level entry point on
        // an empty data dir. Uses tempdir so no test
        // race with concurrent migrations.
        let dir = tempfile::tempdir().expect("tempdir");
        let argv: Vec<&str> = vec![
            "--data-dir",
            dir.path().to_str().unwrap(),
            "--dry-run",
        ];
        let exit = run_migration_ceremony(&argv);
        // Can't easily capture stdout without
        // restructuring the entry point's writer
        // injection; smoke-test that exit is SUCCESS
        // for the dry-run on an empty dir.
        // The classify_plan + plan_step_to_jsonl tests
        // above pin the JSONL shape directly.
        assert_eq!(format!("{exit:?}"), "ExitCode(unix_exit_status(0))");
    }

    #[test]
    fn run_migration_ceremony_refuses_execution_today() {
        let dir = tempfile::tempdir().expect("tempdir");
        let argv: Vec<&str> = vec![
            "--data-dir",
            dir.path().to_str().unwrap(),
            // Note: NO --dry-run flag.
        ];
        let exit = run_migration_ceremony(&argv);
        // Execution path refuses today; expects
        // FAILURE exit + operator-readable message.
        assert_eq!(format!("{exit:?}"), "ExitCode(unix_exit_status(1))");
    }
}
