//! Firmware update (OTA) command handler + helpers (Batch 20k
//! ARC-008 split).
//!
//! WHY: Plan §5 Faz 1 Step 5 domain isolation. The firmware OTA
//! pipeline is a 5-stage state machine (resolve → download →
//! verify → install → restart) with MQTT progress events at every
//! stage. It owns 6 free-function helpers that don't belong on
//! `CommandHandler` (URL-safety validators, SHA-256 compute,
//! GitHub tag resolver). Extracting the whole pipeline into a
//! dedicated module surfaces the security-critical state machine
//! for isolated audit.
//!
//! WHAT:
//! - `impl CommandHandler` block with `cmd_update_firmware` —
//!   validates params, computes target architecture, spawns a
//!   fire-and-forget task that streams MQTT progress events
//!   through the 5 stages, and returns an immediate ACK to the
//!   caller.
//! - Free helpers (module-private `pub(super)` scope):
//!   - `is_valid_github_repo` — `owner/repo` format validator
//!     (defense against URL injection via the `repo` param).
//!   - `is_valid_version_string` — tag-string safety validator
//!     (alphanumeric + dot + dash + underscore only).
//!   - `resolve_firmware_version` — explicit "agent-v1.5.3" /
//!     bare "1.5.2" → canonical GitHub release tag name; live
//!     "latest" resolution is rejected.
//!   - `download_file` — reqwest GET with 300s timeout; writes
//!     to local path.
//!   - `compute_sha256` / `read_checksum_file` — integrity
//!     verification primitives. `read_checksum_file` enforces
//!     64-char hex SHA-256 format to prevent corrupted checksum
//!     files from masking a genuine tamper event.
//!
//! SECURITY DECISIONS DOCUMENTED:
//! - `is_valid_github_repo` explicitly rejects `..` to prevent
//!   path-traversal attacks via the `repo` parameter if a
//!   downstream URL constructor naively concatenates.
//! - `read_checksum_file` requires EXACT 64-char lowercase hex to
//!   reject truncated/padded/colon-separated checksum files that
//!   would otherwise compare-equal by accident.
//! - Tag prefix filter `starts_with("agent-v")` prevents the OTA
//!   from installing random non-agent GitHub releases (e.g.,
//!   docs-v1.0, infra-v2.0) if an attacker controls the
//!   release-tag namespace briefly.
//! - Fire-and-forget spawn pattern matches `cmd_reboot` /
//!   `cmd_restart_agent` rationale: the response MUST return
//!   before the long-running update starts, and awaiting the
//!   task would deadlock (task kills the process).

use chrono::Utc;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::{error, info, warn};

use crate::mqtt::{CommandMessage, CommandResponse};

use super::CommandHandler;

/// Decision returned by the Batch 119 legacy-tarball mode
/// gate (pure function for testability). The command body
/// uses this to either warn-and-proceed or reject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LegacyTarballGateDecision {
    /// `firmware_update.mode=Permissive` — operator
    /// migration signal. Proceed but warn-log on invocation
    /// so the operator sees the path is being deprecated.
    AllowWithWarn,
    /// `firmware_update.mode=Enforcing` — reject invocation.
    /// The caller returns a structured error pointing the
    /// operator at `apply_signed_manifest`.
    Reject,
}

/// Pure mode-gate decision for the legacy tarball OTA path
/// (Batch 119 Sprint 6.5). Extracted from the command body
/// so the mode→decision mapping is unit-testable without
/// requiring a full CommandHandler fixture.
///
/// ## Contract (plan §3 HC-6 rollout discipline)
///
/// - Disabled (default): Reject. Signed-manifest rollout is
///   the only production-safe OTA path.
/// - Permissive: AllowWithWarn. Operator migration signal;
///   the path still works but the agent warn-logs on each
///   invocation so the operator can plan the cutover.
/// - Enforcing: Reject. The legacy tarball path does NOT
///   run the 8-gate SignedFirmwareManifest verify pipeline;
///   operators committed to mode=Enforcing have committed
///   to signed-only firmware + must use apply_signed_manifest.
pub(super) fn legacy_tarball_mode_gate(
    mode: crate::config::FirmwareUpdateMode,
) -> LegacyTarballGateDecision {
    use crate::config::FirmwareUpdateMode;
    match mode {
        FirmwareUpdateMode::Disabled => LegacyTarballGateDecision::Reject,
        FirmwareUpdateMode::Permissive => LegacyTarballGateDecision::AllowWithWarn,
        FirmwareUpdateMode::Enforcing => LegacyTarballGateDecision::Reject,
    }
}

impl CommandHandler {
    /// Update agent firmware (OTA).
    ///
    /// Downloads and installs a new version of the edge-agent
    /// binary from GitHub releases. Sends MQTT progress updates
    /// at each stage.
    ///
    /// # Task Handle
    /// The spawned task is intentionally not tracked because:
    /// 1. The agent will be restarted after successful update.
    /// 2. We must return the ACK response before the update
    ///    begins (awaiting would deadlock — the task eventually
    ///    kills the process).
    /// 3. Progress is reported via MQTT at each stage.
    pub(super) async fn cmd_update_firmware(
        &self,
        command: &CommandMessage,
    ) -> (bool, Value, Option<String>) {
        info!("Executing update_firmware command");

        // Batch 119 Sprint 6.5: firmware_update.mode gate.
        // Plan §3 HC-6 rollout discipline enforced via the
        // pure `legacy_tarball_mode_gate` decision helper
        // (testable without CommandHandler fixtures).
        {
            let mode = {
                let s = self.state.read().await;
                s.config.firmware_update.mode
            };
            match legacy_tarball_mode_gate(mode) {
                LegacyTarballGateDecision::AllowWithWarn => {
                    warn!(
                        "update_firmware: legacy tarball OTA invoked while firmware_update.mode=Permissive. \
                         Migrate to 'apply_signed_manifest' for 8-gate verify + tenant-bound monotonic version. \
                         This command will be REJECTED when mode is raised to Enforcing."
                    );
                }
                LegacyTarballGateDecision::Reject => {
                    warn!(
                        "update_firmware: REJECTED under firmware_update.mode={:?}. \
                         Legacy tarball OTA does NOT run the 8-gate SignedFirmwareManifest \
                         verify pipeline; operators MUST use 'apply_signed_manifest'.",
                        mode
                    );
                    return (
                        false,
                        json!({
                            "rejected": true,
                            "gate": "legacy_tarball_disabled",
                            "mode": format!("{:?}", mode).to_ascii_lowercase(),
                            "migration": "use_apply_signed_manifest",
                        }),
                        Some(format!(
                            "update_firmware rejected: firmware_update.mode={:?} disables the legacy tarball path. \
                                     Use 'apply_signed_manifest' with a SignedFirmwareManifest payload instead.",
                            mode
                        )),
                    );
                }
            }
        }

        let params = &command.params;

        let target_version = match params.get("target_version").and_then(|v| v.as_str()) {
            Some(v) => v.to_string(),
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing required parameter: target_version".to_string()),
                );
            }
        };

        let repo = params
            .get("repo")
            .and_then(|v| v.as_str())
            .unwrap_or("suderra/edge-agent")
            .to_string();

        // Defense against URL injection via `repo` param. Must be
        // "owner/repo" with alphanumeric / dash / underscore / dot
        // ONLY. Path-traversal via `..` explicitly rejected.
        if !is_valid_github_repo(&repo) {
            return (
                false,
                json!(null),
                Some(format!(
                    "Invalid repo format: expected 'owner/repo' with alphanumeric, dash, underscore, or dot characters"
                )),
            );
        }

        let command_id = command.command_id.clone();
        let state = self.state.clone();
        let current_version = env!("CARGO_PKG_VERSION").to_string();

        let device_id = {
            let s = state.read().await;
            s.config.device_id.clone()
        };

        let target_version_ack = target_version.clone();
        let current_version_ack = current_version.clone();

        // Fire-and-forget — bind to _handle so
        // clippy::let_underscore_future doesn't flag a
        // forgotten-await false positive (firmware progress
        // task lifetime is task-bound, not awaited here).
        let _handle = tokio::spawn(async move {
            let send_progress = |stage: &str, detail: Value| {
                let state = state.clone();
                let command_id = command_id.clone();
                let device_id = device_id.clone();
                let stage = stage.to_string();
                async move {
                    let response = CommandResponse {
                        command_id,
                        device_id,
                        success: true,
                        result: json!({
                            "stage": stage,
                            "detail": detail,
                        }),
                        timestamp: Utc::now().to_rfc3339(),
                        error: None,
                    };
                    let s = state.read().await;
                    crate::publish_helpers::publish_response(&s, &response).await;
                }
            };

            let send_failed = |error_msg: String| {
                let state = state.clone();
                let command_id = command_id.clone();
                let device_id = device_id.clone();
                async move {
                    error!("Firmware update failed: {}", error_msg);
                    let response = CommandResponse {
                        command_id,
                        device_id,
                        success: false,
                        result: json!({"stage": "failed"}),
                        timestamp: Utc::now().to_rfc3339(),
                        error: Some(error_msg),
                    };
                    let s = state.read().await;
                    crate::publish_helpers::publish_response(&s, &response).await;
                }
            };

            // Stage 1: Resolve version
            send_progress("resolving", json!({"target": &target_version})).await;

            let resolved_tag = match resolve_firmware_version(&target_version, &repo).await {
                Ok(tag) => tag,
                Err(e) => {
                    send_failed(format!("Failed to resolve version: {}", e)).await;
                    return;
                }
            };

            let resolved_version = resolved_tag
                .strip_prefix("agent-v")
                .unwrap_or(&resolved_tag);

            if resolved_version == current_version {
                send_progress(
                    "already_installed",
                    json!({
                        "current_version": current_version,
                        "resolved_version": resolved_version,
                    }),
                )
                .await;
                return;
            }

            info!(
                "Firmware update: {} -> {} (tag: {})",
                current_version, resolved_version, resolved_tag
            );

            // Stage 2: Download
            send_progress(
                "downloading",
                json!({
                    "from_version": current_version,
                    "to_version": resolved_version,
                    "tag": &resolved_tag,
                }),
            )
            .await;

            let arch = match std::env::consts::ARCH {
                "x86_64" => "x86_64",
                "aarch64" => "aarch64",
                "arm" => "armv7",
                other => {
                    send_failed(format!("Unsupported architecture: {}", other)).await;
                    return;
                }
            };

            let tarball_name = format!("suderra-agent-{}-unknown-linux-gnu.tar.gz", arch);
            let checksum_name = format!("{}.sha256", tarball_name);
            let base_url = format!(
                "https://github.com/{}/releases/download/{}/",
                repo, resolved_tag
            );

            let update_dir = PathBuf::from("/var/lib/suderra/updates");
            if let Err(e) = fs::create_dir_all(&update_dir) {
                send_failed(format!("Failed to create update directory: {}", e)).await;
                return;
            }

            let tarball_path = update_dir.join(&tarball_name);
            let checksum_path = update_dir.join(&checksum_name);

            if let Err(e) =
                download_file(&format!("{}{}", base_url, tarball_name), &tarball_path).await
            {
                send_failed(format!("Failed to download tarball: {}", e)).await;
                return;
            }

            if let Err(e) =
                download_file(&format!("{}{}", base_url, checksum_name), &checksum_path).await
            {
                send_failed(format!("Failed to download checksum file: {}", e)).await;
                return;
            }

            // Stage 3: Verify checksum
            send_progress("verifying", json!({"file": &tarball_name})).await;

            let computed = match compute_sha256(&tarball_path) {
                Ok(h) => h,
                Err(e) => {
                    send_failed(format!("Failed to compute SHA256: {}", e)).await;
                    return;
                }
            };

            let expected = match read_checksum_file(&checksum_path) {
                Ok(h) => h,
                Err(e) => {
                    send_failed(format!("Failed to read checksum file: {}", e)).await;
                    return;
                }
            };

            if computed != expected {
                send_failed(format!(
                    "Checksum mismatch: expected={}, computed={}",
                    expected, computed
                ))
                .await;
                return;
            }

            info!("Checksum verified: {}", computed);

            // Stage 4: Install
            send_progress(
                "installing",
                json!({
                    "version": resolved_version,
                    "arch": arch,
                }),
            )
            .await;

            let binary_path = PathBuf::from("/opt/suderra/edge-agent");
            let backup_path = PathBuf::from("/opt/suderra/edge-agent.bak");

            let extract_dir = update_dir.join("extract");
            let _ = fs::remove_dir_all(&extract_dir);
            if let Err(e) = fs::create_dir_all(&extract_dir) {
                send_failed(format!("Failed to create extract directory: {}", e)).await;
                return;
            }

            let tar_status = tokio::process::Command::new("tar")
                .args([
                    "xzf",
                    &tarball_path.to_string_lossy().to_string(),
                    "-C",
                    &extract_dir.to_string_lossy().to_string(),
                ])
                .status()
                .await;

            match tar_status {
                Ok(s) if s.success() => {}
                Ok(s) => {
                    send_failed(format!("tar extraction failed with status: {}", s)).await;
                    return;
                }
                Err(e) => {
                    send_failed(format!("Failed to execute tar: {}", e)).await;
                    return;
                }
            }

            let extracted_binary = extract_dir.join("suderra-agent");
            if !extracted_binary.exists() {
                send_failed("Extracted binary not found at expected path".to_string()).await;
                return;
            }

            if binary_path.exists() {
                if let Err(e) = fs::copy(&binary_path, &backup_path) {
                    send_failed(format!("Failed to backup current binary: {}", e)).await;
                    return;
                }
                info!("Current binary backed up to {:?}", backup_path);
            }

            let chmod_status = tokio::process::Command::new("chmod")
                .args(["+x", &extracted_binary.to_string_lossy().to_string()])
                .status()
                .await;

            if let Err(e) = chmod_status {
                error!("Failed to chmod extracted binary: {}", e);
            }

            // Atomic install: stage → rename. rename is atomic on
            // same filesystem; cross-device fallback is copy + log-
            // loud because atomic guarantee is lost in that case.
            let staging_path = PathBuf::from("/opt/suderra/edge-agent.new");
            if let Err(e) = fs::copy(&extracted_binary, &staging_path) {
                send_failed(format!("Failed to stage new binary: {}", e)).await;
                return;
            }

            if let Err(e) = fs::rename(&staging_path, &binary_path) {
                error!("Atomic rename failed ({}), falling back to copy", e);
                if let Err(e2) = fs::copy(&staging_path, &binary_path) {
                    error!("Failed to install new binary: {}. Attempting rollback.", e2);
                    if backup_path.exists() {
                        let _ = fs::copy(&backup_path, &binary_path);
                    }
                    let _ = fs::remove_file(&staging_path);
                    send_failed(format!("Failed to install new binary: {}", e2)).await;
                    return;
                }
                let _ = fs::remove_file(&staging_path);
            }

            let _ = fs::remove_dir_all(&extract_dir);
            let _ = fs::remove_file(&tarball_path);
            let _ = fs::remove_file(&checksum_path);

            // Stage 5: Restart
            send_progress(
                "restarting",
                json!({
                    "previous_version": current_version,
                    "new_version": resolved_version,
                }),
            )
            .await;

            // Wait for MQTT flush before systemctl kills us.
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

            let status = tokio::process::Command::new("systemctl")
                .args(["restart", "suderra-agent"])
                .status()
                .await;

            match status {
                Ok(s) if s.success() => info!("Agent restart initiated after firmware update"),
                Ok(s) => error!("Restart after firmware update failed with status: {}", s),
                Err(e) => error!("Failed to restart agent after firmware update: {}", e),
            }
        });

        (
            true,
            json!({
                "accepted": true,
                "target_version": target_version_ack,
                "current_version": current_version_ack,
                "note": "Firmware update accepted. Progress will be reported via MQTT."
            }),
            None,
        )
    }
}

// ============================================================================
// Firmware Update Helpers (module-private)
// ============================================================================

/// Validate that a GitHub repo string is safe (owner/repo format,
/// no path traversal). Defense against URL injection via the
/// `repo` parameter if a downstream URL constructor naively
/// concatenates. Explicitly rejects `..` to neutralize path-
/// traversal vectors.
pub(super) fn is_valid_github_repo(repo: &str) -> bool {
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 {
        return false;
    }
    let valid_chars = |s: &str| -> bool {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            && !s.starts_with('.')
            && !s.contains("..")
    };
    valid_chars(parts[0]) && valid_chars(parts[1])
}

/// Validate that a version/tag string contains only safe
/// characters. 64-char max defense against abnormally-long tag
/// injection.
pub(super) fn is_valid_version_string(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// Resolve a firmware version string to a GitHub release tag.
///
/// Accepts:
/// - "agent-v1.5.3" → used as-is.
/// - "1.5.2" → prefixed with "agent-v".
///
/// Rejects "latest" because production consumers must be bound
/// to the signed release registry, not live release ordering.
pub(super) async fn resolve_firmware_version(target: &str, _repo: &str) -> anyhow::Result<String> {
    if target.eq_ignore_ascii_case("latest") {
        anyhow::bail!(
            "latest firmware resolution is disabled; specify an explicit agent-v<semver> tag"
        )
    } else if !is_valid_version_string(target) {
        anyhow::bail!("Invalid version string: contains disallowed characters")
    } else if target.starts_with("agent-v") {
        Ok(target.to_string())
    } else {
        Ok(format!("agent-v{}", target))
    }
}

/// Download a file from a URL to a local path with a 300-second
/// timeout.
///
/// WHY pre-Phase-1.1.5 this callsite was an ORPHAN-HIGH-035 surface:
/// the bare reqwest client builder inherited the process-global
/// default rustls CryptoProvider — pre-Phase-1.1.5 that was the
/// **unrestricted** ring provider installed by `mqtt.rs::install_default()`.
/// Firmware OTA downloads (tarball + checksum) flow through this helper;
/// without explicit cipher-allowlist plumbing a TLS 1.2 ECDHE downgrade
/// attack on the firmware-host CDN would expose the OTA payload to a
/// passive MITM that observes the binary + checksum out of order. The
/// SHA-256 checksum verifier downstream catches *tampering*, not
/// *eavesdropping* — confidentiality of the firmware binary (which
/// contains compiled-in OTA signing pubkeys + agent telemetry endpoints)
/// matters even when integrity is independently verified.
///
/// Closure: this helper now goes through `build_suderra_https_client_config`
/// — same TLS 1.3 + 3-suite AEAD allowlist as `provisioning.rs::activate`,
/// `scripting/engine.rs`, and explicit firmware artifact downloads. Every reqwest
/// callsite in the agent now uniformly enforces the cipher allowlist.
pub(super) async fn download_file(url: &str, dest: &Path) -> anyhow::Result<()> {
    info!("Downloading {} -> {:?}", url, dest);

    let suderra_tls = crate::mtls::build_suderra_https_client_config()
        .map_err(|e| anyhow::anyhow!("Failed to build Suderra HTTPS ClientConfig: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .use_preconfigured_tls((*suderra_tls).clone())
        .build()?;

    let response = client
        .get(url)
        .header("User-Agent", "suderra-agent")
        .send()
        .await?;

    if !response.status().is_success() {
        anyhow::bail!("Download failed with status {}", response.status());
    }

    let bytes = response.bytes().await?;
    fs::write(dest, &bytes)?;

    info!("Downloaded {} bytes to {:?}", bytes.len(), dest);
    Ok(())
}

/// Compute SHA256 hash of a file, returning lowercase hex string.
pub(super) fn compute_sha256(path: &Path) -> anyhow::Result<String> {
    use sha2::{Digest, Sha256};

    let data = fs::read(path)?;
    let hash = Sha256::digest(&data);
    Ok(format!("{:x}", hash))
}

/// Read a .sha256 checksum file and extract the hash.
///
/// Supports formats:
/// - `<hash>  <filename>` (sha256sum output)
/// - `<hash>` (hash only)
///
/// Enforces EXACT 64-char lowercase hex to reject truncated /
/// padded / colon-separated checksum files that would otherwise
/// compare-equal by accident.
pub(super) fn read_checksum_file(path: &Path) -> anyhow::Result<String> {
    let content = fs::read_to_string(path)?.trim().to_string();

    let hash = content
        .split_whitespace()
        .next()
        .ok_or_else(|| anyhow::anyhow!("Empty checksum file"))?
        .to_lowercase();

    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        anyhow::bail!("Invalid SHA256 hash format: {}", hash);
    }

    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::FirmwareUpdateMode;

    // ========================================================================
    // legacy_tarball_mode_gate tests (Batch 119 Sprint 6.5)
    // ========================================================================

    #[test]
    fn mode_gate_disabled_returns_reject() {
        assert_eq!(
            legacy_tarball_mode_gate(FirmwareUpdateMode::Disabled),
            LegacyTarballGateDecision::Reject
        );
    }

    #[test]
    fn mode_gate_permissive_returns_allow_with_warn() {
        assert_eq!(
            legacy_tarball_mode_gate(FirmwareUpdateMode::Permissive),
            LegacyTarballGateDecision::AllowWithWarn
        );
    }

    #[test]
    fn mode_gate_enforcing_returns_reject() {
        assert_eq!(
            legacy_tarball_mode_gate(FirmwareUpdateMode::Enforcing),
            LegacyTarballGateDecision::Reject
        );
    }

    #[test]
    fn mode_gate_decision_is_total_over_mode_variants() {
        // Every FirmwareUpdateMode variant must produce a
        // decision. If a new variant is added + not handled,
        // this test (together with Rust's exhaustive match
        // in legacy_tarball_mode_gate) fails at compile
        // time. Runtime assertion here is belt-and-
        // suspenders for reviewers inspecting the
        // contract.
        let all = [
            FirmwareUpdateMode::Disabled,
            FirmwareUpdateMode::Permissive,
            FirmwareUpdateMode::Enforcing,
        ];
        for m in all {
            let decision = legacy_tarball_mode_gate(m);
            // The decision must be one of the known
            // variants; the match on the result itself is
            // also exhaustive.
            match decision {
                LegacyTarballGateDecision::AllowWithWarn | LegacyTarballGateDecision::Reject => {}
            }
        }
    }
}
