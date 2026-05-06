// BATCH-001-CI-FIX-015: pre-staged types for Sprint 6.1-6.8 runtime wiring.
// Re-exports are intentionally unused until the runtime consumers land.
#![allow(unused_imports)]

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

// Batch 5a — AuthorizedContext sealed proof + PolicyEngine trait. The
// `AuthorizedContext` ctor is `pub(crate)` and called ONLY from
// `super::policy::PolicyEngine::authorize` implementations. External
// callers cannot mint an AuthorizedContext; command handlers that take one
// as an argument are the make-it-impossible gate per ADR-018 §11.
pub mod context;
pub mod policy;

// Batch 5b — RbacManifest wire format + canonical-bytes length-prefix
// serialization + `verify_manifest` gate (signature + tenant + version +
// expiry). Consumers obtain a validated `RbacManifest` ONLY via
// `verify::verify_manifest`; direct access to `SignedRbacManifest.manifest`
// is discouraged by the invariant test in Sprint 6.1.
pub mod manifest;
pub mod verify;

// Batch #249a refactor — shared ed25519 pubkey hex parser.
// Used by every signed-manifest verifier in the authz tree (RBAC
// + user-token + future streams) so the 64-char-length + hex
// conversion + VerifyingKey ctor lives in exactly ONE place.
pub mod signing_key_util;

// Batch #243 refactor — shared envelope-gate helper. Gates 1-5
// (validity window / clock / tenant / version / expiry) are common to
// every signed edge manifest; `manifest_common::run_envelope_gates` is
// the single canonical implementation consumed by `verify` (RBAC) and
// `user_token_manifest` (OPC UA credentials). Zero duplication across
// manifest verifiers.
pub mod manifest_common;

// Batch #243 — UserTokenManifest wire format + verify_user_token_manifest.
// Parallel to `manifest` + `verify` for the OPC UA UserName/Password +
// X.509 credential side of operator authentication. Signed by
// `user_token_manifest_signing_key` (ADR-021 slot 4); independent
// monotonic version stream so credential rotation doesn't force RBAC
// fleet re-signing.
pub mod user_token_manifest;

// Batch #245 — UserTokenManifestStore hot-reload atom. Holds the
// verified user-token manifest + a cached UserTokenEnrollment; the
// store swap is atomic so validator readers never see mismatched
// pairs. Paired with `opc_ua_server_user_token_validator` (at crate
// root) which consumes this store.
pub mod user_token_manifest_runtime;

// Batch 67 — RbacManifestStore runtime loader (Sprint 6.1 full wire
// partial). Holds the verified manifest in memory + exposes operator→
// pubkey lookup for Batch 68+ envelope Gate 7 swap.
pub mod manifest_runtime;

// Batch 71 — ManifestVersionStore: SQLCipher-backed persistence for
// `highest_seen_policy_version` across reboots. Closes the rollback
// window where Batch 67/68 started from floor=0 every boot, letting
// an attacker replay a captured older signed manifest. Batch 72
// wires this into RbacManifestStore::load_from_file_inner.
pub mod manifest_version_store;

// Batch 223 — InMemoryPolicyEngine: PolicyEngine impl backed by
// RbacManifestStore. Closes gap A-1 from the ruthless assessment
// (Faz 5 write chain was DenyAll-only; this batch wires the real
// authorize path — tenant check, policy-version monotonicity,
// manifest-validity window, operator-binding lookup, role-set
// permission match, co-approver gate for two-person-integrity
// commands).
pub mod in_memory_engine;

// Re-export the commonly-used types for ergonomic downstream use.
// Keep this list in sync with public API surface; every addition here is a
// commitment to forward-compat for downstream consumers (ST VM, commands,
// audit events, etc.).
pub use permission::{
    ActuatorClass, AerationSubClass, ChemistrySubClass, DeviceId, LifeSupportRole, ModbusDeviceId,
    ModbusRegisterRange, ModbusRegisterRangeError, OperatorId, Permission, SpiDeviceId, TagId,
    TenantId, ThermalSubClass,
};

pub use context::{
    ActorIdentity, AuthorizationDecision, AuthorizationDenyReason, AuthorizedContext,
};

pub use policy::{
    AuthorizationRequest, CoApproverEvidence, DenyAllPolicyEngine, Ed25519SignatureBytes,
    InvalidSignatureLength, PolicyEngine, PolicyEngineError,
};

pub use manifest::{
    CanonicalBytesError, CustomRole, Ed25519PublicKeyBytes, InvalidPubKeyLength, OperatorBinding,
    RbacManifest, SignedRbacManifest,
};

pub use verify::{verify_manifest, ManifestVerifyError};

pub use manifest_common::{run_envelope_gates, ManifestStructuralError};

pub use user_token_manifest::{
    verify_user_token_manifest, SignedUserTokenManifest, UserPassManifestBinding,
    UserTokenManifest, UserTokenManifestVerifyError, X509ManifestBinding,
};

pub use user_token_manifest_runtime::UserTokenManifestStore;
