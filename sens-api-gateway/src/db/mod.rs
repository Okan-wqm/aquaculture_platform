//! Data-access foundations for the edge agent's SQLCipher stores.
//!
//! EDGE-HIGH-026: this module owns the single canonical SQLCipher open
//! ceremony (`sqlcipher_factory`). Every steady-state store opener routes
//! through it so the `PRAGMA key` literal, the KDF/journal/synchronous/
//! busy_timeout/auto_vacuum sequence, and the raw-key format live in ONE
//! place instead of being hand-rolled (and drifting) across ~19 callsites.
//!
//! The only other legitimate `PRAGMA key` / `PRAGMA rekey` users are the
//! v1→v2 migration ceremonies under `db_migration/` (rekey.rs, rekey_swap.rs,
//! cli*.rs); those open a DB solely to run the rekey and are allowlisted by
//! the `sqlcipher_factory_ssot` invariant test.

pub mod sqlcipher_factory;
