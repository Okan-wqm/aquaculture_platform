//! The ARIA-HIGH-010 gold corpus: a safe and an unsafe twin per claim, plus
//! the comment and string-literal decoys that must never create a finding
//! (the reader strips both before it sees a token).
//!
//! The claimed constructs in this file are pinned by
//! `rust-runtime-safety-adapter.test.ts` and by the semantic fixture case;
//! `src/diagnostics.rs` is reached only through `#[cfg(test)]` and is
//! harness: nothing in it may be claimed.

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

#[cfg(test)]
mod diagnostics;
