//! The ARIA-HIGH-010 gold corpus: a safe and an unsafe twin per claim, plus
//! the comment and string-literal decoys that must never create a finding
//! (the reader strips both before it sees a token).
//!
//! The claimed constructs in this file are pinned by
//! `rust-runtime-safety-adapter.test.ts` and by the semantic fixture case;
//! `src/diagnostics.rs` is reached only through `#[cfg(test)]` and is
//! harness: nothing in it may be claimed, nor in this file's own test items.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use tokio::net::TcpStream;
use tokio::sync::watch;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

async fn poll_worker() -> u32 {
    0
}

fn collect_diagnostics() -> u32 {
    0
}

async fn read_sensors() -> u32 {
    0
}

fn start_hardware() -> i32 {
    0
}

fn with_timeout<T>(future: T, limit: Duration) -> Result<T, tokio::time::error::Elapsed> {
    let _ = limit;
    Ok(future)
}

// ---------------------------------------------------------- detached_task
// Two discarded handles (claimed) against a stored one and two joined ones.

pub fn dispatch_untracked() {
    tokio::spawn(poll_worker());
    thread::spawn(collect_diagnostics());
}

pub async fn dispatch_tracked() {
    let handle = tokio::spawn(poll_worker());
    let _ = handle.abort();
    thread::spawn(collect_diagnostics()).join().expect("collector");
    tokio::spawn(poll_worker()).await.expect("poll worker");
}

pub fn dispatch_documented_only() {
    // tokio::spawn(untracked_worker());
    let note = "call tokio::spawn(untracked_worker()); to start the worker";
    let _ = note.len();
}

// --------------------------------------------- uncancellable_long_lived_loop

pub async fn telemetry_loop_unbounded() {
    // This comment mentions select! and shutdown_rx, but a comment is not
    // code: the loop below has no cancellation path.
    loop {
        read_sensors().await;
    }
}

pub async fn loop_with_documented_cancel() {
    let banner = "this loop answers select! on shutdown_rx";
    while banner.len() > 0 {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub async fn telemetry_loop_cancellable(mut shutdown_rx: watch::Receiver<()>) {
    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => break,
            _ = read_sensors() => {}
        }
    }
}

pub async fn deadline_loop(mut shutdown: watch::Receiver<()>) {
    while !shutdown.has_changed().unwrap_or(true) {
        read_sensors().await;
    }
}

pub fn busy_collect(buffer: &mut Vec<u32>) {
    let filled = AtomicBool::new(false);
    loop {
        if filled.load(Ordering::Acquire) || buffer.len() >= 4 {
            break;
        }
        buffer.push(0);
    }
}

// ------------------------------------- unsafe_without_safety_contract

pub fn start_uncontracted() -> i32 {
    let ret = unsafe { start_hardware() };
    ret
}

pub fn start_contracted() -> i32 {
    // SAFETY: hardware initialisation completed before this call, so the
    // FFI entry point cannot observe a half-configured device.
    unsafe { start_hardware() }
}

pub fn start_blurred_contract() -> i32 {
    // SAFETY: a contract that stopped touching the block it names.

    unsafe { start_hardware() }
}

pub fn start_documented_false() -> i32 {
    let note = "SAFETY: this string is not a contract";
    let _ = note.len();
    unsafe { start_hardware() }
}

pub struct SharedCounter(*const u8);

// SAFETY: SharedCounter moves between threads as an immutable view over
// memory whose lifetime outlives every handle.
unsafe impl Send for SharedCounter {}

unsafe impl Sync for SharedCounter {}

// ------------------------------------------------ unbounded_external_io

pub async fn connect_unbounded(addr: &str) -> std::io::Result<()> {
    let socket = TcpStream::connect(addr).await?;
    drop(socket);
    Ok(())
}

pub async fn connect_bounded(addr: &str) -> std::io::Result<()> {
    let socket = with_timeout(TcpStream::connect(addr), CONNECT_TIMEOUT).await??;
    drop(socket);
    Ok(())
}

pub async fn connect_deadline(addr: &str) -> std::io::Result<()> {
    let socket = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await??;
    drop(socket);
    Ok(())
}

pub async fn fetch_unbounded(url: &str) -> anyhow::Result<()> {
    let page = reqwest::get(url).await?;
    let _ = page;
    Ok(())
}

pub async fn client_bounded(url: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let _ = client;
    Ok(())
}

pub async fn client_unbounded(url: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::builder().build()?;
    let _ = client;
    Ok(())
}

pub async fn io_documented_only(addr: &str) -> std::io::Result<()> {
    let note = "TcpStream::connect(addr) here is wrapped in with_timeout";
    let note2 = "reqwest::get(url) has a 30 second timeout";
    let _ = note.len() + note2.len() + addr.len();
    Ok(())
}

// --------------------------------- uncancellable_long_lived_loop, long-lived only
// A loop is long-lived only when it waits on the executor (an `.await` in its
// span) and nothing ends it. Each loop below that no `.await` drives, or that a
// timeout or deadline ends as a whole, is not a claim; each one paired with it
// waits forever and is.

const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const TICK: Duration = Duration::from_millis(100);

async fn refill_frame() -> Vec<u8> {
    Vec::new()
}

/// No `.await` in the loop: a parse over a buffer already in hand never
/// yields to the executor, whatever the async fn around it awaits first.
pub async fn parse_frame_words(frame: Vec<u8>) -> Vec<u16> {
    let _ = read_sensors().await;
    let mut words = Vec::new();
    let mut offset = 0;
    while offset + 2 <= frame.len() {
        words.push(u16::from_le_bytes([frame[offset], frame[offset + 1]]));
        offset += 2;
    }
    words
}

/// Claimed: the await sits in a nested block of the body, and nothing ends
/// the loop.
pub async fn refill_frames_forever(mut frame: Vec<u8>) {
    let mut offset = 0;
    loop {
        if offset + 2 > frame.len() {
            frame = refill_frame().await;
            offset = 0;
        }
        offset += 2;
    }
}

/// The whole loop runs inside `tokio::time::timeout`: the timeout ends it.
pub async fn drain_within_timeout(mut rx: tokio::sync::mpsc::Receiver<u32>) -> u32 {
    let mut total = 0;
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, async {
        while let Some(value) = rx.recv().await {
            total += value;
        }
    })
    .await;
    total
}

/// Claimed: a timeout on each receive bounds one wait, never the loop; an
/// elapsed receive goes round again.
pub async fn drain_with_per_receive_timeout(mut rx: tokio::sync::mpsc::Receiver<u32>) -> u32 {
    let mut total = 0;
    loop {
        match tokio::time::timeout(DRAIN_TIMEOUT, rx.recv()).await {
            Ok(Some(value)) => total += value,
            Ok(None) => return total,
            Err(_) => continue,
        }
    }
}

/// A fixed deadline ends the receive loop: once it passes, `timeout_at`
/// answers `Err` and the `while let` stops.
pub async fn collect_until_deadline(mut rx: tokio::sync::mpsc::Receiver<u32>) -> Vec<u32> {
    let deadline = tokio::time::Instant::now() + DRAIN_TIMEOUT;
    let mut results = Vec::new();
    while let Ok(Some(value)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        results.push(value);
    }
    results
}

/// Claimed: the deadline is re-armed on every round, so `timeout_at` bounds
/// one receive, never the loop.
pub async fn rearm_deadline_forever(mut rx: tokio::sync::mpsc::Receiver<u32>) {
    loop {
        let deadline = tokio::time::Instant::now() + DRAIN_TIMEOUT;
        if let Ok(Some(value)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            let _ = value;
        }
    }
}

/// The loop leaves when its deadline passes.
pub async fn settle_until_deadline() -> u32 {
    let deadline = tokio::time::Instant::now() + DRAIN_TIMEOUT;
    let mut last = 0;
    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        last = read_sensors().await;
    }
    last
}

/// Claimed: `sleep_until(deadline)` paces the loop on a deadline it keeps
/// moving; it never leaves.
pub async fn sample_on_deadline_forever() {
    let mut deadline = tokio::time::Instant::now();
    loop {
        deadline += TICK;
        tokio::time::sleep_until(deadline).await;
        read_sensors().await;
    }
}

/// A `try_recv` drain in the shutdown arm of a `select!`: it never awaits and
/// runs once, after cancellation fired. Neither the drain nor the select! loop
/// around it is a claim.
pub async fn batch_until_cancelled(
    mut rx: tokio::sync::mpsc::Receiver<u32>,
    cancel: tokio_util::sync::CancellationToken,
) -> Vec<u32> {
    let mut buf = Vec::new();
    loop {
        tokio::select! {
            () = cancel.cancelled() => {
                while let Ok(value) = rx.try_recv() {
                    buf.push(value);
                }
                return buf;
            }
            msg = rx.recv() => match msg {
                Some(value) => buf.push(value),
                None => return buf,
            },
        }
    }
}

/// Claimed at the outer `loop`: it polls by draining with `try_recv`, sleeps
/// and goes round again with nothing to end it. The drain inside is not.
pub async fn poll_drain_forever(mut rx: tokio::sync::mpsc::Receiver<u32>) {
    let mut buf = Vec::new();
    loop {
        while let Ok(value) = rx.try_recv() {
            buf.push(value);
        }
        buf.clear();
        tokio::time::sleep(TICK).await;
    }
}

// ------------------------------------------------- inline test code, never claimed
// A production file's own `#[cfg(test)] mod` and `#[test]` / `#[tokio::test]`
// fns are test code (rust-source.ts testSpans marks them). Each construct in
// them would be a claim in shipped code, and none is one here. The production
// twin after them proves a span ends where its item does.

#[cfg(test)]
mod inline_tests {
    use super::*;

    #[test]
    fn harness_spawns_and_unsafe() {
        tokio::spawn(poll_worker());
        thread::spawn(collect_diagnostics());
        let value = unsafe { start_hardware() };
        assert_eq!(value, 0);
    }

    #[tokio::test]
    async fn harness_loop_and_io() {
        let socket = TcpStream::connect("127.0.0.1:1883").await;
        let _ = socket;
        loop {
            read_sensors().await;
        }
    }

    struct HarnessHandle(*const u8);

    unsafe impl Send for HarnessHandle {}
}

#[test]
fn file_level_test_fn() {
    let value = unsafe { start_hardware() };
    let client = reqwest::Client::builder().build();
    let _ = client;
    assert_eq!(value, 0);
}

#[tokio::test]
async fn file_level_tokio_test() {
    tokio::spawn(poll_worker());
    while read_sensors().await == 0 {
        tokio::time::sleep(TICK).await;
    }
}

/// Claimed: shipped code after the test items.
pub fn dispatch_after_tests() {
    tokio::spawn(poll_worker());
}

#[cfg(test)]
mod diagnostics;
