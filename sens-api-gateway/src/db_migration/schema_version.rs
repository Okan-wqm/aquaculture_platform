//! `DbKeySchemaVersion` enum (Batch #329 D-3 primitive-first).
//!
//! ## Why a versioned enum (not a magic integer)
//!
//! The wire format on disk is a JSON sidecar carrying a
//! schema version tag. The reader MUST be able to refuse
//! unknown versions fail-closed (forward-incompat
//! scenario) AND distinguish v1 (machine-id-derived)
//! from v2 (keystore-derived) at the type level so the
//! consumer's key derivation match arm is exhaustive —
//! a `match` on `DbKeySchemaVersion` is checked by the
//! compiler when a v3 variant lands.
//!
//! ## Why two variants today
//!
//! - **`V1MachineIdDerived`** is the LEGACY path
//!   (`offline_queue::derive_db_encryption_key` —
//!   `HMAC-SHA256(machine_id, /etc/suderra/db.key)`).
//!   The audit history captured this is INSUFFICIENT
//!   as sole key material because `/etc/machine-id` is
//!   world-readable and `/etc/suderra/db.key` lives
//!   outside the D-1a/D-1b/D-2 keystore hierarchy
//!   (no TPM seal, no mlock, no zeroize-on-drop).
//!
//! - **`V2KeystoreDerived`** is the TARGET path. The
//!   SQLCipher key is HKDF-Expand'd from the keystore
//!   master via `Keystore::derive_key(KeyPurpose::
//!   SqlCipherOfflineQueue, &db_path_bytes)`. This puts
//!   the key under all the D-1a (TPM seal) / D-1b
//!   (rotation cadence) / D-2 (mlock + memfd_secret +
//!   zeroize-on-drop) protections automatically.
//!
//! ## JSON wire shape
//!
//! Serialized as a string discriminator (NOT an integer)
//! so the on-disk file is operator-readable: an incident-
//! response engineer can `cat offline_queue.db.key-source.json`
//! and see `"schema_version": "v1-machine-id-derived"`
//! without having to memorize integer codes. String
//! discriminators also make schema_version mismatches
//! self-documenting in error logs.
//!
//! ## Why `#[serde(rename_all = "kebab-case")]`
//!
//! Matches the rest of the suderra-agent JSON wire
//! convention (config.toml-derived structs use kebab-case
//! field names; the keystore_rotation_marker schema_version
//! field is an integer but predates this convention). The
//! kebab-case discriminator is also the ergonomic fit for
//! a human-readable JSON sidecar.

use serde::{Deserialize, Serialize};

/// Schema version of the SQLCipher key derivation in
/// effect for a given DB file. Persisted as a string
/// discriminator in the `*.key-source.json` sidecar.
///
/// **Variant lifecycle:**
///
/// | variant                  | status   | derivation                                                                |
/// |--------------------------|----------|---------------------------------------------------------------------------|
/// | `V1MachineIdDerived`     | LEGACY   | `HMAC-SHA256(machine_id, /etc/suderra/db.key)` — pre-keystore             |
/// | `V2KeystoreDerived`      | TARGET   | `Keystore::derive_key(SqlCipherOfflineQueue, &db_path)` — D-1a/D-1b/D-2   |
///
/// Adding a `V3*` variant requires a coordinated migration
/// arc (manifest write path bumps the wire version + every
/// reader's match arm extends + a migration binary rekeys
/// existing v1/v2 DBs to v3 via `PRAGMA rekey`). The enum
/// is `#[non_exhaustive]` so external callers cannot
/// pattern-match without a wildcard arm — preserves
/// forward-compat at the type level when a new variant
/// lands in a future batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum DbKeySchemaVersion {
    /// Pre-keystore legacy derivation. Reader recognizes
    /// this version + dispatches to the v1 derivation
    /// function. Boot-time detector emits a structured
    /// WARN log + bumps a Prometheus metric so operators
    /// see the migration backlog.
    V1MachineIdDerived,
    /// Keystore-derived (D-1a/D-1b/D-2 protected). The
    /// production target. Default for newly-created DBs
    /// once the consumer-migration batch lands.
    V2KeystoreDerived,
}

impl DbKeySchemaVersion {
    /// The current TARGET schema version for newly-created
    /// DBs. Boot-time detector compares this to the on-disk
    /// manifest's version to decide whether the DB needs
    /// migration.
    ///
    /// **Why a method, not a const:** the target advances
    /// across releases (today v2; future v3). Encoding it
    /// as an associated method keeps the call sites
    /// expressive (`DbKeySchemaVersion::current_target()`
    /// reads as the architectural intent — "what version
    /// SHOULD a new DB be") + the future v2→v3 bump is a
    /// single-line change that ripples through every
    /// caller automatically.
    pub fn current_target() -> Self {
        Self::V2KeystoreDerived
    }

    /// True when this version requires migration to the
    /// current target. Used by the boot-time detector to
    /// decide whether to log the migration-backlog warning.
    ///
    /// **Why not derive from `==`:** the future may add a
    /// v3 variant where `current_target()` jumps to v3 but
    /// v2 is still acceptable (backward-compat window). The
    /// method gives that future flexibility without
    /// callsite churn.
    pub fn requires_migration_to_current_target(&self) -> bool {
        // Today: anything other than the current target
        // requires migration. Future versions may relax
        // this when a backward-compat window applies.
        *self != Self::current_target()
    }
}

impl std::fmt::Display for DbKeySchemaVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Mirrors the kebab-case JSON discriminator so
        // operator log lines + JSON sidecar values use the
        // SAME string — no mental translation required when
        // reading both side-by-side.
        match self {
            Self::V1MachineIdDerived => f.write_str("v1-machine-id-derived"),
            Self::V2KeystoreDerived => f.write_str("v2-keystore-derived"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip JSON: serialize V1 + V2 + parse back
    /// + bytes match the documented kebab-case wire form.
    #[test]
    fn schema_version_serializes_to_kebab_case_string() {
        let v1 = DbKeySchemaVersion::V1MachineIdDerived;
        let v1_json = serde_json::to_string(&v1).expect("ser");
        assert_eq!(v1_json, "\"v1-machine-id-derived\"");

        let v2 = DbKeySchemaVersion::V2KeystoreDerived;
        let v2_json = serde_json::to_string(&v2).expect("ser");
        assert_eq!(v2_json, "\"v2-keystore-derived\"");
    }

    /// Round-trip JSON: parse the kebab-case string back
    /// to the typed variant. Pins the wire-format contract
    /// against accidental rename refactors.
    #[test]
    fn schema_version_deserializes_from_kebab_case_string() {
        let v1: DbKeySchemaVersion = serde_json::from_str("\"v1-machine-id-derived\"").expect("de");
        assert_eq!(v1, DbKeySchemaVersion::V1MachineIdDerived);

        let v2: DbKeySchemaVersion = serde_json::from_str("\"v2-keystore-derived\"").expect("de");
        assert_eq!(v2, DbKeySchemaVersion::V2KeystoreDerived);
    }

    /// Unknown discriminators fail-closed. A future v3
    /// rolled out by a newer agent must NOT silently parse
    /// as v2 on an older reader — the older reader emits
    /// a structured error so the operator sees the version
    /// skew rather than corrupting the DB with the wrong
    /// key.
    #[test]
    fn schema_version_rejects_unknown_discriminator() {
        let result: Result<DbKeySchemaVersion, _> = serde_json::from_str("\"v99-future-format\"");
        assert!(
            result.is_err(),
            "unknown variant must fail-closed: {:?}",
            result
        );
    }

    /// Display string matches the JSON wire string exactly
    /// — operator log line + JSON sidecar value are
    /// byte-identical when stringified.
    #[test]
    fn schema_version_display_matches_wire_string() {
        assert_eq!(
            format!("{}", DbKeySchemaVersion::V1MachineIdDerived),
            "v1-machine-id-derived"
        );
        assert_eq!(
            format!("{}", DbKeySchemaVersion::V2KeystoreDerived),
            "v2-keystore-derived"
        );
    }

    /// `current_target` returns V2 today. A future bump to
    /// v3 is a deliberate single-line change — this test
    /// pins TODAY's target so the bump is visible in the
    /// diff.
    #[test]
    fn current_target_is_v2_keystore_derived() {
        assert_eq!(
            DbKeySchemaVersion::current_target(),
            DbKeySchemaVersion::V2KeystoreDerived
        );
    }

    /// Migration-required predicate fires for v1 (legacy)
    /// + does NOT fire for v2 (the current target). Boot-
    /// time detector relies on this exact semantic to
    /// decide whether to emit the migration-backlog WARN.
    #[test]
    fn requires_migration_fires_for_v1_only() {
        assert!(
            DbKeySchemaVersion::V1MachineIdDerived.requires_migration_to_current_target(),
            "v1 must require migration to v2 target"
        );
        assert!(
            !DbKeySchemaVersion::V2KeystoreDerived.requires_migration_to_current_target(),
            "v2 (current target) must NOT require migration"
        );
    }

    /// `Copy + Clone + Eq + Hash` derives are required by
    /// future consumers (HashMap key for per-DB key cache
    /// in the boot detector). Pin the trait surface so a
    /// refactor that drops a derive breaks here, not at
    /// the consumer call site.
    #[test]
    fn schema_version_implements_copy_clone_eq_hash() {
        fn assert_copy<T: Copy>() {}
        fn assert_clone<T: Clone>() {}
        fn assert_eq<T: Eq>() {}
        fn assert_hash<T: std::hash::Hash>() {}
        assert_copy::<DbKeySchemaVersion>();
        assert_clone::<DbKeySchemaVersion>();
        assert_eq::<DbKeySchemaVersion>();
        assert_hash::<DbKeySchemaVersion>();
    }
}
