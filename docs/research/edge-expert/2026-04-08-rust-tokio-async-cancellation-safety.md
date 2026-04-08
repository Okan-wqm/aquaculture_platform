# Research: Rust Tokio Async Cancellation Safety

**Topic:** Cancellation-safe `.await`, mutex choice, `spawn_blocking`, graceful shutdown, runtime configuration for the `sens-api-gateway` Rust edge agent
**Date:** 2026-04-08
**Agent:** edge-expert

## Sources

- [Tokio — Select tutorial (cancellation semantics)](https://tokio.rs/tokio/tutorial/select)
- [Tokio — Graceful Shutdown topic](https://tokio.rs/tokio/topics/shutdown)
- [Tokio — Shared State / Mutex tutorial](https://tokio.rs/tokio/tutorial/shared-state)
- [Tokio — Bridging with sync code](https://tokio.rs/tokio/topics/bridging)
- [Tokio — Spawning tutorial](https://tokio.rs/tokio/tutorial/spawning)
- [docs.rs — `tokio::select!` macro (cancel-safety matrix)](https://docs.rs/tokio/latest/tokio/macro.select.html)
- [docs.rs — `tokio::sync::Mutex`](https://docs.rs/tokio/latest/tokio/sync/struct.Mutex.html)
- [docs.rs — `tokio::sync::mpsc::Receiver::recv` (cancel safety)](https://docs.rs/tokio/latest/tokio/sync/mpsc/struct.Receiver.html)
- [docs.rs — `tokio::sync::mpsc::Sender::send` (NOT fully cancel safe)](https://docs.rs/tokio/latest/tokio/sync/mpsc/struct.Sender.html)
- [docs.rs — `tokio::sync::broadcast::Receiver::recv`](https://docs.rs/tokio/latest/tokio/sync/broadcast/struct.Receiver.html)
- [docs.rs — `tokio::task::spawn_blocking`](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)
- [docs.rs — `tokio::task::block_in_place`](https://docs.rs/tokio/latest/tokio/task/fn.block_in_place.html)
- [docs.rs — `tokio_util::sync::CancellationToken`](https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html)
- [docs.rs — `tokio_util::task::TaskTracker`](https://docs.rs/tokio-util/latest/tokio_util/task/task_tracker/struct.TaskTracker.html)
- [docs.rs — `tokio::task::JoinSet`](https://docs.rs/tokio/latest/tokio/task/struct.JoinSet.html)
- [Tokio blog — Reducing tail latencies with automatic cooperative task yielding](https://tokio.rs/blog/2020-04-preemption)

## Key Findings

### Cancellation-safety definition (tokio.rs)
A future is **cancellation-safe** if dropping an in-progress future and recreating it is a no-op — no partially consumed messages, no half-written state, no lost permits. In `select!`, every branch that does not complete first is *dropped mid-`.await`*. Any branch whose future is not cancel-safe must not be used directly in `select!`.

### Cancel-safe primitives (documented by docs.rs)
- `tokio::sync::mpsc::Receiver::recv` / `recv_many`
- `tokio::sync::mpsc::UnboundedReceiver::recv`
- `tokio::sync::broadcast::Receiver::recv`
- `tokio::sync::Notify::notified`
- `tokio::net::UdpSocket::recv` / `recv_from`
- `tokio::net::TcpListener::accept`
- `tokio::time::sleep` / `sleep_until` / `Interval::tick`
- `AsyncReadExt::read` (but **not** `read_exact` / `read_to_end`)

### NOT cancel-safe (must not be used bare in `select!`)
- `tokio::sync::mpsc::Sender::send` — if dropped in-flight, the message is **lost** and the sender's place in the queue is gone. Use `Sender::reserve()` → `Permit::send()` to split the awaitable wait from the infallible synchronous send.
- `AsyncReadExt::read_exact`, `read_to_end`, `AsyncBufReadExt::read_line` — partial reads are consumed from the buffer but not returned to the caller on cancel.
- Any hand-written future with multi-step internal state machines (for example, a Modbus request/response cycle that has already written the request frame) — these must be wrapped in a cancellation-proof owned task that runs to completion, with results delivered back over an mpsc channel.

### `tokio::sync::Mutex` vs `std::sync::Mutex`
- **`std::sync::Mutex`** is the default recommendation from tokio.rs when the guarded data is "just data" and the critical section is short and non-async. It is faster (no async state machine) and does not need to cross `.await`.
- **`tokio::sync::Mutex`** is only required when the lock **must** be held across an `.await` point. The guard is `Send` and the `lock()` future is cancel-safe.
- Holding a `std::sync::MutexGuard` across an `.await` must be prevented by construction: wrap the lock in a struct and perform locking only inside *non-async* methods. `clippy::await_holding_lock` catches most violations.
- `tokio::sync::Mutex` does **not** poison on panic; `std::sync::Mutex` does. Poisoning is a signal of bug-state on the edge device and must not be silently swallowed with `.into_inner()` — the process image and script state could be corrupt.

### `spawn_blocking`, `block_in_place`, dedicated threads
- `spawn_blocking` moves a closure to the runtime's blocking thread pool (default upper bound 512 threads). Use it for **bounded** sync work: SQLCipher queries, gzip backup compression, file system snapshots, `rppal` GPIO / I2C / SPI register reads, rodbus sync adapters, crypto/KDF operations.
- **Do not** use `spawn_blocking` for indefinite loops (poll threads, hardware watchers). tokio.rs explicitly warns: long-lived blocking tasks reduce pool capacity and can deadlock queued work. Use a dedicated `std::thread::spawn` with an mpsc bridge back to async.
- `spawn_blocking` tasks **cannot be aborted** once started. `runtime.shutdown_timeout()` will wait for them — a hanging SPI read will hang the whole process on shutdown.
- `block_in_place` is only valid on the `multi_thread` runtime and moves the *current* worker thread out of the scheduler pool. It is not available on `current_thread` and is hostile to latency of co-resident tasks.

### Runtime configuration (tokio.rs)
- `multi_thread` (default, `#[tokio::main]`): correct for I/O-heavy gateways with many concurrent MQTT, Modbus, HTTP tasks.
- `current_thread`: correct for constrained Raspberry Pi Zero / RevPi Compact class devices where a single-core scheduler reduces context-switch overhead and avoids cross-core cache misses. Must pair with `LocalSet` for `!Send` futures (rumqttc `EventLoop` on some target configs).
- **Cooperative yielding** (since Tokio 0.2): tasks are automatically budgeted and may return `Pending` to yield to the scheduler. Tight compute loops inside `async fn` bypass the budget and starve the runtime — they must be moved into `spawn_blocking` or manually call `tokio::task::yield_now()`.

### Graceful shutdown pattern (tokio.rs + tokio-util)
Tokio's canonical pattern has three parts:
1. **Detect** shutdown trigger (`tokio::signal::ctrl_c`, SIGTERM from systemd, health check failure, OTA reboot command).
2. **Notify** every task — preferred primitives:
   - `tokio_util::sync::CancellationToken` (cheap clone, cooperative, hierarchical via `child_token()`).
   - `tokio::sync::broadcast` channel for "shutdown message" fanout.
3. **Wait** for every task to finish — preferred primitives:
   - `tokio_util::task::TaskTracker` (pair with `CancellationToken`) — new tasks can be spawned while old ones drain.
   - `tokio::task::JoinSet` — owned collection of join handles; `shutdown()` aborts all and awaits.
   - An mpsc channel where every task holds a `Sender` clone; the main task awaits on a `Receiver` until all senders drop (message-less "quiescence detection").

For industrial edge, the multi-stage shutdown order is load-bearing:
1. Stop accepting new SCADA commands (close health server inbound).
2. Command scripting engine to safe-state (all outputs to configured fail-safe values — IEC 61131-3 "safe state").
3. Flush offline queue to SQLCipher, fsync, rotate backup.
4. Drain MQTT publish buffer (respect QoS 1 / 2 in-flight).
5. Disconnect Modbus with LWT equivalents where supported.
6. `runtime.shutdown_timeout(Duration::from_secs(N))`.

## Security Concerns

- **Cancel-unsafe futures in `select!` branches = state corruption** on the edge device. If a half-written Modbus command frame is dropped mid-flight because the shutdown branch won, the PLC may latch a partial write on the wire. This is a life-safety issue for aquaculture control outputs.
- **`std::sync::Mutex` held across `.await`** can deadlock the scheduler on the current-thread runtime and stall the watchdog thread → WDT reset → uncontrolled restart → control outputs may transiently enter indeterminate state.
- **`spawn_blocking` unbounded growth**: unbounded blocking pool leaks can be triggered by an attacker flooding the device with slow Modbus reads on a compromised OT segment (DoS via thread exhaustion). The blocking pool must be sized and paired with a semaphore.
- **Panic in a `spawn_blocking`** closure crashes only that thread, but an unjoined `JoinHandle::await` returns `JoinError::Panicked` — silently ignored panics hide corrupted process-image state.

## Performance Concerns

- Using `tokio::sync::Mutex` instead of `std::sync::Mutex` for microsecond-scale data protection (for example, the CB atomic state fall-through path) wastes ~200ns per lock on the async state machine and is a false-security pattern.
- `block_in_place` steals the current worker — on a 2-core RevPi the scheduler loses 50% capacity for the blocking duration; prefer `spawn_blocking`.
- Running CPU-bound IEC 61131-3 scan cycles inside `async fn` without yields causes cooperative-yield starvation and inflates MQTT publish tail latency.

## Architectural Implications for edge-expert reviews

1. Every `tokio::select!` call site must be audited: each branch's future must appear on the documented cancel-safe list from docs.rs, **or** be wrapped in an owned `tokio::spawn` task whose handle is what the `select!` awaits (so the task runs to completion even if the branch is dropped).
2. Every `std::sync::Mutex` critical section must be provably non-async (enforce with `clippy::await_holding_lock` in CI).
3. Every `spawn_blocking` invocation must have a documented upper bound on wall-clock duration, and the caller must be able to tolerate shutdown-timeout expiry without losing durability (the closure itself must be crash-safe if the process is killed while it is running).
4. All long-running hardware poll loops (rppal GPIO, SPI, I2C, UART) must run on dedicated OS threads via `std::thread::spawn`, communicating with the async world via `tokio::sync::mpsc` (or `flume`). They must never use `spawn_blocking`.
5. `shutdown.rs` must implement the ordered multi-stage pattern above; the review must verify the scripting engine's "safe-state" command is issued *before* MQTT disconnect (to guarantee the control outputs reach their safe value while the broker is still reachable to log the transition).
6. The runtime's blocking thread pool must be explicitly sized via `RuntimeBuilder::max_blocking_threads()` and paired with a `tokio::sync::Semaphore` guarding the `spawn_blocking` callsites, not left at the 512 default.

## Domain Rule Additions for edge-expert

- **R-ASYNC-01:** Every `tokio::select!` branch that is not on the documented cancel-safe primitive list must be wrapped in `tokio::spawn` and the `JoinHandle` awaited in the branch.
- **R-ASYNC-02:** `mpsc::Sender::send` is FORBIDDEN inside `select!`. Use `Sender::reserve()` + `Permit::send()`.
- **R-ASYNC-03:** `std::sync::Mutex` is the default; `tokio::sync::Mutex` is only permitted with a code comment proving the lock must cross an `.await`.
- **R-ASYNC-04:** `clippy::await_holding_lock` must be `deny` in `sens-api-gateway` CI.
- **R-ASYNC-05:** Long-lived poll loops use `std::thread::spawn` + mpsc bridge, NOT `spawn_blocking`.
- **R-ASYNC-06:** Runtime's `max_blocking_threads` must be explicitly configured; `spawn_blocking` callsites protected by `Semaphore`.
- **R-ASYNC-07:** Shutdown coordination uses `CancellationToken` + `TaskTracker` **or** `JoinSet`; ad-hoc `AtomicBool` shutdown flags are FORBIDDEN.
- **R-ASYNC-08:** Shutdown stages must execute in this order: stop intake → scripting safe-state → offline queue flush/fsync → MQTT drain → Modbus disconnect → runtime shutdown_timeout.
- **R-ASYNC-09:** `block_in_place` is FORBIDDEN on `current_thread` runtime and DISCOURAGED on `multi_thread` — justify in comments.
- **R-ASYNC-10:** Every `JoinHandle`/`JoinSet::join_next` must inspect `JoinError` for `is_panic()` and propagate to telemetry; silently ignored panics are FORBIDDEN.
