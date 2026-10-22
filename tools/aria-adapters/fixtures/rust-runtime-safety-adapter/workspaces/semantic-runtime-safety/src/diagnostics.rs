//! Test-only diagnostics helpers. The production scan must never claim
//! anything in this file: it is reached only through the `#[cfg(test)]`
//! declaration in `lib.rs`, so the workspace classifier reads it as harness.

use tokio::net::TcpStream;

pub fn uncontracted() -> i32 {
    let value = unsafe { 1 + 1 };
    value
}

pub async fn unbounded() -> std::io::Result<()> {
    let socket = TcpStream::connect("127.0.0.1:1883").await?;
    drop(socket);
    Ok(())
}

pub async fn detached() {
    tokio::spawn(poll());
}

async fn poll() -> u32 {
    0
}
