//! Tokio runtime construction tuned for the multi-tenant ingestion
//! profile documented in `docs/plans/sensor-rust-migration/PLAN.md`
//! § Faz 2 Tokio Runtime Tuning.
//!
//! The defaults are baked into [`crate::config::RuntimeConfig`] and
//! the operator can override every knob via TOML; this module is the
//! single place where the [`tokio::runtime::Builder`] is configured,
//! so any future tuning experiment lands here without scattering
//! `Builder` calls across the binary.

use std::io;

use tokio::runtime::{Builder, Runtime};

use crate::config::RuntimeConfig;

/// Build a multi-threaded tokio runtime tuned per [`RuntimeConfig`].
///
/// Errors:
/// - Returns the underlying `std::io::Error` if `Builder::build`
///   fails (e.g. the kernel refuses the requested stack size).
///
/// Note on the LIFO slot: tokio's LIFO slot keeps a freshly-woken
/// task on the same worker that woke it, improving cache locality
/// for the "parse a single MQTT message end-to-end" pattern. Stable
/// tokio enables it by default and exposes no public toggle, so we
/// intentionally do not configure it here. If a future experiment
/// wants to disable it, the work is `tokio_unstable` cfg + a private
/// builder method, with a corresponding RuntimeConfig knob.
pub fn build_runtime(cfg: &RuntimeConfig) -> io::Result<Runtime> {
    Builder::new_multi_thread()
        .enable_all()
        .worker_threads(cfg.worker_threads)
        .max_blocking_threads(cfg.max_blocking_threads)
        .thread_name("sensor-ingestion-worker")
        .thread_stack_size(cfg.thread_stack_kb.saturating_mul(1024))
        .build()
}

#[cfg(test)]
mod tests {
    use super::{RuntimeConfig, build_runtime};

    #[test]
    fn build_runtime_with_defaults() {
        let rt = build_runtime(&RuntimeConfig::default()).unwrap();
        // Sanity: the runtime can run a tiny task synchronously.
        let result = rt.block_on(async { 1 + 1 });
        assert_eq!(result, 2);
    }

    #[test]
    fn build_runtime_with_one_worker() {
        let cfg = RuntimeConfig {
            worker_threads: 1,
            ..RuntimeConfig::default()
        };
        let rt = build_runtime(&cfg).unwrap();
        let result = rt.block_on(async { 42 });
        assert_eq!(result, 42);
    }

    #[test]
    fn build_runtime_with_small_stack() {
        let cfg = RuntimeConfig {
            thread_stack_kb: 128,
            ..RuntimeConfig::default()
        };
        let rt = build_runtime(&cfg).unwrap();
        rt.block_on(async {});
    }
}
