//! # Authorization module — ABAC Permission-set + sealed `AuthorizedContext`
//!
//! Implements the architectural contract defined in:
//! - ADR-018 (Edge RBAC ABAC + 5-Key Segregation + Tenant Trust Root)
//! - ADR-024 §1 (Extended `ActuatorClass` enum + `LifeSupport` orthogonal flag)
//!
//! ## Module tree (Batch 2 — types-only; runtime wiring lands in later batches)
//!
//! - [`permission`] — `Permission` enum + `ActuatorClass` taxonomy + identifier
//!   newtypes. **Pure type definitions**, zero runtime behavior.
//!
//! ## Why this module exists before Faz 2 security module batches
//!
//! Edge vocabulary (the `Permission` enum) is the **fixed trust-vocabulary** per
//! ADR-018 §3.1 — platform RBAC manifest evolution changes `custom_roles` mapping
//! in the cloud, but edge `Permission` variants are immutable until a binary
//! release. Landing this enum early enables downstream modules (ST VM, command
//! handlers, audit events) to reference it before the full authorization runtime
//! is wired.
//!
//! ## Module-boundary invariant (ADR-018 §11 + ADR-020 FINDING-009)
//!
//! The `AuthorizedContext` type (to land in Faz 2 Sprint 6.1) must be constructed
//! ONLY from inside this module tree. This is enforced via:
//! 1. Private field + sealed trait pattern at the type level
//! 2. CODEOWNERS entry `/sens-api-gateway/src/authz/ @security-lead @okan`
//! 3. Invariant test `tests/invariants/authorized_context_constructors.rs`
//!
//! This batch does NOT yet define `AuthorizedContext` — it only establishes the
//! `permission` submodule + enum taxonomy so downstream refs can compile.
//!
//! ## Relation to STRIDE threat model
//!
//! `docs/security/threat-model.md` §3.2 (RBAC + Authz) — this module is the
//! primary subject of that table. FR2 Use Control per IEC 62443-3-3 SL-2.

// WHY: Public re-exports keep downstream call sites clean —
//      `use crate::authz::Permission` instead of `crate::authz::permission::Permission`.
// WHAT: Flat re-export of all public types defined in submodules.
// INVARIANT: Only types listed here are part of the public module surface;
//            submodule-internal helpers stay crate-private.
pub mod permission;

// Re-export the commonly-used types for ergonomic downstream use.
// Keep this list in sync with public API surface; every addition here is a
// commitment to forward-compat for downstream consumers (ST VM, commands,
// audit events, etc.).
pub use permission::{
    ActuatorClass,
    AerationSubClass,
    ChemistrySubClass,
    DeviceId,
    LifeSupportRole,
    ModbusDeviceId,
    ModbusRegisterRange,
    ModbusRegisterRangeError,
    OperatorId,
    Permission,
    SpiDeviceId,
    TagId,
    TenantId,
    ThermalSubClass,
};
