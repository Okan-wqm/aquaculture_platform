//! Per-tenant `IngestBackend` selection — the strangler-fig rollout
//! gate per ADR-025 (Rust sidecar architecture) + ADR-027
//! (`docs/adr/027-per-tenant-ingest-backend-toggle.md`).
//!
//! WHY this module exists separately from `main`:
//!   The rollout decision (which tenant the Rust sidecar processes vs
//!   which still belongs to the NestJS `sensor-service` path) is its
//!   own architectural concern, distinct from the persistence /
//!   publisher pipeline. Inlining the gate into `main::drain_mqtt_stream`
//!   would couple gate semantics to the boot flow and bury the rollout
//!   logic where unit tests cannot reach it. Extracting now also
//!   future-proofs the eventual switch from `StaticBackendPolicy`
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
use std::sync::Arc;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use serde::{Deserialize, Serialize};
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

/// Versioned owner named by the handoff control plane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IngressOwner {
    /// Existing NestJS MQTT ingress.
    Nestjs,
    /// Rust sensor-ingestion sidecar.
    Rust,
}

/// Handoff phase. Only `ACTIVE` authorizes an owner decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IngressOwnerPolicyState {
    /// Prospective owner is warming dependencies and may not ingest.
    Preparing,
    /// Named owner exclusively owns new admission.
    Active,
    /// Prior owner is draining committed source identities.
    Draining,
}

/// Per-tenant, monotonically-versioned handoff policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IngressOwnerPolicy {
    /// Tenant whose session copy is governed by this row.
    pub tenant_id: TenantId,
    /// Strictly increasing control-plane version.
    pub version: u64,
    /// Exclusive ingress owner.
    pub owner: IngressOwner,
    /// Opaque epoch/barrier identity written by the handoff coordinator.
    pub effective_epoch: String,
    /// Preparation, ownership, or drain phase.
    pub state: IngressOwnerPolicyState,
}

/// Hot-path decision. Unknown and transitional policies deliberately do not
/// collapse into `NOT_OWNER`, because acknowledging them could lose data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnershipDecision {
    /// Rust is the ACTIVE owner and may commit the source delivery.
    Process,
    /// NestJS is the ACTIVE owner; this session copy may be ACK-dropped.
    NotOwnerActive,
    /// No current ACTIVE policy is known; source must remain unacknowledged.
    Indeterminate,
}

/// Result of applying an owner-policy message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyApplyOutcome {
    /// Newer policy became visible atomically.
    Applied,
    /// Exact same version and payload was replayed.
    Duplicate,
    /// Older version, or conflicting reuse of the current version, was rejected.
    Stale,
}

/// Lock-free per-tenant owner policy registry. There is intentionally no global
/// default: an unknown tenant cannot be proven safe to ACK on either backend.
const OWNER_POLICY_SNAPSHOT_LEASE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
struct OwnerPolicySnapshot {
    policies: HashMap<TenantId, IngressOwnerPolicy>,
    observed_at: Instant,
}

#[derive(Debug)]
pub struct VersionedOwnerPolicies {
    current: ArcSwap<OwnerPolicySnapshot>,
}

impl Default for VersionedOwnerPolicies {
    fn default() -> Self {
        Self::new()
    }
}

impl VersionedOwnerPolicies {
    /// Construct an empty, fail-closed policy set.
    #[must_use]
    pub fn new() -> Self {
        Self {
            current: ArcSwap::from_pointee(OwnerPolicySnapshot {
                policies: HashMap::new(),
                observed_at: Instant::now(),
            }),
        }
    }

    /// Apply only a strictly newer policy; exact replay is idempotent.
    pub fn apply(&self, policy: IngressOwnerPolicy) -> PolicyApplyOutcome {
        let current = self.current.load();
        if let Some(existing) = current.policies.get(&policy.tenant_id) {
            if existing == &policy {
                return PolicyApplyOutcome::Duplicate;
            }
            if policy.version <= existing.version {
                return PolicyApplyOutcome::Stale;
            }
        }
        let mut next = (**current).clone();
        next.policies.insert(policy.tenant_id, policy);
        self.current.store(Arc::new(next));
        PolicyApplyOutcome::Applied
    }

    /// Reconcile a complete authoritative snapshot while retaining any newer
    /// core update that raced the request/reply round trip. Tenants omitted by
    /// the authoritative snapshot are removed.
    pub fn reconcile_snapshot(&self, policies: Vec<IngressOwnerPolicy>) {
        self.reconcile_snapshot_at(policies, Instant::now());
    }

    fn reconcile_snapshot_at(&self, policies: Vec<IngressOwnerPolicy>, observed_at: Instant) {
        let mut replacement: HashMap<TenantId, IngressOwnerPolicy> = HashMap::new();
        for policy in policies {
            match replacement.get(&policy.tenant_id) {
                Some(existing) if existing.version >= policy.version => {}
                _ => {
                    replacement.insert(policy.tenant_id, policy);
                }
            }
        }
        let current = self.current.load();
        for (tenant_id, current_policy) in &current.policies {
            if let Some(authoritative) = replacement.get(tenant_id) {
                if current_policy.version > authoritative.version {
                    replacement.insert(*tenant_id, current_policy.clone());
                }
            }
        }
        self.current.store(Arc::new(OwnerPolicySnapshot {
            policies: replacement,
            observed_at,
        }));
    }

    /// Decide ownership from one atomic snapshot read.
    #[must_use]
    pub fn decision_for(&self, tenant_id: TenantId) -> OwnershipDecision {
        self.decision_at(tenant_id, Instant::now())
    }

    fn decision_at(&self, tenant_id: TenantId, now: Instant) -> OwnershipDecision {
        let current = self.current.load();
        if now.saturating_duration_since(current.observed_at) > OWNER_POLICY_SNAPSHOT_LEASE {
            return OwnershipDecision::Indeterminate;
        }
        let Some(policy) = current.policies.get(&tenant_id) else {
            return OwnershipDecision::Indeterminate;
        };
        if policy.state != IngressOwnerPolicyState::Active {
            return OwnershipDecision::Indeterminate;
        }
        match policy.owner {
            IngressOwner::Rust => OwnershipDecision::Process,
            IngressOwner::Nestjs => OwnershipDecision::NotOwnerActive,
        }
    }
}

/// TOML-driven backend policy — retained for tests that want a
/// deterministic, immutable policy value. `#[cfg(test)]` because
/// the production path (ADR-031) uses [`DynamicBackendPolicy`] so
/// the NATS-served snapshot + hot-swap wiring is live end-to-end.
///
/// WHY the per-tenant override is the storage primitive (HashMap of
/// UUID → IngestBackend):
///   The override list is expected to grow tenant-by-tenant during the
///   pilot and to flip to "all tenants" at cutover. HashMap supports
///   both extremes: `O(1)` lookup at every size, plus the operator-
///   facing diff stays one TOML line per tenant.
#[cfg(test)]
#[derive(Debug, Clone)]
pub struct StaticBackendPolicy {
    default_backend: IngestBackend,
    tenant_overrides: HashMap<TenantId, IngestBackend>,
}

#[cfg(test)]
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

#[cfg(test)]
impl IngestBackendPolicy for StaticBackendPolicy {
    fn backend_for(&self, tenant: TenantId) -> IngestBackend {
        self.tenant_overrides
            .get(&tenant)
            .copied()
            .unwrap_or(self.default_backend)
    }
}

// ---------------------------------------------------------------------
// IngestBackendSnapshot + DynamicBackendPolicy (ADR-031).
// ---------------------------------------------------------------------

/// Immutable snapshot of the per-tenant backend routing decision at a
/// point in time. Swapped atomically under an `ArcSwap` so the drain's
/// per-message read (`backend_for(tenant)`) never blocks on the update
/// path.
///
/// Wire shape mirrors what the `policy.ingest_backend.snapshot` NATS
/// responder replies with + what `policy.ingest_backend.changed`
/// events aggregate to. Serialised via serde so the JSON the
/// admin-api-service emits round-trips byte-for-byte.
///
/// The `overrides` map is a plain `HashMap<TenantId, IngestBackend>` —
/// the hot-path lookup is O(1), which matches the existing
/// `StaticBackendPolicy` cost. A future tenant-bucket partitioning
/// scheme (say 256 buckets to keep CPU-cache locality under a fleet
/// of 50 000 tenants) would slot in at this struct without changing
/// the callers.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct IngestBackendSnapshot {
    /// Default backend every tenant not named in [`Self::overrides`]
    /// routes to. Starts as [`IngestBackend::Node`] for safe rollout;
    /// flips to [`IngestBackend::Rust`] at Faz-3 cut-over.
    pub default_backend: IngestBackend,

    /// Per-tenant override map. A tenant appearing here bypasses the
    /// `default_backend` choice. Present tenants are explicit opt-
    /// ins (during pilot) or explicit opt-outs (during rollback).
    pub overrides: HashMap<TenantId, IngestBackend>,
}

impl IngestBackendSnapshot {
    /// Test-only convenience: every tenant routes to
    /// [`IngestBackend::Node`]. The production bootstrap path
    /// ([`crate::policy::bootstrap_policy`]) reaches the same steady
    /// state through `IngestBackendSnapshot::from_config(&default)`,
    /// so this helper stays `cfg(test)` — Tier 1 "make it impossible"
    /// to accidentally short-circuit the operator-signed TOML path
    /// on the production boot flow.
    #[cfg(test)]
    #[must_use]
    pub fn node_only() -> Self {
        Self {
            default_backend: IngestBackend::Node,
            overrides: HashMap::new(),
        }
    }

    /// Build a snapshot from an [`IngestBackendConfig`] (the TOML
    /// section). Used as the bootstrap primitive when the NATS
    /// snapshot + disk fallback both unavailable — operator-signed
    /// starting state.
    #[must_use]
    pub fn from_config(cfg: &IngestBackendConfig) -> Self {
        let overrides = cfg
            .tenant_overrides
            .iter()
            .map(|(uuid, backend)| (TenantId::from_uuid(*uuid), *backend))
            .collect();
        Self {
            default_backend: cfg.default_backend,
            overrides,
        }
    }
}

/// Dynamic policy backed by an `ArcSwap<IngestBackendSnapshot>`. The
/// drain's hot path reads through an `arc_swap::Guard`; policy
/// updates replace the inner Arc atomically so no reader ever sees
/// a torn snapshot.
///
/// `Send + Sync` through the `ArcSwap` + `Arc` composition. Multiple
/// call sites can hold the policy: the drain (reads), the NATS
/// subscriber (writes via [`Self::apply_snapshot`] / [`Self::apply_change`]),
/// the cold-start bootstrap (writes the initial snapshot).
#[derive(Debug)]
pub struct DynamicBackendPolicy {
    current: ArcSwap<IngestBackendSnapshot>,
}

impl DynamicBackendPolicy {
    /// Construct from an initial snapshot. The bootstrap path calls
    /// this with whichever source won the cold-start race: a
    /// successful NATS snapshot response, the disk fallback, or the
    /// config-file default (in that order of preference).
    #[must_use]
    pub fn new(initial: IngestBackendSnapshot) -> Self {
        Self {
            current: ArcSwap::from_pointee(initial),
        }
    }

    /// Atomically replace the current snapshot. Every subsequent
    /// `backend_for` read on this policy sees the new state from the
    /// next memory-ordering publish point onward.
    pub fn apply_snapshot(&self, snapshot: IngestBackendSnapshot) {
        self.current.store(Arc::new(snapshot));
    }

    /// Apply a single incremental change (one
    /// `policy.ingest_backend.changed` event) to the current
    /// snapshot. Clones the current snapshot (which the `Arc` makes
    /// structurally cheap), mutates the clone per the event, swaps
    /// the new snapshot in.
    ///
    /// Keeps hot-path readers lock-free because the `store` is
    /// atomic; a reader holding a `Guard` at the moment of the
    /// write keeps its old snapshot alive until the guard drops.
    pub fn apply_change(&self, change: IngestBackendChange) {
        let current = self.current.load();
        // `(**current).clone()` dereferences the Guard → &Arc →
        // &IngestBackendSnapshot, then Clone moves to an owned
        // snapshot the mutation lands on without touching the live
        // reader's Arc.
        let mut next = (**current).clone();
        match change {
            IngestBackendChange::SetGlobal { backend } => {
                next.default_backend = backend;
            }
            IngestBackendChange::SetTenant {
                tenant_id: tenant,
                backend,
            } => {
                next.overrides.insert(tenant, backend);
            }
            IngestBackendChange::RemoveTenant { tenant_id: tenant } => {
                next.overrides.remove(&tenant);
            }
        }
        self.apply_snapshot(next);
    }

    /// Snapshot the current routing state. NOT on the hot path — hot
    /// readers go through [`IngestBackendPolicy::backend_for`] which
    /// reads through a single `ArcSwap::load` guard without cloning.
    ///
    /// The live production caller is
    /// [`crate::policy::persist_snapshot_to_disk`] invoked from the
    /// `policy.ingest_backend.>` subscriber after every
    /// [`Self::apply_change`]: the subscriber pulls the new snapshot
    /// out and writes it to the disk fallback file so the next cold
    /// boot starts from the last-known authoritative state.
    #[must_use]
    pub fn snapshot(&self) -> IngestBackendSnapshot {
        (**self.current.load()).clone()
    }
}

impl IngestBackendPolicy for DynamicBackendPolicy {
    fn backend_for(&self, tenant: TenantId) -> IngestBackend {
        // `load()` returns a `Guard` that deref's to `&Arc<Snapshot>`;
        // two deref layers (`**guard`) give us `&IngestBackendSnapshot`
        // which the lookup reads through without allocating. The
        // guard is dropped at the end of this expression.
        let guard = self.current.load();
        guard
            .overrides
            .get(&tenant)
            .copied()
            .unwrap_or(guard.default_backend)
    }
}

/// Incremental change an ADR-031
/// `policy.ingest_backend.changed` event can express. Kept as a
/// single enum (rather than separate subjects per action) so the
/// subscriber deserialises one wire type and the match arm is the
/// single source of truth for the state-transition semantics.
///
/// The enum uses struct-shaped variants (rather than tuple) so
/// `#[serde(tag = "action")]` produces the ADR-031 wire shape:
///   `{"action":"set_global","backend":"Rust"}`
///   `{"action":"set_tenant","tenant_id":"<uuid>","backend":"Rust"}`
///   `{"action":"remove_tenant","tenant_id":"<uuid>"}`
/// Tuple variants are incompatible with internally-tagged enums
/// (serde's tag attribute needs named fields to merge the tag in).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum IngestBackendChange {
    /// Replace the global default (affects every tenant without an
    /// explicit override).
    SetGlobal {
        /// New global default.
        backend: IngestBackend,
    },

    /// Set a per-tenant override (insert or overwrite).
    SetTenant {
        /// Tenant whose override is being installed.
        tenant_id: TenantId,
        /// Backend the tenant should route to from this event onward.
        backend: IngestBackend,
    },

    /// Remove a per-tenant override (the tenant falls back to the
    /// global default on the next read).
    RemoveTenant {
        /// Tenant whose override is being removed.
        tenant_id: TenantId,
    },
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

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
            ..IngestBackendConfig::default()
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

    // -----------------------------------------------------------------
    // DynamicBackendPolicy — ADR-031 hot-swap invariants.
    // -----------------------------------------------------------------

    #[test]
    fn snapshot_node_only_routes_every_tenant_to_node() {
        let snap = super::IngestBackendSnapshot::node_only();
        assert_eq!(snap.default_backend, IngestBackend::Node);
        assert!(snap.overrides.is_empty());
    }

    #[test]
    fn dynamic_policy_reads_initial_snapshot() {
        let policy = super::DynamicBackendPolicy::new(super::IngestBackendSnapshot::node_only());
        let t = fixed_tenant(0x01);
        assert_eq!(policy.backend_for(t), IngestBackend::Node);
    }

    #[test]
    fn apply_snapshot_swaps_state_visible_to_next_read() {
        // The hot path reads the ArcSwap guard; after a store the
        // next read MUST see the new snapshot. A regression that
        // swapped the wrong Arc cell would fail this.
        let policy = super::DynamicBackendPolicy::new(super::IngestBackendSnapshot::node_only());
        let t = fixed_tenant(0x05);
        assert_eq!(policy.backend_for(t), IngestBackend::Node);

        let mut overrides = HashMap::new();
        overrides.insert(t, IngestBackend::Rust);
        policy.apply_snapshot(super::IngestBackendSnapshot {
            default_backend: IngestBackend::Node,
            overrides,
        });

        assert_eq!(
            policy.backend_for(t),
            IngestBackend::Rust,
            "per-tenant override from the new snapshot must win"
        );
    }

    #[test]
    fn apply_change_set_global_flips_default() {
        let policy = super::DynamicBackendPolicy::new(super::IngestBackendSnapshot::node_only());
        let t = fixed_tenant(0x07);
        assert_eq!(policy.backend_for(t), IngestBackend::Node);

        policy.apply_change(super::IngestBackendChange::SetGlobal {
            backend: IngestBackend::Rust,
        });

        assert_eq!(
            policy.backend_for(t),
            IngestBackend::Rust,
            "flipping global must cascade to unoverridden tenants"
        );
    }

    #[test]
    fn apply_change_set_tenant_overrides_without_touching_global() {
        let policy = super::DynamicBackendPolicy::new(super::IngestBackendSnapshot::node_only());
        let t_override = fixed_tenant(0x0A);
        let t_global = fixed_tenant(0x0B);

        policy.apply_change(super::IngestBackendChange::SetTenant {
            tenant_id: t_override,
            backend: IngestBackend::Rust,
        });

        assert_eq!(policy.backend_for(t_override), IngestBackend::Rust);
        assert_eq!(
            policy.backend_for(t_global),
            IngestBackend::Node,
            "other tenants still follow the untouched global default"
        );
    }

    #[test]
    fn apply_change_remove_tenant_reverts_to_global() {
        let policy = super::DynamicBackendPolicy::new(super::IngestBackendSnapshot::node_only());
        let t = fixed_tenant(0x0C);

        policy.apply_change(super::IngestBackendChange::SetTenant {
            tenant_id: t,
            backend: IngestBackend::Rust,
        });
        assert_eq!(policy.backend_for(t), IngestBackend::Rust);

        policy.apply_change(super::IngestBackendChange::RemoveTenant { tenant_id: t });
        assert_eq!(
            policy.backend_for(t),
            IngestBackend::Node,
            "removing the override must fall back to the global default"
        );
    }

    #[test]
    fn snapshot_serde_round_trip_preserves_shape() {
        // The snapshot is the wire shape for the
        // `policy.ingest_backend.snapshot` reply. A rename would
        // break the cross-language contract silently at deploy —
        // this test anchors the JSON round trip at compile time.
        let mut overrides = HashMap::new();
        overrides.insert(fixed_tenant(0x01), IngestBackend::Rust);
        let original = super::IngestBackendSnapshot {
            default_backend: IngestBackend::Node,
            overrides,
        };
        let json = serde_json::to_string(&original).expect("serialise snapshot");
        let decoded: super::IngestBackendSnapshot =
            serde_json::from_str(&json).expect("deserialise snapshot");
        assert_eq!(original, decoded);
    }

    #[test]
    fn change_event_serde_tagged_shape_matches_wire_contract() {
        // ADR-031 wire shape: `{"action":"set_global","backend":"Rust"}` etc.
        // The `#[serde(tag = "action", rename_all = "snake_case")]`
        // produces the canonical discriminator. A refactor that
        // dropped the attribute would silently ship incompatible
        // JSON; the test pins the bytes.
        let ev = super::IngestBackendChange::SetGlobal {
            backend: IngestBackend::Rust,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(
            json.contains("\"action\":\"set_global\""),
            "set_global wire shape broken: {json}"
        );

        let decoded: super::IngestBackendChange = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, ev);

        let remove_json = serde_json::to_string(&super::IngestBackendChange::RemoveTenant {
            tenant_id: fixed_tenant(0x09),
        })
        .unwrap();
        assert!(remove_json.contains("\"action\":\"remove_tenant\""));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_reads_under_swap_do_not_panic() {
        // Lock-free read invariant. 16 concurrent reader tasks pound
        // `backend_for` while a writer task apply_changes per-tenant
        // overrides in a tight loop. The test passes if it terminates
        // without panic (the workspace `unwrap_used = deny` /
        // `panic = deny` make any torn-snapshot panic a build error)
        // + the readers observe only the valid states (Node or Rust,
        // never random bytes).
        let policy = Arc::new(super::DynamicBackendPolicy::new(
            super::IngestBackendSnapshot::node_only(),
        ));
        let mut handles = Vec::new();
        for seed in 0_u8..16 {
            let p = Arc::clone(&policy);
            handles.push(tokio::spawn(async move {
                // 1024 reads per task. Loop bound is u16 so the
                // counter stays in-range; only the tenant discriminator
                // byte feeds the u8 fixed_tenant seed.
                for i in 0_u16..1024 {
                    // `i as u8` is intentional truncation — the reader
                    // workload just needs a different tenant per
                    // iteration, and the exact tenant id does not
                    // matter beyond the lookup cost. The `allow` is
                    // scoped tight to the cast so the workspace's
                    // `clippy::cast_possible_truncation = warn`
                    // posture stays strict elsewhere.
                    #[allow(clippy::cast_possible_truncation)]
                    let seed_byte = i as u8;
                    let t = fixed_tenant(seed ^ seed_byte);
                    let _ = p.backend_for(t);
                }
            }));
        }
        // Writer task — 256 rapid swaps. The seed iterates 0..=255
        // which exhausts the u8 namespace exactly once.
        let writer = {
            let p = Arc::clone(&policy);
            tokio::spawn(async move {
                for seed in 0_u16..=255 {
                    // Same truncation-is-intended argument as the
                    // reader loop: the writer wants different
                    // tenants, not specific ones.
                    #[allow(clippy::cast_possible_truncation)]
                    let seed_byte = seed as u8;
                    p.apply_change(super::IngestBackendChange::SetTenant {
                        tenant_id: fixed_tenant(seed_byte),
                        backend: if seed % 2 == 0 {
                            IngestBackend::Rust
                        } else {
                            IngestBackend::Node
                        },
                    });
                }
            })
        };
        for h in handles {
            h.await.expect("reader task panicked");
        }
        writer.await.expect("writer task panicked");
    }

    #[test]
    fn versioned_owner_policy_is_fail_closed_until_active() {
        let tenant = fixed_tenant(0x31);
        let policies = super::VersionedOwnerPolicies::new();
        assert_eq!(
            policies.decision_for(tenant),
            super::OwnershipDecision::Indeterminate
        );

        assert_eq!(
            policies.apply(super::IngressOwnerPolicy {
                tenant_id: tenant,
                version: 1,
                owner: super::IngressOwner::Rust,
                effective_epoch: "2026-08-25T00:00:00.000Z".to_owned(),
                state: super::IngressOwnerPolicyState::Preparing,
            }),
            super::PolicyApplyOutcome::Applied
        );
        assert_eq!(
            policies.decision_for(tenant),
            super::OwnershipDecision::Indeterminate
        );
    }

    #[test]
    fn versioned_owner_policy_rejects_stale_and_ack_drops_only_active_other_owner() {
        let tenant = fixed_tenant(0x32);
        let policies = super::VersionedOwnerPolicies::new();
        let active_node = super::IngressOwnerPolicy {
            tenant_id: tenant,
            version: 7,
            owner: super::IngressOwner::Nestjs,
            effective_epoch: "2026-08-25T00:00:00.000Z".to_owned(),
            state: super::IngressOwnerPolicyState::Active,
        };
        assert_eq!(
            policies.apply(active_node.clone()),
            super::PolicyApplyOutcome::Applied
        );
        assert_eq!(
            policies.decision_for(tenant),
            super::OwnershipDecision::NotOwnerActive
        );
        assert_eq!(
            policies.apply(super::IngressOwnerPolicy {
                version: 6,
                owner: super::IngressOwner::Rust,
                ..active_node
            }),
            super::PolicyApplyOutcome::Stale
        );
        assert_eq!(
            policies.decision_for(tenant),
            super::OwnershipDecision::NotOwnerActive
        );
    }

    #[test]
    fn versioned_owner_policy_snapshot_lease_expires_fail_closed() {
        let tenant = fixed_tenant(0x33);
        let policies = super::VersionedOwnerPolicies::new();
        let observed_at = Instant::now();
        let active_rust = super::IngressOwnerPolicy {
            tenant_id: tenant,
            version: 1,
            owner: super::IngressOwner::Rust,
            effective_epoch: "2026-08-25T00:00:00.000Z".to_owned(),
            state: super::IngressOwnerPolicyState::Active,
        };
        policies.reconcile_snapshot_at(vec![active_rust.clone()], observed_at);

        assert_eq!(
            policies.decision_at(tenant, observed_at + Duration::from_millis(4_999)),
            super::OwnershipDecision::Process
        );
        assert_eq!(
            policies.apply(super::IngressOwnerPolicy {
                version: 2,
                ..active_rust.clone()
            }),
            super::PolicyApplyOutcome::Applied
        );
        assert_eq!(
            policies.decision_at(tenant, observed_at + Duration::from_millis(5_001)),
            super::OwnershipDecision::Indeterminate
        );

        policies.reconcile_snapshot_at(
            vec![super::IngressOwnerPolicy {
                version: 2,
                ..active_rust
            }],
            observed_at + Duration::from_millis(5_001),
        );
        assert_eq!(
            policies.decision_at(tenant, observed_at + Duration::from_millis(5_002)),
            super::OwnershipDecision::Process
        );
    }
}
