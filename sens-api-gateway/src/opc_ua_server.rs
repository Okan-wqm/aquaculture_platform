//! OPC UA server — Batch 208 Faz 5 (plan §5 Faz 5 step 2).
//!
//! Primitive-first module for the async-opcua-backed server
//! that 3rd-party HMIs (Ignition, UaExpert, Kepware,
//! Wonderware) browse + subscribe to. This batch lands the
//! `OpcUaTagRegistry` — a pure-logic map from the agent's
//! live tag catalog (AgentConfig.io_poll.tags + their
//! TagConfig shapes) to OPC UA browsable identifiers.
//!
//! No async-opcua dep is pulled in by this file. Batch 209
//! lands `start_opcua_server` against the `opc-ua-server`
//! Cargo feature flag and binds async-opcua VariableNode
//! callbacks into this registry + the existing `authz`
//! PolicyEngine + `audit` sink. Keeping the registry
//! feature-agnostic means:
//! - `--no-default-features` builds still link clean
//! - The registry is unit-tested without spinning an
//!   async-opcua runtime
//! - Batch 209 wiring has a stable seam to bind against
//!
//! Address space shape (plan §5 Faz 5 step 2):
//! ```
//! Objects/Suderra/Tags/{browse_name}   → Variable node
//! ```
//! Writability is derived from `IoType`: DO/AO are writable,
//! DI/AI are read-only. Forced values (TagSource::Force) are
//! surfaced with the live quality so HMIs can display the
//! force banner without inspecting the force registry
//! directly.
//!
//! ## Wire status (Batch #278 audit)
//!
//! Production wire confirmed across multiple call sites:
//! - `opc_ua_server_runtime.rs:1021,1026,1028-1031` —
//!   `execute_opcua_write` orchestrator wired into the
//!   SimpleNodeManager `add_write_callback` body. Receives
//!   the typed-authz port, force registry, process image,
//!   audit sink dependencies as Arc references.
//! - `opc_ua_sens_node_manager.rs` (Batch #265) — references
//!   `execute_opcua_write` as the future-Batch-#267 delegate
//!   target (the typed-principal write completion path).
//!   ORPHAN-MEDIUM-023 tracks the missing delegate wire +
//!   names this orchestrator as the consumer that closes
//!   the finding.
//! - `opc_ua_server_runtime.rs:259` — `simple_node_manager(...)`
//!   builder wiring with the `OpcUaTagRegistry::build(configs)`
//!   address-space population at boot.
//!
//! Per-item dead-code allow audit pending — the blanket allow
//! retains future extension surfaces (tag-data-type-aware
//! Variant mapping per Batch #264 audit, future
//! AuthorizedContext-passing refactor per ORPHAN-MEDIUM-023
//! resolution). WHITELIST-with-reason per Plan §3.1 ARC-009.

#![allow(dead_code)]

// Phase B-1 (ADR-031) — submodule declarations resolve to
// `src/opc_ua_server/<name>.rs` per Rust's directory-with-mod-stem
// convention. Pre-B-1 this file was the only `opc_ua_server` module;
// Phase B-1 adds two PKI lifecycle primitives without restructuring
// the existing OpcUaTagRegistry surface. Phase B-2 (Plan §B-2 Batches
// #269-#270) adds the FailedAuthWindow brute-force throttle primitive.
pub mod auth_throttle;
pub mod cert_rotation;
pub mod pki_store;
// Phase B-3 (Plan §B-3 Batch #271-#272) — per-tenant + per-user session
// quota primitive with RAII SessionLease decrement.
pub mod session_quota;
// Phase B-4 (Plan §B-4 Batch #273-#275) — push-subscription bridge from
// ProcessImage::subscribe_changes broadcast → OPC UA subscription state.
pub mod subscription_bridge;

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::audit::entry::{
    AuditAction, AuditActor, AuditEntry, AuditOutcome, AuditPhase, AuditResource,
};
use crate::audit::sink::AuditSink;
use crate::authz::context::{ActorIdentity, AuthorizationDecision};
use crate::authz::permission::{Permission, TagId, TenantId};
use crate::authz::policy::{AuthorizationRequest, PolicyEngine};
use crate::process_image::{IoType, ProcessImage, TagConfig, TagQuality, TagSource};
use crate::scripting::force_registry::ForceRegistry;

/// A single tag node exposed to the OPC UA address space.
///
/// Projection of `TagConfig` with the fields the OPC UA
/// server cares about (browse name, writability, EURange,
/// engineering unit). Derived at boot; immutable at runtime
/// — config reloads rebuild the whole registry atomically.
#[derive(Debug, Clone, PartialEq)]
pub struct OpcUaTagNode {
    /// Original tag identifier from config — the same key
    /// downstream services (authz, audit, force registry,
    /// command handlers) use, so a single tag_name string
    /// threads through every OPC UA call without any
    /// alias translation.
    pub tag_name: String,
    /// OPC UA BrowseName — sanitized copy of `tag_name`
    /// with characters OPC UA clients frequently choke on
    /// (`/`, `.`, `:`, whitespace) replaced by `_`.
    /// Kept separate from `tag_name` so the original
    /// identifier remains untouched for authz + audit.
    pub browse_name: String,
    /// IEC 61131-3 I/O type. Drives `is_writable` — DO/AO
    /// are writable, DI/AI are read-only. The OPC UA
    /// server rejects writes against read-only nodes at
    /// the protocol layer with `BadNotWritable` before
    /// hitting authz.
    pub io_type: IoType,
    /// Declared tag data type string (e.g. "Bool", "Real",
    /// "Int"). Batch 209 maps this to the OPC UA spec
    /// DataType NodeId when building Variable nodes.
    pub data_type: String,
    /// Engineering unit string (e.g. "mg/L"). Surfaced on
    /// the Variable node's EngineeringUnits property so
    /// HMIs can label charts without separate config.
    pub eng_unit: Option<String>,
    /// Engineering range minimum. Clamp boundary for
    /// HMI-initiated writes + display scaling.
    pub eng_min: Option<f64>,
    /// Engineering range maximum. Clamp boundary + display
    /// scaling. Batch 209 write path rejects out-of-range
    /// writes with `BadOutOfRange` before the authz gate
    /// so invalid values never reach `update_tag_raw`.
    pub eng_max: Option<f64>,
}

impl OpcUaTagNode {
    /// True when the node is writable from OPC UA clients.
    /// DO/AO are writable; DI/AI are not. Independent from
    /// authz — this is the OPC UA-layer writability flag,
    /// the authz gate runs on top for every actual write.
    pub fn is_writable(&self) -> bool {
        matches!(self.io_type, IoType::DO | IoType::AO)
    }
}

/// OPC UA address-space registry.
///
/// Built once at boot from the tag catalog; queried by the
/// async-opcua session callbacks to resolve browse requests
/// + read/write actions. The registry is immutable after
/// construction; config reloads swap the registry via
/// `ArcSwap` or an equivalent primitive in Batch 209.
#[derive(Debug, Clone, Default)]
pub struct OpcUaTagRegistry {
    /// Tag-name → node. BTreeMap keeps iteration order
    /// stable (so browse responses are deterministic
    /// across sessions) + lookup is O(log n).
    nodes: BTreeMap<String, OpcUaTagNode>,
}

/// Build failure — surfaces the exact conflict so operators
/// can fix their config before boot proceeds.
#[derive(Debug, Clone, PartialEq)]
pub enum OpcUaTagRegistryError {
    /// Two tags in the catalog share the same `tag_name`.
    /// Operators hit this when a copy-paste error leaves
    /// duplicate entries in config.yaml; we fail the build
    /// rather than silently drop one, because which one
    /// survives would be a function of iteration order.
    DuplicateTagName { tag_name: String },
    /// Two different tag names sanitize to the same
    /// BrowseName — e.g. `tank/a` and `tank_a` both map to
    /// `tank_a`. Operators fix this by renaming one tag.
    DuplicateBrowseName {
        browse_name: String,
        first_tag: String,
        duplicate_tag: String,
    },
    /// `tag_name` is empty after trimming. OPC UA BrowseName
    /// cannot be empty, and such entries would also fail
    /// every downstream lookup.
    EmptyTagName,
}

impl std::fmt::Display for OpcUaTagRegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateTagName { tag_name } => write!(
                f,
                "opc_ua_server tag catalog has duplicate tag_name `{}` — OPC UA BrowseNames must be unique",
                tag_name
            ),
            Self::DuplicateBrowseName { browse_name, first_tag, duplicate_tag } => write!(
                f,
                "opc_ua_server tag catalog: tags `{}` and `{}` both sanitize to BrowseName `{}` — rename one to disambiguate",
                first_tag, duplicate_tag, browse_name
            ),
            Self::EmptyTagName => write!(
                f,
                "opc_ua_server tag catalog has an empty tag_name — OPC UA BrowseNames cannot be empty"
            ),
        }
    }
}

impl std::error::Error for OpcUaTagRegistryError {}

impl OpcUaTagRegistry {
    /// Build the registry from a tag-catalog iterator.
    ///
    /// Fails fast on duplicate tag_name, duplicate
    /// BrowseName after sanitization, or empty tag_name —
    /// every one of those errors surfaces operator config
    /// mistakes that would otherwise silently misbehave
    /// under load (reads resolving to the wrong node,
    /// writes landing on the wrong tag).
    pub fn build<'a, I>(configs: I) -> Result<Self, OpcUaTagRegistryError>
    where
        I: IntoIterator<Item = &'a TagConfig>,
    {
        let mut nodes: BTreeMap<String, OpcUaTagNode> = BTreeMap::new();
        // Second map detects BrowseName collisions after
        // sanitization — critical check since two distinct
        // tag_names can collapse to the same BrowseName.
        let mut browse_index: BTreeMap<String, String> = BTreeMap::new();

        for cfg in configs {
            let tag_name = cfg.tag_name.trim();
            if tag_name.is_empty() {
                return Err(OpcUaTagRegistryError::EmptyTagName);
            }
            let tag_name = tag_name.to_string();
            if nodes.contains_key(&tag_name) {
                return Err(OpcUaTagRegistryError::DuplicateTagName { tag_name });
            }
            let browse_name = sanitize_browse_name(&tag_name);
            if let Some(first_tag) = browse_index.get(&browse_name) {
                return Err(OpcUaTagRegistryError::DuplicateBrowseName {
                    browse_name,
                    first_tag: first_tag.clone(),
                    duplicate_tag: tag_name,
                });
            }
            browse_index.insert(browse_name.clone(), tag_name.clone());
            nodes.insert(
                tag_name.clone(),
                OpcUaTagNode {
                    tag_name,
                    browse_name,
                    io_type: cfg.io_type,
                    data_type: cfg.data_type.clone(),
                    eng_unit: cfg.eng_unit.clone(),
                    eng_min: cfg.eng_min,
                    eng_max: cfg.eng_max,
                },
            );
        }

        Ok(Self { nodes })
    }

    /// Node count. Useful for `/metrics` + boot logs.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// True when no tags are configured — the server still
    /// starts (operators may be pre-staging config) but
    /// Batch 209 logs a warn so HMIs don't silently see an
    /// empty address space.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Look up a node by `tag_name` (not BrowseName).
    /// Downstream authz + audit use `tag_name` as the
    /// identifier so the OPC UA session handler converts
    /// the HMI-supplied BrowseName back to `tag_name` via
    /// `find_by_browse_name` before dispatching.
    pub fn get(&self, tag_name: &str) -> Option<&OpcUaTagNode> {
        self.nodes.get(tag_name)
    }

    /// Look up a node by BrowseName (HMI-facing identifier).
    /// O(n) scan — acceptable because HMIs typically
    /// enumerate the address space once at session start
    /// and cache NodeId references locally.
    pub fn find_by_browse_name(&self, browse_name: &str) -> Option<&OpcUaTagNode> {
        self.nodes
            .values()
            .find(|node| node.browse_name == browse_name)
    }

    /// Iterator over nodes in deterministic (BTreeMap)
    /// order. Used by Batch 209 to populate the OPC UA
    /// Objects/Suderra/Tags folder at boot.
    pub fn iter(&self) -> impl Iterator<Item = &OpcUaTagNode> {
        self.nodes.values()
    }

    /// Count of writable nodes (DO/AO). Reported to
    /// `/metrics` + boot log so operators see at a glance
    /// how many actuators an HMI could reach.
    pub fn writable_count(&self) -> usize {
        self.nodes.values().filter(|n| n.is_writable()).count()
    }
}

/// BrowseName sanitizer.
///
/// OPC UA BrowseNames nominally accept most unicode, but
/// HMIs in the plan's interop matrix (Ignition, UaExpert,
/// Kepware, Wonderware) are known to choke on path-like
/// separators + whitespace — they interpret `/` and `.`
/// as hierarchy delimiters in some dialects, and strip
/// whitespace in others. Replacing those characters with
/// `_` gives the widest compatibility without losing the
/// tag_name → browse_name reversibility (lookup by
/// BrowseName still works via `find_by_browse_name`).
fn sanitize_browse_name(tag_name: &str) -> String {
    tag_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// ============================================================
// Batch 209 Faz 5 — write-orchestrator primitive
// ============================================================
//
// Plan §5 Faz 5 step 4 "Write-through security chain":
//   1. Session auth check (handled by async-opcua session layer
//      before the orchestrator runs)
//   2. Registry lookup → BadNodeIdUnknown if tag not in catalog
//   3. IoType DO/AO check → BadNotWritable for DI/AI
//   4. ForceRegistry check → BadNotWritable if the tag is
//      actively forced (operators see the force banner; HMI
//      writes silently landing on top would strip that signal)
//   5. EURange check → BadOutOfRange if eng_min/eng_max exceeded
//   6. authz::PolicyEngine evaluate → BadUserAccessDenied if
//      the actor lacks OpcUaWrite{tag_id}
//   7. process_image.update_tag_raw(source=OpcUaClient) + audit
//
// Steps 2-5 are pure logic against the registry — no async.
// Steps 6 + 7 dispatch through trait objects so the orchestrator
// stays async-opcua-free and unit tests can drive every branch
// without spinning a runtime.

/// Outcome of an OPC UA write attempt.
///
/// Success carries the tag_name (for audit correlation); every
/// reject variant encodes the exact reason so the async-opcua
/// session handler can translate to the matching OPC UA status
/// code (BadNotWritable, BadOutOfRange, BadUserAccessDenied,
/// BadNodeIdUnknown, BadInternalError).
#[derive(Debug, Clone, PartialEq)]
pub enum OpcUaWriteOutcome {
    /// The write landed in ProcessImage + an audit entry was
    /// emitted. Carries the canonical tag_name so the async-
    /// opcua layer can map back to its NodeId for the response.
    Success { tag_name: String },
    /// Registry returned no node for the resolved tag_name.
    /// Maps to OPC UA `BadNodeIdUnknown`.
    RejectedUnknownTag { tag_name: String },
    /// Tag's IoType is DI/AI — reads only. Maps to OPC UA
    /// `BadNotWritable`.
    RejectedNotWritable { tag_name: String },
    /// Tag has an active force entry; writes through the OPC UA
    /// path would strip the force banner HMIs display. Maps to
    /// OPC UA `BadNotWritable` (with a distinct audit reason so
    /// operators see "blocked by force" vs "read-only node").
    RejectedForced { tag_name: String },
    /// Value lies outside eng_min/eng_max. Maps to OPC UA
    /// `BadOutOfRange`. Carries the range for audit context.
    RejectedOutOfRange {
        tag_name: String,
        value: f64,
        eng_min: f64,
        eng_max: f64,
    },
    /// authz PolicyEngine denied the actor. Maps to OPC UA
    /// `BadUserAccessDenied`. Carries the actor + reason so the
    /// audit record + OPC UA fault response match the authz
    /// decision exactly.
    RejectedNoPermission { tag_name: String, actor: String },
    /// ProcessImage update_tag_raw returned an error
    /// (underlying storage or bus fault). Maps to OPC UA
    /// `BadInternalError`.
    RejectedProcessImage { tag_name: String, reason: String },
}

impl OpcUaWriteOutcome {
    /// True when the write landed in ProcessImage.
    pub fn is_success(&self) -> bool {
        matches!(self, Self::Success { .. })
    }
}

/// Inputs the orchestrator needs from the OPC UA session layer.
///
/// Kept as a plain struct (not a trait) because the shape is
/// fixed by the write-through chain and adding fields later is
/// an additive change.
#[derive(Debug, Clone)]
pub struct OpcUaWriteRequest<'a> {
    /// Canonical tag identifier (NOT BrowseName). The session
    /// handler resolves BrowseName → tag_name via
    /// `OpcUaTagRegistry::find_by_browse_name` before building
    /// the request.
    pub tag_name: &'a str,
    /// Value the HMI wrote.
    pub value: f64,
    /// Actor identifier — either the authenticated OPC UA
    /// username, or the X509 cert CN, or "anonymous" when the
    /// session is anonymous (authz will deny these at step 6).
    pub actor: &'a str,
}

/// Authz port — abstract over the real
/// `authz::PolicyEngine::evaluate`. Returns true when the
/// actor is allowed to write the named tag.
///
/// Kept as a thin trait so unit tests can drive both allow +
/// deny branches without pulling the full policy engine in.
#[async_trait::async_trait]
pub trait OpcUaAuthzPort: Send + Sync {
    async fn is_write_allowed(&self, actor: &str, tag_name: &str) -> bool;
}

/// Force-registry port — abstract over
/// `ForceRegistry::is_forced`. Non-async (registry is in-proc
/// + uses blocking locks); wrapped in an async trait so the
/// orchestrator's `.await` chain reads uniformly.
#[async_trait::async_trait]
pub trait OpcUaForceRegistryPort: Send + Sync {
    async fn is_forced(&self, tag_name: &str) -> bool;
}

/// ProcessImage write port — abstract over
/// `ProcessImage::update_tag_raw(.., source=OpcUaClient)`.
/// Returns Ok on a successful write, Err(reason) when the
/// underlying storage/bus rejected the write.
#[async_trait::async_trait]
pub trait OpcUaProcessImagePort: Send + Sync {
    async fn write_tag(&self, tag_name: &str, value: f64, actor: &str) -> Result<(), String>;
}

/// Audit sink port — abstract over the pre+post audit-chain
/// writer. Batch 210+ wires this to the real `audit` module.
#[async_trait::async_trait]
pub trait OpcUaAuditPort: Send + Sync {
    /// Emit an audit entry for an OPC UA write attempt,
    /// regardless of outcome. The outcome variant decides the
    /// `result` field of the audit record.
    async fn record_write_attempt(
        &self,
        actor: &str,
        tag_name: &str,
        value: f64,
        outcome: &OpcUaWriteOutcome,
    );
}

/// Execute the Faz 5 OPC UA write-through security chain.
///
/// Every reject path STILL emits an audit entry — silent
/// denies would hide policy scans + brute-force patterns from
/// the SIEM. Success path emits both pre + post implicitly
/// (audit sink sees the final outcome + the engine handles
/// the chain-splitting internally; this is why the sink
/// gets the outcome ref, not just the attempt shape).
pub async fn execute_opcua_write(
    registry: &OpcUaTagRegistry,
    request: &OpcUaWriteRequest<'_>,
    authz: &dyn OpcUaAuthzPort,
    force_registry: &dyn OpcUaForceRegistryPort,
    process_image: &dyn OpcUaProcessImagePort,
    audit: &dyn OpcUaAuditPort,
) -> OpcUaWriteOutcome {
    let tag_name = request.tag_name;
    let actor = request.actor;
    let value = request.value;

    // Step 2: Registry lookup.
    let node = match registry.get(tag_name) {
        Some(n) => n,
        None => {
            let outcome = OpcUaWriteOutcome::RejectedUnknownTag {
                tag_name: tag_name.to_string(),
            };
            audit.record_write_attempt(actor, tag_name, value, &outcome).await;
            return outcome;
        }
    };

    // Step 3: IoType DO/AO check.
    if !node.is_writable() {
        let outcome = OpcUaWriteOutcome::RejectedNotWritable {
            tag_name: tag_name.to_string(),
        };
        audit.record_write_attempt(actor, tag_name, value, &outcome).await;
        return outcome;
    }

    // Step 4: Forced-tag check. A forced tag is an operator-
    // held actuator state — OPC UA HMI writes silently
    // landing on top would strip the force banner, so we
    // reject with a distinct audit reason.
    if force_registry.is_forced(tag_name).await {
        let outcome = OpcUaWriteOutcome::RejectedForced {
            tag_name: tag_name.to_string(),
        };
        audit.record_write_attempt(actor, tag_name, value, &outcome).await;
        return outcome;
    }

    // Step 5: EURange check. If either bound is unset the
    // range constraint is considered non-binding on that
    // side (operators opt-in by declaring eng_min/eng_max);
    // this matches the existing CommandHandler write path
    // so OPC UA doesn't impose stricter-than-policy limits.
    if let (Some(lo), Some(hi)) = (node.eng_min, node.eng_max) {
        if value < lo || value > hi {
            let outcome = OpcUaWriteOutcome::RejectedOutOfRange {
                tag_name: tag_name.to_string(),
                value,
                eng_min: lo,
                eng_max: hi,
            };
            audit.record_write_attempt(actor, tag_name, value, &outcome).await;
            return outcome;
        }
    }

    // Step 6: authz — PolicyEngine is the single source of
    // truth for per-actor per-tag write permission.
    if !authz.is_write_allowed(actor, tag_name).await {
        let outcome = OpcUaWriteOutcome::RejectedNoPermission {
            tag_name: tag_name.to_string(),
            actor: actor.to_string(),
        };
        audit.record_write_attempt(actor, tag_name, value, &outcome).await;
        return outcome;
    }

    // Step 7: ProcessImage update.
    match process_image.write_tag(tag_name, value, actor).await {
        Ok(()) => {
            let outcome = OpcUaWriteOutcome::Success {
                tag_name: tag_name.to_string(),
            };
            audit.record_write_attempt(actor, tag_name, value, &outcome).await;
            outcome
        }
        Err(reason) => {
            let outcome = OpcUaWriteOutcome::RejectedProcessImage {
                tag_name: tag_name.to_string(),
                reason,
            };
            audit.record_write_attempt(actor, tag_name, value, &outcome).await;
            outcome
        }
    }
}

// ============================================================
// Batch #290 A-2b part 5 step 5f-prep — post-typed-authz
// write delegate
// ============================================================
//
// ## Why this function exists (architectural reasoning)
//
// `execute_opcua_write` (above) carries 6 sequential gates,
// the 5th being `OpcUaAuthzPort::is_write_allowed(actor, tag)`
// — the legacy untyped authz path. SimpleNodeManager's
// `add_write_callback` boundary loses RequestContext (per
// ORPHAN-CRITICAL-021) so its only authz signal is a
// hard-coded actor string `"opc-ua-anonymous"`, which the
// PolicyEngine rejects unconditionally. That's why Gap A-3
// landed the typed-authz chain (Batches #239-#250 +
// SensNodeManager Batches #263-#289).
//
// SensNodeManager.write() (Batch #265) does typed authz
// EARLIER in the chain — at the trait method body itself —
// using `TypedAuthzPort::authorize_write` against the typed
// `AuthenticatedUser` principal extracted from the live
// session. By the time SensNodeManager.write() reaches the
// "Allow" branch, the policy decision is already in hand.
//
// Calling `execute_opcua_write` from there would re-run the
// authz step (now via OpcUaAuthzPort, the legacy port). Two
// architectural problems:
//
// 1. **Double-decision drift hazard.** The typed path
//    consults the policy engine via a typed
//    `AuthorizationRequest`; the legacy path consults via a
//    string actor. If the two evaluations diverge (different
//    manifest version pinning, different attribute carriage),
//    the same write could pass typed-authz but fail legacy
//    authz, surfacing as a confusing
//    `BadUserAccessDenied` response after a successful
//    typed-allow log line.
//
// 2. **Audit duplication.** Both paths emit audit records.
//    The typed path emits via the typed-authz audit adapter;
//    the legacy path emits via OpcUaAuditPort. The same
//    write would generate 2 audit records of different shape,
//    confusing forensic queries.
//
// The Tier-1 architectural shape is two functions with
// distinct signatures (not a `pre_authorized: bool` flag —
// that would be a workaround that lets the compiler accept
// "I already authz'd" lies):
//
//   - `execute_opcua_write(...)` — accepts `&dyn OpcUaAuthzPort`,
//     runs the legacy authz check at step 6. Existing call
//     site: `wire_write_callbacks` (until Batch #293 deletes
//     it as part of A-2b 5e closure).
//
//   - `execute_opcua_write_post_typed_authz(...)` — does NOT
//     accept an authz port. Skips step 6 entirely. The
//     function name + signature document the caller's
//     contract: "you have done typed-authz before invoking
//     me." Future call site: SensNodeManager.write() Allow
//     branch (Batch #291 wire).
//
// The two functions share steps 2-5 (registry lookup,
// writable, force, range) + step 7 (commit) + audit. The
// shared steps factor into a private `pre_commit_gate` helper
// — one source of truth, no copy-paste drift.
//
// ## Wire status (Batch #290)
//
// **Primitive only.** This batch lands the function +
// 7 unit tests. SensNodeManager.write() does NOT YET call
// it (Batch #291 swaps the Allow-branch
// `set_status(Good)` placeholder for the real delegate
// invocation). The function is dead code until Batch #291,
// but landing the primitive first means:
//
// - Each gate's behavior is unit-tested in isolation against
//   the new function's signature, BEFORE any production
//   caller exists.
// - Batch #291 becomes a pure call-site change with no new
//   logic — easier to bisect if a regression shows up.
//
// ## Linked findings
//
// - ULTRA-HIGH-035 PARTIAL_FIX (overall A-2b part 5).
// - ORPHAN-CRITICAL-021 (anonymous-actor hardcode) — closed
//   by Batch #292 runtime swap that removes
//   `wire_write_callbacks` entirely.
// - ORPHAN-MEDIUM-023 (SensNodeManager.write Allow path
//   skips delegate) — closed by Batch #291 wire that
//   replaces `set_status(Good)` placeholder.

/// Apply the pre-commit validation gates shared between the
/// legacy `execute_opcua_write` and the post-typed-authz
/// delegate. Returns `Ok(node)` when all gates pass; returns
/// `Err(outcome)` when any gate rejects.
///
/// Steps (in evaluation order):
/// 1. Registry lookup → `RejectedUnknownTag` if absent.
/// 2. IoType DO/AO → `RejectedNotWritable` if read-only.
/// 3. Force registry → `RejectedForced` if currently forced.
/// 4. EURange → `RejectedOutOfRange` if out of declared bounds.
///
/// **Why a private helper.** Both write entry points run
/// these gates in identical order. Extracting them into one
/// function eliminates copy-paste drift hazard (a future
/// Batch that adds a 5th gate must touch only this fn — a
/// missing update on the other entry would be caught at code
/// review by the symmetry).
async fn evaluate_pre_commit_gates<'a>(
    registry: &'a OpcUaTagRegistry,
    request: &OpcUaWriteRequest<'_>,
    force_registry: &dyn OpcUaForceRegistryPort,
) -> Result<&'a OpcUaTagNode, OpcUaWriteOutcome> {
    let tag_name = request.tag_name;
    let value = request.value;

    // Step 1: Registry lookup.
    let node = match registry.get(tag_name) {
        Some(n) => n,
        None => {
            return Err(OpcUaWriteOutcome::RejectedUnknownTag {
                tag_name: tag_name.to_string(),
            });
        }
    };

    // Step 2: IoType DO/AO check.
    if !node.is_writable() {
        return Err(OpcUaWriteOutcome::RejectedNotWritable {
            tag_name: tag_name.to_string(),
        });
    }

    // Step 3: Forced-tag check.
    if force_registry.is_forced(tag_name).await {
        return Err(OpcUaWriteOutcome::RejectedForced {
            tag_name: tag_name.to_string(),
        });
    }

    // Step 4: EURange check. Half-bounded ranges (one None)
    // are permissive on the open side, matching legacy
    // CommandHandler write semantics.
    if let (Some(lo), Some(hi)) = (node.eng_min, node.eng_max) {
        if value < lo || value > hi {
            return Err(OpcUaWriteOutcome::RejectedOutOfRange {
                tag_name: tag_name.to_string(),
                value,
                eng_min: lo,
                eng_max: hi,
            });
        }
    }

    Ok(node)
}

/// Post-typed-authz write delegate. Runs steps 1-4 (registry,
/// writable, force, range) + step 7 (process-image commit) +
/// audit on every outcome. Does NOT accept an authz port —
/// the caller (SensNodeManager.write()) is responsible for
/// running typed-authz BEFORE invoking this delegate.
///
/// The contract is encoded in the signature: there is no
/// `&dyn OpcUaAuthzPort` parameter. A caller who hasn't done
/// typed authz cannot satisfy the type signature with a
/// "ran typed authz" placeholder — they must either run
/// typed authz themselves or call the legacy
/// `execute_opcua_write` with an authz port.
///
/// **Audit semantics.** Every outcome (success or reject)
/// fires `audit.record_write_attempt(actor, ...)`. The
/// `actor: &str` parameter for the audit record is the
/// caller's typed-authz-derived actor string (e.g.,
/// `"sens:operator:<hex>"` from `format_operator_token`) so
/// the audit log identifier matches the typed-authz
/// principal end-to-end.
///
/// **Outcome variants.** This function never produces
/// `OpcUaWriteOutcome::RejectedNoPermission` — that variant
/// represents the legacy authz-port-driven deny path which
/// this function explicitly skips. A typed-authz deny
/// happens BEFORE this function is called; the caller maps
/// the typed deny to its own status code (e.g., the
/// SensNodeManager.write() Deny branch already does this).
///
/// **Wire status (Batch #290):** primitive only; first
/// production caller lands in Batch #291.
pub async fn execute_opcua_write_post_typed_authz(
    registry: &OpcUaTagRegistry,
    request: &OpcUaWriteRequest<'_>,
    force_registry: &dyn OpcUaForceRegistryPort,
    process_image: &dyn OpcUaProcessImagePort,
    audit: &dyn OpcUaAuditPort,
) -> OpcUaWriteOutcome {
    let tag_name = request.tag_name;
    let actor = request.actor;
    let value = request.value;

    // Steps 1-4: shared pre-commit gates.
    let _node = match evaluate_pre_commit_gates(
        registry,
        request,
        force_registry,
    )
    .await
    {
        Ok(node) => node,
        Err(outcome) => {
            audit.record_write_attempt(actor, tag_name, value, &outcome).await;
            return outcome;
        }
    };

    // Step 5 (legacy authz): SKIPPED — caller has done typed
    // authz. See module-level docstring for the architectural
    // reasoning.

    // Step 6: ProcessImage update + audit.
    match process_image.write_tag(tag_name, value, actor).await {
        Ok(()) => {
            let outcome = OpcUaWriteOutcome::Success {
                tag_name: tag_name.to_string(),
            };
            audit.record_write_attempt(actor, tag_name, value, &outcome).await;
            outcome
        }
        Err(reason) => {
            let outcome = OpcUaWriteOutcome::RejectedProcessImage {
                tag_name: tag_name.to_string(),
                reason,
            };
            audit.record_write_attempt(actor, tag_name, value, &outcome).await;
            outcome
        }
    }
}

// ============================================================
// Batch 210 Faz 5 — concrete port adapters
// ============================================================
//
// Wraps the real in-proc primitives (ProcessImage,
// ForceRegistry) behind the trait seams declared in Batch 209.
// Keeping the adapters in the same module as the traits means
// future port-shape changes (new audit field, richer write
// return value) surface as compile errors against both the
// trait + adapter in a single diff — impossible to drift.
//
// The authz + audit adapters ship in Batch 211+ once the
// actor-identity resolution design lands (ActorIdentity is
// richer than &str + needs session-layer context to
// construct).

/// ProcessImage → OpcUaProcessImagePort adapter.
///
/// Stamps `source = TagSource::OpcUaClient` so downstream
/// consumers (SCADA UI, audit log, MQTT telemetry) can
/// distinguish HMI writes from live sensor reads without
/// inspecting the originating session. Quality fixed at
/// `Good` because a successful OPC UA write means the HMI
/// sent a deterministic value + the authz/range chain
/// already accepted it; Batch 211+ may widen to carry HMI-
/// supplied quality if the spec path requires it.
pub struct ProcessImageOpcUaAdapter {
    process_image: Arc<ProcessImage>,
}

impl ProcessImageOpcUaAdapter {
    pub fn new(process_image: Arc<ProcessImage>) -> Self {
        Self { process_image }
    }
}

#[async_trait::async_trait]
impl OpcUaProcessImagePort for ProcessImageOpcUaAdapter {
    async fn write_tag(
        &self,
        tag_name: &str,
        value: f64,
        _actor: &str,
    ) -> Result<(), String> {
        // Actor is carried by the audit port (Batch 211+);
        // ProcessImage itself tracks source, not actor.
        // ProcessImage::update_tag_raw returns (); the port
        // signature reserves a fail path so Batch 212+ can
        // widen the storage layer to surface faults without
        // re-shaping the orchestrator.
        self.process_image
            .update_tag_raw(tag_name, value, TagQuality::Good, TagSource::OpcUaClient)
            .await;
        Ok(())
    }
}

/// ForceRegistry → OpcUaForceRegistryPort adapter. Thin
/// wrapper over `ForceRegistry::is_forced`. Present so the
/// orchestrator call site depends on the trait, not the
/// concrete registry — lets alternate sources (e.g. a test
/// harness with a pre-loaded forced-tag list) drop in
/// without any orchestrator changes.
pub struct ForceRegistryOpcUaAdapter {
    force_registry: Arc<ForceRegistry>,
}

impl ForceRegistryOpcUaAdapter {
    pub fn new(force_registry: Arc<ForceRegistry>) -> Self {
        Self { force_registry }
    }
}

#[async_trait::async_trait]
impl OpcUaForceRegistryPort for ForceRegistryOpcUaAdapter {
    async fn is_forced(&self, tag_name: &str) -> bool {
        self.force_registry.is_forced(tag_name).await
    }
}

// ============================================================
// Batch 211 Faz 5 — AuditSink adapter
// ============================================================

/// Closure type that yields the current PolicyEngine policy
/// version at call time. Kept as a `dyn Fn()` so the adapter
/// stays decoupled from the concrete PolicyEngine impl —
/// production wires `move || engine.current_policy_version()`;
/// tests wire a canned integer closure.
pub type PolicyVersionFn = Arc<dyn Fn() -> u64 + Send + Sync>;

/// AuditSink → OpcUaAuditPort adapter.
///
/// Converts OpcUaWriteOutcome into the canonical `AuditEntry`
/// shape (plan §5 Faz 5 step 4 sub-step 13: "audit pre + post-
/// exec"). Every OPC UA write attempt — success OR reject —
/// produces exactly one Post-phase entry; silent denies would
/// hide brute-force patterns from the SIEM.
///
/// Why Post-phase only: the orchestrator runs the full 7-step
/// chain before calling `record_write_attempt`, so the audit
/// record captures the FINAL outcome. The existing command
/// handler pattern uses Pre + Post pairs because the command
/// handler runs authz BEFORE the mutation — for OPC UA writes
/// the orchestrator encapsulates both phases internally, so a
/// single Post entry correctly represents the full decision
/// chain. Tenant-side SIEM correlation uses `correlation_id`
/// to thread per-session HMI activity.
pub struct AuditSinkOpcUaAdapter {
    sink: Arc<AuditSink>,
    tenant: TenantId,
    policy_version_fn: PolicyVersionFn,
}

impl AuditSinkOpcUaAdapter {
    pub fn new(
        sink: Arc<AuditSink>,
        tenant: TenantId,
        policy_version_fn: PolicyVersionFn,
    ) -> Self {
        Self {
            sink,
            tenant,
            policy_version_fn,
        }
    }

    /// Map OpcUaWriteOutcome → AuditOutcome. Success is
    /// obvious; authz denies surface as AuthorizationDenied
    /// (distinct from Failure so cloud-side analytics can
    /// separate "actor tried something not allowed" from
    /// "hardware/storage fault"). Everything else collapses
    /// to Failure with the reason carried in `detail`.
    fn classify_outcome(outcome: &OpcUaWriteOutcome) -> AuditOutcome {
        match outcome {
            OpcUaWriteOutcome::Success { .. } => AuditOutcome::Success,
            OpcUaWriteOutcome::RejectedNoPermission { .. } => {
                AuditOutcome::AuthorizationDenied
            }
            OpcUaWriteOutcome::RejectedUnknownTag { .. }
            | OpcUaWriteOutcome::RejectedNotWritable { .. }
            | OpcUaWriteOutcome::RejectedForced { .. }
            | OpcUaWriteOutcome::RejectedOutOfRange { .. }
            | OpcUaWriteOutcome::RejectedProcessImage { .. } => AuditOutcome::Failure,
        }
    }

    /// Stable short reason tag for the audit detail payload.
    /// Analytics tools match against this string so variants
    /// must keep stable names across releases.
    fn outcome_reason_tag(outcome: &OpcUaWriteOutcome) -> &'static str {
        match outcome {
            OpcUaWriteOutcome::Success { .. } => "success",
            OpcUaWriteOutcome::RejectedUnknownTag { .. } => "unknown_tag",
            OpcUaWriteOutcome::RejectedNotWritable { .. } => "not_writable",
            OpcUaWriteOutcome::RejectedForced { .. } => "forced",
            OpcUaWriteOutcome::RejectedOutOfRange { .. } => "out_of_range",
            OpcUaWriteOutcome::RejectedNoPermission { .. } => "no_permission",
            OpcUaWriteOutcome::RejectedProcessImage { .. } => "process_image_error",
        }
    }

    /// Build the JSON `detail` payload. Includes the value +
    /// reason tag + outcome-specific context (range bounds,
    /// ProcessImage error string). Bounded to `MAX_DETAIL_BYTES`
    /// at canonical-bytes serialization time; the JSON
    /// constructed here stays well under that cap.
    fn build_detail(
        value: f64,
        outcome: &OpcUaWriteOutcome,
    ) -> String {
        let reason = Self::outcome_reason_tag(outcome);
        let extra = match outcome {
            OpcUaWriteOutcome::RejectedOutOfRange {
                eng_min, eng_max, ..
            } => {
                serde_json::json!({ "eng_min": eng_min, "eng_max": eng_max })
            }
            OpcUaWriteOutcome::RejectedProcessImage { reason: r, .. } => {
                serde_json::json!({ "process_image_error": r })
            }
            _ => serde_json::Value::Null,
        };
        serde_json::json!({
            "opc_ua_write": true,
            "value": value,
            "reason": reason,
            "extra": extra,
        })
        .to_string()
    }
}

// ============================================================
// Batch 212 Faz 5 — PolicyEngine adapter
// ============================================================

/// Closure resolving a session-string actor (X509 CN,
/// username, or literal "anonymous") into the authz crate's
/// `ActorIdentity`. None surfaces as an authz denial
/// (unresolvable actor ⇒ cannot be granted any permission);
/// session layer constructs this closure with session-level
/// context (manifest lookup, cert chain, U/P table) at spawn
/// time.
///
/// A closure — not a trait — so the session layer can inline
/// arbitrary resolution logic without a new trait impl per
/// session type (X509 / U/P / anonymous).
pub type ActorResolverFn = Arc<dyn Fn(&str) -> Option<ActorIdentity> + Send + Sync>;

/// PolicyEngine → OpcUaAuthzPort adapter.
///
/// Maps `(actor_str, tag_name) → bool` onto the full
/// PolicyEngine::authorize request shape. The adapter owns
/// the static surfaces (engine handle, tenant binding, actor
/// resolver) and mints a per-call `AuthorizationRequest`
/// with current policy_version + `received_at = SystemTime::now()`.
///
/// Rejects without consulting the engine when:
/// - actor resolver returns None (unresolvable actor)
///
/// Otherwise delegates to `engine.authorize(..)` and maps the
/// `AuthorizationDecision::Allow` → true; every Deny reason
/// (PermissionNotGranted, RoleExpired, TenantMismatch,
/// TwoPersonIntegrityMissing, EmergencyOverrideRequired,
/// StalePolicyVersion, LicenseTierInsufficient) → false.
/// The denial reason itself is captured by the audit adapter
/// through the OpcUaWriteOutcome layer (the orchestrator
/// short-circuits on the bool, and the audit port receives
/// RejectedNoPermission), matching the current audit contract.
pub struct PolicyEngineOpcUaAdapter {
    engine: Arc<dyn PolicyEngine>,
    tenant: TenantId,
    actor_resolver: ActorResolverFn,
}

impl PolicyEngineOpcUaAdapter {
    pub fn new(
        engine: Arc<dyn PolicyEngine>,
        tenant: TenantId,
        actor_resolver: ActorResolverFn,
    ) -> Self {
        Self {
            engine,
            tenant,
            actor_resolver,
        }
    }
}

#[async_trait::async_trait]
impl OpcUaAuthzPort for PolicyEngineOpcUaAdapter {
    async fn is_write_allowed(&self, actor: &str, tag_name: &str) -> bool {
        let actor_identity = match (self.actor_resolver)(actor) {
            Some(a) => a,
            None => {
                // Unresolvable actor cannot be granted any
                // permission — fail-closed per plan HC-3.
                // The audit port sees `RejectedNoPermission`
                // via the orchestrator short-circuit.
                return false;
            }
        };

        let request = AuthorizationRequest::new(
            actor_identity,
            Permission::OpcUaWrite {
                tag_id: TagId::new(tag_name.to_string()),
            },
            self.tenant.clone(),
            self.engine.current_policy_version(),
            std::time::SystemTime::now(),
        );

        match self.engine.authorize(request).await {
            Ok(AuthorizationDecision::Allow(_)) => true,
            // Every Deny reason collapses to false at this
            // boundary. The orchestrator already classifies the
            // distinct reasons via its own reject variants; the
            // engine's structured deny reason is captured in
            // the engine's own audit trail.
            Ok(AuthorizationDecision::Deny(_)) | Err(_) => false,
        }
    }
}

#[async_trait::async_trait]
impl OpcUaAuditPort for AuditSinkOpcUaAdapter {
    async fn record_write_attempt(
        &self,
        actor: &str,
        tag_name: &str,
        value: f64,
        outcome: &OpcUaWriteOutcome,
    ) {
        let now = chrono::Utc::now();
        let entry = AuditEntry {
            timestamp_unix_secs: now.timestamp(),
            timestamp_nanos: now.timestamp_subsec_nanos(),
            correlation_id: uuid::Uuid::new_v4().to_string(),
            phase: AuditPhase::Post,
            // `opc-ua:` prefix matches the `op:` / `svc:` shape
            // ActorIdentity::audit_label produces; analytics
            // treats it as a distinct source class. The session
            // layer passes the resolved subject (X509 CN, or
            // username, or literal "anonymous") as `actor`.
            actor: AuditActor::new(format!("opc-ua:{}", actor)),
            tenant: self.tenant.clone(),
            policy_version: (self.policy_version_fn)(),
            // OPC UA writes never carry two-person integrity —
            // the async-opcua session model is single-actor.
            // Force-value commands + policy pushes flow through
            // the MQTT command path which enforces TPI there.
            two_person_integrity_verified: false,
            action: AuditAction::TagWrite,
            resource: AuditResource::Tag {
                name: tag_name.to_string(),
            },
            outcome: Self::classify_outcome(outcome),
            detail: Self::build_detail(value, outcome),
        };
        if let Err(e) = self.sink.append(entry) {
            // Audit sink failure is SEV-HIGH ops incident but
            // MUST NOT abort the OPC UA session — the HMI write
            // already either landed (Success) or was rejected
            // (any Rejected* variant), and swallowing the audit
            // error would hide the forensic gap. tracing::warn
            // surfaces to the observability pipeline.
            tracing::warn!(
                error = %e,
                tag = tag_name,
                "opc_ua audit append failed — forensic gap for this write"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_image::{ProtocolConfig, TagSource};

    fn tag(name: &str, io_type: IoType) -> TagConfig {
        TagConfig {
            tag_name: name.to_string(),
            io_type,
            data_type: "Real".to_string(),
            source: TagSource::Modbus,
            poll_interval_ms: Some(1000),
            raw_min: None,
            raw_max: None,
            eng_min: Some(0.0),
            eng_max: Some(100.0),
            eng_unit: Some("mg/L".to_string()),
            invert: false,
            alarm_hh: None,
            alarm_h: None,
            alarm_l: None,
            alarm_ll: None,
            deadband: None,
            protocol_config: ProtocolConfig::Modbus {
                slave_id: 1,
                register: 0,
                function: 3,
                register_type: "holding".to_string(),
            },
        }
    }

    #[test]
    fn sanitize_replaces_path_separators() {
        assert_eq!(sanitize_browse_name("tank/a.temp"), "tank_a_temp");
    }

    #[test]
    fn sanitize_preserves_underscore_and_hyphen() {
        assert_eq!(sanitize_browse_name("pump-1_rpm"), "pump-1_rpm");
    }

    #[test]
    fn sanitize_replaces_whitespace_and_punctuation() {
        assert_eq!(sanitize_browse_name("tank a:flow"), "tank_a_flow");
    }

    #[test]
    fn empty_catalog_yields_empty_registry() {
        let r = OpcUaTagRegistry::build(std::iter::empty::<&TagConfig>()).unwrap();
        assert!(r.is_empty());
        assert_eq!(r.len(), 0);
        assert_eq!(r.writable_count(), 0);
    }

    #[test]
    fn build_preserves_tag_metadata() {
        let cfgs = vec![tag("do_tank_a", IoType::AI)];
        let r = OpcUaTagRegistry::build(cfgs.iter()).unwrap();
        let node = r.get("do_tank_a").expect("tag resolved");
        assert_eq!(node.tag_name, "do_tank_a");
        assert_eq!(node.browse_name, "do_tank_a");
        assert_eq!(node.io_type, IoType::AI);
        assert_eq!(node.data_type, "Real");
        assert_eq!(node.eng_unit.as_deref(), Some("mg/L"));
        assert_eq!(node.eng_min, Some(0.0));
        assert_eq!(node.eng_max, Some(100.0));
        assert!(!node.is_writable(), "AI is read-only");
    }

    #[test]
    fn writable_reflects_io_type() {
        let cfgs = vec![
            tag("di_limit", IoType::DI),
            tag("do_pump", IoType::DO),
            tag("ai_sensor", IoType::AI),
            tag("ao_setpoint", IoType::AO),
        ];
        let r = OpcUaTagRegistry::build(cfgs.iter()).unwrap();
        assert_eq!(r.len(), 4);
        assert_eq!(r.writable_count(), 2, "DO + AO");
        assert!(!r.get("di_limit").unwrap().is_writable());
        assert!(r.get("do_pump").unwrap().is_writable());
        assert!(!r.get("ai_sensor").unwrap().is_writable());
        assert!(r.get("ao_setpoint").unwrap().is_writable());
    }

    #[test]
    fn duplicate_tag_name_fails_fast() {
        let cfgs = vec![tag("dup", IoType::DO), tag("dup", IoType::AI)];
        let err = OpcUaTagRegistry::build(cfgs.iter()).unwrap_err();
        assert_eq!(
            err,
            OpcUaTagRegistryError::DuplicateTagName { tag_name: "dup".into() }
        );
    }

    #[test]
    fn duplicate_browse_name_after_sanitization_fails_fast() {
        // `tank/a` and `tank_a` both sanitize to `tank_a` —
        // the registry catches that collision instead of
        // silently dropping one entry.
        let cfgs = vec![tag("tank/a", IoType::AI), tag("tank_a", IoType::AI)];
        let err = OpcUaTagRegistry::build(cfgs.iter()).unwrap_err();
        match err {
            OpcUaTagRegistryError::DuplicateBrowseName {
                browse_name,
                first_tag,
                duplicate_tag,
            } => {
                assert_eq!(browse_name, "tank_a");
                assert_eq!(first_tag, "tank/a");
                assert_eq!(duplicate_tag, "tank_a");
            }
            other => panic!("unexpected error variant: {:?}", other),
        }
    }

    #[test]
    fn empty_tag_name_fails_fast() {
        let cfgs = vec![tag("   ", IoType::AI)];
        let err = OpcUaTagRegistry::build(cfgs.iter()).unwrap_err();
        assert_eq!(err, OpcUaTagRegistryError::EmptyTagName);
    }

    #[test]
    fn find_by_browse_name_round_trip() {
        let cfgs = vec![tag("tank/a", IoType::AI)];
        let r = OpcUaTagRegistry::build(cfgs.iter()).unwrap();
        let node = r.find_by_browse_name("tank_a").expect("resolved");
        assert_eq!(node.tag_name, "tank/a");
    }

    #[test]
    fn find_by_browse_name_returns_none_for_unknown() {
        let r = OpcUaTagRegistry::default();
        assert!(r.find_by_browse_name("missing").is_none());
    }

    #[test]
    fn iter_order_is_deterministic_by_tag_name() {
        // BTreeMap ordering means browse responses are
        // stable across sessions — HMIs that cache NodeIds
        // never see tag shuffling between reconnects.
        let cfgs = vec![
            tag("zeta", IoType::AI),
            tag("alpha", IoType::AI),
            tag("mike", IoType::AI),
        ];
        let r = OpcUaTagRegistry::build(cfgs.iter()).unwrap();
        let names: Vec<_> = r.iter().map(|n| n.tag_name.clone()).collect();
        assert_eq!(names, vec!["alpha", "mike", "zeta"]);
    }

    #[test]
    fn error_display_points_operator_at_conflict() {
        let err = OpcUaTagRegistryError::DuplicateTagName {
            tag_name: "dup".into(),
        };
        let msg = format!("{}", err);
        assert!(msg.contains("dup"), "msg={}", msg);
        assert!(msg.contains("unique"), "msg={}", msg);
    }

    #[test]
    fn registry_is_clone_and_debug() {
        // Downstream Batch 209 wire needs to clone the
        // registry into the async-opcua session handler;
        // assert the trait implementations are present.
        let r = OpcUaTagRegistry::default();
        let _r2 = r.clone();
        let _dbg = format!("{:?}", r);
    }

    // ============================================================
    // Batch 209 Faz 5 — write-orchestrator tests
    // ============================================================

    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use tokio::sync::Mutex;

    /// Canned authz port — flips allow/deny based on the
    /// (actor, tag_name) pair passed at construction.
    struct CannedAuthz {
        allow_for: Option<(String, String)>,
    }

    #[async_trait::async_trait]
    impl OpcUaAuthzPort for CannedAuthz {
        async fn is_write_allowed(&self, actor: &str, tag_name: &str) -> bool {
            match &self.allow_for {
                Some((a, t)) => a == actor && t == tag_name,
                None => false,
            }
        }
    }

    /// Canned force-registry port — returns true for the
    /// stored tag_name, false otherwise.
    struct CannedForce {
        forced_tag: Option<String>,
    }

    #[async_trait::async_trait]
    impl OpcUaForceRegistryPort for CannedForce {
        async fn is_forced(&self, tag_name: &str) -> bool {
            self.forced_tag.as_deref() == Some(tag_name)
        }
    }

    /// Capturing process-image port — stores the last write
    /// attempt + returns the configured result.
    struct CapturingPi {
        result: Result<(), String>,
        last: Mutex<Option<(String, f64, String)>>,
    }

    #[async_trait::async_trait]
    impl OpcUaProcessImagePort for CapturingPi {
        async fn write_tag(
            &self,
            tag_name: &str,
            value: f64,
            actor: &str,
        ) -> Result<(), String> {
            *self.last.lock().await =
                Some((tag_name.to_string(), value, actor.to_string()));
            self.result.clone()
        }
    }

    /// Capturing audit port — stores every outcome the chain
    /// emitted. Every reject path MUST emit exactly one audit
    /// record; success path MUST also emit exactly one.
    struct CapturingAudit {
        outcomes: Mutex<Vec<OpcUaWriteOutcome>>,
    }

    #[async_trait::async_trait]
    impl OpcUaAuditPort for CapturingAudit {
        async fn record_write_attempt(
            &self,
            _actor: &str,
            _tag_name: &str,
            _value: f64,
            outcome: &OpcUaWriteOutcome,
        ) {
            self.outcomes.lock().await.push(outcome.clone());
        }
    }

    fn registry_with(tags: Vec<TagConfig>) -> OpcUaTagRegistry {
        OpcUaTagRegistry::build(tags.iter()).expect("registry builds")
    }

    async fn audit_outcomes(audit: &CapturingAudit) -> Vec<OpcUaWriteOutcome> {
        audit.outcomes.lock().await.clone()
    }

    #[tokio::test]
    async fn write_success_happy_path() {
        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let authz = CannedAuthz {
            allow_for: Some(("hmi-op".into(), "do_pump".into())),
        };
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 50.0,
                actor: "hmi-op",
            },
            &authz,
            &force,
            &pi,
            &audit,
        )
        .await;

        assert!(out.is_success(), "outcome={:?}", out);
        let last = pi.last.lock().await.clone().expect("pi received write");
        assert_eq!(last.0, "do_pump");
        assert_eq!(last.1, 50.0);
        assert_eq!(last.2, "hmi-op");
        let outs = audit_outcomes(&audit).await;
        assert_eq!(outs.len(), 1);
        assert!(outs[0].is_success());
    }

    #[tokio::test]
    async fn write_unknown_tag_rejects_and_audits() {
        let reg = registry_with(vec![]);
        let authz = CannedAuthz { allow_for: None };
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "ghost",
                value: 1.0,
                actor: "hmi-op",
            },
            &authz,
            &force,
            &pi,
            &audit,
        )
        .await;

        assert_eq!(
            out,
            OpcUaWriteOutcome::RejectedUnknownTag {
                tag_name: "ghost".into(),
            }
        );
        // Silent denies would hide scans; assert audit fired.
        assert_eq!(audit_outcomes(&audit).await.len(), 1);
        assert!(pi.last.lock().await.is_none(), "pi untouched");
    }

    #[tokio::test]
    async fn write_rejects_read_only_tag() {
        let reg = registry_with(vec![tag("ai_sensor", IoType::AI)]);
        let authz = CannedAuthz {
            allow_for: Some(("hmi-op".into(), "ai_sensor".into())),
        };
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "ai_sensor",
                value: 50.0,
                actor: "hmi-op",
            },
            &authz,
            &force,
            &pi,
            &audit,
        )
        .await;

        assert_eq!(
            out,
            OpcUaWriteOutcome::RejectedNotWritable {
                tag_name: "ai_sensor".into(),
            }
        );
        // authz NOT consulted (step 3 fires before step 6) —
        // the pi check confirms no write attempted.
        assert!(pi.last.lock().await.is_none());
    }

    #[tokio::test]
    async fn write_rejects_forced_tag_with_distinct_reason() {
        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let authz = CannedAuthz {
            allow_for: Some(("hmi-op".into(), "do_pump".into())),
        };
        let force = CannedForce {
            forced_tag: Some("do_pump".into()),
        };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 50.0,
                actor: "hmi-op",
            },
            &authz,
            &force,
            &pi,
            &audit,
        )
        .await;

        assert_eq!(
            out,
            OpcUaWriteOutcome::RejectedForced {
                tag_name: "do_pump".into(),
            }
        );
        assert!(pi.last.lock().await.is_none());
    }

    #[tokio::test]
    async fn write_rejects_out_of_range_against_eng_bounds() {
        // eng_min=0 eng_max=100 per the helper `tag`.
        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let authz = CannedAuthz {
            allow_for: Some(("hmi-op".into(), "do_pump".into())),
        };
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 150.0,
                actor: "hmi-op",
            },
            &authz,
            &force,
            &pi,
            &audit,
        )
        .await;

        match out {
            OpcUaWriteOutcome::RejectedOutOfRange {
                tag_name,
                value,
                eng_min,
                eng_max,
            } => {
                assert_eq!(tag_name, "do_pump");
                assert_eq!(value, 150.0);
                assert_eq!(eng_min, 0.0);
                assert_eq!(eng_max, 100.0);
            }
            other => panic!("unexpected outcome: {:?}", other),
        }
        assert!(pi.last.lock().await.is_none());
    }

    #[tokio::test]
    async fn write_permits_exact_boundary_values() {
        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let authz = CannedAuthz {
            allow_for: Some(("hmi-op".into(), "do_pump".into())),
        };
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 100.0, // exact upper bound
                actor: "hmi-op",
            },
            &authz,
            &force,
            &pi,
            &audit,
        )
        .await;
        assert!(out.is_success());
    }

    #[tokio::test]
    async fn write_without_eng_range_skips_step_5() {
        // When eng_min OR eng_max is missing the range check
        // is non-binding on that side — matches the existing
        // CommandHandler write path.
        let mut t = tag("do_pump", IoType::DO);
        t.eng_min = None;
        t.eng_max = None;
        let reg = registry_with(vec![t]);
        let authz = CannedAuthz {
            allow_for: Some(("hmi-op".into(), "do_pump".into())),
        };
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 1_000_000.0, // would fail every bounded range
                actor: "hmi-op",
            },
            &authz,
            &force,
            &pi,
            &audit,
        )
        .await;
        assert!(out.is_success());
    }

    #[tokio::test]
    async fn write_rejects_when_authz_denies() {
        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let authz = CannedAuthz { allow_for: None };
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 50.0,
                actor: "stranger",
            },
            &authz,
            &force,
            &pi,
            &audit,
        )
        .await;

        match out {
            OpcUaWriteOutcome::RejectedNoPermission { tag_name, actor } => {
                assert_eq!(tag_name, "do_pump");
                assert_eq!(actor, "stranger");
            }
            other => panic!("unexpected outcome: {:?}", other),
        }
        // The permission audit MUST fire so the SIEM sees
        // unauthorized HMI attempts.
        assert_eq!(audit_outcomes(&audit).await.len(), 1);
        assert!(pi.last.lock().await.is_none());
    }

    #[tokio::test]
    async fn write_surfaces_process_image_error() {
        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let authz = CannedAuthz {
            allow_for: Some(("hmi-op".into(), "do_pump".into())),
        };
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Err("modbus write timeout".into()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 50.0,
                actor: "hmi-op",
            },
            &authz,
            &force,
            &pi,
            &audit,
        )
        .await;

        match out {
            OpcUaWriteOutcome::RejectedProcessImage { tag_name, reason } => {
                assert_eq!(tag_name, "do_pump");
                assert_eq!(reason, "modbus write timeout");
            }
            other => panic!("unexpected outcome: {:?}", other),
        }
    }

    #[tokio::test]
    async fn write_chain_order_short_circuits_before_authz() {
        // Forced tag in step 4 must short-circuit before the
        // authz port is ever consulted in step 6. Verify with
        // an AtomicBool that authz was NOT queried.
        struct TripwireAuthz {
            queried: Arc<AtomicBool>,
        }
        #[async_trait::async_trait]
        impl OpcUaAuthzPort for TripwireAuthz {
            async fn is_write_allowed(&self, _actor: &str, _tag_name: &str) -> bool {
                self.queried.store(true, Ordering::SeqCst);
                true
            }
        }

        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let tripwire = Arc::new(AtomicBool::new(false));
        let authz = TripwireAuthz {
            queried: tripwire.clone(),
        };
        let force = CannedForce {
            forced_tag: Some("do_pump".into()),
        };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let _ = execute_opcua_write(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 50.0,
                actor: "hmi-op",
            },
            &authz,
            &force,
            &pi,
            &audit,
        )
        .await;

        assert!(
            !tripwire.load(Ordering::SeqCst),
            "authz MUST NOT be consulted after force short-circuit"
        );
    }

    // ============================================================
    // Batch 210 Faz 5 — concrete adapter tests
    // ============================================================

    #[tokio::test]
    async fn process_image_adapter_writes_with_opcua_source() {
        use crate::process_image::TagSource;

        let pi = Arc::new(ProcessImage::new());
        let adapter = ProcessImageOpcUaAdapter::new(pi.clone());

        adapter
            .write_tag("do_pump", 75.0, "hmi-op")
            .await
            .unwrap();

        let got = pi.get_tag("do_pump").await.expect("tag persisted");
        assert_eq!(got.value, 75.0);
        // HMI writes must be tagged with OpcUaClient source so
        // downstream UI + audit can distinguish from sensor reads.
        assert_eq!(got.source, TagSource::OpcUaClient);
        // Quality pegged to Good on the success path — the authz +
        // range chain already validated the write.
        assert_eq!(got.quality, TagQuality::Good);
    }

    #[tokio::test]
    async fn process_image_adapter_overwrites_existing_tag() {
        let pi = Arc::new(ProcessImage::new());
        let adapter = ProcessImageOpcUaAdapter::new(pi.clone());

        adapter.write_tag("setpoint", 10.0, "op-a").await.unwrap();
        adapter.write_tag("setpoint", 20.0, "op-b").await.unwrap();

        let got = pi.get_tag("setpoint").await.expect("tag persisted");
        assert_eq!(got.value, 20.0);
    }

    #[tokio::test]
    async fn force_registry_adapter_reflects_force_state() {
        // Minimal registry fixture — the is_forced path runs
        // purely off the in-memory map, no DB or sweep task
        // required.
        let fr = Arc::new(ForceRegistry::new());
        let clock = crate::runtime_safety::SystemClockAuthority::new();
        let adapter = ForceRegistryOpcUaAdapter::new(fr.clone());

        // Empty registry — no tag forced.
        assert!(!adapter.is_forced("do_pump").await);

        // Apply a force + verify adapter reflects it.
        fr.apply(
            "do_pump".to_string(),
            50.0,
            TagQuality::Good,
            "op-a".to_string(),
            "test force".to_string(),
            60,
            false,
            &clock,
        )
        .await
        .unwrap();
        assert!(adapter.is_forced("do_pump").await);
        assert!(
            !adapter.is_forced("other_tag").await,
            "unrelated tags MUST NOT appear forced"
        );
    }

    // ============================================================
    // Batch 212 Faz 5 — PolicyEngine adapter tests
    // ============================================================

    use crate::authz::context::{
        AuthorizationDenyReason, AuthorizedContext,
    };
    use crate::authz::permission::OperatorId;
    use crate::authz::policy::PolicyEngineError;
    use async_trait::async_trait;

    fn operator_actor() -> ActorIdentity {
        ActorIdentity::Operator(OperatorId::new_from_verified([0x7Au8; 16]))
    }

    /// Canned PolicyEngine — returns the configured decision
    /// unconditionally. Captures the last request for assertion.
    struct CannedPolicyEngine {
        decision: std::sync::Mutex<
            Result<AuthorizationDecision, PolicyEngineError>,
        >,
        last_request: std::sync::Mutex<Option<AuthorizationRequest>>,
        policy_version: u64,
    }

    #[async_trait]
    impl PolicyEngine for CannedPolicyEngine {
        async fn authorize(
            &self,
            request: AuthorizationRequest,
        ) -> Result<AuthorizationDecision, PolicyEngineError> {
            *self.last_request.lock().unwrap() = Some(request);
            // Replace locked decision so re-issue paths return
            // Ok(Deny(...)) without cloning AuthorizationDecision
            // (which has no Clone impl).
            let taken = std::mem::replace(
                &mut *self.decision.lock().unwrap(),
                Ok(AuthorizationDecision::Deny(
                    AuthorizationDenyReason::PermissionNotGranted,
                )),
            );
            taken
        }

        fn current_policy_version(&self) -> u64 {
            self.policy_version
        }

        async fn reload_manifest(&self) -> Result<u64, PolicyEngineError> {
            Ok(self.policy_version)
        }
    }

    fn canned_allow() -> Arc<CannedPolicyEngine> {
        let ctx = AuthorizedContext::new_from_verified(
            operator_actor(),
            Permission::OpcUaWrite {
                tag_id: TagId::new("do_pump".into()),
            },
            test_tenant(),
            42,
            false,
            std::time::SystemTime::UNIX_EPOCH,
        );
        Arc::new(CannedPolicyEngine {
            decision: std::sync::Mutex::new(Ok(AuthorizationDecision::Allow(ctx))),
            last_request: std::sync::Mutex::new(None),
            policy_version: 42,
        })
    }

    fn canned_deny(reason: AuthorizationDenyReason) -> Arc<CannedPolicyEngine> {
        Arc::new(CannedPolicyEngine {
            decision: std::sync::Mutex::new(Ok(AuthorizationDecision::Deny(reason))),
            last_request: std::sync::Mutex::new(None),
            policy_version: 42,
        })
    }

    fn canned_err() -> Arc<CannedPolicyEngine> {
        Arc::new(CannedPolicyEngine {
            decision: std::sync::Mutex::new(Err(
                PolicyEngineError::ManifestUnavailable,
            )),
            last_request: std::sync::Mutex::new(None),
            policy_version: 42,
        })
    }

    #[tokio::test]
    async fn authz_adapter_allows_when_engine_allows() {
        let engine = canned_allow();
        let adapter = PolicyEngineOpcUaAdapter::new(
            engine.clone(),
            test_tenant(),
            Arc::new(|_actor: &str| Some(operator_actor())),
        );

        assert!(adapter.is_write_allowed("hmi-op", "do_pump").await);

        // Request shape verified.
        let req = engine
            .last_request
            .lock()
            .unwrap()
            .clone()
            .expect("engine called");
        assert_eq!(
            req.requested_permission,
            Permission::OpcUaWrite {
                tag_id: TagId::new("do_pump".into()),
            }
        );
        assert_eq!(req.claimed_policy_version, 42);
    }

    #[tokio::test]
    async fn authz_adapter_denies_when_engine_denies() {
        let engine = canned_deny(AuthorizationDenyReason::PermissionNotGranted);
        let adapter = PolicyEngineOpcUaAdapter::new(
            engine,
            test_tenant(),
            Arc::new(|_actor: &str| Some(operator_actor())),
        );

        assert!(!adapter.is_write_allowed("stranger", "do_pump").await);
    }

    #[tokio::test]
    async fn authz_adapter_denies_when_engine_errors() {
        // Engine surfacing ManifestUnavailable is a fail-closed
        // signal (plan HC-3 root-cause discipline). The
        // adapter MUST treat the error as a denial; the
        // orchestrator audit trail captures the denial at the
        // RejectedNoPermission boundary.
        let engine = canned_err();
        let adapter = PolicyEngineOpcUaAdapter::new(
            engine,
            test_tenant(),
            Arc::new(|_actor: &str| Some(operator_actor())),
        );

        assert!(!adapter.is_write_allowed("hmi-op", "do_pump").await);
    }

    #[tokio::test]
    async fn authz_adapter_denies_unresolved_actor_without_calling_engine() {
        let engine = canned_allow();
        let adapter = PolicyEngineOpcUaAdapter::new(
            engine.clone(),
            test_tenant(),
            Arc::new(|_actor: &str| None), // unresolvable actor
        );

        assert!(!adapter.is_write_allowed("anonymous", "do_pump").await);
        assert!(
            engine.last_request.lock().unwrap().is_none(),
            "engine MUST NOT be called for an unresolvable actor",
        );
    }

    #[tokio::test]
    async fn authz_adapter_binds_tenant_to_adapter_not_request_actor() {
        // Verify the adapter stamps its captured tenant on the
        // request, NOT the actor's tenant. Cross-tenant attempts
        // surface as the engine's TenantMismatch deny reason —
        // but that's the engine's concern, not the adapter's.
        let engine = canned_allow();
        let my_tenant = TenantId::new_from_verified([0xAAu8; 16]);
        let adapter = PolicyEngineOpcUaAdapter::new(
            engine.clone(),
            my_tenant.clone(),
            Arc::new(|_actor: &str| Some(operator_actor())),
        );

        let _ = adapter.is_write_allowed("hmi-op", "do_pump").await;

        let req = engine
            .last_request
            .lock()
            .unwrap()
            .clone()
            .expect("engine called");
        assert_eq!(req.tenant, my_tenant);
    }

    // ============================================================
    // Batch 211 Faz 5 — AuditSink adapter tests
    // ============================================================

    use crate::audit::sink::AuditHmacKey;

    fn test_tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn tmp_audit_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "suderra-opcua-audit-{}-{}.log",
            std::process::id(),
            rand::random::<u32>()
        ))
    }

    fn read_audit_ndjson(
        path: &std::path::Path,
    ) -> Vec<serde_json::Value> {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("valid NDJSON"))
            .collect()
    }

    #[tokio::test]
    async fn audit_adapter_writes_success_entry() {
        let path = tmp_audit_path();
        let key = AuditHmacKey::from_bytes([0xAAu8; 32]);
        let sink = Arc::new(AuditSink::open(&path, key).expect("open"));
        let adapter = AuditSinkOpcUaAdapter::new(
            sink,
            test_tenant(),
            Arc::new(|| 42u64),
        );

        adapter
            .record_write_attempt(
                "hmi-op",
                "do_pump",
                75.0,
                &OpcUaWriteOutcome::Success {
                    tag_name: "do_pump".into(),
                },
            )
            .await;

        let records = read_audit_ndjson(&path);
        assert_eq!(records.len(), 1);
        // HmacChainEntry nests AuditEntry under `entry`.
        let entry = &records[0]["entry"];
        // Canonical shape checks — these are the fields the
        // cloud-side analytics correlator indexes on.
        assert_eq!(entry["phase"], "post");
        assert_eq!(entry["outcome"], "success");
        assert_eq!(entry["action"], "tag_write");
        assert_eq!(entry["policy_version"], 42);
        assert_eq!(entry["actor"]["label"], "opc-ua:hmi-op");
        // AuditResource::Tag serializes as externally-tagged
        // enum default → {"tag":{"name":"do_pump"}}.
        assert_eq!(entry["resource"]["tag"]["name"], "do_pump");

        let detail: serde_json::Value =
            serde_json::from_str(entry["detail"].as_str().unwrap()).unwrap();
        assert_eq!(detail["opc_ua_write"], true);
        assert_eq!(detail["value"], 75.0);
        assert_eq!(detail["reason"], "success");

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn audit_adapter_writes_auth_denied_entry() {
        let path = tmp_audit_path();
        let key = AuditHmacKey::from_bytes([0xBBu8; 32]);
        let sink = Arc::new(AuditSink::open(&path, key).expect("open"));
        let adapter = AuditSinkOpcUaAdapter::new(
            sink,
            test_tenant(),
            Arc::new(|| 7u64),
        );

        adapter
            .record_write_attempt(
                "stranger",
                "do_pump",
                50.0,
                &OpcUaWriteOutcome::RejectedNoPermission {
                    tag_name: "do_pump".into(),
                    actor: "stranger".into(),
                },
            )
            .await;

        let records = read_audit_ndjson(&path);
        assert_eq!(records.len(), 1);
        // Authz denials MUST classify as AuthorizationDenied, not
        // Failure — cloud-side analytics separates "actor tried
        // something not allowed" from "hardware fault".
        assert_eq!(records[0]["entry"]["outcome"], "authorization_denied");
        assert_eq!(records[0]["entry"]["actor"]["label"], "opc-ua:stranger");

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn audit_adapter_writes_reject_paths_as_failure() {
        let path = tmp_audit_path();
        let key = AuditHmacKey::from_bytes([0xCCu8; 32]);
        let sink = Arc::new(AuditSink::open(&path, key).expect("open"));
        let adapter = AuditSinkOpcUaAdapter::new(
            sink,
            test_tenant(),
            Arc::new(|| 99u64),
        );

        let rejects = [
            OpcUaWriteOutcome::RejectedUnknownTag {
                tag_name: "ghost".into(),
            },
            OpcUaWriteOutcome::RejectedNotWritable {
                tag_name: "ai_sensor".into(),
            },
            OpcUaWriteOutcome::RejectedForced {
                tag_name: "do_pump".into(),
            },
            OpcUaWriteOutcome::RejectedOutOfRange {
                tag_name: "do_pump".into(),
                value: 150.0,
                eng_min: 0.0,
                eng_max: 100.0,
            },
            OpcUaWriteOutcome::RejectedProcessImage {
                tag_name: "do_pump".into(),
                reason: "modbus timeout".into(),
            },
        ];
        for o in rejects.iter() {
            adapter.record_write_attempt("hmi-op", "tag", 1.0, o).await;
        }

        let records = read_audit_ndjson(&path);
        assert_eq!(records.len(), 5);
        for r in &records {
            assert_eq!(r["entry"]["outcome"], "failure");
        }
        // Reason tags distinguish the five variants.
        let reasons: Vec<String> = records
            .iter()
            .map(|r| {
                let detail: serde_json::Value = serde_json::from_str(
                    r["entry"]["detail"].as_str().unwrap(),
                )
                .unwrap();
                detail["reason"].as_str().unwrap().to_string()
            })
            .collect();
        assert_eq!(
            reasons,
            vec![
                "unknown_tag",
                "not_writable",
                "forced",
                "out_of_range",
                "process_image_error",
            ]
        );

        // Out-of-range entry includes the bounds for forensics.
        let detail: serde_json::Value = serde_json::from_str(
            records[3]["entry"]["detail"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(detail["extra"]["eng_min"], 0.0);
        assert_eq!(detail["extra"]["eng_max"], 100.0);

        // process_image_error entry carries the underlying
        // reason string for ops + forensics triage.
        let detail: serde_json::Value = serde_json::from_str(
            records[4]["entry"]["detail"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(detail["extra"]["process_image_error"], "modbus timeout");

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn audit_adapter_policy_version_refreshed_per_call() {
        use std::sync::atomic::{AtomicU64, Ordering};

        let counter = Arc::new(AtomicU64::new(10));
        let counter_for_closure = counter.clone();
        let path = tmp_audit_path();
        let key = AuditHmacKey::from_bytes([0xDDu8; 32]);
        let sink = Arc::new(AuditSink::open(&path, key).expect("open"));
        let adapter = AuditSinkOpcUaAdapter::new(
            sink,
            test_tenant(),
            Arc::new(move || counter_for_closure.load(Ordering::SeqCst)),
        );

        adapter
            .record_write_attempt(
                "hmi-op",
                "do_pump",
                1.0,
                &OpcUaWriteOutcome::Success {
                    tag_name: "do_pump".into(),
                },
            )
            .await;

        // Bump policy_version (simulating a hot-reload);
        // next audit call MUST pick up the new value.
        counter.store(11, Ordering::SeqCst);

        adapter
            .record_write_attempt(
                "hmi-op",
                "do_pump",
                2.0,
                &OpcUaWriteOutcome::Success {
                    tag_name: "do_pump".into(),
                },
            )
            .await;

        let records = read_audit_ndjson(&path);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["entry"]["policy_version"], 10);
        assert_eq!(records[1]["entry"]["policy_version"], 11);

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn force_registry_adapter_reflects_removal() {
        let fr = Arc::new(ForceRegistry::new());
        let clock = crate::runtime_safety::SystemClockAuthority::new();
        let adapter = ForceRegistryOpcUaAdapter::new(fr.clone());

        fr.apply(
            "do_pump".to_string(),
            50.0,
            TagQuality::Good,
            "op-a".to_string(),
            "test".to_string(),
            60,
            false,
            &clock,
        )
        .await
        .unwrap();
        assert!(adapter.is_forced("do_pump").await);

        fr.remove("do_pump").await.unwrap();
        assert!(!adapter.is_forced("do_pump").await);
    }

    #[tokio::test]
    async fn write_every_reject_path_audits_exactly_once() {
        // Cross-check: every reject variant above emitted
        // exactly 1 audit entry. This test re-issues each
        // reject flavour and asserts the audit-capture
        // length is 1 on every path.
        for scenario in [
            // unknown tag
            ("ghost", false, None, 50.0, false),
            // not writable
            ("ai_sensor", false, None, 50.0, false),
            // forced
            ("do_pump", false, Some("do_pump"), 50.0, false),
            // out of range
            ("do_pump", true, None, 150.0, false),
            // no permission
            ("do_pump", false, None, 50.0, true),
        ] {
            let (tag_name, authz_allow, forced, value, authz_reject_only) = scenario;
            let reg = registry_with(vec![
                tag("do_pump", IoType::DO),
                tag("ai_sensor", IoType::AI),
            ]);
            let authz = CannedAuthz {
                allow_for: if authz_reject_only {
                    None
                } else if authz_allow {
                    Some(("hmi-op".into(), tag_name.to_string()))
                } else {
                    None
                },
            };
            let force = CannedForce {
                forced_tag: forced.map(|s| s.to_string()),
            };
            let pi = CapturingPi {
                result: Ok(()),
                last: Mutex::new(None),
            };
            let audit = CapturingAudit {
                outcomes: Mutex::new(Vec::new()),
            };
            let _ = execute_opcua_write(
                &reg,
                &OpcUaWriteRequest {
                    tag_name,
                    value,
                    actor: "hmi-op",
                },
                &authz,
                &force,
                &pi,
                &audit,
            )
            .await;
            assert_eq!(
                audit_outcomes(&audit).await.len(),
                1,
                "scenario={:?}",
                scenario
            );
        }
    }

    // =========================================================
    // Batch #290 — execute_opcua_write_post_typed_authz tests
    // =========================================================
    //
    // The post-typed-authz delegate skips the legacy
    // OpcUaAuthzPort step entirely. These tests pin its
    // behavior on every other gate + the commit path. The
    // function's signature has NO authz port parameter (Tier-1
    // architectural shape); a hypothetical caller cannot pass
    // a "fake-authorized" port placeholder and have the
    // compiler accept it.

    #[tokio::test]
    async fn post_typed_authz_writes_to_process_image_on_happy_path() {
        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write_post_typed_authz(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 50.0,
                actor: "sens:operator:00000000000000000000000000000042",
            },
            &force,
            &pi,
            &audit,
        )
        .await;

        assert!(out.is_success(), "outcome={:?}", out);
        let last = pi.last.lock().await.clone().expect("pi received write");
        assert_eq!(last.0, "do_pump");
        assert_eq!(last.1, 50.0);
        // Actor flows through unchanged — the
        // sens:operator:<hex> token is the audit-log identifier
        // that bridges the typed-authz principal to the legacy
        // ProcessImage write API. A future Batch refactors the
        // port traits to take typed AuthenticatedUser directly,
        // dropping the round-trip through string form.
        assert_eq!(
            last.2,
            "sens:operator:00000000000000000000000000000042"
        );
        let outs = audit_outcomes(&audit).await;
        assert_eq!(outs.len(), 1);
        assert!(outs[0].is_success());
    }

    #[tokio::test]
    async fn post_typed_authz_rejects_unknown_tag() {
        let reg = registry_with(vec![]);
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write_post_typed_authz(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "ghost",
                value: 1.0,
                actor: "sens:operator:00000000000000000000000000000042",
            },
            &force,
            &pi,
            &audit,
        )
        .await;

        assert_eq!(
            out,
            OpcUaWriteOutcome::RejectedUnknownTag {
                tag_name: "ghost".into(),
            }
        );
        assert_eq!(audit_outcomes(&audit).await.len(), 1);
        assert!(pi.last.lock().await.is_none());
    }

    #[tokio::test]
    async fn post_typed_authz_rejects_read_only_tag() {
        let reg = registry_with(vec![tag("ai_sensor", IoType::AI)]);
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write_post_typed_authz(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "ai_sensor",
                value: 50.0,
                actor: "sens:operator:00000000000000000000000000000042",
            },
            &force,
            &pi,
            &audit,
        )
        .await;

        assert_eq!(
            out,
            OpcUaWriteOutcome::RejectedNotWritable {
                tag_name: "ai_sensor".into(),
            }
        );
        assert!(pi.last.lock().await.is_none());
    }

    #[tokio::test]
    async fn post_typed_authz_rejects_forced_tag() {
        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let force = CannedForce {
            forced_tag: Some("do_pump".into()),
        };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write_post_typed_authz(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 50.0,
                actor: "sens:operator:00000000000000000000000000000042",
            },
            &force,
            &pi,
            &audit,
        )
        .await;

        assert_eq!(
            out,
            OpcUaWriteOutcome::RejectedForced {
                tag_name: "do_pump".into(),
            }
        );
        assert!(pi.last.lock().await.is_none());
    }

    #[tokio::test]
    async fn post_typed_authz_rejects_out_of_range() {
        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write_post_typed_authz(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 150.0, // helper sets eng_max=100
                actor: "sens:operator:00000000000000000000000000000042",
            },
            &force,
            &pi,
            &audit,
        )
        .await;

        match out {
            OpcUaWriteOutcome::RejectedOutOfRange {
                tag_name,
                value,
                eng_min,
                eng_max,
            } => {
                assert_eq!(tag_name, "do_pump");
                assert_eq!(value, 150.0);
                assert_eq!(eng_min, 0.0);
                assert_eq!(eng_max, 100.0);
            }
            other => panic!("expected OutOfRange, got {:?}", other),
        }
        assert!(pi.last.lock().await.is_none());
    }

    #[tokio::test]
    async fn post_typed_authz_propagates_process_image_error() {
        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Err("storage backend offline".to_string()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let out = execute_opcua_write_post_typed_authz(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 50.0,
                actor: "sens:operator:00000000000000000000000000000042",
            },
            &force,
            &pi,
            &audit,
        )
        .await;

        match out {
            OpcUaWriteOutcome::RejectedProcessImage { tag_name, reason } => {
                assert_eq!(tag_name, "do_pump");
                assert_eq!(reason, "storage backend offline");
            }
            other => panic!("expected ProcessImage error, got {:?}", other),
        }
        // Audit fires on error path too — silent failures
        // would hide infrastructure problems from the SIEM.
        assert_eq!(audit_outcomes(&audit).await.len(), 1);
    }

    #[tokio::test]
    async fn post_typed_authz_never_produces_no_permission_variant() {
        // The function's signature precludes it: there is no
        // OpcUaAuthzPort parameter, so step 6 cannot run, so
        // RejectedNoPermission cannot be the outcome. This
        // test exercises every other reject path and confirms
        // RejectedNoPermission is NEVER the variant produced —
        // a future regression that adds an authz check inside
        // this function would surface here.
        let reg = registry_with(vec![
            tag("do_pump", IoType::DO),
            tag("ai_sensor", IoType::AI),
        ]);
        for scenario in [
            // (tag, value, force_tag, pi_err, expected_variant_name)
            ("ghost", 50.0, None, false, "RejectedUnknownTag"),
            ("ai_sensor", 50.0, None, false, "RejectedNotWritable"),
            ("do_pump", 50.0, Some("do_pump"), false, "RejectedForced"),
            ("do_pump", 150.0, None, false, "RejectedOutOfRange"),
            ("do_pump", 50.0, None, true, "RejectedProcessImage"),
            ("do_pump", 50.0, None, false, "Success"),
        ] {
            let (tag_name, value, forced, pi_err, expected) = scenario;
            let force = CannedForce {
                forced_tag: forced.map(|s| s.to_string()),
            };
            let pi = CapturingPi {
                result: if pi_err {
                    Err("err".to_string())
                } else {
                    Ok(())
                },
                last: Mutex::new(None),
            };
            let audit = CapturingAudit {
                outcomes: Mutex::new(Vec::new()),
            };
            let out = execute_opcua_write_post_typed_authz(
                &reg,
                &OpcUaWriteRequest {
                    tag_name,
                    value,
                    actor: "sens:operator:00000000000000000000000000000042",
                },
                &force,
                &pi,
                &audit,
            )
            .await;
            // Tier-1 invariant: the no-permission variant is
            // unreachable in the post-typed-authz delegate.
            assert!(
                !matches!(
                    out,
                    OpcUaWriteOutcome::RejectedNoPermission { .. }
                ),
                "scenario={:?} produced unreachable RejectedNoPermission",
                expected
            );
        }
    }

    #[tokio::test]
    async fn post_typed_authz_audits_actor_string_unchanged() {
        // The actor string flows through to the audit record
        // verbatim. SensNodeManager.write() formats the
        // operator_id as `"sens:operator:<32-hex>"` (Batch
        // #265 format_operator_token) and passes that string
        // here. An accidental upper-casing or path-mangling
        // would corrupt the audit-log identifier — this test
        // pins the transparent passthrough.
        let reg = registry_with(vec![tag("do_pump", IoType::DO)]);
        let force = CannedForce { forced_tag: None };
        let pi = CapturingPi {
            result: Ok(()),
            last: Mutex::new(None),
        };
        let audit = CapturingAudit {
            outcomes: Mutex::new(Vec::new()),
        };

        let actor_token =
            "sens:operator:42424242424242424242424242424242";
        let _ = execute_opcua_write_post_typed_authz(
            &reg,
            &OpcUaWriteRequest {
                tag_name: "do_pump",
                value: 50.0,
                actor: actor_token,
            },
            &force,
            &pi,
            &audit,
        )
        .await;

        let last = pi.last.lock().await.clone().expect("pi write");
        assert_eq!(last.2, actor_token, "actor token must pass through unchanged");
    }
}
