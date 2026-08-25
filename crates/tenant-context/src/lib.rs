//! `tenant-context` — compile-time tenant isolation primitives.
//!
//! WHY this crate exists:
//!   The platform is multi-tenant with strict schema-per-tenant isolation
//!   (ADR-011). The TS side enforces tenant boundary at runtime via
//!   `getScopedRepository()` + middleware. The Rust ingestion path needs
//!   the same guarantee but tighter: at compile time.
//!
//!   This is the highest tier of the architectural-solution hierarchy —
//!   "Make it impossible". Two values produced under different
//!   [`TenantCtx`] scopes cannot be combined in one operation, because
//!   their lifetimes do not unify (the GhostCell pattern). The compiler
//!   refuses to build code that crosses the boundary.
//!
//! WHAT lives here:
//!   - [`TenantId`]   — opaque newtype around `Uuid`.
//!   - [`SchemaName`] — PostgreSQL-identifier-validated newtype derived
//!     from a `TenantId` per ADR-011.
//!   - [`TenantCtx`]  — runtime context + invariant lifetime brand.
//!   - [`Scoped`]     — wrapper that statically pins a value to a brand.
//!   - [`with_tenant`] — entry point that opens a brand for the
//!     duration of the supplied closure.

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(not(test), deny(missing_docs))]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
    )
)]

use std::fmt;
use std::marker::PhantomData;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

/// Crate version for diagnostic / drift-detection telemetry.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Errors raised by [`SchemaName::try_parse`] and friends.
#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum TenantContextError {
    /// Schema-name candidate failed the PostgreSQL identifier whitelist.
    /// Concrete value is intentionally NOT included in the error so
    /// audit logs cannot be poisoned with attacker-controlled bytes.
    #[error("schema name failed validation against the postgres identifier whitelist")]
    InvalidSchemaName,
}

// ---------- TenantId ------------------------------------------------------

/// Opaque tenant identifier. Constructable only from a parsed [`Uuid`]
/// or from a strict 36-byte UUID string — there is no `From<&str>` that
/// accepts arbitrary input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TenantId(Uuid);

impl TenantId {
    /// Wrap an already-parsed [`Uuid`]. Use this when the UUID came
    /// from a trusted source (NATS cert CN, JWT claim).
    #[must_use]
    pub const fn from_uuid(u: Uuid) -> Self {
        Self(u)
    }

    /// Parse a strict 36-byte UUID string (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
    /// Returns `Err` for any other length or any non-hex character.
    ///
    /// # Errors
    /// Returns the underlying `uuid::Error` unchanged so callers can
    /// distinguish parse-failure modes if they care.
    pub fn try_parse(s: &str) -> Result<Self, uuid::Error> {
        Uuid::try_parse(s).map(Self)
    }

    /// Borrow the inner `Uuid` for serialisation / logging. Note: a
    /// `Display` impl is intentionally NOT provided so that accidental
    /// `format!("{}", tenant_id)` does not bypass the masking layer in
    /// `observability::masking`.
    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

// ---------- SchemaName ----------------------------------------------------

/// PostgreSQL schema name derived from a [`TenantId`].
///
/// The platform SSoT (`getTenantSchemaName` in
/// libs/backend-common/src/database/tenant-schema.utils.ts) fixes the
/// convention `tenant_<16-hex>` — the FIRST 16 hex chars of the
/// de-hyphenated, lower-cased UUID. This crate previously derived the
/// full 32-hex form, which produced schema names NO platform scanner
/// (listTenantSchemas, schema-drift validator, erasure workers) could
/// see: schemas the platform believes do not exist (Task 3,
/// SENSOR-CRITICAL-089).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct SchemaName(String);

impl SchemaName {
    /// Build a schema name from a [`TenantId`]. Always succeeds — the
    /// transformation is total because [`TenantId`] is itself a
    /// validated UUID.
    #[must_use]
    pub fn from_tenant_id(tenant: TenantId) -> Self {
        // `Uuid::simple` formats as 32 lowercase hex chars without
        // hyphens; the platform takes the FIRST 16. Cross-language
        // parity is pinned by the shared golden-vector fixture
        // (crates/tenant-context/tests/schema-golden) that BOTH this
        // crate and the TS SSoT test against.
        let full = tenant.0.simple().to_string();
        let mut s = String::with_capacity(7 + 16);
        s.push_str("tenant_");
        s.push_str(&full[..16]);
        Self(s)
    }

    /// Parse an arbitrary string against the strict platform shape:
    /// `^tenant_[0-9a-f]{16}$` (the TS SSoT regex). Used at trust
    /// boundaries where the candidate is operator- or device-supplied.
    ///
    /// # Errors
    /// Returns [`TenantContextError::InvalidSchemaName`] if the input
    /// does not match the whitelist exactly. The bad value is NOT
    /// echoed back so audit logs cannot be poisoned.
    pub fn try_parse(candidate: &str) -> Result<Self, TenantContextError> {
        if candidate.len() != 7 + 16 {
            return Err(TenantContextError::InvalidSchemaName);
        }
        if !candidate.starts_with("tenant_") {
            return Err(TenantContextError::InvalidSchemaName);
        }
        let Some(hex_part) = candidate.get(7..) else {
            return Err(TenantContextError::InvalidSchemaName);
        };
        if !hex_part
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(TenantContextError::InvalidSchemaName);
        }
        Ok(Self(candidate.to_owned()))
    }

    /// Borrow as `&str` for SQL identifier quoting.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SchemaName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

// ---------- Scoped<'brand, T> + TenantCtx<'brand> -------------------------

/// Invariant lifetime brand. Values produced inside one [`with_tenant`]
/// invocation cannot be smuggled into another, because the brand
/// lifetime is invariant (cannot be coerced to a different lifetime).
///
/// The `fn(&'brand ()) -> &'brand ()` trick gives us invariance without
/// requiring `unsafe`. See the GhostCell paper (RustBelt, ICFP 2021).
type Brand<'brand> = PhantomData<fn(&'brand ()) -> &'brand ()>;

/// Tenant-scoped runtime context. Holds the [`TenantId`] +
/// [`SchemaName`] for downstream use and carries an invariant lifetime
/// brand so [`Scoped`] values that share its brand cannot leak out of
/// the [`with_tenant`] closure.
#[derive(Debug)]
pub struct TenantCtx<'brand> {
    tenant_id: TenantId,
    schema_name: SchemaName,
    _brand: Brand<'brand>,
}

// See note above — `'brand` is named for architectural clarity, not
// because the lint is broken.
#[allow(clippy::elidable_lifetime_names)]
impl<'brand> TenantCtx<'brand> {
    /// Tenant id for this context.
    #[must_use]
    pub const fn tenant_id(&self) -> TenantId {
        self.tenant_id
    }

    /// Schema name for this context. ADR-011 shape, ready to feed to
    /// `format_ident!` / SQL identifier quoting on the persistence
    /// boundary.
    #[must_use]
    pub fn schema_name(&self) -> &SchemaName {
        &self.schema_name
    }

    /// Wrap a value in a [`Scoped`] tied to this context's brand. The
    /// resulting [`Scoped`] cannot escape the [`with_tenant`] closure
    /// because the brand lifetime is invariant.
    #[must_use]
    pub fn scope<T>(&self, value: T) -> Scoped<'brand, T> {
        Scoped {
            inner: value,
            _brand: PhantomData,
        }
    }

    /// Consume a [`Scoped`] under THIS context, returning the inner
    /// value. The brand lifetime on `self` and `scoped` MUST match,
    /// which is the architectural primitive of this crate: a
    /// `TenantCtx` for tenant B cannot unwrap a `Scoped` produced by
    /// tenant A — the unification fails at compile time.
    ///
    /// This is the function that makes the GhostCell brand load-bearing.
    /// `into_inner` exists for trust-boundary egress (serialise to
    /// wire, hand to NATS publisher, etc.) where the brand is no
    /// longer the right invariant; `unwrap_scoped` is the inside-the-
    /// system path.
    #[must_use]
    pub fn unwrap_scoped<T>(&self, scoped: Scoped<'brand, T>) -> T {
        scoped.inner
    }
}

/// Lifetime-branded value wrapper. A `Scoped<'brand, T>` can only be
/// consumed by code that holds a `TenantCtx<'brand>` with the same
/// brand lifetime. Mixing values from two different `with_tenant`
/// invocations fails to compile.
#[derive(Debug)]
pub struct Scoped<'brand, T> {
    inner: T,
    _brand: Brand<'brand>,
}

// `'brand` is intentionally named (not elided) because it is the
// architectural primitive of this crate — readers MUST see that the
// methods carry a brand. Eliding to `'_` would obscure the GhostCell
// pattern. Same rationale for `TenantCtx<'brand>` above.
#[allow(clippy::elidable_lifetime_names)]
impl<'brand, T> Scoped<'brand, T> {
    /// Borrow the inner value (still scoped — borrows live no longer
    /// than the brand).
    #[must_use]
    pub const fn get(&self) -> &T {
        &self.inner
    }

    /// Mutable borrow of the inner value.
    pub const fn get_mut(&mut self) -> &mut T {
        &mut self.inner
    }

    /// Unwrap the inner value, dropping the brand. The caller is now
    /// responsible for re-scoping (or deciding the value is safe at
    /// trust-boundary egress, e.g. when serialising to the wire with
    /// the tenant id explicit in the payload).
    #[must_use]
    pub fn into_inner(self) -> T {
        self.inner
    }
}

/// Open a tenant brand for the duration of `f`. The closure receives a
/// [`TenantCtx`] whose brand cannot escape; any [`Scoped`] values it
/// returns through `into_inner` lose the brand at egress (caller takes
/// over).
pub fn with_tenant<R, F>(tenant_id: TenantId, f: F) -> R
where
    F: for<'brand> FnOnce(&TenantCtx<'brand>) -> R,
{
    let ctx = TenantCtx {
        tenant_id,
        schema_name: SchemaName::from_tenant_id(tenant_id),
        _brand: PhantomData,
    };
    f(&ctx)
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{SchemaName, Scoped, TenantContextError, TenantCtx, TenantId, with_tenant};

    fn fixed_uuid(seed: u8) -> Uuid {
        // Deterministic UUID for tests. Pattern: 1 byte seed, rest zero.
        let mut bytes = [0_u8; 16];
        bytes[0] = seed;
        Uuid::from_bytes(bytes)
    }

    #[test]
    fn tenant_id_round_trip() {
        let u = fixed_uuid(0xAB);
        let id = TenantId::from_uuid(u);
        assert_eq!(id.as_uuid(), &u);
    }

    #[test]
    fn tenant_id_try_parse_strict() {
        let s = "550e8400-e29b-41d4-a716-446655440000";
        let id = TenantId::try_parse(s).unwrap();
        assert_eq!(id.as_uuid().to_string(), s);
    }

    #[test]
    fn tenant_id_try_parse_rejects_garbage() {
        assert!(TenantId::try_parse("nope").is_err());
        assert!(TenantId::try_parse("").is_err());
    }

    #[test]
    fn schema_name_shape_matches_platform_ssot() {
        let id = TenantId::try_parse("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let s = SchemaName::from_tenant_id(id);
        // TS SSoT: tenant_ + first 16 hex of the de-hyphenated UUID.
        assert_eq!(s.as_str(), "tenant_550e8400e29b41d4");
        assert_eq!(s.as_str().len(), 7 + 16);
    }

    #[test]
    fn schema_name_try_parse_round_trips() {
        let raw = "tenant_550e8400e29b41d4";
        let parsed = SchemaName::try_parse(raw).unwrap();
        assert_eq!(parsed.as_str(), raw);
    }

    #[test]
    fn schema_name_try_parse_rejects_uppercase_hex() {
        // The platform fixes lowercase. Uppercase MUST be rejected (a real
        // attacker tactic is to substitute homograph chars; locking
        // the alphabet eliminates the class).
        let raw = "tenant_550E8400E29B41D4";
        assert_eq!(
            SchemaName::try_parse(raw).unwrap_err(),
            TenantContextError::InvalidSchemaName,
        );
    }

    #[test]
    fn schema_name_try_parse_rejects_wrong_prefix() {
        let raw = "TENANT_550e8400e29b41d4";
        assert_eq!(
            SchemaName::try_parse(raw).unwrap_err(),
            TenantContextError::InvalidSchemaName,
        );
    }

    #[test]
    fn schema_name_rejects_legacy_32_hex_shape() {
        // The pre-Task-3 shape (full 32 hex) must now FAIL parse: schemas
        // in that form are invisible to every platform scanner.
        let raw = "tenant_550e8400e29b41d4a716446655440000";
        assert_eq!(
            SchemaName::try_parse(raw).unwrap_err(),
            TenantContextError::InvalidSchemaName,
        );
    }

    #[test]
    fn schema_name_try_parse_rejects_short() {
        assert!(SchemaName::try_parse("tenant_abc").is_err());
        assert!(SchemaName::try_parse("").is_err());
    }

    #[test]
    fn schema_name_try_parse_rejects_long() {
        let raw = "tenant_550e8400e29b41d4a716446655440000extra";
        assert!(SchemaName::try_parse(raw).is_err());
    }

    #[test]
    fn schema_name_try_parse_rejects_non_hex() {
        let raw = "tenant_550e8400e29b41d4a716446655zz0000";
        assert!(SchemaName::try_parse(raw).is_err());
    }

    #[test]
    fn schema_name_error_does_not_leak_input() {
        // Audit-log poisoning vector: attacker-supplied bytes must not
        // appear in the error Display output.
        let bad = "tenant_<script>alert(1)</script>";
        let err = SchemaName::try_parse(bad).unwrap_err();
        assert!(!err.to_string().contains("script"));
    }

    #[test]
    fn with_tenant_provides_ctx() {
        let id = TenantId::from_uuid(fixed_uuid(0x42));
        with_tenant(id, |ctx: &TenantCtx<'_>| {
            assert_eq!(ctx.tenant_id(), id);
            assert!(ctx.schema_name().as_str().starts_with("tenant_"));
        });
    }

    #[test]
    fn scoped_round_trip_within_one_brand() {
        let id = TenantId::from_uuid(fixed_uuid(0x42));
        let unwrapped: i32 = with_tenant(id, |ctx| {
            let scoped: Scoped<'_, i32> = ctx.scope(7_i32);
            // Borrow inside the brand.
            assert_eq!(*scoped.get(), 7);
            // Egress at the end of the closure — caller takes ownership.
            scoped.into_inner()
        });
        assert_eq!(unwrapped, 7);
    }

    // The cross-tenant misuse compile_fail tests live under
    // `tests/compile_fail/` and run via the trybuild harness in
    // `tests/cross_tenant_compile_fail.rs`.
}
