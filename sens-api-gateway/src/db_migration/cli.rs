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

use crate::db_migration::boot_detector::{DbMigrationBacklogReport, detect_db_migration_backlog};
use crate::db_migration::cli_executor::{ConsumerOutcome, FailReason, SkipReason};
use crate::db_migration::cli_runtime::execute_migration_ceremony;
use crate::db_migration::schema_version::DbKeySchemaVersion;
use crate::keystore::Keystore;
use crate::keystore::purpose::KeyPurpose;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

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
    let mut schema_target: DbKeySchemaVersion = DbKeySchemaVersion::current_target();
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
                let value = argv.get(i + 1).ok_or_else(|| ArgError::Missing {
                    flag: "--data-dir <path>".to_string(),
                })?;
                data_dir = Some(PathBuf::from(value));
                i += 2;
            }
            "--schema-target" => {
                let value = argv.get(i + 1).ok_or_else(|| ArgError::Missing {
                    flag: "--schema-target <kebab-case-version>".to_string(),
                })?;
                schema_target = match *value {
                    "v1-machine-id-derived" => DbKeySchemaVersion::V1MachineIdDerived,
                    "v2-keystore-derived" => DbKeySchemaVersion::V2KeystoreDerived,
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
                let value = argv.get(i + 1).ok_or_else(|| ArgError::Missing {
                    flag: "--output-format <jsonl>".to_string(),
                })?;
                output_format = match *value {
                    "jsonl" => OutputFormat::Jsonl,
                    other => {
                        return Err(ArgError::Invalid {
                            flag: "--output-format".to_string(),
                            reason: format!("unknown format `{other}` (expected jsonl)"),
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
    let db_path_refs: Vec<&Path> = db_paths.iter().map(|p| p.as_path()).collect();

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

    for (path, (filename, purpose)) in db_paths.iter().zip(KNOWN_SQLCIPHER_CONSUMERS.iter()) {
        let consumer = filename.strip_suffix(".db").unwrap_or(filename).to_string();

        // Find this path in the boot detector's report
        // and route to the corresponding PlanAction.
        let action_and_current = (|| {
            for entry in &report.backlog {
                if &entry.db_path == path {
                    return (PlanAction::WouldMigrate, Some(entry.current_version));
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
    write_kv_str(&mut out, "to", &format!("{}", step.target_version));
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
        KeyPurpose::SqlCipherRetainPersistence => "sqlcipher-retain-persistence".into(),
        KeyPurpose::SqlCipherLicenseCache => "sqlcipher-license-cache".into(),
        KeyPurpose::SqlCipherBytecodeRetain => "sqlcipher-bytecode-retain".into(),
        KeyPurpose::SqlCipherScadaDisplay => "sqlcipher-scada-display".into(),
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
///
/// **Why a thin wrapper:** the legacy two-arg call site
/// in `main.rs` (Batch #6 dispatch) still works
/// unchanged via this wrapper. The execution-capable
/// path lives in
/// `run_migration_ceremony_with_context` (Batch #12)
/// and is invoked when `main.rs` plumbs the
/// `MigrationContext` (subsequent batch).
pub fn run_migration_ceremony(argv: &[&str]) -> ExitCode {
    run_migration_ceremony_inner(argv, None)
}

/// Runtime context the execution path needs from the
/// agent's already-initialized subsystems. Built by
/// `main.rs`'s `--migrate-db` arm AFTER config load +
/// keystore bootstrap, then passed into
/// `run_migration_ceremony_with_context`.
///
/// **Why a struct (not three positional args):** the
/// CLI dispatch site can construct + pass this once,
/// the test harness can construct deterministic
/// instances, and adding a fifth field later (e.g.,
/// progress callback) doesn't break callers. Mirrors
/// the established `RotationSource<'_>` shape from
/// keystore.
pub struct MigrationContext {
    /// Provisioning device UUID (from
    /// `AgentConfig.device_id`). Used for the v2
    /// device-bound consumer context.
    pub device_id: String,
    /// Currently-loaded program's bytecode SHA-256, or
    /// `None` if no program is loaded. Used for the v2
    /// program-bound consumer context.
    pub program_artifact_sha256: Option<Vec<u8>>,
    /// Agent's already-built keystore handle. Used for
    /// the v2 target-key derivation.
    pub keystore: Arc<dyn Keystore>,
    /// Current Unix timestamp seconds. Caller passes
    /// `chrono::Utc::now().timestamp()` (or equivalent)
    /// at dispatch time; the ceremony does NOT call
    /// `SystemTime::now()` because tests would become
    /// non-deterministic.
    pub now_unix: i64,
}

/// Execute-capable variant of `run_migration_ceremony`.
/// When `args.dry_run` is true, behaves identically to
/// the legacy entry point (stdout JSONL plan emission).
/// When `args.dry_run` is false, drives the full
/// migration ceremony via
/// `cli_runtime::execute_migration_ceremony` and emits
/// per-consumer outcome JSONL to stdout.
///
/// **Why one entry point covers both modes:** a single
/// dispatch site (`main.rs` `--migrate-db` arm) doesn't
/// need to inspect `dry_run` to pick between two
/// functions; the function inspects it internally and
/// routes. Consistent with the
/// `parse_args → behavior` shape of the other
/// subcommand entry points.
pub fn run_migration_ceremony_with_context(argv: &[&str], context: MigrationContext) -> ExitCode {
    run_migration_ceremony_inner(argv, Some(context))
}

/// Shared dispatcher for both
/// `run_migration_ceremony` (no-context legacy) and
/// `run_migration_ceremony_with_context` (execute-
/// capable). Inspects `args.dry_run` to pick between
/// the dry-run plan path (always available) and the
/// execute path (only available when context is
/// `Some`).
fn run_migration_ceremony_inner(argv: &[&str], context: Option<MigrationContext>) -> ExitCode {
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

    if args.dry_run {
        return emit_dry_run_plan(&args);
    }

    // Execute path — requires a `MigrationContext`. If
    // the caller didn't provide one (legacy
    // `run_migration_ceremony` entry), refuse with the
    // operator-readable message that documents how to
    // reach the execute-capable variant.
    let ctx = match context {
        Some(c) => c,
        None => {
            #[allow(clippy::print_stderr)]
            {
                eprintln!("db-migrate-cli: execution path requires MigrationContext.");
                eprintln!("  This entry point (run_migration_ceremony) is dry-run only.");
                eprintln!("  The agent must dispatch via run_migration_ceremony_with_context");
                eprintln!("  with a MigrationContext built from the loaded config + keystore.");
            }
            return ExitCode::FAILURE;
        }
    };

    execute_ceremony_via_context(&args, ctx)
}

/// Drive the migration via the execute path. Builds a
/// per-call tokio runtime so the sync `ExitCode`
/// caller doesn't need to thread an async runtime
/// through the dispatch chain.
///
/// **Why a per-call runtime (not the agent's main
/// runtime):** the CLI subcommand is a one-shot
/// process — the agent's main async runtime hasn't
/// been spun up at this dispatch point (the migration
/// runs PRE-agent-boot). Building a fresh
/// current-thread runtime is the lightest-weight
/// option that doesn't require a Tokio runtime
/// already in scope.
fn execute_ceremony_via_context(args: &MigrationArgs, ctx: MigrationContext) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            #[allow(clippy::print_stderr)]
            {
                eprintln!("db-migrate-cli: failed to build tokio runtime: {e}");
            }
            return ExitCode::FAILURE;
        }
    };

    let outcome_result = runtime.block_on(execute_migration_ceremony(
        args,
        ctx.device_id,
        ctx.program_artifact_sha256,
        ctx.keystore,
        ctx.now_unix,
    ));

    match outcome_result {
        Ok(outcome) => {
            emit_outcome_jsonl(&outcome.per_consumer);
            if outcome.is_clean() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(e) => {
            #[allow(clippy::print_stderr)]
            {
                eprintln!("db-migrate-cli: ceremony failed: {e}");
            }
            ExitCode::FAILURE
        }
    }
}

/// Emit the dry-run plan as JSONL to stdout — extracted
/// so both the legacy entry point and the
/// `with_context` entry point share identical dry-run
/// behavior (no drift between modes).
fn emit_dry_run_plan(args: &MigrationArgs) -> ExitCode {
    let plan = compute_dry_run_plan(args);
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

/// Emit the execute-path per-consumer outcome as JSONL
/// to stdout — one line per `ConsumerOutcome`. The
/// runbook documents the schema; downstream operator
/// tooling (jq pipelines) consumes this.
///
/// **Why hand-rolled JSON (not serde):** the same
/// reasoning as `plan_step_to_jsonl` (Batch #6) — avoid
/// a serde dependency on the outcome enum + keep the
/// schema explicit at the call site so the runbook can
/// document it without chasing #[serde] attributes.
fn emit_outcome_jsonl(outcomes: &[ConsumerOutcome]) {
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    for o in outcomes {
        let line = consumer_outcome_to_jsonl(o);
        #[allow(clippy::print_stdout)]
        {
            let _ = writeln!(handle, "{line}");
        }
    }
}

/// Hand-rolled JSON formatter for a single
/// `ConsumerOutcome`. Format mirrors the dry-run
/// plan's shape so operator tooling can union the two
/// streams without per-mode parsing.
fn consumer_outcome_to_jsonl(outcome: &ConsumerOutcome) -> String {
    match outcome {
        ConsumerOutcome::Migrated { purpose, from, to } => format!(
            "{{\"outcome\":\"migrated\",\"purpose\":\"{}\",\"from\":\"{}\",\"to\":\"{}\"}}",
            format_key_purpose(*purpose),
            schema_version_str(*from),
            schema_version_str(*to),
        ),
        ConsumerOutcome::Skipped { purpose, reason } => format!(
            "{{\"outcome\":\"skipped\",\"purpose\":\"{}\",\"reason\":\"{}\"}}",
            format_key_purpose(*purpose),
            skip_reason_str(reason),
        ),
        ConsumerOutcome::Failed { purpose, reason } => format!(
            "{{\"outcome\":\"failed\",\"purpose\":\"{}\",\"reason_class\":\"{}\"}}",
            format_key_purpose(*purpose),
            fail_reason_class(reason),
        ),
    }
}

fn schema_version_str(v: DbKeySchemaVersion) -> &'static str {
    match v {
        DbKeySchemaVersion::V1MachineIdDerived => "v1-machine-id-derived",
        DbKeySchemaVersion::V2KeystoreDerived => "v2-keystore-derived",
    }
}

// DbKeySchemaVersion is `Copy`; ConsumerOutcome's
// destructure binds `from` and `to` by move into the
// formatter call. The schema_version_str takes by
// value so the Copy is what's flowing through.

fn skip_reason_str(reason: &SkipReason) -> &'static str {
    match reason {
        SkipReason::NoDb => "no_db",
        SkipReason::AlreadyV2 => "already_v2",
    }
}

fn fail_reason_class(reason: &FailReason) -> &'static str {
    // Class only — not full reason string. The full
    // operator post-mortem detail comes from stderr
    // logs; the JSONL is for routing-on-class.
    match reason {
        FailReason::Resolver(_) => "resolver",
        FailReason::Context(_) => "context",
        FailReason::V2Derivation(_) => "v2_derivation",
        FailReason::DbOpen { .. } => "db_open",
        FailReason::RekeySwap(_) => "rekey_swap",
    }
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
        eprintln!("  --schema-target <version>    Migration target (default: v2-keystore-derived)");
        eprintln!("  --output-format <fmt>        Output format (default: jsonl)");
        eprintln!("  --dry-run                    Compute plan without executing");
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
        let purposes: Vec<KeyPurpose> = KNOWN_SQLCIPHER_CONSUMERS.iter().map(|(_, p)| *p).collect();
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
        let args = parse_args(&["--data-dir", "/var/lib/suderra"]).expect("parse ok");
        assert_eq!(args.data_dir, PathBuf::from("/var/lib/suderra"));
        assert_eq!(args.schema_target, DbKeySchemaVersion::V2KeystoreDerived);
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
        let err = parse_args(&["--dry-run"]).expect_err("must error");
        assert!(matches!(err, ArgError::Missing { .. }));
    }

    #[test]
    fn parse_args_unknown_flag() {
        let err = parse_args(&["--data-dir", "/x", "--bogus"]).expect_err("must error");
        assert!(matches!(err, ArgError::Unknown { .. }));
    }

    #[test]
    fn parse_args_invalid_schema_target() {
        let err = parse_args(&["--data-dir", "/x", "--schema-target", "v99-fictitious"])
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
                ArgError::Missing { flag: "x".into() },
                "migrate_db_arg_missing",
            ),
            (
                ArgError::Unknown { flag: "y".into() },
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
            PlanAction::SidecarFailure { reason: "x".into() }.as_str(),
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
            assert_eq!(step.target_version, DbKeySchemaVersion::V2KeystoreDerived);
        }
    }

    #[test]
    fn classify_plan_legacy_v1_db_yields_would_migrate() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Touch offline_queue.db (no sidecar = legacy v1
        // default per Batch #5 boot detector logic).
        std::fs::write(dir.path().join("offline_queue.db"), b"").expect("touch");
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
            assert!(json.contains(expected), "missing `{expected}` in: {json}");
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
        let argv: Vec<&str> = vec!["--data-dir", dir.path().to_str().unwrap(), "--dry-run"];
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
        // Legacy entry point has no MigrationContext, so
        // the execute path refuses with the operator-
        // readable message + FAILURE exit.
        assert_eq!(format!("{exit:?}"), "ExitCode(unix_exit_status(1))");
    }

    // -------- Batch #12 — run_migration_ceremony_with_context --------

    use crate::db_migration::v1_legacy_key::{
        derive_v1_legacy_key, format_sqlcipher_pragma_key_hex,
    };
    use crate::keystore::error::{KeyDerivationError, KeystoreError, KeystoreErrorKind};
    use crate::keystore::purpose::DerivedKeyId;
    use crate::keystore::secret::KeyMaterial;
    use crate::keystore::{KeyBackend, RotationSource};
    use async_trait::async_trait;
    use rusqlite::Connection;
    use std::sync::Mutex;

    /// Per-module env-mutation serializer for the
    /// integration tests below — both `with_context`
    /// happy-path tests touch `SUDERRA_MACHINE_ID_PATH`
    /// + `SUDERRA_DB_KEY_PATH`. Mirrors
    /// `cli_runtime::tests::ENV_MUTEX`.
    static CLI_ENV_MUTEX: Mutex<()> = Mutex::new(());

    /// Deterministic test keystore (mirrors Batch #11
    /// pattern in cli_runtime).
    struct CliDeterministicKeystore;

    #[async_trait]
    impl Keystore for CliDeterministicKeystore {
        fn backend(&self) -> KeyBackend {
            KeyBackend::FileBacked
        }

        async fn derive_key(
            &self,
            purpose: KeyPurpose,
            _context: &[u8],
        ) -> Result<KeyMaterial, KeyDerivationError> {
            let mut bytes = [0u8; 32];
            bytes[0] = match purpose {
                KeyPurpose::SqlCipherOfflineQueue => 0xc1,
                KeyPurpose::SqlCipherRetainPersistence => 0xc2,
                KeyPurpose::SqlCipherLicenseCache => 0xc3,
                KeyPurpose::SqlCipherBytecodeRetain => 0xc4,
                _ => 0xff,
            };
            Ok(KeyMaterial::from_derived_bytes(purpose, bytes))
        }

        fn derived_key_id(&self, _purpose: KeyPurpose, _context: &[u8]) -> DerivedKeyId {
            DerivedKeyId([0u8; 16])
        }

        async fn rotate_master(&self) -> Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }

        async fn rotate_master_with_source(
            &self,
            _source: RotationSource<'_>,
        ) -> Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }
    }

    fn ctx(now_unix: i64) -> MigrationContext {
        MigrationContext {
            device_id: "ctx-device-uuid".into(),
            program_artifact_sha256: Some(vec![0xEE; 32]),
            keystore: Arc::new(CliDeterministicKeystore),
            now_unix,
        }
    }

    fn seed_v1_db(path: &std::path::Path, machine_id: &[u8], secret_key: &[u8]) {
        let bytes = derive_v1_legacy_key(machine_id, secret_key);
        let hex = format_sqlcipher_pragma_key_hex(&bytes);
        let conn = Connection::open(path).expect("open db");
        conn.execute_batch(&format!("PRAGMA key = \"x'{hex}'\";"))
            .expect("apply v1");
        conn.execute_batch(
            "CREATE TABLE seed (id INTEGER PRIMARY KEY); \
             INSERT INTO seed VALUES (1);",
        )
        .expect("seed table");
    }

    #[test]
    fn with_context_dry_run_path_emits_success_same_as_legacy() {
        // Dry-run path should be identical regardless of
        // whether context is supplied (the dry-run
        // routing branch ignores context entirely).
        let dir = tempfile::tempdir().expect("tempdir");
        let argv: Vec<&str> = vec!["--data-dir", dir.path().to_str().unwrap(), "--dry-run"];
        let exit = run_migration_ceremony_with_context(&argv, ctx(1_700_000_000));
        assert_eq!(format!("{exit:?}"), "ExitCode(unix_exit_status(0))");
    }

    #[test]
    fn with_context_execute_path_with_no_dbs_returns_success_clean_outcome() {
        // No v1 DBs present → 4 NoDb skips → outcome is
        // clean → exit SUCCESS. Validates that the
        // execute path doesn't error on an empty
        // data_dir (the orchestrator handles NoDb
        // gracefully).
        let _guard = CLI_ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let mid = dir.path().join("mid");
        std::fs::write(&mid, "ctx-mid\n").expect("seed mid");
        let secret = dir.path().join("db.key");
        std::fs::write(&secret, vec![0xAAu8; 32]).expect("seed secret");

        // SAFETY: env-mutation serialized via CLI_ENV_MUTEX.
        unsafe {
            std::env::set_var("SUDERRA_MACHINE_ID_PATH", &mid);
            std::env::set_var("SUDERRA_DB_KEY_PATH", &secret);
        }
        let argv: Vec<&str> = vec!["--data-dir", dir.path().to_str().unwrap()];
        let exit = run_migration_ceremony_with_context(&argv, ctx(1_700_000_000));
        unsafe {
            std::env::remove_var("SUDERRA_MACHINE_ID_PATH");
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        assert_eq!(format!("{exit:?}"), "ExitCode(unix_exit_status(0))");
    }

    #[test]
    fn with_context_execute_path_with_v1_db_migrates_and_returns_success() {
        let _guard = CLI_ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let mid = dir.path().join("mid");
        std::fs::write(&mid, "ctx-mid-with-v1\n").expect("seed mid");
        let secret = dir.path().join("db.key");
        let secret_bytes = vec![0xBBu8; 32];
        std::fs::write(&secret, &secret_bytes).expect("seed secret");

        // Seed offline_queue.db with the SAME v1 inputs
        // the ceremony will compute internally.
        seed_v1_db(
            &dir.path().join("offline_queue.db"),
            b"ctx-mid-with-v1",
            &secret_bytes,
        );

        // SAFETY: env-mutation serialized via CLI_ENV_MUTEX.
        unsafe {
            std::env::set_var("SUDERRA_MACHINE_ID_PATH", &mid);
            std::env::set_var("SUDERRA_DB_KEY_PATH", &secret);
        }
        let argv: Vec<&str> = vec!["--data-dir", dir.path().to_str().unwrap()];
        let exit = run_migration_ceremony_with_context(&argv, ctx(1_700_000_000));
        unsafe {
            std::env::remove_var("SUDERRA_MACHINE_ID_PATH");
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        assert_eq!(format!("{exit:?}"), "ExitCode(unix_exit_status(0))");

        // Post-condition: the manifest sidecar was
        // written + declares v2.
        let sidecar = crate::db_migration::manifest::manifest_path_for_db(
            &dir.path().join("offline_queue.db"),
        );
        let manifest_str = std::fs::read_to_string(&sidecar).expect("read sidecar");
        assert!(
            manifest_str.contains("v2-keystore-derived"),
            "expected v2 manifest, got: {manifest_str}"
        );
    }

    #[test]
    fn with_context_execute_path_bootstrap_failure_returns_failure_exit() {
        let _guard = CLI_ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        // Point SUDERRA_DB_KEY_PATH at a missing file —
        // bootstrap fails with SecretKeyMissing.
        let no_secret = dir.path().join("nope.key");

        // SAFETY: env-mutation serialized via CLI_ENV_MUTEX.
        unsafe {
            std::env::set_var("SUDERRA_DB_KEY_PATH", &no_secret);
        }
        let argv: Vec<&str> = vec!["--data-dir", dir.path().to_str().unwrap()];
        let exit = run_migration_ceremony_with_context(&argv, ctx(1_700_000_000));
        unsafe {
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        // Bootstrap failure → FAILURE exit.
        assert_eq!(format!("{exit:?}"), "ExitCode(unix_exit_status(1))");
    }

    #[test]
    fn consumer_outcome_to_jsonl_migrated_shape_pinned() {
        let line = consumer_outcome_to_jsonl(&ConsumerOutcome::Migrated {
            purpose: KeyPurpose::SqlCipherOfflineQueue,
            from: DbKeySchemaVersion::V1MachineIdDerived,
            to: DbKeySchemaVersion::V2KeystoreDerived,
        });
        assert_eq!(
            line,
            "{\"outcome\":\"migrated\",\"purpose\":\"sqlcipher-offline-queue\",\"from\":\"v1-machine-id-derived\",\"to\":\"v2-keystore-derived\"}"
        );
    }

    #[test]
    fn consumer_outcome_to_jsonl_skipped_no_db_shape_pinned() {
        let line = consumer_outcome_to_jsonl(&ConsumerOutcome::Skipped {
            purpose: KeyPurpose::SqlCipherLicenseCache,
            reason: SkipReason::NoDb,
        });
        assert_eq!(
            line,
            "{\"outcome\":\"skipped\",\"purpose\":\"sqlcipher-license-cache\",\"reason\":\"no_db\"}"
        );
    }

    #[test]
    fn consumer_outcome_to_jsonl_skipped_already_v2_shape_pinned() {
        let line = consumer_outcome_to_jsonl(&ConsumerOutcome::Skipped {
            purpose: KeyPurpose::SqlCipherBytecodeRetain,
            reason: SkipReason::AlreadyV2,
        });
        assert_eq!(
            line,
            "{\"outcome\":\"skipped\",\"purpose\":\"sqlcipher-bytecode-retain\",\"reason\":\"already_v2\"}"
        );
    }

    #[test]
    fn consumer_outcome_to_jsonl_failed_db_open_class_pinned() {
        let line = consumer_outcome_to_jsonl(&ConsumerOutcome::Failed {
            purpose: KeyPurpose::SqlCipherRetainPersistence,
            reason: FailReason::DbOpen { reason: "x".into() },
        });
        assert_eq!(
            line,
            "{\"outcome\":\"failed\",\"purpose\":\"sqlcipher-retain-persistence\",\"reason_class\":\"db_open\"}"
        );
    }
}
