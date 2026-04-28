//! Data directory resolution helper (Batch 30).
//!
//! WHY: `SUDERRA_DATA_DIR` is read from 6+ sites across the
//! codebase (scripting/engine.rs, commands/mod.rs, main.rs × 4)
//! with the same `unwrap_or_else(|_| "/var/lib/suderra".
//! to_string())` default. A future policy change (e.g., move
//! default to `/opt/suderra/data` for FHS compliance) would
//! require editing every site — if one is missed, paths diverge
//! silently and persistence writes land in the wrong directory.
//!
//! This module is the SSoT for the default-path string AND for
//! the env-var name. Consumers call `data_dir()` to get a
//! `PathBuf`; call `data_dir_as_string()` when a String is
//! required for legacy-API compatibility.
//!
//! WHY NOT CONFIG FIELD: the data directory is intentionally
//! environment-variable-controlled (not YAML-config-controlled)
//! because it's needed at config-LOAD time — the YAML file may
//! itself live in the data dir on custom deployments. Config-
//! chicken-and-egg. Env var is the right layer.
//!
//! VALIDATION: `data_dir()` does NOT check that the path exists
//! or is writable — that's the responsibility of each
//! subsystem's init (BackupManager::init, OfflineQueue::open,
//! etc). Keeping this helper infallible means boot-time config
//! resolution is a pure function; IO-touching fallibility lives
//! at the subsystem boundary.

use std::path::PathBuf;

/// Environment variable name for data-dir override. Pinned as a
/// constant so a future refactor can grep-find all readers.
pub const DATA_DIR_ENV_VAR: &str = "SUDERRA_DATA_DIR";

/// Default data directory path. FHS-compliant:
/// `/var/lib/<application>` is the convention for persistent
/// application data per Filesystem Hierarchy Standard §5.8.
pub const DEFAULT_DATA_DIR: &str = "/var/lib/suderra";

/// Resolve the data directory path.
///
/// Checks `SUDERRA_DATA_DIR` env var; falls back to
/// `DEFAULT_DATA_DIR`. Always returns a `PathBuf` — operators
/// calling `data_dir().join("subdir")` get ergonomic interop
/// without manual path construction.
pub fn data_dir() -> PathBuf {
    std::env::var(DATA_DIR_ENV_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_DATA_DIR))
}

/// Same as `data_dir()` but returns a String for APIs that
/// haven't migrated to PathBuf yet.
///
/// Prefer `data_dir()` in new code — String loses path
/// semantics + forces UTF-8 round-trip for non-UTF-8 paths.
/// Allowed-dead-code because current consumers route through
/// `data_dir().join(...).to_string_lossy()` pattern; kept
/// available for future format!-string callers.
#[allow(dead_code)]
pub fn data_dir_as_string() -> String {
    std::env::var(DATA_DIR_ENV_VAR).unwrap_or_else(|_| DEFAULT_DATA_DIR.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Batch 96: serialize env-var-touching tests in this
    /// module. Two tests set + remove SUDERRA_DATA_DIR on
    /// opposite paths; parallel cargo test harness races
    /// them -> one observes the other's in-flight state.
    /// Mutex pattern mirrors authz/manifest_version_store's
    /// TEST_LOCK.
    static ENV_TEST_LOCK: std::sync::LazyLock<std::sync::Mutex<()>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(()));

    fn env_test_guard() -> std::sync::MutexGuard<'static, ()> {
        ENV_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    fn default_when_env_var_unset() {
        let _g = env_test_guard();
        // SAFETY: Rust 2024 edition requires unsafe for env mutation
        // — setting/removing env vars is not thread-safe (other
        // threads may be reading concurrently). Mutex above
        // serializes this test against honors_env_var_override.
        unsafe {
            std::env::remove_var(DATA_DIR_ENV_VAR);
        }
        assert_eq!(data_dir(), PathBuf::from("/var/lib/suderra"));
        assert_eq!(data_dir_as_string(), "/var/lib/suderra");
    }

    #[test]
    fn honors_env_var_override() {
        let _g = env_test_guard();
        unsafe {
            std::env::set_var(DATA_DIR_ENV_VAR, "/tmp/edge-test-data");
        }
        assert_eq!(data_dir(), PathBuf::from("/tmp/edge-test-data"));
        assert_eq!(data_dir_as_string(), "/tmp/edge-test-data");
        // Cleanup so sibling tests in the same binary don't pick
        // up the override.
        unsafe {
            std::env::remove_var(DATA_DIR_ENV_VAR);
        }
    }
}
