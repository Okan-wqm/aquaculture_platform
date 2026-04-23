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

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::Arc;

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
        )
        .await
        .unwrap();
        assert!(adapter.is_forced("do_pump").await);
        assert!(
            !adapter.is_forced("other_tag").await,
            "unrelated tags MUST NOT appear forced"
        );
    }

    #[tokio::test]
    async fn force_registry_adapter_reflects_removal() {
        let fr = Arc::new(ForceRegistry::new());
        let adapter = ForceRegistryOpcUaAdapter::new(fr.clone());

        fr.apply(
            "do_pump".to_string(),
            50.0,
            TagQuality::Good,
            "op-a".to_string(),
            "test".to_string(),
            60,
            false,
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
}
