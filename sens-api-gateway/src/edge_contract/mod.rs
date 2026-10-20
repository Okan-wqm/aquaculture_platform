//! Suderra edge contract v1 as the agent verifies it (ADR-048 DEC-3,
//! DEC-25).
//!
//! Implements `contracts/suderra-edge/v1` for the statements the agent
//! relies on: DSSE envelopes signed over the exact payload bytes and checked
//! with ed25519-dalek `verify_strict`, the strict JSON rules, typed statement
//! schemas that deny unknown members, per-purpose and per-epoch key
//! resolution, and the checks of statements.json in their normative order,
//! minus the ones `verified_by.agent.omits` assigns to root alone.
//!
//! The module depends on external crates only, never on `crate::`, so
//! `tests/contracts_golden.rs` compiles it into its own test crate and holds
//! it to every golden fixture of the contract.

pub mod dsse;
pub mod encoding;
pub mod json;
pub mod keys;
pub mod registry;
pub mod statements;
pub mod verify;
