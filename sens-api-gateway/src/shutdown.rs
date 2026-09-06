//! Graceful Shutdown Coordinator
//!
//! Manages proper shutdown sequence for all agent components:
//! 1. Signal all tasks to stop
//! 2. Wait for script engine + in-flight operations to stop
//! 3. SAFE-STATE all actuator outputs (LIFE-SAFETY)
//! 4. Flush offline queue (fsync WAL to disk)
//! 5. Disconnect hardware interfaces (Modbus, LoRa, I2C)
//! 6. Publish offline status via MQTT
//! 7. Disconnect MQTT
//!
//! v1.2.3: Increased broadcast channel capacity for reliability
//!
//! NOTE: Full shutdown coordination API. Some helpers are for
//! advanced task management patterns.
//!
//! ## Wire status (Batch #276 audit)
//!
//! Production wire confirmed across multiple call sites:
//! - `main.rs::shutdown_coordinator.shutdown(...)` — graceful
//!   shutdown entry point at SIGTERM / SIGINT.
//! - Batch #258 `is_shutting_down` AtomicBool — command-
//!   dispatch race gate flipped at the start of the shutdown
//!   sequence so new commands reject with `ServiceShuttingDown`.
//!
//! Per-item dead-code allow audit pending — the
//! `ShutdownAwareTask` wrapper type + a few unused `register_*`
//! helper variants remain compiled-but-unreferenced. They're
//! held for future Sprint 6.x integration when additional
//! background tasks (drain task expansions, scada-display
//! WebSocket fan-out) need shutdown registration. WHITELIST-
//! with-reason per the ARC-009 framework.
//!
//! Plan ref: ARC-009 + Batch #258 C-7 shutdown race fix.

#![allow(dead_code)]

use std::time::Duration;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tracing::{info, warn};

/// Broadcast channel capacity for shutdown signals (v1.2.3)
/// Increased from 1 to 16 to prevent message loss when multiple subscribers exist
const SHUTDOWN_CHANNEL_CAPACITY: usize = 16;

/// Graceful shutdown coordinator
pub struct ShutdownCoordinator {
    /// Broadcast sender for shutdown signal
    notify: broadcast::Sender<()>,
    /// Registered task handles
    tasks: Vec<(&'static str, JoinHandle<()>)>,
}

impl ShutdownCoordinator {
    /// Create a new shutdown coordinator
    ///
    /// v1.2.3: Uses larger broadcast channel capacity for reliability
    pub fn new() -> Self {
        let (notify, _) = broadcast::channel(SHUTDOWN_CHANNEL_CAPACITY);
        Self {
            notify,
            tasks: Vec::new(),
        }
    }

    /// Get a shutdown signal receiver
    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.notify.subscribe()
    }

    /// Register a task handle for graceful shutdown
    pub fn register_task(&mut self, name: &'static str, handle: JoinHandle<()>) {
        self.tasks.push((name, handle));
    }

    /// Get the number of registered tasks
    pub fn task_count(&self) -> usize {
        self.tasks.len()
    }

    /// Initiate graceful shutdown
    ///
    /// This will:
    /// 1. Send shutdown signal to all subscribers
    /// 2. Wait for all registered tasks to complete (with timeout)
    pub async fn shutdown(self, shutdown_timeout: Duration) {
        info!("Initiating graceful shutdown...");

        // Step 1: Signal all tasks to stop
        let subscriber_count = self.notify.receiver_count();
        info!(
            "Sending shutdown signal to {} subscribers",
            subscriber_count
        );

        if let Err(e) = self.notify.send(()) {
            warn!("Failed to send shutdown signal: {}", e);
        }

        // Give a small delay for signal propagation
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Step 2: Wait for all tasks to complete.
        //
        // PR935-HIGH-002 / PR935-HIGH-003: the drain is CONCURRENT and every
        // timeout arm ACTUALLY ABORTS. Two properties are load-bearing for
        // the life-safety guarantee that safe-state is the last actuator
        // write:
        //   1. `tokio::time::timeout(_, &mut handle)` borrows the handle, so
        //      on expiry the handle survives and `handle.abort()` cancels the
        //      task. The previous code moved the handle into `timeout`, which
        //      DROPPED (detached) it on expiry — a wedged actuator write kept
        //      running and could overwrite the fail-safe value applied later.
        //   2. Awaiting all handles concurrently bounds the whole drain to a
        //      single `shutdown_timeout`, not `task_count * shutdown_timeout`.
        //      Sequential draining let a few wedged tasks push the total past
        //      the caller's hard shutdown deadline, so the safe-state phase
        //      was never reached before the deadline watchdog fired.
        let task_count = self.tasks.len();
        info!(
            "Draining {} tasks concurrently (per-task budget {:?})...",
            task_count, shutdown_timeout
        );

        let drains = self.tasks.into_iter().map(|(name, mut handle)| async move {
            match tokio::time::timeout(shutdown_timeout, &mut handle).await {
                Ok(Ok(())) => {
                    info!("Task '{}' completed gracefully", name);
                }
                Ok(Err(e)) => {
                    warn!("Task '{}' panicked: {}", name, e);
                }
                Err(_) => {
                    warn!(
                        "Task '{}' exceeded the shutdown budget — aborting so it \
                         cannot write actuators after safe-state is applied",
                        name
                    );
                    handle.abort();
                }
            }
        });
        futures::future::join_all(drains).await;

        info!("All tasks drained");
    }

    /// Abort all tasks immediately (for emergency shutdown)
    pub fn abort_all(self) {
        warn!("Aborting all tasks...");
        for (name, handle) in self.tasks {
            handle.abort();
            warn!("Task '{}' aborted", name);
        }
    }
}

impl Default for ShutdownCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

/// Shutdown-aware task wrapper
///
/// Wraps an async task to respond to shutdown signals
pub struct ShutdownAwareTask<F> {
    task: F,
    shutdown_rx: broadcast::Receiver<()>,
}

impl<F> ShutdownAwareTask<F>
where
    F: std::future::Future<Output = ()>,
{
    /// Create a new shutdown-aware task
    pub fn new(task: F, shutdown_rx: broadcast::Receiver<()>) -> Self {
        Self { task, shutdown_rx }
    }

    /// Run the task until completion or shutdown signal
    pub async fn run(self) {
        tokio::select! {
            // v1.2.4: biased; ensures shutdown signal is always checked first
            biased;

            _ = async {
                let mut rx = self.shutdown_rx;
                let _ = rx.recv().await;
            } => {
                // Shutdown signal received
                info!("Shutdown signal received, stopping task");
            }
            _ = self.task => {
                // Task completed normally
            }
        }
    }
}

/// Helper to run a task with shutdown awareness
pub async fn run_until_shutdown<F>(task: F, mut shutdown_rx: broadcast::Receiver<()>)
where
    F: std::future::Future<Output = ()>,
{
    tokio::select! {
        // v1.2.4: biased; ensures shutdown signal is always checked first
        biased;

        _ = shutdown_rx.recv() => {
            info!("Shutdown signal received");
        }
        _ = task => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_shutdown_coordinator() {
        let mut coordinator = ShutdownCoordinator::new();
        let rx = coordinator.subscribe();

        // Spawn a task that waits for shutdown
        let handle = tokio::spawn(async move {
            let mut rx = rx;
            let _ = rx.recv().await;
        });

        coordinator.register_task("test_task", handle);
        assert_eq!(coordinator.task_count(), 1);

        // Shutdown should complete quickly
        coordinator.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn drain_is_concurrent_not_sequential() {
        // PR935-HIGH-003: N wedged tasks must drain in ~one per-task budget,
        // not N budgets. Real short timers: 8 tasks × 200ms sequential = 1.6s;
        // concurrent ≈ 200ms. We assert well under the sequential figure.
        let mut coordinator = ShutdownCoordinator::new();
        for i in 0..8 {
            let name: &'static str = Box::leak(format!("wedged-{i}").into_boxed_str());
            // A task that never observes the shutdown signal (wedged).
            let handle = tokio::spawn(async {
                std::future::pending::<()>().await;
            });
            coordinator.register_task(name, handle);
        }

        let start = std::time::Instant::now();
        coordinator.shutdown(Duration::from_millis(200)).await;
        let elapsed = start.elapsed();

        assert!(
            elapsed < Duration::from_millis(900),
            "drain took {elapsed:?} — expected ~one 200ms budget; a sequential \
             drain of 8 tasks would take ~1.6s (PR935-HIGH-003 regression)"
        );
    }

    #[tokio::test]
    async fn timed_out_task_is_actually_aborted() {
        // PR935-HIGH-002: a task that exceeds the budget must be ABORTED, not
        // detached. The task would set a flag after a long sleep; a detached
        // task stays alive (is_finished == false). We keep an AbortHandle to
        // assert the coordinator cancelled it.
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let ran_past_abort = Arc::new(AtomicBool::new(false));
        let flag = ran_past_abort.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            flag.store(true, Ordering::SeqCst);
        });
        let observer = handle.abort_handle();

        let mut coordinator = ShutdownCoordinator::new();
        coordinator.register_task("slow", handle);
        coordinator.shutdown(Duration::from_millis(100)).await;

        // Give the aborted task a moment to unwind, then assert it is finished
        // (cancelled) and never reached the post-sleep store.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            observer.is_finished(),
            "task was not aborted on timeout — it was detached (PR935-HIGH-002)"
        );
        assert!(
            !ran_past_abort.load(Ordering::SeqCst),
            "aborted task still executed past its await point (PR935-HIGH-002)"
        );
    }

    #[tokio::test]
    async fn test_run_until_shutdown() {
        let (tx, rx) = broadcast::channel(1);

        let task_handle = tokio::spawn(async move {
            run_until_shutdown(
                async {
                    // This would run forever without shutdown
                    loop {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                },
                rx,
            )
            .await;
        });

        // Send shutdown signal
        tx.send(()).unwrap();

        // Task should complete
        tokio::time::timeout(Duration::from_secs(1), task_handle)
            .await
            .expect("Task should complete after shutdown signal")
            .expect("Task should not panic");
    }
}
