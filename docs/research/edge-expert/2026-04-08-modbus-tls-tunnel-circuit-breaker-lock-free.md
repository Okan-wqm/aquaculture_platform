# Research: Modbus TCP/RTU Safety, TLS Tunneling, Lock-Free Circuit Breaker, Token Bucket, Timeout Correctness

**Topic:** Modbus safety posture, `rodbus` 1.4 TLS, lock-free circuit breaker (atomics + CAS), token-bucket rate limiter, timeout correctness
**Date:** 2026-04-08
**Agent:** edge-expert

## Sources

- [docs.rs — `rodbus` crate root](https://docs.rs/rodbus/latest/rodbus/)
- [GitHub — `stepfunc/rodbus` README (Modbus over TLS + X.509 role ext)](https://github.com/stepfunc/rodbus/blob/main/rodbus/README.md)
- [GitHub — `stepfunc/rodbus` releases (1.x line)](https://github.com/stepfunc/rodbus/releases)
- [stepfunc.io — Modbus topic index](https://stepfunc.io/tags/modbus/)
- [CISA — ICS Advisory ICSA-17-101-01 (Schneider Modicon Modbus)](https://www.cisa.gov/news-events/ics-advisories/icsa-17-101-01)
- [CISA — ICS Advisory ICSA-17-089-02 (Schneider Modicon PLCs)](https://www.cisa.gov/news-events/ics-advisories/icsa-17-089-02)
- [CISA — ICS Advisory ICSA-25-254-09 (Schneider Modicon 2025)](https://www.cisa.gov/news-events/ics-advisories/icsa-25-254-09)
- [NIST SP 800-82 Rev. 3 — Guide to Operational Technology (OT) Security (final)](https://csrc.nist.gov/pubs/sp/800/82/r3/final)
- [NIST SP 800-82 Rev. 2 PDF (archived, still widely cited)](https://nvlpubs.nist.gov/nistpubs/specialpublications/nist.sp.800-82r2.pdf)
- [docs.rs — `leaky-bucket` crate](https://docs.rs/leaky-bucket)
- [docs.rs — `ratelimit` (brayniac)](https://docs.rs/ratelimit)
- [GitHub — `brayniac/ratelimit`](https://github.com/brayniac/ratelimit)

## Key Findings

### Modbus threat model (NIST SP 800-82 + CISA advisories)
- **Modbus has no authentication, no integrity, no confidentiality.** Function codes 5/6/15/16 (write coil/register/multiple) accept any request from any source that can reach the TCP socket or serial line.
- NIST SP 800-82 explicitly calls out Modbus as a protocol that "was not designed with security as a primary requirement" and requires compensating controls: network segmentation, unidirectional gateways, Modbus/TCP Security (RFC-draft TLS variant), and strict ACLs.
- CISA has issued multiple advisories (ICSA-17-101-01, ICSA-17-089-02, ICSA-25-254-09) on unauthenticated Modbus packets causing DoS or arbitrary write on Schneider Modicon PLCs; the pattern recurs across vendors. Any Modbus-TCP endpoint on a shared L2 segment is exposed.

### `rodbus` 1.4 (stepfunc) security features
- Supports **Modbus TCP**, **Modbus RTU** (serial), and **Modbus Security (TLS)** with optional **X.509 role extension** per the Modbus Organization spec. Role extension encodes an authorization role in a custom X.509 extension so the server can enforce per-role write authorization.
- TLS support is feature-gated; compiling without it produces a smaller binary but is only acceptable on a physically isolated OT segment.
- `rodbus` Client/Server channels are Tokio-based; request timeouts are per-request. There is no built-in circuit breaker or rate limiter — those must be layered on top.
- License note: rodbus 1.x is a **non-commercial license**; production use requires a commercial agreement with Step Function I/O. A review must verify the license is in place; using rodbus commercially without a license is a legal finding and blocks deploy.

### Modbus request timeout correctness
- **Per-request deadline, not per-connection.** A client-side timeout must be a `tokio::time::timeout` around each request, not reliant on TCP keepalive. On the wire, Modbus/TCP has a 2-byte transaction identifier; a late reply to a timed-out request must be discarded, not matched to the next request.
- **Serial/RTU inter-frame silence**: Modbus RTU requires ≥ 3.5 character-times of silence between frames and rejects frames with CRC errors; the underlying UART driver (linux tty) can merge frames under load and corrupt the state machine. Reviews must verify the RTU adapter uses `termios` with `VMIN=0`, `VTIME` sized correctly, or `TIOCGRS485` for RS-485 transceivers.
- **Server-side backpressure**: the gateway must rate-limit Modbus client traffic to the slave PLC — a flooding client can DoS the PLC's scan cycle, directly affecting control.

### Lock-free circuit breaker (atomics + CAS)
The canonical pattern encodes the three states (Closed / Open / HalfOpen) plus the failure counter plus the "open-since" timestamp in a single `AtomicU64` (or a pair of atomics) and drives transitions with `compare_exchange_weak`:

```rust
// Layout: [ state:2 | failures:14 | opened_at_ms:48 ]
struct CbState(AtomicU64);

impl CbState {
    fn on_failure(&self, now_ms: u64, threshold: u16, open_for: u64) {
        loop {
            let cur = self.0.load(Ordering::Acquire);
            let (state, fails, _) = decode(cur);
            let next = match state {
                CLOSED if fails + 1 >= threshold => encode(OPEN, 0, now_ms),
                CLOSED                           => encode(CLOSED, fails + 1, 0),
                HALF_OPEN                        => encode(OPEN, 0, now_ms),
                OPEN                             => return, // already open
                _ => unreachable!(),
            };
            if self.0.compare_exchange_weak(cur, next,
                    Ordering::AcqRel, Ordering::Acquire).is_ok() {
                return;
            }
        }
    }
}
```

Key properties a reviewer must verify:
1. **State transitions are total** — every valid input state has a defined next state; no `_ => unreachable!()` that can actually trigger (mark as `debug_assert` only).
2. **Memory ordering**: use `Ordering::AcqRel` on successful CAS, `Ordering::Acquire` on the failure load. Using `Relaxed` on the success path breaks happens-before for the counter reset.
3. **ABA protection**: if state and counter are in the same word, ABA is avoided by construction. If split across two atomics, `seqlock` or versioned pointers are required.
4. **HalfOpen probe counting**: HalfOpen must admit only *N* probe requests (typically 1) simultaneously — implement with an `AtomicI32` permit counter that `fetch_sub` / `fetch_add` and tracks overflow.
5. **Clock**: use `Instant::elapsed()` internally, not wall-clock (`SystemTime`) — the system clock can jump backwards (NTP correction) and wedge the open-since timestamp.
6. **No async lock inside the breaker**: the breaker's `allow()` check is a nanosecond-scale atomic load; wrapping it in a `tokio::sync::Mutex` defeats the purpose.

### Token bucket rate limiter (lock-free)
Production Rust implementations (brayniac/ratelimit, leaky-bucket, rater) use one of two shapes:

**A. Wall-clock-derived token count**:
```
available(now) = min(capacity, last_tokens + rate * (now - last_updated))
```
Stored as `AtomicU64` packing `(tokens, last_updated)`. On `acquire`, CAS-loop to decrement. This avoids a background refill thread but requires careful unit handling (nanoseconds overflow after ~583 years — safe).

**B. Background refill**: a single task periodically adds tokens to an `AtomicU64` counter; consumers `fetch_sub`. Simpler but costs a task.

For an edge agent with hard real-time budget on the scripting scan cycle, **shape A is preferred** — no scheduler pressure, no background task.

### Timeout correctness rules
- **Every network call has an explicit `tokio::time::timeout(deadline, fut)`**. Never rely on OS defaults.
- **Deadline propagation**: a SCADA command from the backend has a deadline; that deadline must propagate into the Modbus request timeout so the whole chain shares a single deadline. Use a `Deadline` type passed through calls.
- **Timeout < circuit-breaker opening threshold × expected latency**. Otherwise the breaker never opens — it's always mid-timeout.
- **No retry without jitter**: a retry after timeout must use jittered backoff (same full-jitter pattern as MQTT reconnect).

## Security Concerns

- **Unauthenticated Modbus-TCP** on any shared network is a CRITICAL finding unless the network segment is physically isolated and documented. Modbus/Security (TLS + X.509 role) or a dedicated VLAN + stateful firewall is the only acceptable production posture.
- **Write function codes (5, 6, 15, 16, 22, 23) on aquaculture control outputs** (VFD parameters, dosing pump speed, aerator on/off) are **life-safety critical** and must traverse an RBAC check keyed on the authenticated role (from X.509 role extension). Unrestricted write is CRITICAL.
- **Request-response desynchronization**: a Modbus client that does not discard late responses to timed-out transactions can apply a delayed write as if it were a current command — dangerous on fail-safe outputs.
- **Serial RTU exposed via TCP tunnel**: a common anti-pattern is socat/ser2net exposing `/dev/ttyUSB0` on the LAN. This removes even the "physical access" control. FORBIDDEN without TLS.
- **Circuit breaker incorrectness**: a breaker that silently falls through to "allow" on overflow or ABA can mask a downstream PLC DoS and prevent graceful degradation.

## Performance Concerns

- `tokio::sync::Mutex` in the circuit breaker hot path costs ~200 ns + potential task park → defeats the purpose.
- `SystemTime::now()` is ~20 ns on Linux but unstable across NTP jumps; `Instant::now()` is monotonic and ~15 ns.
- Token bucket with background refill adds scheduler pressure; shape A (wall-clock-derived) is preferred.
- Unbounded request queue ahead of the breaker can absorb enough traffic that the breaker never opens — always pair the breaker with a bounded inbound queue.

## Architectural Implications for edge-expert reviews

1. `modbus.rs` must wrap every client request in `tokio::time::timeout(deadline, rodbus_call)` with an explicit deadline derived from the caller.
2. Late responses (TID mismatch) must be discarded with a telemetry counter, never matched to a subsequent request.
3. Production deployments must use `rodbus`'s Modbus Security (TLS) with X.509 role extension, or be network-segmented and documented as such in the deploy manifest.
4. Write function codes must go through an RBAC check (matched against the provisioning role) before the rodbus call; unauthenticated writes to life-safety outputs are CRITICAL.
5. `resilience/circuit_breaker.rs` must be implemented with `AtomicU64` packing state+counter+timestamp, driven by `compare_exchange_weak`. `tokio::sync::Mutex` or `parking_lot::Mutex` in the hot path is FORBIDDEN.
6. Circuit breaker state transitions must be exhaustive — `match state { Closed => .., Open => .., HalfOpen => .. }` with no catch-all.
7. `Instant` (monotonic) is the ONLY acceptable clock in the breaker and rate limiter. `SystemTime`/`chrono::Utc::now()` is FORBIDDEN in these modules.
8. Token bucket limiter must be lock-free (shape A) and must guard the Modbus client inbound path.
9. Every network timeout must be paired with jittered retry and subject to the circuit breaker.
10. `rodbus` license must be verified and recorded; non-commercial use for production deploy is a legal finding blocking deploy.
11. RTU adapters: `termios` configuration audited (`VMIN=0`, `VTIME` sized for character time; RS-485 direction control via `TIOCSRS485` or GPIO).

## Domain Rule Additions for edge-expert

- **R-MOD-01:** Every `rodbus` client call wrapped in `tokio::time::timeout` with deadline propagated from caller.
- **R-MOD-02:** Late responses (TID mismatch) discarded with a metric counter; matching them to later requests is FORBIDDEN.
- **R-MOD-03:** Production Modbus MUST use Modbus Security (TLS + X.509 role extension) OR be on a documented isolated segment.
- **R-MOD-04:** Write function codes (5, 6, 15, 16, 22, 23) on control outputs go through an RBAC check matched against the authenticated role.
- **R-MOD-05:** `rodbus` non-commercial license is incompatible with production; commercial license must be recorded in `docs/licenses/` and verified during deploy review.
- **R-MOD-06:** RTU adapters must configure `termios` with `VMIN=0`, correctly sized `VTIME`, and RS-485 direction control via `TIOCSRS485` or a dedicated GPIO.
- **R-MOD-07:** Server-side inbound rate limit (token bucket) protects the downstream PLC scan cycle.
- **R-CB-01:** Circuit breaker state in a single `AtomicU64` packed (`state`, `failure_count`, `opened_at_ms`) driven by `compare_exchange_weak` with `Ordering::AcqRel` on success.
- **R-CB-02:** `Mutex` (sync or async) in the breaker hot path is FORBIDDEN.
- **R-CB-03:** Breaker uses `Instant` (monotonic); `SystemTime` is FORBIDDEN.
- **R-CB-04:** Breaker state `match` is exhaustive; no `_ => ...` catch-all.
- **R-CB-05:** HalfOpen admits exactly *N* probes via an `AtomicI32` permit counter with documented `N`.
- **R-CB-06:** Breaker threshold × expected per-request latency < retry deadline; otherwise breaker never opens.
- **R-RL-01:** Token bucket rate limiter is lock-free, wall-clock-derived (no background refill task).
- **R-RL-02:** Token bucket guards all inbound OT-network request paths (Modbus, SCADA command ingress).
- **R-TO-01:** Every network call has an explicit `tokio::time::timeout`; OS defaults are NOT acceptable.
- **R-TO-02:** Deadlines propagate end-to-end (backend command → gateway dispatch → PLC write) via a `Deadline` type.
- **R-TO-03:** Retry after timeout uses full-jitter exponential backoff.
