# Research: Rust Memory Safety — `unsafe`, `unwrap`, Leaks, Bounded Collections

**Topic:** `unsafe` block audit, eliminating `unwrap()` on I/O, bounded collections, `Box::leak` / `mem::forget` discipline, string interning for memory efficiency
**Date:** 2026-04-08
**Agent:** edge-expert

## Sources

- [The Rust Reference — The `unsafe` keyword](https://doc.rust-lang.org/reference/unsafe-keyword.html)
- [The Rustonomicon — Exception Safety](https://doc.rust-lang.org/nomicon/exception-safety.html)
- [The Rustonomicon — Leaking](https://doc.rust-lang.org/nomicon/leaking.html)
- [The Rust Book — Unsafe Rust (ch 20.1)](https://doc.rust-lang.org/book/ch20-01-unsafe-rust.html)
- [The Rust Book — To `panic!` or Not to `panic!`](https://doc.rust-lang.org/book/ch09-03-to-panic-or-not-to-panic.html)
- [Standard Library Dev Guide — Safety Comments Policy](https://std-dev-guide.rust-lang.org/policy/safety-comments.html)
- [`std::mem::forget`](https://doc.rust-lang.org/std/mem/fn.forget.html)
- [`Box::leak`](https://doc.rust-lang.org/std/boxed/struct.Box.html#method.leak)
- [`std::mem::ManuallyDrop`](https://doc.rust-lang.org/std/mem/struct.ManuallyDrop.html)
- [Clippy Lints index (restriction group)](https://rust-lang.github.io/rust-clippy/master/index.html)
- [Clippy — `unwrap_used` lint documentation](https://rust-lang.github.io/rust-clippy/master/index.html#unwrap_used)
- [Clippy — Lint Configuration](https://doc.rust-lang.org/clippy/lint_configuration.html)
- [Clippy — Usage (deny / forbid in CI)](https://doc.rust-lang.org/clippy/usage.html)

## Key Findings

### `unsafe` discipline (Rustonomicon, Reference, std-dev-guide)
- `unsafe` does **not** turn off the borrow checker — it merely unlocks five extra operations (deref raw pointer, call unsafe fn, access/modify mutable static, implement unsafe trait, access union field). Every `unsafe` block is a load-bearing invariant assertion by the author.
- **`SAFETY:` comment is mandatory.** The std-dev-guide's Safety Comments Policy requires that every `unsafe` block have an attached comment in the form `// SAFETY: <proof that the documented invariants of each unsafe call are upheld>`. Grouping multiple unsafe operations under one `SAFETY:` comment is acceptable only if the justification applies to all of them.
- **Keep unsafe blocks small** and wrap them in a safe abstraction exposing a safe API. Minimizing the review surface makes it feasible to audit.
- **Exception safety under unsafe:** Code that transiently creates unsound state (for example, `ptr::write` before updating a length field in a `Vec`) must ensure no panicking code runs between the two steps. A poison guard or `catch_unwind` is required on any path that may unwind.

### `unwrap()` and `expect()` in production
- The Rust Book explicitly allows `unwrap`/`expect` in examples, prototypes and tests, but recommends returning `Result` for production paths that can fail.
- For an embedded edge agent controlling physical outputs, any `unwrap` on I/O, network, file, deserialization, or configuration parsing is a crash risk. A panic inside a Tokio worker aborts the task (or the process if the panic propagates out of the runtime), and with `panic = "abort"` in `Cargo.toml` (the recommended setting for binaries that must not leave hung threads) the entire gateway dies — WDT reboot → brief loss of control.
- Clippy provides `clippy::unwrap_used` and `clippy::expect_used` in the `restriction` group. The documented pattern is to set them to `deny` (or `forbid`) at the crate root while `#[allow]`-ing them inside `#[cfg(test)]` modules:
  ```rust
  #![deny(clippy::unwrap_used, clippy::expect_used)]
  ```
- `unwrap_or`, `unwrap_or_else`, `unwrap_or_default` are **not** panicking and are permitted.

### `Box::leak`, `mem::forget`, `ManuallyDrop`
- `std::mem::forget` is **safe** — not marked `unsafe` — because Rust's memory safety guarantees do not require destructors to run (reference cycles in `Rc`, `process::exit`, etc.). However it is an anti-pattern in application code: it silently leaks owned resources (files, sockets, mmap regions).
- `Box::leak(b)` converts an owned `Box<T>` to `&'static mut T` by leaking the allocation. The canonical use is initializing a `&'static` configuration object computed at startup that must outlive `main`.
- `ManuallyDrop` is the **preferred** alternative when ownership is being transferred across an FFI boundary or into raw-pointer storage, because it disables `Drop` before anything else happens and thus prevents the double-free class of bugs that `mem::forget` permits.
- In an edge agent, the only legitimate uses are (a) FFI buffers transferred to C libraries (rppal bindings, SQLCipher native handle ownership transfer) and (b) one-shot `Box::leak` for `&'static` config — both must be documented with a `// WHY-LEAK:` comment.

### Bounded collections
- `std::collections::VecDeque`, `Vec`, `HashMap` have no upper bound and are unsafe to fill from untrusted network input (MQTT payloads, Modbus register pushes).
- The edge agent uses the `bounded.rs` module for ring-buffer semantics: push on full drops oldest or rejects new. Reviews must verify that any collection receiving external data (MQTT inbound queue, Modbus alarm list, script I/O buffers) uses a bounded type and exposes a metric on drop-count so the operator can see pressure.
- `tokio::sync::mpsc::channel(capacity)` is the preferred inter-task channel because it applies backpressure; `unbounded_channel()` is **forbidden** for any path that accepts external input.

### String interning (lasso / `interning.rs`)
- Topic strings, Modbus tag names, and sensor IDs repeat thousands of times in a long-running gateway. Storing each as `String` wastes heap. The `lasso` crate interns to a `Spur` (u32-sized key) with `O(1)` resolution.
- Interning also pins the string for the process lifetime — this is intentional. Reviews must verify the interner is used only for values with a bounded cardinality (device IDs, tag names from a configured set). Interning attacker-controlled strings (MQTT publish topics from an untrusted client) is a **memory-exhaustion vulnerability** — each unique topic permanently adds heap that cannot be freed.

## Security Concerns

- `unwrap()` on any input from the OT network, MQTT broker, or Modbus slave gives a remote attacker a DoS primitive (craft a packet that triggers the panic). On a gateway that controls aquaculture life support, an unexpected restart can silently disable fail-safe outputs during the boot window.
- An `unsafe` block without a `SAFETY:` comment is unauditable — reviewers cannot verify whether the invariants still hold after surrounding code changes, making it a ticking memory-corruption bug.
- `mem::forget` on an authenticated session handle or credential buffer is a **credential retention** bug: secrets remain in memory past their intended lifetime, visible to a post-compromise memory scraper.
- Interning untrusted string inputs creates a permanent memory leak primitive; combined with a constrained 512 MB RevPi, hours of operation under adversarial load yields OOM and crash.

## Performance Concerns

- `String` everywhere for topic names is cache-hostile and GC-churn equivalent on an embedded device — `lasso::Spur` is 4× more cache dense.
- Unbounded collections cause unbounded allocator pressure and tail-latency spikes on `jemalloc`.
- `Clone`-heavy error paths (stringly-typed errors) allocate under load — prefer `&'static str` or `thiserror` enums with interned contexts.

## Architectural Implications for edge-expert reviews

1. **Crate-root lint wall** must include:
   ```rust
   #![deny(clippy::unwrap_used, clippy::expect_used,
           clippy::panic, clippy::todo, clippy::unimplemented,
           clippy::unreachable, clippy::indexing_slicing,
           clippy::integer_arithmetic, clippy::float_arithmetic,
           unsafe_op_in_unsafe_fn)]
   #![warn(clippy::pedantic, clippy::nursery)]
   ```
   Tests use `#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]`.
2. Every `unsafe` block must begin with a `// SAFETY:` comment. A missing comment is a **CRITICAL** review finding.
3. Every `Box::leak` and `mem::forget` must have a `// WHY-LEAK:` comment naming the external owner (FFI, `'static` config, ring-buffer thread handoff). Absent this the finding is **HIGH**.
4. Every collection on the external-input path must be bounded, with a metric for drops/rejects exposed via telemetry.
5. `interning.rs` (lasso) must only intern strings whose cardinality is bounded at configuration time. An audit trail must show all intern callsites have a provably bounded domain; MQTT inbound topic strings must **not** be interned.
6. All credential-bearing structs must implement `Zeroize`/`ZeroizeOnDrop` (from the `zeroize` crate); `mem::forget` on any such struct is a **CRITICAL** finding.
7. Panic strategy: `Cargo.toml` `[profile.release] panic = "abort"` is recommended for the edge agent so that a runaway panic cannot leave partially-updated OT state; paired with systemd `Restart=always` and a staged boot that enters safe-state on start.

## Domain Rule Additions for edge-expert

- **R-MEM-01:** Crate-level `#![deny(clippy::unwrap_used, clippy::expect_used)]` with `cfg(test)` allow — mandatory in `sens-api-gateway/src/lib.rs`/`main.rs`.
- **R-MEM-02:** Every `unsafe` block REQUIRES a `// SAFETY:` comment explaining upheld invariants.
- **R-MEM-03:** `unsafe fn` must be callable only from `unsafe` blocks; `unsafe_op_in_unsafe_fn` lint set to `deny`.
- **R-MEM-04:** `Box::leak` and `mem::forget` REQUIRE a `// WHY-LEAK:` comment; `ManuallyDrop` preferred over `mem::forget` for FFI ownership transfer.
- **R-MEM-05:** Zero-on-drop for all credentials via the `zeroize` crate; `Secret<String>` already wraps this in `config.rs`.
- **R-MEM-06:** `unbounded_channel` is FORBIDDEN on external-input paths; use `mpsc::channel(capacity)` with documented capacity rationale.
- **R-MEM-07:** `interning.rs` callsites must operate on a bounded-cardinality domain; interning attacker-controlled strings (MQTT topics from untrusted publishers) is FORBIDDEN.
- **R-MEM-08:** All network-input deserialization must use `?` or explicit error handling; `unwrap()`/`expect()` on a `Result` from `serde_json`, `rumqttc::Event`, `rodbus` response types is FORBIDDEN.
- **R-MEM-09:** Crate root lint wall also denies `clippy::indexing_slicing` (catch raw `vec[i]` panics on untrusted input).
- **R-MEM-10:** `Cargo.toml` release profile: `panic = "abort"` (paired with systemd-supervised restart and safe-state on boot).
