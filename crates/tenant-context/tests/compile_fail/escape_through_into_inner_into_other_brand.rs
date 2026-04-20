//! Should NOT compile: tries to unwrap a `Scoped` value under a
//! `TenantCtx` from a DIFFERENT `with_tenant` brand.
//!
//! This is the load-bearing test for the GhostCell brand on
//! `tenant-context`: if the compiler ever lets this through, an alert
//! engine running under tenant B could unwrap tenant A's reading —
//! exactly the class ADR-025 § Threat 2 forbids.
//!
//! The brand lifetime is invariant (see `Brand<'brand>`'s definition
//! using a `fn(&'brand ()) -> &'brand ()` PhantomData), and each
//! `with_tenant` opens a fresh, unrelated brand via the higher-ranked
//! trait bound `for<'brand> FnOnce(&TenantCtx<'brand>) -> R`. The two
//! brand lifetimes therefore cannot unify and the call below has to
//! fail to compile with a "lifetime may not live long enough" error.

use tenant_context::{TenantCtx, TenantId, with_tenant};
use uuid::Uuid;

fn main() {
    let a = TenantId::from_uuid(Uuid::nil());
    let b = TenantId::from_uuid(Uuid::nil());

    with_tenant(a, |ctx_a: &TenantCtx<'_>| {
        // Inside brand A: produce a Scoped value.
        let scoped_a = ctx_a.scope(7_i32);

        with_tenant(b, |ctx_b: &TenantCtx<'_>| {
            // CROSS-BRAND CALL: ctx_b has brand 'b, scoped_a has brand
            // 'a. The signature of unwrap_scoped requires the same
            // brand on both arguments, so the unification fails.
            let _leaked: i32 = ctx_b.unwrap_scoped(scoped_a);
        });
    });
}
