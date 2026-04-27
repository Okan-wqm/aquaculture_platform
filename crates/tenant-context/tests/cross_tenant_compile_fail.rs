//! Compile-fail harness: proves that the GhostCell brand on
//! [`tenant_context::Scoped`] cannot be smuggled across two
//! `with_tenant` invocations.
//!
//! Each `tests/compile_fail/*.rs` file is a tiny standalone program
//! that the harness expects to FAIL to compile. If any of them ever
//! starts compiling, the brand has a hole and this test fails.
//!
//! Run via `cargo test -p tenant-context --test cross_tenant_compile_fail`.

#![allow(clippy::unwrap_used, clippy::panic, clippy::expect_used)]

#[test]
fn cross_tenant_smuggle_does_not_compile() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/*.rs");
}
