//! Per-tenant `IngestBackend` selection — the strangler-fig rollout
//! gate per ADR-025 and `docs/adr/_draft/021-per-tenant-ingest-backend-
//! toggle.md`.
//!
//! WHY this module exists separately from `main`:
//!   The rollout decision (which tenant the Rust sidecar processes vs
//!   which still belongs to the NestJS `sensor-service` path) is its
//!   own architectural concern, distinct from the persistence /
//!   publisher pipeline. Inlining the gate into `main::drain_mqtt_stream`
//!   would couple gate semantics to the boot flow and bury the rollout
//!   logic where unit tests cannot reach it. Extracting now also
//!   future-proofs the eventual switch from [`StaticBackendPolicy`]
//!   (TOML-served) to a NATS-served dynamic policy
//!   (`sensor.lookup.tenant_settings`) planned for Faz 3 — the trait
//!   stays stable, only the impl swaps.
//!
//! WHY a trait + struct rather than a free function:
//!   The drain loop holds an `Arc<dyn IngestBackendPolicy>`. A future
//!   dynamic-policy implementation will need its own state (NATS sub,
//!   refresh timer, papaya cache) and will be a distinct struct that
//!   implements the same trait. The trait makes the swap mechanical
//!   and keeps the drain loop unaware of which implementation it
//!   currently holds.
//!
//! WHY default = [`IngestBackend::Node`]:
//!   Safe rollout: a misconfigured `[ingest_backend]` section degrades
//!   to "no behaviour change" instead of "every tenant flipped". The
//!   policy gate then drops messages for every tenant (Node-routed
//!   counter increments) — observable, auditable, reversible by a
//!   single config edit. The opposite default would silently put every
//!   new tenant onto the Rust path the moment the sidecar boots.

use std::collections::HashMap;

use tenant_context::TenantId;

use crate::config::{IngestBackend, IngestBackendConfig};

/// Policy abstraction: given a tenant id, return the backend that
/// should process its ingestion stream.
///
/// `Send + Sync` because the drain loop holds an `Arc<dyn
/// IngestBackendPolicy>` and shares it across the per-message hot path.
pub trait IngestBackendPolicy: Send + Sync + std::fmt::Debug {
    /// Decide which backend processes the supplied tenant's stream.
    /// Hot-path call — implementations MUST avoid I/O and locks.
    fn backend_for(&self, tenant: TenantId) -> IngestBackend;
}

/// TOML-driven backend policy. Resolves the backend in O(1) from a
/// pre-built `HashMap`. The intended caller is `main::async_main`
/// which constructs one of these from the `[ingest_backend]` config
/// section at boot and Arc-shares it down to the drain loop.
///
/// WHY the per-tenant override is the storage primitive (HashMap of
/// UUID → IngestBackend):
///   The override list is expected to grow tenant-by-tenant during the
///   pilot and to flip to "all tenants" at cutover. HashMap supports
///   both extremes: `O(1)` lookup at every size, plus the operator-
///   facing diff stays one TOML line per tenant.
#[derive(Debug, Clone)]
pub struct StaticBackendPolicy {
    default_backend: IngestBackend,
    tenant_overrides: HashMap<TenantId, IngestBackend>,
}

impl StaticBackendPolicy {
    /// Construct from explicit values. Tests + the
    /// [`Self::from_config`] adapter both use this.
    #[must_use]
    pub fn new(
        default_backend: IngestBackend,
        tenant_overrides: HashMap<TenantId, IngestBackend>,
    ) -> Self {
        Self {
            default_backend,
            tenant_overrides,
        }
    }

    /// Convenience: every tenant routes to NestJS. Used by tests that
    /// want to assert "no Rust-routed message under any condition".
    /// `cfg(test)`-gated so a future production caller cannot reach
    /// it without a code edit that surfaces in review — Tier 1 "make
    /// it impossible" beats `#[allow(dead_code)]` + a comment.
    /// Architectural-equivalent prod path is
    /// `StaticBackendPolicy::new(IngestBackend::Node, HashMap::new())`.
    #[cfg(test)]
    #[must_use]
    pub fn node_only() -> Self {
        Self::new(IngestBackend::Node, HashMap::new())
    }

    /// Convenience: every tenant routes to the Rust sidecar. Same
    /// `cfg(test)` discipline as [`Self::node_only`] — Faz 3 cutover
    /// (when the steady state truly is "everyone on Rust") will reach
    /// for `from_config` with `default_backend = "rust"` directly,
    /// not for this helper.
    #[cfg(test)]
    #[must_use]
    pub fn rust_only() -> Self {
        Self::new(IngestBackend::Rust, HashMap::new())
    }

    /// Build from an [`IngestBackendConfig`] loaded out of the TOML
    /// file. The `Uuid` keys in the config are wrapped in `TenantId`
    /// so the policy's public surface stays in the strongly-typed
    /// world, never raw `Uuid`.
    #[must_use]
    pub fn from_config(cfg: &IngestBackendConfig) -> Self {
        let overrides = cfg
            .tenant_overrides
            .iter()
            .map(|(uuid, backend)| (TenantId::from_uuid(*uuid), *backend))
            .collect();
        Self::new(cfg.default_backend, overrides)
    }
}

impl IngestBackendPolicy for StaticBackendPolicy {
    fn backend_for(&self, tenant: TenantId) -> IngestBackend {
        self.tenant_overrides
            .get(&tenant)
            .copied()
            .unwrap_or(self.default_backend)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use uuid::Uuid;

    use tenant_context::TenantId;

    use super::{IngestBackendPolicy, StaticBackendPolicy};
    use crate::config::{IngestBackend, IngestBackendConfig};

    fn fixed_tenant(seed: u8) -> TenantId {
        let mut bytes = [0_u8; 16];
        bytes[0] = seed;
        TenantId::from_uuid(Uuid::from_bytes(bytes))
    }

    #[test]
    fn default_returns_node() {
        // The "happy path" of the safe default: an empty override map
        // plus IngestBackend::Node default → every tenant on Node.
        let p = StaticBackendPolicy::new(IngestBackend::Node, HashMap::new());
        assert_eq!(p.backend_for(fixed_tenant(0xAA)), IngestBackend::Node);
        assert_eq!(p.backend_for(fixed_tenant(0xBB)), IngestBackend::Node);
    }

    #[test]
    fn tenant_override_takes_precedence_over_default() {
        // The whole point of the gate: a tenant in the override map
        // routes to its named backend regardless of the default. Mixed
        // expectations across two tenants pin the partitioning.
        let overridden = fixed_tenant(0x01);
        let other = fixed_tenant(0x02);
        let mut overrides = HashMap::new();
        overrides.insert(overridden, IngestBackend::Rust);
        let p = StaticBackendPolicy::new(IngestBackend::Node, overrides);
        assert_eq!(p.backend_for(overridden), IngestBackend::Rust);
        assert_eq!(p.backend_for(other), IngestBackend::Node);
    }

    #[test]
    fn node_only_returns_node_for_every_tenant() {
        // Steady-state pre-rollout: gate is on but nobody is migrated.
        let p = StaticBackendPolicy::node_only();
        for seed in 0..16 {
            assert_eq!(
                p.backend_for(fixed_tenant(seed)),
                IngestBackend::Node,
                "tenant {seed} should be Node"
            );
        }
    }

    #[test]
    fn rust_only_returns_rust_for_every_tenant() {
        // Steady-state post-rollout: every tenant migrated; the
        // override map is empty because the default already says Rust.
        let p = StaticBackendPolicy::rust_only();
        for seed in 0..16 {
            assert_eq!(
                p.backend_for(fixed_tenant(seed)),
                IngestBackend::Rust,
                "tenant {seed} should be Rust"
            );
        }
    }

    #[test]
    fn from_config_default_node_no_overrides() {
        // The config-derived constructor must agree with node_only()
        // when the config carries the type-default values.
        let p = StaticBackendPolicy::from_config(&IngestBackendConfig::default());
        assert_eq!(p.backend_for(fixed_tenant(0xCC)), IngestBackend::Node);
    }

    #[test]
    fn from_config_with_overrides() {
        // Operator-shaped input: one tenant explicitly Rust, default
        // Node. The TenantId wrap happens inside from_config; the
        // assertion runs in TenantId-space, never raw Uuid.
        let overridden_uuid = Uuid::from_bytes([0xDD; 16]);
        let mut overrides = HashMap::new();
        overrides.insert(overridden_uuid, IngestBackend::Rust);
        let cfg = IngestBackendConfig {
            default_backend: IngestBackend::Node,
            tenant_overrides: overrides,
        };
        let p = StaticBackendPolicy::from_config(&cfg);
        assert_eq!(
            p.backend_for(TenantId::from_uuid(overridden_uuid)),
            IngestBackend::Rust
        );
        assert_eq!(p.backend_for(fixed_tenant(0xEE)), IngestBackend::Node);
    }

    #[test]
    fn policy_is_send_and_sync() {
        // Compile-time assertion: a mis-edit that adds a !Send field
        // to the policy would break the drain loop's Arc-share model,
        // and we want the failure at compile time, not at deploy.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<StaticBackendPolicy>();
        assert_send_sync::<std::sync::Arc<dyn IngestBackendPolicy>>();
    }

    #[test]
    fn serde_roundtrip_lowercase_strings() {
        // The lowercase `"node"` / `"rust"` representation is the
        // operator-facing contract (TOML + `INGEST_BACKEND` env var).
        // Round-trip through serde_json so a regression on the rename
        // attribute is caught immediately.
        let backend = IngestBackend::Rust;
        let s = serde_json::to_string(&backend).unwrap();
        assert_eq!(s, "\"rust\"");
        let parsed: IngestBackend = serde_json::from_str("\"node\"").unwrap();
        assert_eq!(parsed, IngestBackend::Node);
        let parsed: IngestBackend = serde_json::from_str("\"rust\"").unwrap();
        assert_eq!(parsed, IngestBackend::Rust);
    }

    #[test]
    fn policy_partitions_synthetic_mixed_tenant_batch() {
        // Drives the "would the policy correctly partition a batch"
        // assertion the stage-13 spec calls for. We can't run the
        // async drain in a unit test (no broker, no stream), but we
        // can prove the gate's classification logic with a synthetic
        // tenant list — the drain loop's job is then a thin "if Rust
        // -> proceed; if Node -> drop" wrapper around backend_for().
        let migrated = fixed_tenant(0x11);
        let mut overrides = HashMap::new();
        overrides.insert(migrated, IngestBackend::Rust);
        let policy = StaticBackendPolicy::new(IngestBackend::Node, overrides);

        let batch: Vec<TenantId> = vec![
            migrated,
            fixed_tenant(0x21),
            migrated,
            fixed_tenant(0x22),
            migrated,
            fixed_tenant(0x23),
        ];
        let rust_count = batch
            .iter()
            .filter(|t| matches!(policy.backend_for(**t), IngestBackend::Rust))
            .count();
        let node_count = batch.len() - rust_count;
        assert_eq!(rust_count, 3, "three messages from the migrated tenant");
        assert_eq!(node_count, 3, "three messages from non-migrated tenants");
    }
}
