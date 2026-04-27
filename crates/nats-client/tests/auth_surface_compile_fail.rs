//! Compile-fail harness: proves that [`nats_client::NatsClient`]
//! cannot be configured with username/password, token, or nkey auth.
//!
//! ADR-014/015 require cert-only identity. The wrapper enforces this
//! by NOT exposing those constructors at all. If someone ever adds
//! such a method, the compile_fail tests below will start to compile
//! and this trybuild test will fail.

#![allow(clippy::unwrap_used, clippy::panic, clippy::expect_used)]

#[test]
fn no_user_pass_or_token_constructor_exists() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/auth_surface_compile_fail/*.rs");
}
