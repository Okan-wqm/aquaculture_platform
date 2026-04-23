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

use crate::process_image::{IoType, TagConfig};

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
}
