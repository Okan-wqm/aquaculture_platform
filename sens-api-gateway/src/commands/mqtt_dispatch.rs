//! MQTT message routing for the CommandHandler.
//!
//! ## Why this module exists (Batch #296 ULTRA-HIGH-013 closure)
//!
//! Pre-Batch-#296 the `handle_message` body lived inline in
//! `commands/mod.rs`, contributing ~292 lines to a 1279-line file
//! that violated the ULTRA-HIGH-013 ≤500-line ceiling.
//! `handle_message` is the MQTT subscriber callback — it routes
//! incoming `IncomingMessage` payloads through the topic dispatch
//! (`commands` vs `config`) + executes the full command lifecycle
//! pipeline:
//!
//!   1. Topic match + retained-message rejection (D-14 attacker
//!      broker-replay defense).
//!   2. Envelope-vs-CommandMessage parse + signature verify
//!      (Batch 7 / Sprint 6.4 envelope_adapter).
//!   3. Replay-window check (max_command_age_secs +
//!      max_command_skew_secs).
//!   4. JTI dedup — Moka path (signature_mode != Disabled) or
//!      VecDeque fallback (Disabled / HC-1 backward compat).
//!   5. `execute_command` dispatch.
//!   6. Response publish.
//!
//! Each phase has its own architectural rationale documented inline
//! at the corresponding code site below; this module is structurally
//! thin — extraction was line-count-driven only, not behavior-shape
//! driven. Future sub-decompositions (per-phase methods) belong here.
//!
//! ## Visibility
//!
//! `handle_message` is `async fn` (private to the `commands` module
//! tree); the only caller is the run-loop in `commands/mod.rs`
//! `CommandHandler::run`. Keeping the method private prevents
//! external code from bypassing the rate-limiter that wraps the
//! call site in `run`.

use anyhow::Result;
use tracing::{debug, info, warn};

use crate::mqtt::{CommandMessage, IncomingMessage};

use super::envelope_adapter;

impl super::CommandHandler {
    /// Handle one incoming MQTT message — topic-dispatch + the full
    /// command lifecycle (parse → verify → replay-check → dedup →
    /// execute → publish).
    ///
    /// Returns `Err` only when an unrecoverable error happens that
    /// the caller's `error!` log should surface; rejections (retained
    /// flag, parse failure, replay, dedup hit) return `Ok(())`
    /// because they're operational events, not panics.
    pub(super) async fn handle_message(&mut self, message: IncomingMessage) -> Result<()> {
        let state = self.state.read().await;
        let topics = state.mqtt_client.as_ref().map(|m| m.topics().clone());
        drop(state);

        let topics = match topics {
            Some(t) => t,
            None => return Ok(()),
        };

        // Check if this is a command message
        if message.topic == topics.commands {
            debug!("Received command message");

            // Batch 25+31 plan D-14 retained-message rejection
            // (tier-1 fail-fast). Batch 25 added the inline
            // boolean check; Batch 31 routes it through the
            // canonical `runtime_safety::retained_msg::
            // is_retained_command_rejected` predicate so the
            // rejection decision + reason is a single typed
            // value. Sprint 6.2 audit-sink wire will consume
            // `RetainedMsgRejectionReason` as the structured
            // audit event payload.
            //
            // Topic-matcher: comparing against `topics.commands`
            // directly (exact match). Sprint 6.7 may widen to
            // regex-based tenant-scoped command-topic family.
            let commands_topic = topics.commands.clone();
            let rejection = crate::runtime_safety::retained_msg::is_retained_command_rejected(
                message.retain,
                &message.topic,
                |t| t == commands_topic,
            );
            if !matches!(
                rejection,
                crate::runtime_safety::retained_msg::RetainedMsgRejectionReason::NotRejected
            ) {
                warn!(
                    "Rejecting retained MQTT command: reason={}, topic='{}', {} bytes payload. \
                     Attacker-controlled broker replay vector; audit sink wires in Sprint 6.2.",
                    rejection,
                    message.topic,
                    message.payload.len()
                );
                return Ok(());
            }

            // Batch 63 Sprint 6.4 partial: envelope-first
            // parse. The adapter tries CommandEnvelope format;
            // falls back to legacy CommandMessage on non-
            // envelope payloads. Envelope payloads run
            // through verify_envelope's 7 gates (cmd bounds,
            // jti format, nonce bounds, freshness window,
            // tenant binding, cmd_hash match, signature-mode
            // rule) BEFORE reaching the legacy dispatch path.
            //
            // Architectural upgrade (not patch): both formats
            // continue to work; signed envelopes get stronger
            // gates while legacy CommandMessage retains HC-1
            // backward compat.
            let (signature_mode, tenant_bytes, rbac_store) = {
                let state = self.state.read().await;
                let tenant_bytes =
                    envelope_adapter::tenant_id_bytes_or_none(state.tenant_id.as_deref());
                // Batch 68 Sprint 6.1 full wire: clone Arc so
                // the adapter can run verify_signature via
                // RbacManifestStore::lookup_operator_pubkey
                // without holding the AppState read-guard.
                (
                    state.config.signature_mode,
                    tenant_bytes,
                    state.rbac_manifest_store.clone(),
                )
            };

            let command: CommandMessage = if let Some(tenant_bytes) = tenant_bytes {
                match envelope_adapter::try_parse_and_verify(
                    &message.payload,
                    tenant_bytes,
                    signature_mode,
                    &rbac_store,
                ) {
                    envelope_adapter::AdapterOutcome::NotEnvelopeFormat => {
                        // SEC-HIGH-057 (2026-08-23 scan №2): Enforcing mode
                        // REJECTS non-envelope payloads — the entire point of
                        // the mode is that only signed envelopes execute.
                        if signature_mode
                            == crate::command_envelope::envelope::SignatureMode::Enforcing
                        {
                            warn!(
                                "ENFORCING: rejected non-envelope payload on {} (unsigned legacy path forbidden)",
                                message.topic
                            );
                            return Ok(());
                        }
                        // Disabled/Permissive: legacy path — CommandMessage parse.
                        match serde_json::from_slice(&message.payload) {
                            Ok(cmd) => cmd,
                            Err(e) => {
                                warn!(
                                    "Failed to parse command (neither envelope nor legacy): {}",
                                    e
                                );
                                return Ok(());
                            }
                        }
                    }
                    envelope_adapter::AdapterOutcome::Verified(adapted) => {
                        // Envelope parsed + all 7 gates
                        // passed. Project into CommandMessage
                        // shape so the existing execute_command
                        // dispatch path stays unchanged.
                        // Batch #307: propagate the verified-
                        // co-approver flag so cmd_force_value
                        // (and other two-person-integrity
                        // handlers) can gate on it.
                        CommandMessage {
                            command_id: adapted.command_id,
                            command: adapted.command,
                            params: adapted.params,
                            timestamp: adapted.timestamp,
                            verified_co_approver: adapted.verified_co_approver,
                        }
                    }
                    envelope_adapter::AdapterOutcome::VerifyFailed(err) => {
                        warn!("Rejecting CommandEnvelope: verify_envelope Err={:?}", err);
                        return Ok(());
                    }
                }
            } else {
                // tenant_id unavailable (provisioning
                // incomplete) — envelope verify can't run
                // (Gate 5 tenant binding requires it). Fall
                // back to legacy parse unconditionally until
                // provisioning completes. This matches pre-
                // Batch-63 behavior for pre-provisioning
                // bootstrap commands.
                match serde_json::from_slice(&message.payload) {
                    Ok(cmd) => cmd,
                    Err(e) => {
                        warn!("Failed to parse command: {}", e);
                        return Ok(());
                    }
                }
            };

            info!(
                "Executing command: {} (id: {})",
                command.command, command.command_id
            );

            // IEC 62443 SL-2 FR-7: Command replay protection.
            // MQTT QoS 1 can re-deliver the same message. Reject:
            //   (1) Commands already seen (dedup by command_id)
            //   (2) Commands with stale timestamps (> max_command_age_secs)
            // Retained-flag rejection moved UP to pre-parse per
            // Batch 25 D-14.
            //
            // Batch 34: replay-window + skew-tolerance are NOW
            // config-driven via config.runtime.max_command_age_secs
            // + max_command_skew_secs. Pre-Batch-34 both were
            // hardcoded (300s / 60s).
            let (max_age_secs, max_skew_secs) = {
                let state_guard = self.state.read().await;
                (
                    state_guard.config.runtime.max_command_age_secs as i64,
                    state_guard.config.runtime.max_command_skew_secs as i64,
                )
            };
            // SEC-HIGH-057 (№2): unparseable timestamp previously SILENTLY
            // SKIPPED the replay age check — hard-fail instead.
            match chrono::DateTime::parse_from_rfc3339(&command.timestamp) {
                Ok(cmd_time) => {
                    let age = chrono::Utc::now().signed_duration_since(cmd_time);
                    if age.num_seconds() > max_age_secs || age.num_seconds() < -max_skew_secs {
                        warn!(
                            "Rejecting stale/future command: {} age={}s (id: {}, max_age={}s, max_skew={}s)",
                            command.command,
                            age.num_seconds(),
                            command.command_id,
                            max_age_secs,
                            max_skew_secs
                        );
                        return Ok(());
                    }
                }
                Err(_) => {
                    warn!(
                        "Rejecting command with unparseable timestamp '{}': replay window cannot be enforced (id: {})",
                        command.timestamp, command.command_id
                    );
                    return Ok(());
                }
            }
            // Batch 60 Sprint 6.4 foundation: command_id dedup
            // UPGRADED to use MokaJtiDedupTable when available
            // (signature_mode != Disabled). Legacy path (the
            // in-memory VecDeque) continues to work when Moka
            // is not allocated (Disabled mode + HC-1 backward
            // compat).
            //
            // ARCHITECTURAL UPGRADE (not patch):
            // - Pre-Batch-60 the VecDeque<String> was the SOLE
            //   dedup mechanism, O(n) contains + FIFO eviction
            //   at 1000 entries, no TTL.
            // - Post-Batch-60 when Moka is active: O(1) lookup,
            //   config-tunable capacity (default 100k), TTL-
            //   bounded (default 60s), metric-visible via
            //   live_entry_count(). VecDeque is bypassed.
            // - When Moka is not active (Disabled mode): falls
            //   through to the VecDeque — no behavior change.
            //
            // The command_id value IS semantically a jti — a
            // per-command unique identifier used for replay
            // detection. Reusing the existing field avoids a
            // wire-format change (pre-Batch-60 senders already
            // mint unique command_ids).
            let is_duplicate = if let Some(ref dedup) = {
                let state = self.state.read().await;
                state.jti_dedup_table.clone()
            } {
                // Moka path — config-driven capacity + TTL.
                // Construct a Jti from command_id; expires_at
                // is "now + moka_ttl" derived from the dedup
                // table's own bounds, approximated via a
                // generous 3600s ceiling (Moka's internal TTL
                // evicts earlier).
                match crate::command_envelope::Jti::try_new(command.command_id.clone()) {
                    Ok(jti) => {
                        let expires_at =
                            std::time::SystemTime::now() + std::time::Duration::from_secs(3600);
                        match dedup.check_and_mark(&jti, expires_at).await {
                            Ok(crate::command_envelope::DedupResult::Fresh) => false,
                            Ok(crate::command_envelope::DedupResult::Duplicate) => true,
                            Err(e) => {
                                warn!(
                                    "JTI dedup check failed (treating as duplicate fail-closed): {:?}",
                                    e
                                );
                                true
                            }
                        }
                    }
                    Err(e) => {
                        // command_id doesn't meet jti bounds
                        // (empty / too long / non-ASCII). Fall
                        // back to VecDeque path — Moka rejects
                        // ill-formed jti, legacy path still
                        // accepts anything.
                        warn!(
                            "command_id rejected as jti ({:?}); falling back to VecDeque dedup",
                            e
                        );
                        self.executed_command_ids.contains(&command.command_id)
                    }
                }
            } else {
                // Legacy path — VecDeque FIFO dedup.
                self.executed_command_ids.contains(&command.command_id)
            };

            if is_duplicate {
                warn!(
                    "Rejecting duplicate command: {} (id: {})",
                    command.command, command.command_id
                );
                return Ok(());
            }

            // Execute command
            let response = self.execute_command(&command).await;

            // Track executed command ID for dedup (VecDeque
            // bounded set, evicts oldest). Still maintained
            // even when Moka is active so the legacy-fallback
            // path (for ill-formed command_ids that Moka
            // rejects) has recent history.
            if self.executed_command_ids.len() >= 1000 {
                self.executed_command_ids.pop_front();
            }
            self.executed_command_ids
                .push_back(command.command_id.clone());

            // Publish response — Batch #255 ARC-002 migration:
            // command responses persist on broker outage + replay
            // on reconnect at High priority (cloud requests
            // correlate via command_id; loss breaks the
            // request-response loop until the cloud-side timeout
            // fires retry).
            let state = self.state.read().await;
            crate::publish_helpers::publish_response(&state, &response).await;
        } else if message.topic == topics.config {
            debug!("Received config update");
            // Batch 25+31 plan D-14: retained-message rejection
            // for config updates. Routed through the canonical
            // `runtime_safety::retained_msg` predicate. Same
            // replay-attack vector as command topic — retained
            // config would re-apply on every reconnect.
            let config_topic = topics.config.clone();
            let rejection = crate::runtime_safety::retained_msg::is_retained_command_rejected(
                message.retain,
                &message.topic,
                |t| t == config_topic,
            );
            if !matches!(
                rejection,
                crate::runtime_safety::retained_msg::RetainedMsgRejectionReason::NotRejected
            ) {
                warn!(
                    "Rejecting retained MQTT config-update: reason={}, topic='{}', {} bytes. \
                     Broker-replay poisoning vector.",
                    rejection,
                    message.topic,
                    message.payload.len()
                );
                return Ok(());
            }
            self.handle_config_update(&message.payload).await?;
        }

        Ok(())
    }
}
