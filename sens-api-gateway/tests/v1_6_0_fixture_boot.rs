#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

//! TST-008 (ADR-048 DEC-4.8, DEC-28): the v1.6.0 generic-Linux (HC-1) fleet
//! keeps booting under this agent.
//!
//! `tests/fixtures/v1.6.0/` holds what an activated v1.6.0 device carries
//! (all TEST-ONLY material):
//!
//! * `config.yaml` — identity, tenant and broker credential inside the
//!   operator config, the base64-encoded `b64:` password included, as the
//!   v1.6.0 agent wrote it on activation;
//! * `db.key.TEST-ONLY` — the device secret v1.6.0 created at
//!   `/etc/suderra/db.key`;
//! * `machine-id` — the device's machine-id;
//! * `offline_queue.db` — a SQLCipher offline queue with one queued message,
//!   keyed with the v1 key `HMAC-SHA256(db.key, machine-id)` in the v1.6.0
//!   schema (no `edge_seq_state` table yet).
//!
//! The repository history does not reach back to the v1.6.0 release, so the
//! database was produced from the v1 key contract that
//! `tests/invariants/db_migration_v1_legacy_key.rs` pins, with SQLCipher's
//! current on-disk format; `fixture_database_opens_with_the_v1_key_contract`
//! re-derives that key independently of the agent.
//!
//! The test runs the real binary (`--preflight`: configuration load and the
//! boot's offline-queue open, nothing else) against a copy of the fixture
//! laid out as the v1.6.0 unit runs it: `SUDERRA_DATA_DIR` set, the device
//! secret and machine-id at their v1.6.0 locations (passed through the
//! v1.6.0-era overrides, since a test cannot write `/etc`). Where the
//! resolver finds the legacy secret by default is unit-tested in
//! `db_secret::tests::generic_secret_precedence`.

use std::path::{Path, PathBuf};
use std::process::Command;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v1.6.0")
}

/// A v1.6.0 device tree in a temporary directory.
struct Device {
    _root: tempfile::TempDir,
    config: PathBuf,
    db_key: PathBuf,
    machine_id: PathBuf,
    data: PathBuf,
}

impl Device {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("tempdir");
        let etc = root.path().join("etc-suderra");
        let data = root.path().join("var-lib-suderra");
        std::fs::create_dir_all(&etc).expect("mkdir etc");
        std::fs::create_dir_all(&data).expect("mkdir data");
        let fx = fixture_dir();
        let config = etc.join("config.yaml");
        let db_key = etc.join("db.key");
        let machine_id = root.path().join("machine-id");
        std::fs::copy(fx.join("config.yaml"), &config).expect("copy config");
        std::fs::copy(fx.join("db.key.TEST-ONLY"), &db_key).expect("copy db.key");
        std::fs::copy(fx.join("machine-id"), &machine_id).expect("copy machine-id");
        std::fs::copy(fx.join("offline_queue.db"), data.join("offline_queue.db"))
            .expect("copy queue");
        Self {
            _root: root,
            config,
            db_key,
            machine_id,
            data,
        }
    }

    /// The agent binary with the v1.6.0 unit's environment.
    fn agent(&self) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_suderra-agent"));
        cmd.env_clear()
            .env("SUDERRA_CONFIG", &self.config)
            .env("SUDERRA_DATA_DIR", &self.data)
            .env("SUDERRA_DB_KEY_PATH", &self.db_key)
            .env("SUDERRA_MACHINE_ID_PATH", &self.machine_id);
        cmd
    }
}

fn v1_key_hex(db_key: &[u8], machine_id: &str) -> String {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(db_key).expect("hmac key");
    mac.update(machine_id.trim().as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The fixture is what it claims to be: a v1-keyed queue with one message.
#[test]
fn fixture_database_opens_with_the_v1_key_contract() {
    let fx = fixture_dir();
    let key = std::fs::read(fx.join("db.key.TEST-ONLY")).expect("db.key");
    let mid = std::fs::read_to_string(fx.join("machine-id")).expect("machine-id");
    let conn = rusqlite::Connection::open_with_flags(
        fx.join("offline_queue.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("open");
    conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", v1_key_hex(&key, &mid)))
        .expect("key");
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM message_queue", [], |r| r.get(0))
        .expect("the v1 key must decrypt the fixture");
    assert_eq!(n, 1);
}

#[cfg(not(feature = "suderra-os"))]
mod generic {
    use super::*;

    fn preflight(device: &Device) -> serde_json::Value {
        let out = device
            .agent()
            .arg("--preflight")
            .output()
            .expect("run agent");
        assert!(
            out.status.success(),
            "--preflight failed: {}\nstderr:\n{}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
        let stdout = String::from_utf8(out.stdout).expect("utf8");
        let line = stdout.lines().last().expect("summary line");
        serde_json::from_str(line).expect("summary JSON")
    }

    /// A v1.6.0 device boots: its config loads (credentials from
    /// config.yaml, the HC-1 fallback when no activation document exists),
    /// its secret and machine-id derive the same v1 key, and its queued
    /// message is still there.
    #[test]
    fn v1_6_0_device_boots_with_its_config_and_queue() {
        let device = Device::new();
        let summary = preflight(&device);
        assert_eq!(
            summary["config"]["device_id"],
            "9b2f6c1e-4a7d-4e3b-8c5f-2d1a0e9f7b6c"
        );
        assert_eq!(
            summary["config"]["tenant_id"],
            "1f3e5d7c-9b2a-4c6e-8f0d-1a3b5c7d9e2f"
        );
        assert_eq!(summary["config"]["activated"], true);
        assert_eq!(summary["offline_queue"]["pending"], 1);
        assert_eq!(
            summary["offline_queue"]["path"],
            device.data.join("offline_queue.db").display().to_string()
        );
        assert_eq!(summary["activation_state"], false);
    }

    /// Booting writes nothing into the operator's files (ADR-048 DEC-4.1):
    /// config.yaml and the secret are byte-identical afterwards, no second
    /// secret appears under the data root, and no activation document is
    /// invented for an already-activated device.
    #[test]
    fn booting_a_v1_6_0_device_rewrites_none_of_its_operator_files() {
        let device = Device::new();
        let config_before = std::fs::read(&device.config).expect("config");
        let key_before = std::fs::read(&device.db_key).expect("key");
        preflight(&device);
        assert_eq!(
            std::fs::read(&device.config).expect("config"),
            config_before
        );
        assert_eq!(std::fs::read(&device.db_key).expect("key"), key_before);
        assert!(!device.data.join("secrets").join("db.key").exists());
        assert!(!device.data.join("state").join("activation.json").exists());
    }

    /// A secret that does not derive the queue's key fails the boot closed
    /// and leaves the queue in place — it is never recreated empty.
    #[test]
    fn a_foreign_secret_fails_closed_and_keeps_the_queue() {
        let device = Device::new();
        std::fs::write(&device.db_key, [0x5Au8; 32]).expect("foreign secret");
        let queue = device.data.join("offline_queue.db");
        let before = std::fs::read(&queue).expect("queue");
        let out = device
            .agent()
            .arg("--preflight")
            .output()
            .expect("run agent");
        assert!(!out.status.success(), "a foreign secret must fail the boot");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stderr.contains("offline_queue DB open"),
            "must fail at the queue open, got:\n{stderr}"
        );
        assert_eq!(std::fs::read(&queue).expect("queue kept"), before);
    }
}

/// The Suderra OS binary ignores every path override (ADR-048 DEC-4.5,
/// DEC-19): pointed at the fixture through the v1.6.0 environment, it still
/// reads only its compile-time site config.
#[cfg(feature = "suderra-os")]
#[test]
fn suderra_os_binary_ignores_the_v1_6_0_environment() {
    let device = Device::new();
    let out = device
        .agent()
        .arg("--preflight")
        .output()
        .expect("run agent");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !out.status.success(),
        "no site config exists on the test host"
    );
    assert!(
        stderr.contains("/var/lib/suderra-site/config.yaml"),
        "must name the compile-time site config, got:\n{stderr}"
    );
    assert!(
        !stderr.contains(&device.config.display().to_string()),
        "must not read SUDERRA_CONFIG:\n{stderr}"
    );
}
