//! Bytecode program registry — Batch 163 Faz 3 (plan R-1).
//!
//! ## WHY
//!
//! The edge agent ingests signed ST bytecode artifacts
//! (Batch 158) + runs them in the scan cycle (Batches 151,
//! 159, 160, 161). Between ingest + scan a stateful
//! component must:
//!
//! - Hold the current set of deployed programs keyed by
//!   `program_id`.
//! - Enforce monotonic `policy_version` so a replay / down-
//!   grade attack cannot re-install an older bytecode under
//!   the same id.
//! - Enforce tenant isolation so a program previously
//!   deployed under tenant A cannot be overwritten by an
//!   incoming deploy from tenant B (even if the signature
//!   is valid — distinct tenants MUST NOT be able to replace
//!   each other's programs).
//! - Track the enabled/disabled flag so an operator can
//!   pause a program without erasing it.
//! - Serve the scan-cycle engine a cheap iterator of
//!   currently-deployed-and-enabled programs.
//!
//! Batch 163 lands the registry as a thread-safe primitive
//! (`Arc<RwLock<HashMap<…>>>`). The deploy-command batch +
//! the ScriptEngine Phase 5b batch consume this primitive.
//!
//! ## What's not in Batch 163
//!
//! - The deploy command itself — that lives in
//!   `commands::cmd_deploy_program`.
//! - Persistence across agent restarts — the registry is
//!   currently in-memory only. A future batch adds a
//!   SQLCipher-backed persistence layer alongside the
//!   existing `persistence.rs` (variable store) so
//!   deployed bytecodes survive reboot.

// Batch #259 wire-audit: D-1 ultra-plan compile/registry
// path is partially orphan (Batch 149-167 primitives wired
// for runtime + scan-cycle, but several stdlib/compile/
// debug helpers wait on the D-1 production wire). Blanket
// allow retained + tracked as ULTRA-HIGH-024; remove
// per-item as the D-1 batch consumes each helper.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::sync::RwLock;

use super::bytecode::Bytecode;

/// One entry in the program registry. Wraps the
/// verified bytecode with deploy-time metadata the
/// engine + audit layers need.
#[derive(Debug, Clone)]
pub struct ProgramEntry {
    /// Operator-facing identifier — used as the HashMap
    /// key + surfaced in audit events. Typically a UUID
    /// but may also be an operator-chosen human-readable
    /// tag (`fish_feeder_alert`, `ph_guard`, …).
    pub program_id: String,
    /// Signed + verified bytecode artifact.
    pub bytecode: Bytecode,
    /// Tenant that owns this program. `None` indicates a
    /// platform-scoped program (rare; used for factory
    /// default alarms). Tenant-scoped programs reject
    /// cross-tenant replacement.
    pub tenant_id: Option<String>,
    /// Monotonic version per `program_id`. The registry
    /// rejects incoming entries whose `policy_version`
    /// is ≤ the stored one — defending against replay +
    /// downgrade.
    pub policy_version: u64,
    /// Whether the engine should execute this program in
    /// the scan cycle. Operators can pause a program
    /// without removing it (e.g. for diagnostics).
    pub enabled: bool,
    /// When the entry was inserted (or re-inserted via
    /// higher-version deploy). Surfaced in list + get
    /// responses so operators see freshness.
    pub deployed_at: DateTime<Utc>,
}

/// Registry error taxonomy. Each variant surfaces a
/// specific gate failure so the deploy-command audit can
/// record the exact reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    /// `get` / `set_enabled` / `remove` referenced a
    /// program id that is not in the registry.
    NotFound { program_id: String },
    /// `insert` received an entry whose `policy_version`
    /// is ≤ the stored entry's version. Replay /
    /// downgrade defense.
    PolicyVersionNotMonotonic {
        program_id: String,
        existing: u64,
        incoming: u64,
    },
    /// `insert` received an entry whose `tenant_id`
    /// differs from the stored entry's — one tenant
    /// cannot overwrite another's program even with a
    /// higher version.
    TenantMismatch {
        program_id: String,
        existing: Option<String>,
        incoming: Option<String>,
    },
    /// EDGE-HIGH-016: `insert` received an entry whose
    /// `bytecode.max_gas_per_tick` exceeds the hard VM
    /// ceiling. Accepting it would let a program declare a
    /// budget the VM cannot honour, so the deploy is
    /// rejected loudly here rather than being silently
    /// throttled at runtime. Operator-visible defense in
    /// depth over the VM-side clamp.
    GasCeilingExceeded {
        program_id: String,
        requested: u32,
        ceiling: u32,
    },
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound { program_id } => {
                write!(f, "registry: program `{}` not found", program_id)
            }
            Self::PolicyVersionNotMonotonic {
                program_id,
                existing,
                incoming,
            } => write!(
                f,
                "registry: program `{}` policy version not monotonic (existing={}, incoming={})",
                program_id, existing, incoming
            ),
            Self::TenantMismatch {
                program_id,
                existing,
                incoming,
            } => write!(
                f,
                "registry: program `{}` tenant mismatch (existing={:?}, incoming={:?})",
                program_id, existing, incoming
            ),
            Self::GasCeilingExceeded {
                program_id,
                requested,
                ceiling,
            } => write!(
                f,
                "registry: program `{}` max_gas_per_tick {} exceeds hard VM ceiling {}",
                program_id, requested, ceiling
            ),
        }
    }
}

impl std::error::Error for RegistryError {}

/// Thread-safe in-memory registry of deployed bytecode
/// programs. Cheap to clone (`Arc`-backed) so the engine
/// + command handlers share a single source of truth.
#[derive(Debug, Clone, Default)]
pub struct BytecodeProgramRegistry {
    inner: Arc<RwLock<HashMap<String, ProgramEntry>>>,
}

impl BytecodeProgramRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a new entry or replace an existing entry
    /// whose monotonic + tenant gates pass.
    ///
    /// Gates (in order):
    /// 1. If an entry with the same `program_id` already
    ///    exists, its `tenant_id` MUST equal the incoming
    ///    entry's `tenant_id` → else `TenantMismatch`.
    /// 2. If an entry with the same `program_id` already
    ///    exists, the incoming `policy_version` MUST be
    ///    strictly greater → else
    ///    `PolicyVersionNotMonotonic`.
    /// 3. Otherwise the insert succeeds; stored entry is
    ///    the incoming one.
    pub async fn insert(&self, entry: ProgramEntry) -> Result<(), RegistryError> {
        // EDGE-HIGH-016: reject a program whose declared per-tick gas budget
        // exceeds the hard VM ceiling. Every deploy path funnels through
        // insert, so this is the single operator-visible chokepoint; the
        // VM-side clamp (ScriptVm::new) is the last-resort backstop for any
        // entry that reaches the runtime without passing through here.
        if entry.bytecode.max_gas_per_tick > crate::scripting::bytecode_vm::MAX_GAS_CEIL {
            return Err(RegistryError::GasCeilingExceeded {
                program_id: entry.program_id.clone(),
                requested: entry.bytecode.max_gas_per_tick,
                ceiling: crate::scripting::bytecode_vm::MAX_GAS_CEIL,
            });
        }
        let mut inner = self.inner.write().await;
        if let Some(existing) = inner.get(&entry.program_id) {
            if existing.tenant_id != entry.tenant_id {
                return Err(RegistryError::TenantMismatch {
                    program_id: entry.program_id.clone(),
                    existing: existing.tenant_id.clone(),
                    incoming: entry.tenant_id,
                });
            }
            if entry.policy_version <= existing.policy_version {
                return Err(RegistryError::PolicyVersionNotMonotonic {
                    program_id: entry.program_id.clone(),
                    existing: existing.policy_version,
                    incoming: entry.policy_version,
                });
            }
        }
        inner.insert(entry.program_id.clone(), entry);
        Ok(())
    }

    /// Fetch a single entry by id. Returns `None` if the
    /// registry has no entry for the id (cheaper than
    /// an explicit `contains` + `get` because the scan
    /// cycle consumer needs the entry anyway).
    pub async fn get(&self, program_id: &str) -> Option<ProgramEntry> {
        let inner = self.inner.read().await;
        inner.get(program_id).cloned()
    }

    /// Return every stored entry sorted by `program_id`
    /// so ops surfaces render a stable order.
    pub async fn list(&self) -> Vec<ProgramEntry> {
        let inner = self.inner.read().await;
        let mut entries: Vec<_> = inner.values().cloned().collect();
        entries.sort_by(|a, b| a.program_id.cmp(&b.program_id));
        entries
    }

    /// Return the subset of entries whose `enabled=true`
    /// — the scan-cycle engine calls this every tick.
    /// Sorted by program_id for deterministic execution
    /// order across scan cycles.
    pub async fn list_enabled(&self) -> Vec<ProgramEntry> {
        self.list()
            .await
            .into_iter()
            .filter(|e| e.enabled)
            .collect()
    }

    /// Toggle the enabled flag on an existing entry.
    pub async fn set_enabled(&self, program_id: &str, enabled: bool) -> Result<(), RegistryError> {
        let mut inner = self.inner.write().await;
        match inner.get_mut(program_id) {
            Some(entry) => {
                entry.enabled = enabled;
                Ok(())
            }
            None => Err(RegistryError::NotFound {
                program_id: program_id.to_string(),
            }),
        }
    }

    /// Remove an entry entirely. Returns NotFound when
    /// the caller tries to remove a non-existent program
    /// — idempotent callers that want "remove if
    /// present" should discard the error.
    pub async fn remove(&self, program_id: &str) -> Result<(), RegistryError> {
        let mut inner = self.inner.write().await;
        if inner.remove(program_id).is_some() {
            Ok(())
        } else {
            Err(RegistryError::NotFound {
                program_id: program_id.to_string(),
            })
        }
    }

    /// Total count of entries (enabled + disabled).
    /// Diagnostic helper for health / metrics endpoints.
    pub async fn len(&self) -> usize {
        self.inner.read().await.len()
    }

    /// Batch 215 Faz 7 — union of FB instance identifiers
    /// across every loaded program, optionally excluding one
    /// program (the one being replaced at deploy time).
    ///
    /// The deploy budget gate unions this set with the
    /// incoming bytecode's `fb_instance_ids` to compute the
    /// POST-deploy FB instance cardinality. Excluding the
    /// program being replaced avoids double-counting
    /// instances that only exist in the current version (they
    /// drop out when the new version lands) so operators
    /// don't hit false-positive cap rejections on version
    /// bumps that refactor FB use.
    pub async fn fb_instance_ids_except(
        &self,
        exclude_program_id: Option<&str>,
    ) -> std::collections::BTreeSet<String> {
        let inner = self.inner.read().await;
        let mut union = std::collections::BTreeSet::new();
        for (id, entry) in inner.iter() {
            if Some(id.as_str()) == exclude_program_id {
                continue;
            }
            union.extend(entry.bytecode.fb_instance_ids());
        }
        union
    }
}

#[cfg(test)]
mod tests {
    use super::super::bytecode::Opcode;
    use super::*;

    fn mk_bc(program_id: &str) -> Bytecode {
        Bytecode {
            program_id: program_id.to_string(),
            program_name: format!("{}-name", program_id),
            tenant_id: None,
            policy_version: 0,
            max_gas_per_tick: 1000,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: vec![],
            safe_state_pinned_tags: vec![],
            opcodes: vec![Opcode::Return],
        }
    }

    fn mk_entry(program_id: &str, tenant: Option<&str>, version: u64) -> ProgramEntry {
        ProgramEntry {
            program_id: program_id.to_string(),
            bytecode: mk_bc(program_id),
            tenant_id: tenant.map(|s| s.to_string()),
            policy_version: version,
            enabled: true,
            deployed_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn insert_then_get_roundtrips() {
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry("p1", Some("tenant-a"), 1))
            .await
            .expect("insert ok");
        let got = reg.get("p1").await.expect("exists");
        assert_eq!(got.program_id, "p1");
        assert_eq!(got.tenant_id, Some("tenant-a".to_string()));
        assert_eq!(got.policy_version, 1);
        assert!(got.enabled);
    }

    #[tokio::test]
    async fn get_missing_returns_none() {
        let reg = BytecodeProgramRegistry::new();
        assert!(reg.get("ghost").await.is_none());
    }

    #[tokio::test]
    async fn insert_replaces_on_higher_version() {
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry("p1", Some("tenant-a"), 1))
            .await
            .expect("ok");
        reg.insert(mk_entry("p1", Some("tenant-a"), 2))
            .await
            .expect("replace ok");
        assert_eq!(reg.get("p1").await.expect("exists").policy_version, 2);
    }

    // EDGE-HIGH-016: the deploy chokepoint rejects an over-ceiling gas budget
    // loudly instead of letting the VM silently throttle it at runtime.
    #[tokio::test]
    async fn insert_rejects_gas_above_ceiling() {
        let reg = BytecodeProgramRegistry::new();
        let mut entry = mk_entry("p-gas", Some("tenant-a"), 1);
        entry.bytecode.max_gas_per_tick = crate::scripting::bytecode_vm::MAX_GAS_CEIL + 1;
        let err = reg.insert(entry).await.expect_err("over-ceiling rejected");
        assert!(matches!(err, RegistryError::GasCeilingExceeded { .. }));
        // The rejected program must not be stored.
        assert!(reg.get("p-gas").await.is_none());
    }

    #[tokio::test]
    async fn insert_accepts_gas_at_ceiling_boundary() {
        let reg = BytecodeProgramRegistry::new();
        let mut entry = mk_entry("p-gas-ok", Some("tenant-a"), 1);
        entry.bytecode.max_gas_per_tick = crate::scripting::bytecode_vm::MAX_GAS_CEIL;
        reg.insert(entry).await.expect("at-ceiling accepted");
        assert!(reg.get("p-gas-ok").await.is_some());
    }

    #[tokio::test]
    async fn insert_rejects_equal_version() {
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry("p1", Some("tenant-a"), 5))
            .await
            .expect("ok");
        let err = reg
            .insert(mk_entry("p1", Some("tenant-a"), 5))
            .await
            .expect_err("not monotonic");
        match err {
            RegistryError::PolicyVersionNotMonotonic {
                existing, incoming, ..
            } => {
                assert_eq!(existing, 5);
                assert_eq!(incoming, 5);
            }
            other => panic!("expected PolicyVersionNotMonotonic, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn insert_rejects_lower_version() {
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry("p1", Some("tenant-a"), 10))
            .await
            .expect("ok");
        let err = reg
            .insert(mk_entry("p1", Some("tenant-a"), 3))
            .await
            .expect_err("rollback");
        assert!(matches!(
            err,
            RegistryError::PolicyVersionNotMonotonic { .. }
        ));
    }

    #[tokio::test]
    async fn insert_rejects_cross_tenant_overwrite() {
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry("p1", Some("tenant-a"), 1))
            .await
            .expect("ok");
        let err = reg
            .insert(mk_entry("p1", Some("tenant-b"), 2))
            .await
            .expect_err("tenant mismatch");
        match err {
            RegistryError::TenantMismatch {
                existing, incoming, ..
            } => {
                assert_eq!(existing, Some("tenant-a".to_string()));
                assert_eq!(incoming, Some("tenant-b".to_string()));
            }
            other => panic!("expected TenantMismatch, got {:?}", other),
        }
        // Original entry must still be intact.
        assert_eq!(
            reg.get("p1").await.expect("exists").tenant_id,
            Some("tenant-a".to_string())
        );
    }

    #[tokio::test]
    async fn insert_rejects_swap_none_tenant_to_some() {
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry("p1", None, 1)).await.expect("ok");
        let err = reg
            .insert(mk_entry("p1", Some("tenant-a"), 2))
            .await
            .expect_err("tenant mismatch");
        assert!(matches!(err, RegistryError::TenantMismatch { .. }));
    }

    #[tokio::test]
    async fn set_enabled_toggles_flag() {
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry("p1", Some("tenant-a"), 1))
            .await
            .expect("ok");
        reg.set_enabled("p1", false).await.expect("ok");
        assert!(!reg.get("p1").await.expect("exists").enabled);
        reg.set_enabled("p1", true).await.expect("ok");
        assert!(reg.get("p1").await.expect("exists").enabled);
    }

    #[tokio::test]
    async fn set_enabled_on_missing_returns_not_found() {
        let reg = BytecodeProgramRegistry::new();
        match reg.set_enabled("ghost", true).await {
            Err(RegistryError::NotFound { program_id }) => {
                assert_eq!(program_id, "ghost");
            }
            other => panic!("expected NotFound, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn remove_deletes_entry() {
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry("p1", Some("tenant-a"), 1))
            .await
            .expect("ok");
        reg.remove("p1").await.expect("ok");
        assert!(reg.get("p1").await.is_none());
    }

    #[tokio::test]
    async fn remove_missing_returns_not_found() {
        let reg = BytecodeProgramRegistry::new();
        assert!(matches!(
            reg.remove("ghost").await,
            Err(RegistryError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn list_returns_all_entries_sorted() {
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry("zebra", Some("tenant-a"), 1))
            .await
            .expect("ok");
        reg.insert(mk_entry("alpha", Some("tenant-a"), 1))
            .await
            .expect("ok");
        reg.insert(mk_entry("mango", Some("tenant-a"), 1))
            .await
            .expect("ok");

        let entries = reg.list().await;
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].program_id, "alpha");
        assert_eq!(entries[1].program_id, "mango");
        assert_eq!(entries[2].program_id, "zebra");
    }

    #[tokio::test]
    async fn list_enabled_filters_disabled() {
        let reg = BytecodeProgramRegistry::new();
        let mut disabled = mk_entry("disabled_one", Some("tenant-a"), 1);
        disabled.enabled = false;
        reg.insert(disabled).await.expect("ok");
        reg.insert(mk_entry("enabled_one", Some("tenant-a"), 1))
            .await
            .expect("ok");

        let enabled = reg.list_enabled().await;
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].program_id, "enabled_one");
    }

    #[tokio::test]
    async fn len_counts_entries() {
        let reg = BytecodeProgramRegistry::new();
        assert_eq!(reg.len().await, 0);
        reg.insert(mk_entry("p1", Some("tenant-a"), 1))
            .await
            .expect("ok");
        reg.insert(mk_entry("p2", Some("tenant-a"), 1))
            .await
            .expect("ok");
        assert_eq!(reg.len().await, 2);
    }

    #[tokio::test]
    async fn registry_is_cheap_to_clone_and_shares_state() {
        let reg_a = BytecodeProgramRegistry::new();
        let reg_b = reg_a.clone();
        reg_a
            .insert(mk_entry("p1", Some("tenant-a"), 1))
            .await
            .expect("ok");
        // Clone sees the insert — both share the same Arc.
        assert!(reg_b.get("p1").await.is_some());
    }

    // ============================================================
    // Batch 215 Faz 7 — fb_instance_ids_except tests
    // ============================================================

    fn mk_entry_with_fb_ops(
        program_id: &str,
        tenant: Option<&str>,
        fb_ids: &[&str],
    ) -> ProgramEntry {
        let mut bc = mk_bc(program_id);
        bc.opcodes = fb_ids
            .iter()
            .map(|id| Opcode::FbCall {
                fb_id: id.to_string(),
                input_names: vec![],
            })
            .chain(std::iter::once(Opcode::Return))
            .collect();
        ProgramEntry {
            program_id: program_id.to_string(),
            bytecode: bc,
            tenant_id: tenant.map(|s| s.to_string()),
            policy_version: 1,
            enabled: true,
            deployed_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn fb_instance_ids_except_empty_registry_returns_empty() {
        let reg = BytecodeProgramRegistry::new();
        assert!(reg.fb_instance_ids_except(None).await.is_empty());
    }

    #[tokio::test]
    async fn fb_instance_ids_except_unions_every_program() {
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry_with_fb_ops("p1", Some("t1"), &["timer1", "pid1"]))
            .await
            .expect("ok");
        reg.insert(mk_entry_with_fb_ops("p2", Some("t1"), &["timer1", "ctr1"]))
            .await
            .expect("ok");
        let union = reg.fb_instance_ids_except(None).await;
        assert_eq!(union.len(), 3);
        assert!(union.contains("timer1"));
        assert!(union.contains("pid1"));
        assert!(union.contains("ctr1"));
    }

    #[tokio::test]
    async fn fb_instance_ids_except_excludes_named_program() {
        // Excluding p2 drops its unique `ctr1` but keeps
        // shared `timer1` (also in p1) + p1's unique `pid1`.
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry_with_fb_ops("p1", Some("t1"), &["timer1", "pid1"]))
            .await
            .expect("ok");
        reg.insert(mk_entry_with_fb_ops("p2", Some("t1"), &["timer1", "ctr1"]))
            .await
            .expect("ok");
        let without_p2 = reg.fb_instance_ids_except(Some("p2")).await;
        assert_eq!(without_p2.len(), 2);
        assert!(without_p2.contains("timer1"));
        assert!(without_p2.contains("pid1"));
        assert!(!without_p2.contains("ctr1"));
    }

    #[tokio::test]
    async fn fb_instance_ids_except_unknown_id_is_noop() {
        let reg = BytecodeProgramRegistry::new();
        reg.insert(mk_entry_with_fb_ops("p1", Some("t1"), &["timer1"]))
            .await
            .expect("ok");
        let union = reg.fb_instance_ids_except(Some("ghost")).await;
        assert_eq!(union.len(), 1);
        assert!(union.contains("timer1"));
    }
}
