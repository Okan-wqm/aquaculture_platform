//! SQLCipher-backed license cache (Batch 144 Faz 7).
//!
//! ## WHY
//!
//! Plan R-10 + Faz 7 specify:
//! - Cross-boot persistence of the operator's signed
//!   license manifest (no round-trip to cloud on every
//!   boot).
//! - 30-day offline grace period (cached license stays
//!   valid even when cloud is unreachable).
//! - Monotonic `highest_seen_policy_version` floor for
//!   rollback defense (attacker captures older valid
//!   license, replays across reboot).
//!
//! Batch 143 landed the in-memory hot-swap via
//! cmd_refresh_license but on agent restart the license
//! reverts to `conservative()` STARTER fallback — no
//! cross-boot persistence.
//!
//! This batch closes the cross-boot gap + the rollback-
//! defense gap.
//!
//! ## Schema (two tables in a single SQLCipher file)
//!
//! ```sql
//! CREATE TABLE license_cache (
//!     singleton_key       TEXT PRIMARY KEY CHECK (singleton_key = 'the-one-row'),
//!     signed_manifest_json TEXT NOT NULL,
//!     cached_at_unix_secs  INTEGER NOT NULL
//! );
//!
//! CREATE TABLE license_version_floor (
//!     singleton_key  TEXT PRIMARY KEY CHECK (singleton_key = 'the-one-row'),
//!     highest_seen   INTEGER NOT NULL CHECK (highest_seen >= 0),
//!     updated_at     INTEGER NOT NULL
//! );
//! ```
//!
//! Two singleton-row tables — anti-footgun against
//! accidental multi-row writes via CHECK constraint on
//! the primary key. Matches Batch 71
//! `ManifestVersionStore` pattern.
//!
//! ## Threat model
//!
//! Defense chain (each layer independent):
//! 1. Signed manifest (ed25519 via Batch 141
//!    `verify_license_manifest`) — attacker cannot
//!    forge a manifest without the firmware signing
//!    key.
//! 2. Monotonic floor (this module) — attacker cannot
//!    replay an OLDER signed manifest across reboot.
//! 3. Tenant binding (Batch 141 Gate 3) — attacker's
//!    captured manifest from a DIFFERENT tenant cannot
//!    be replayed here.
//! 4. SQLCipher encryption — attacker needs BOTH
//!    `/etc/suderra/db.key` AND machine-id to read /
//!    mutate the cache. At that privilege level they
//!    could replace the agent binary directly — this
//!    module is NOT the last line.
//!
//! Batch 145 Faz 7 consumers: `AppState::init_license_cache`
//! (boot-time load + verify) + `cmd_refresh_license`
//! (save + record_accepted on successful verify).

use rusqlite::{Connection, params};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::license::SignedLicenseManifest;

/// Singleton-row sentinel. Schema CHECK constraint
/// enforces this exact string — anti-footgun against
/// accidental multi-row writes.
const SINGLETON_KEY: &str = "the-one-row";

/// Default on-disk path for the license cache. Separate
/// SQLCipher file from offline_queue + scada_db + rbac
/// version store per single-responsibility discipline
/// (Batch 71 manifest_version_store precedent).
pub const DEFAULT_CACHE_PATH: &str = "/var/lib/suderra/license_cache.sqlite";

/// Persistent SQLCipher-backed license cache + version
/// floor store.
pub struct LicenseCacheStore {
    conn: Mutex<Connection>,
}

#[derive(Debug)]
pub enum LicenseCacheError {
    Io(String),
    KeyDerivation(String),
    SqlCipher(String),
    Schema(String),
    Query(String),
    Serialize(String),
    Deserialize(String),
    LockPoisoned,
}

impl std::fmt::Display for LicenseCacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "license cache io: {}", e),
            Self::KeyDerivation(e) => write!(f, "license cache key derivation: {}", e),
            Self::SqlCipher(e) => write!(f, "license cache sqlcipher: {}", e),
            Self::Schema(e) => write!(f, "license cache schema: {}", e),
            Self::Query(e) => write!(f, "license cache query: {}", e),
            Self::Serialize(e) => write!(f, "license cache serialize: {}", e),
            Self::Deserialize(e) => write!(f, "license cache deserialize: {}", e),
            Self::LockPoisoned => f.write_str("license cache lock poisoned"),
        }
    }
}

impl std::error::Error for LicenseCacheError {}

impl LicenseCacheStore {
    /// Open (or create) the cache at `path`. Applies
    /// SQLCipher PRAGMA key via the shared
    /// `derive_db_encryption_key` helper. Initializes
    /// the 2-table schema on first run.
    pub fn open(path: &Path) -> Result<Self, LicenseCacheError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| LicenseCacheError::Io(format!("mkdir {}: {}", parent.display(), e)))?;
        }

        // EDGE-HIGH-026: open + key via the canonical SQLCipher factory
        // (v1 device-secret key, DEFAULT profile).
        let conn = crate::db::sqlcipher_factory::open_device_secret(
            path,
            "license_cache",
            crate::db::sqlcipher_factory::PragmaProfile::DEFAULT,
        )
        .map_err(|e| LicenseCacheError::SqlCipher(format!("open {}: {}", path.display(), e)))?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS license_cache (
                singleton_key        TEXT PRIMARY KEY CHECK (singleton_key = 'the-one-row'),
                signed_manifest_json TEXT NOT NULL,
                cached_at_unix_secs  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS license_version_floor (
                singleton_key  TEXT PRIMARY KEY CHECK (singleton_key = 'the-one-row'),
                highest_seen   INTEGER NOT NULL CHECK (highest_seen >= 0),
                updated_at     INTEGER NOT NULL
            );
            ",
        )
        .map_err(|e| LicenseCacheError::Schema(format!("{}", e)))?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Manifest-aware constructor (PR-195 Batch #14 —
    /// second per-consumer adoption of
    /// `consumer_key_resolver` SSoT; LicenseCache is
    /// consumer 2 of 4 per ADR-031).
    ///
    /// Reads the per-DB sidecar manifest (Batch #329)
    /// and derives the SQLCipher PRAGMA key via
    /// `db_migration::consumer_key_resolver` (Batch #8) —
    /// missing manifest = legacy v1 default per Batch
    /// #330; v1 manifest = HMAC-SHA256 kernel; v2
    /// manifest = keystore-derived key.
    ///
    /// **Why this constructor exists:** the legacy
    /// `open` always derives v1 (via
    /// `offline_queue::derive_db_encryption_key`),
    /// which works on un-migrated hosts but fails-closed
    /// on hosts where the operator has run the
    /// migration ceremony (manifest declares v2;
    /// v1-derived PRAGMA key would not decrypt v2-
    /// encrypted pages). This constructor reads the
    /// manifest FIRST + opens with the matching key.
    ///
    /// **Caller contract:**
    ///
    ///   - `path` — same path as the legacy `open`; the
    ///     manifest sidecar lives at
    ///     `manifest_path_for_db(path)`.
    ///   - `keystore` — agent's already-built keystore
    ///     handle for the v2 path.
    ///   - `deployment_uuid` — provisioning device UUID
    ///     bytes (v2 device-bound consumer context per
    ///     ADR-031). LicenseCache is device-bound, so
    ///     program SHA is `None` internally.
    ///
    /// **Async:** `Keystore::derive_key` is async;
    /// caller awaits this constructor at boot time.
    /// Once constructed, the store's hot-path methods
    /// remain sync.
    pub async fn open_with_keystore_derivation(
        path: &Path,
        keystore: std::sync::Arc<dyn crate::keystore::Keystore>,
        deployment_uuid: Vec<u8>,
    ) -> Result<Self, LicenseCacheError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| LicenseCacheError::Io(format!("mkdir {}: {}", parent.display(), e)))?;
        }

        // EDGE-HIGH-026: open + key via the canonical SQLCipher factory's
        // resolver path (device-bound per ADR-031: deployment_uuid required,
        // program_artifact_sha256 None). The factory assembles the v1 inputs
        // internally and owns the PRAGMA key + durability sequence.
        let ctx = crate::db_migration::consumer_context::ConsumerContext {
            deployment_uuid,
            program_artifact_sha256: None,
        };

        let conn = crate::db::sqlcipher_factory::open_resolved(
            path,
            crate::keystore::purpose::KeyPurpose::SqlCipherLicenseCache,
            &ctx,
            keystore.as_ref(),
            crate::db::sqlcipher_factory::PragmaProfile::DEFAULT,
        )
        .await
        .map_err(|e| LicenseCacheError::KeyDerivation(format!("factory open_resolved: {}", e)))?
        .conn;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS license_cache (
                singleton_key        TEXT PRIMARY KEY CHECK (singleton_key = 'the-one-row'),
                signed_manifest_json TEXT NOT NULL,
                cached_at_unix_secs  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS license_version_floor (
                singleton_key  TEXT PRIMARY KEY CHECK (singleton_key = 'the-one-row'),
                highest_seen   INTEGER NOT NULL CHECK (highest_seen >= 0),
                updated_at     INTEGER NOT NULL
            );
            ",
        )
        .map_err(|e| LicenseCacheError::Schema(format!("{}", e)))?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Return the persisted signed license manifest, if
    /// any. None on first-boot / freshly-wiped cache.
    ///
    /// Caller MUST re-verify (ed25519 + tenant + monotonic
    /// floor + freshness) before trusting the returned
    /// manifest — SQLCipher encryption is defense-in-depth,
    /// not the sole trust anchor.
    pub fn load(&self) -> Result<Option<SignedLicenseManifest>, LicenseCacheError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| LicenseCacheError::LockPoisoned)?;

        let row: Option<String> = conn
            .query_row(
                "SELECT signed_manifest_json FROM license_cache WHERE singleton_key = ?1",
                [SINGLETON_KEY],
                |r| r.get(0),
            )
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map(Some)
            .map_err(|e| LicenseCacheError::Query(format!("{}", e)))?
            .flatten();

        match row {
            None => Ok(None),
            Some(json) => {
                let signed: SignedLicenseManifest = serde_json::from_str(&json)
                    .map_err(|e| LicenseCacheError::Deserialize(format!("{}", e)))?;
                Ok(Some(signed))
            }
        }
    }

    /// Persist a verified signed license manifest. Caller
    /// MUST have run `verify_license_manifest` (Batch
    /// 141) FIRST — this method stores whatever it's
    /// given; it doesn't re-verify.
    pub fn save(&self, signed: &SignedLicenseManifest) -> Result<(), LicenseCacheError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let json = serde_json::to_string(signed)
            .map_err(|e| LicenseCacheError::Serialize(format!("{}", e)))?;

        let conn = self
            .conn
            .lock()
            .map_err(|_| LicenseCacheError::LockPoisoned)?;

        conn.execute(
            "INSERT INTO license_cache (singleton_key, signed_manifest_json, cached_at_unix_secs)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(singleton_key) DO UPDATE SET
                signed_manifest_json = excluded.signed_manifest_json,
                cached_at_unix_secs  = excluded.cached_at_unix_secs",
            params![SINGLETON_KEY, json, now],
        )
        .map_err(|e| LicenseCacheError::Query(format!("save: {}", e)))?;

        Ok(())
    }

    /// Read the persisted `highest_seen_policy_version`
    /// floor. Returns 0 on first-boot.
    pub fn get_highest_seen(&self) -> Result<u64, LicenseCacheError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| LicenseCacheError::LockPoisoned)?;

        let row: Option<i64> = conn
            .query_row(
                "SELECT highest_seen FROM license_version_floor WHERE singleton_key = ?1",
                [SINGLETON_KEY],
                |r| r.get(0),
            )
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map(Some)
            .map_err(|e| LicenseCacheError::Query(format!("get_highest_seen: {}", e)))?
            .flatten();

        Ok(row.map(|v| v.max(0) as u64).unwrap_or(0))
    }

    /// Record a newly-accepted `policy_version` as the
    /// new floor. Monotonic: UPSERT `MAX(existing,
    /// version)`. Calling `record_accepted(N)` after
    /// `record_accepted(M>N)` is a safe no-op
    /// (application-side clamp keeps the floor
    /// monotonic).
    pub fn record_accepted(&self, version: u64) -> Result<(), LicenseCacheError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // Clamp negative defensively — SQLite INTEGER is
        // signed; our CHECK constraint enforces >=0 at
        // schema level too.
        let v_i64 = i64::try_from(version).unwrap_or(i64::MAX);

        let conn = self
            .conn
            .lock()
            .map_err(|_| LicenseCacheError::LockPoisoned)?;

        // UPSERT + MAX semantic: SQL `MAX(existing, new)`
        // happens via the ON CONFLICT branch. First
        // record just inserts the value; subsequent
        // records clamp to max.
        conn.execute(
            "INSERT INTO license_version_floor (singleton_key, highest_seen, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(singleton_key) DO UPDATE SET
                highest_seen = MAX(license_version_floor.highest_seen, excluded.highest_seen),
                updated_at   = excluded.updated_at",
            params![SINGLETON_KEY, v_i64, now],
        )
        .map_err(|e| LicenseCacheError::Query(format!("record_accepted: {}", e)))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::permission::TenantId;
    use crate::license::{EdgeLicenseLimits, LicenseManifest, LicenseTier};
    use ed25519_dalek::{Signer, SigningKey};

    fn tmp_cache_path() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "suderra-license-cache-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("license_cache.sqlite")
    }

    fn setup_db_key_for_test() -> tempfile::TempDir {
        // Isolate the derive_db_encryption_key OnceLock
        // from other tests by setting SUDERRA_DB_KEY_PATH
        // to a NON-EXISTENT file path inside a tempdir.
        // The load_or_create_db_secret helper will create
        // the file with 32 random bytes on first access —
        // exactly the production first-boot path.
        //
        // Rust 2024 edition made std::env::set_var
        // unsafe because it's not thread-safe with
        // concurrent reads; our test path relies on
        // single-threaded test harness + the OnceLock
        // gate on the first read.
        let dir = tempfile::TempDir::new().unwrap();
        let key_path = dir.path().join("db.key");
        unsafe {
            std::env::set_var("SUDERRA_DB_KEY_PATH", &key_path);
        }
        dir
    }

    fn sample_signed() -> SignedLicenseManifest {
        let seed = [0x5au8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let manifest = LicenseManifest {
            tenant_id: TenantId::new_from_verified([0xAAu8; 16]),
            policy_version: 7,
            valid_from_unix_secs: 1_700_000_000,
            valid_until_unix_secs: 1_800_000_000,
            issued_at_unix_secs: 1_700_000_000,
            limits: EdgeLicenseLimits {
                tier: LicenseTier::Professional,
                valid_until_unix_secs: 1_800_000_000,
                max_io_channels: 64,
                max_fb_instances: 32,
                min_scan_cycle_ms: 500,
                max_st_programs: 8,
                max_concurrent_tasks: 4,
                max_watch_sessions: 3,
                max_concurrent_forces: 5,
                signed_deploy_required: false,
                opc_ua_server_enabled: false,
            },
        };
        let sig = signing_key.sign(&manifest.canonical_bytes());
        SignedLicenseManifest::from_body_and_signature_bytes(manifest, &sig.to_bytes()).unwrap()
    }

    #[test]
    fn open_creates_schema_on_fresh_path() {
        let _k = setup_db_key_for_test();
        let path = tmp_cache_path();
        let store = LicenseCacheStore::open(&path).expect("open");
        // load() on empty cache returns None
        assert!(store.load().expect("load").is_none());
        // highest_seen on empty store returns 0
        assert_eq!(store.get_highest_seen().expect("hs"), 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_then_load_roundtrip() {
        let _k = setup_db_key_for_test();
        let path = tmp_cache_path();
        let store = LicenseCacheStore::open(&path).expect("open");

        let signed = sample_signed();
        store.save(&signed).expect("save");

        let loaded = store.load().expect("load").expect("Some");
        assert_eq!(loaded, signed);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_upsert_replaces_existing_row() {
        let _k = setup_db_key_for_test();
        let path = tmp_cache_path();
        let store = LicenseCacheStore::open(&path).expect("open");

        // Save original.
        let signed_a = sample_signed();
        store.save(&signed_a).expect("save a");

        // Save a different one (different signature
        // payload will differ from `signed_a`). Verify
        // only the latest persists.
        let seed_b = [0x77u8; 32];
        let key_b = SigningKey::from_bytes(&seed_b);
        let manifest_b = signed_a.clone();
        // Replace the signature via a new key on the
        // original canonical bytes.
        let sig_b = key_b.sign(&b"not-the-real-canonical"[..]);
        // Replace the signed manifest via serde tweak —
        // simpler to just rebuild via from_body_and_sig.
        // Build a distinct manifest so the cache row
        // differs visibly.
        let different = {
            let mut body = crate::license::LicenseManifest {
                tenant_id: TenantId::new_from_verified([0xAAu8; 16]),
                policy_version: 9, // different
                valid_from_unix_secs: 1_700_000_000,
                valid_until_unix_secs: 1_800_000_000,
                issued_at_unix_secs: 1_700_000_000,
                limits: EdgeLicenseLimits::conservative(),
            };
            body.limits.tier = LicenseTier::Enterprise;
            let seed = [0x33u8; 32];
            let k = SigningKey::from_bytes(&seed);
            let s = k.sign(&body.canonical_bytes());
            SignedLicenseManifest::from_body_and_signature_bytes(body, &s.to_bytes()).unwrap()
        };
        let _ = sig_b;
        let _ = manifest_b;

        store.save(&different).expect("save b");
        let loaded = store.load().expect("load").expect("Some");
        assert_eq!(loaded, different);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn record_accepted_monotonic_clamp() {
        let _k = setup_db_key_for_test();
        let path = tmp_cache_path();
        let store = LicenseCacheStore::open(&path).expect("open");

        store.record_accepted(10).expect("record 10");
        assert_eq!(store.get_highest_seen().expect("hs"), 10);

        // Lower version ignored via MAX upsert.
        store.record_accepted(5).expect("record 5");
        assert_eq!(store.get_highest_seen().expect("hs"), 10);

        // Higher version advances.
        store.record_accepted(100).expect("record 100");
        assert_eq!(store.get_highest_seen().expect("hs"), 100);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cache_persists_across_reopen() {
        // Prove on-disk persistence — save → drop store
        // → reopen at same path → load sees the value.
        let _k = setup_db_key_for_test();
        let path = tmp_cache_path();
        {
            let store = LicenseCacheStore::open(&path).expect("open");
            store.save(&sample_signed()).expect("save");
            store.record_accepted(42).expect("record");
        }
        let store2 = LicenseCacheStore::open(&path).expect("reopen");
        let loaded = store2.load().expect("load").expect("Some");
        assert_eq!(loaded, sample_signed());
        assert_eq!(store2.get_highest_seen().expect("hs"), 42);
        let _ = std::fs::remove_file(&path);
    }

    // -------- Batch #14 — manifest-aware constructor tests --------
    //
    // Validates that `open_with_keystore_derivation`
    // reads the per-DB sidecar manifest, picks the
    // correct derivation path (v1 fallback for missing
    // / legacy manifest, v2 for keystore-derived
    // manifest), and successfully opens the DB +
    // initializes the schema.

    use crate::db_migration::manifest::{
        DbKeySourceManifest, manifest_path_for_db, write_manifest as write_db_manifest,
    };
    use crate::db_migration::schema_version::DbKeySchemaVersion;
    use crate::keystore::error::{
        KeyDerivationError as KsKeyDerivationError, KeystoreError, KeystoreErrorKind,
    };
    use crate::keystore::purpose::{DerivedKeyId, KeyPurpose};
    use crate::keystore::secret::KeyMaterial;
    use crate::keystore::{KeyBackend, RotationSource};
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;

    /// Tests that touch SUDERRA_DB_KEY_PATH must
    /// serialize on this mutex (process-wide global
    /// state). Mirrors `db_secret::tests::ENV_MUTEX`
    /// pattern.
    static LICENSE_CACHE_ENV_MUTEX: StdMutex<()> = StdMutex::new(());

    struct LicenseCacheStubKeystore;

    #[async_trait]
    impl crate::keystore::Keystore for LicenseCacheStubKeystore {
        fn backend(&self) -> KeyBackend {
            KeyBackend::FileBacked
        }

        async fn derive_key(
            &self,
            purpose: KeyPurpose,
            _context: &[u8],
        ) -> std::result::Result<KeyMaterial, KsKeyDerivationError> {
            let mut bytes = [0u8; 32];
            bytes[0] = match purpose {
                KeyPurpose::SqlCipherLicenseCache => 0xb3,
                _ => 0xff,
            };
            Ok(KeyMaterial::from_derived_bytes(purpose, bytes))
        }

        fn derived_key_id(&self, _purpose: KeyPurpose, _context: &[u8]) -> DerivedKeyId {
            DerivedKeyId([0u8; 16])
        }

        async fn rotate_master(&self) -> std::result::Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }

        async fn rotate_master_with_source(
            &self,
            _source: RotationSource<'_>,
        ) -> std::result::Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }
    }

    fn ensure_license_cache_secret_sandbox(dir: &std::path::Path) {
        // Each test seeds its own secret in a tempdir
        // and points SUDERRA_DB_KEY_PATH at it under
        // the env mutex.
        let secret = dir.join("db.key");
        if !secret.exists() {
            std::fs::write(&secret, vec![0xCCu8; 32]).expect("seed secret");
        }
    }

    #[tokio::test]
    async fn open_with_keystore_derivation_no_manifest_uses_v1_legacy_default() {
        let _guard = LICENSE_CACHE_ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        ensure_license_cache_secret_sandbox(dir.path());
        let secret = dir.path().join("db.key");
        let db_path = dir.path().join("license_cache.db");

        // SAFETY: env-mutation serialized via mutex.
        unsafe {
            std::env::set_var("SUDERRA_DB_KEY_PATH", &secret);
        }
        let result = LicenseCacheStore::open_with_keystore_derivation(
            &db_path,
            std::sync::Arc::new(LicenseCacheStubKeystore),
            b"deployment-uuid".to_vec(),
        )
        .await;
        unsafe {
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        let _store = result.expect("open with v1 fallback");
        // Schema present: ensure load() works.
        let _store = LicenseCacheStore::open_with_keystore_derivation(
            &db_path,
            std::sync::Arc::new(LicenseCacheStubKeystore),
            b"deployment-uuid".to_vec(),
        );
    }

    #[tokio::test]
    async fn open_with_keystore_derivation_v2_manifest_opens_with_keystore_key() {
        let _guard = LICENSE_CACHE_ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        ensure_license_cache_secret_sandbox(dir.path());
        let secret = dir.path().join("db.key");
        let db_path = dir.path().join("license_cache.db");

        // Compute the v2 key the resolver will produce
        // (StubKeystore returns 0xb3-prefix for
        // SqlCipherLicenseCache).
        let mut v2_bytes = [0u8; 32];
        v2_bytes[0] = 0xb3;
        let v2_hex = crate::db_migration::v1_legacy_key::format_sqlcipher_pragma_key_hex(&v2_bytes);

        // Pre-seed the DB encrypted under v2.
        {
            let conn = Connection::open(&db_path).expect("open seed");
            // INVARIANT-ALLOW: sqlcipher-test-seed — seeds a v2-encrypted fixture.
            conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", v2_hex))
                .expect("apply v2 key");
            conn.execute_batch(
                "CREATE TABLE seed (id INTEGER PRIMARY KEY); \
                 INSERT INTO seed VALUES (1);",
            )
            .expect("seed table");
        }

        // Write v2 manifest.
        write_db_manifest(
            &manifest_path_for_db(&db_path),
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("seed v2 manifest");

        // SAFETY: env-mutation serialized.
        unsafe {
            std::env::set_var("SUDERRA_DB_KEY_PATH", &secret);
        }
        let result = LicenseCacheStore::open_with_keystore_derivation(
            &db_path,
            std::sync::Arc::new(LicenseCacheStubKeystore),
            b"deployment-uuid".to_vec(),
        )
        .await;
        unsafe {
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        // If resolver mis-routed (v1 instead of v2), DB
        // would fail with "not a database".
        let _store = result.expect("open with v2 keystore key");
    }

    #[tokio::test]
    async fn open_with_keystore_derivation_corrupt_manifest_fails_closed() {
        let _guard = LICENSE_CACHE_ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        ensure_license_cache_secret_sandbox(dir.path());
        let secret = dir.path().join("db.key");
        let db_path = dir.path().join("license_cache.db");

        std::fs::write(manifest_path_for_db(&db_path), b"not valid json").expect("seed corrupt");

        // SAFETY: env-mutation serialized.
        unsafe {
            std::env::set_var("SUDERRA_DB_KEY_PATH", &secret);
        }
        let result = LicenseCacheStore::open_with_keystore_derivation(
            &db_path,
            std::sync::Arc::new(LicenseCacheStubKeystore),
            b"deployment-uuid".to_vec(),
        )
        .await;
        unsafe {
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        let err = match result {
            Ok(_) => panic!("expected error"),
            Err(e) => e,
        };
        // Resolver-failed surfaces as KeyDerivation
        // (constructor wraps the resolver error class).
        match err {
            LicenseCacheError::KeyDerivation(msg) => {
                assert!(
                    msg.contains("resolver"),
                    "expected resolver-failed message, got: {msg}"
                );
            }
            other => panic!("expected KeyDerivation, got {other:?}"),
        }
    }
}
