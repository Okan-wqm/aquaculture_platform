//! Process-level hardening primitives (Batch 24, plan §5 Faz 2 Step 2).
//!
//! This module installs two boot-time hardening controls:
//!
//! 1. **`prctl(PR_SET_DUMPABLE, 0)`** — disables core-dump generation
//!    for this process. When future Sprint 6.3 wires the keystore master
//!    key into process memory (mlock-ed pages), a segfault-triggered
//!    coredump would write the key to disk under /var/crash or
//!    systemd-coredump storage. Disabling dumpable status is the kernel-
//!    level gate that prevents the coredump from ever being written,
//!    even if the operator has unlimited `ulimit -c`.
//!
//! 2. **Panic-abort hook** — replaces Rust's default panic handler with
//!    one that calls `std::process::abort()` after logging the panic.
//!    Rust's default behavior on panic is STACK UNWINDING which runs
//!    `Drop::drop()` destructors along the way. For zeroizable secrets
//!    (master key, DEK, per-command envelope signatures), destructors
//!    scrub the memory — GREAT for normal shutdown paths. BUT during a
//!    panic mid-way through a security-critical operation, partial
//!    destructor execution can leave the program in an inconsistent
//!    security state (e.g., key decrypted but authz check not yet
//!    reached). `abort()` is the tier-1 "make it impossible" choice:
//!    the kernel terminates the process immediately with no destructor
//!    execution. The single-shot hardened-shutdown contract is clearer
//!    than relying on partial-unwind correctness proofs.
//!
//! ## Why BOTH protections are needed
//!
//! - `prctl(PR_SET_DUMPABLE, 0)` prevents disk leakage on CRASH.
//! - Panic-abort prevents execution leakage on CONTROLLED FAILURE
//!   (panic! / assert! / unwrap_or_panic paths).
//! - Together they close the two paths by which in-memory secrets
//!   could escape the process boundary.
//!
//! ## Ordering constraint
//!
//! Both must run BEFORE any code path that:
//! - Allocates pages that would later contain secrets (Sprint 6.3).
//! - Spawns tokio tasks whose panics would bypass the main-thread hook.
//!
//! So `harden_process()` is called in `fn main()` FIRST, before the
//! tokio runtime builder and before argument parsing allocates.
//!
//! ## Platform scope
//!
//! Linux-only. On non-Linux targets (cfg=windows, cfg=macos), the
//! implementation is a no-op with an INFO log. The platform gate is
//! justified by the plan's deployment target (Raspberry Pi + x86_64
//! Linux edge gateways — per ADR-019 hardware adapter inventory).
//!
//! ## Cross-references
//!
//! - Plan §5 Faz 2 Step 2 (mlock + prctl + panic hook).
//! - ADR-019 §5 (in-process hardening primitives).
//! - Batch 4b keystore types (pre-staged for Sprint 6.3 mlock wire-up).
//! - Batch 4a systemd-unit hardening (LimitCORE=0 from outside process;
//!   prctl here is the inside-process equivalent that still applies
//!   even if systemd-unit override raises LimitCORE).

use tracing::{info, warn, error};

/// Apply all boot-time process hardening controls.
///
/// Returns an error string if any control failed; the caller must
/// decide whether failure is fatal. Plan §5 Faz 2 Step 2 mandates
/// fail-closed boot when `config.security.process_hardening_enforce`
/// (TODO Sprint 6.3) is enabled; until then the caller logs a
/// warning and continues, preserving HC-1 v1.6.0 backward compat.
///
/// **Batch #309 D-2 partial — mlock added.** The hardening sequence
/// now also pins all current + future allocations in RAM via
/// `mlockall(MCL_CURRENT | MCL_FUTURE)`. This prevents the kernel
/// from paging secret bytes (master key, derived per-purpose keys,
/// envelope signature material) to swap. Kernel-level guarantee
/// that complements (a) `LimitCORE=0` from systemd unit (Batch 4a),
/// (b) `prctl(PR_SET_DUMPABLE, 0)` from this module, and (c)
/// `ZeroizeOnDrop` on `KeyMaterial` (Batch 4b). The four together
/// close the "secret bytes leave RAM" attack surface.
pub fn harden_process() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        disable_core_dumps()?;
        // Batch #309 D-2: mlock BEFORE the panic hook so the panic
        // hook (which logs but does not allocate large buffers) is
        // installed against an already-pinned heap. Order is not
        // load-bearing — both calls are idempotent — but pinning
        // first is the more conservative sequence.
        let mlock_state = mlock::mlock_all_pages();
        match &mlock_state {
            Ok(state) => {
                info!(
                    "Process hardening: mlockall succeeded \
                     (locked_current={} locked_future={})",
                    state.locked_current, state.locked_future,
                );
            }
            Err(e) => {
                // Best-effort by default — mlock requires either
                // root OR CAP_IPC_LOCK OR a sufficient
                // `RLIMIT_MEMLOCK`. Container environments often
                // lack the cap; logging a structured warn lets
                // operators decide whether the deployment posture
                // requires raising the limit.
                warn!(
                    "Process hardening: mlockall FAILED — secret pages \
                     may swap to disk on memory pressure. err={} \
                     (raise RLIMIT_MEMLOCK or grant CAP_IPC_LOCK to \
                     enforce; future config.security.mlock_enforce flag \
                     will fail-close boot here)",
                    e,
                );
            }
        }
        install_panic_abort_hook();
        info!("Process hardening applied: prctl(PR_SET_DUMPABLE=0) + mlockall + panic-abort hook");
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Plan §5 Faz 2 Step 2 scope is Linux-only per ADR-019
        // hardware target. Non-Linux builds (developer laptops
        // running macOS/Windows for build-time linting) skip this
        // hardening; systemd + prctl + mlockall semantics differ
        // outside Linux.
        info!("Process hardening skipped: non-Linux platform (development/CI build)");
        // Panic-abort hook IS cross-platform — install it anyway.
        install_panic_abort_hook();
        Ok(())
    }
}

/// Disable core-dump generation via prctl(PR_SET_DUMPABLE, 0).
///
/// WHY: When keystore master key pages live in process memory
/// (Sprint 6.3 mlock wire-up), a segfault-triggered coredump would
/// write the key to disk under /var/crash. Setting dumpable=0 tells
/// the kernel to skip core-dump generation for this process even
/// when `ulimit -c unlimited` is active.
///
/// INTERACTION WITH SYSTEMD: Batch 4a systemd unit already carries
/// `LimitCORE=0` which is the SYSTEMD-LEVEL coredump cap. prctl
/// here is the INSIDE-PROCESS guard that still applies if an
/// operator-privileged user overrides the systemd limit via
/// `systemctl edit --runtime`.
///
/// SIDE EFFECTS:
/// - `/proc/<pid>/mem` read access restricted to `root` (was
///   readable by the process owner); prevents an attacker with
///   shell-as-same-uid from attaching gdb to read memory.
/// - ptrace attach by non-root is blocked (dumpable=0 is an alias
///   for `PR_SET_PTRACER` deny).
///
/// SAFETY: `libc::prctl` is a C FFI. Calling it with `PR_SET_DUMPABLE
/// = 4` + second arg = `0` is documented-stable syscall semantics.
/// Return value 0 = success, -1 = error (check errno). No memory
/// safety concerns — the syscall operates on kernel-side process
/// flags, not on user memory.
#[cfg(target_os = "linux")]
fn disable_core_dumps() -> Result<(), String> {
    // PR_SET_DUMPABLE = 4 per <sys/prctl.h>.
    // Second arg 0 = not dumpable; 1 = dumpable (default); 2 =
    // dumpable-by-root-only (SUID-transition default).
    const PR_SET_DUMPABLE: libc::c_int = 4;

    // SAFETY: prctl is a kernel syscall operating on per-process
    // flags in kernel memory; it does not touch user memory and
    // cannot violate Rust's aliasing rules. PR_SET_DUMPABLE is a
    // documented-stable prctl operation (added in Linux 2.4).
    let rc = unsafe { libc::prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) };

    if rc == 0 {
        Ok(())
    } else {
        // Capture errno EARLY — any subsequent libc call may clobber it.
        let err = std::io::Error::last_os_error();
        Err(format!(
            "prctl(PR_SET_DUMPABLE, 0) failed: rc={} errno={}",
            rc, err
        ))
    }
}

/// Install a panic hook that calls `std::process::abort()` after
/// logging the panic.
///
/// WHY ABORT vs UNWIND: Rust's default panic handler unwinds the
/// stack, running `Drop::drop` destructors as it goes. For
/// zeroizable secret types (keystore::secret::KeyMaterial, pending
/// Sprint 6.3), destructors scrub the memory — desirable during
/// normal shutdown. BUT mid-operation panics can leave the program
/// in an inconsistent security state:
/// - Master key decrypted into mlock-ed page (Sprint 6.3) but
///   authz check not yet reached → next task sees unauthorized
///   access to an unscrubbed-but-visible key.
/// - TOCTOU window between manifest verify and manifest use (Batch
///   8 updater) — a panic between verify and apply would leave
///   partial state on disk.
///
/// `abort()` terminates the process IMMEDIATELY without destructor
/// execution. Kernel then reaps the process, releasing all pages
/// including the mlock-ed secret pages (pages are zeroed at
/// kernel-release time per Linux MM semantics). This is the tier-1
/// guarantee: panic paths cannot partially-mutate security state.
///
/// The hook also logs the panic info BEFORE aborting so operators
/// can see the panic location in systemd journal.
///
/// WHY NOT `panic = "abort"` IN CARGO: That Cargo setting changes
/// ALL panic paths to abort — tests, development builds, CI runs.
/// Installing a runtime hook gives us abort-on-panic IN PRODUCTION
/// while keeping unwind-based test harnesses (which need unwinding
/// to catch assert! failures per test).
pub fn install_panic_abort_hook() {
    std::panic::set_hook(Box::new(|panic_info| {
        // Log the panic location + message via `tracing::error`.
        // Use `eprintln!` as a fallback because tracing may not
        // have been initialized yet if we're panicking very early.
        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());

        let message: String = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };

        // Try tracing first; fall through to stderr.
        error!("PANIC at {}: {}", location, message);
        // WHY: pre-abort bootstrap — tracing may have been shut
        // down OR the panic may have occurred BEFORE tracing
        // init (rare but possible). eprintln! is the last-resort
        // operator-visible signal.
        #[allow(clippy::print_stderr)]
        {
            eprintln!("PANIC at {}: {}", location, message);
            eprintln!("Process aborting (hardened panic hook — no destructor unwinding).");
        }

        // Abort: kernel terminates the process without destructor
        // execution. Exit code will be SIGABRT (134 on typical
        // Linux) which systemd's Restart=on-failure should pick
        // up as a restart trigger.
        std::process::abort();
    }));
    warn!("Panic-abort hook installed — panics will SIGABRT the process without unwinding");
}

// ===================================================================
// Batch #309 D-2 mlock primitive — pin process pages in RAM
// ===================================================================

/// `mlock` submodule — pin the process's address space in RAM so
/// secret bytes never reach swap.
///
/// ## Why a submodule (not a top-level fn)
///
/// `process_hardening.rs` already owns the prctl + panic-abort
/// surface as top-level fns. mlock has its OWN error taxonomy,
/// state-result type, and platform fallbacks; bundling those into
/// the parent namespace would clutter it. Submodule keeps the
/// prctl + panic + mlock primitives parallel + greppable.
///
/// ## Architectural relationship to `MasterKeyMaterial` / `KeyMaterial`
///
/// `mod secret` already wraps secrets in `Secret<T>` + `ZeroizeOnDrop`
/// (Batch 4b). Those are HEAP-PAGE-LEVEL guarantees: the bytes are
/// scrubbed when the value drops, regardless of which page hosts
/// them. mlock is the COMPLEMENT — it ensures no copy of those
/// pages reaches swap WHILE the value is alive. Without mlock, an
/// attacker with root access to the swap partition (post-reboot
/// forensics, eMMC dump, cloud-VM hypervisor) can extract the
/// master key from a paged-out copy even though the in-RAM copy
/// was correctly drop-zeroized.
///
/// ## Why `mlockall(MCL_CURRENT | MCL_FUTURE)` and not selective `mlock`
///
/// Selective mlock (lock only the pages holding `MasterKeyMaterial`)
/// is more page-efficient but architecturally fragile:
///
/// 1. Rust's allocator may freely move secrets across pages —
///    every reallocation requires a re-`mlock`. Bug-prone.
/// 2. Heap fragmentation can cause secret bytes to live partially
///    on a locked page and partially on an unlocked page.
/// 3. Async stack frames hold transient secrets between awaits;
///    those frames are not addressable from the secret's owner.
///
/// `mlockall` locks the ENTIRE address space — every current page
/// + every future allocation. Memory cost on the RPi CM4 (1-8 GB
/// RAM) is acceptable: the agent's working set is ~150-300 MB at
/// p99; mlockall reduces available swap pressure but not below
/// the box's physical RAM, which is the only reasonable target
/// for an embedded edge gateway anyway.
pub mod mlock {

    /// Result of a successful (or partially-successful) `mlockall`
    /// call. Even when `mlockall` returns 0, we record which flags
    /// were active so audit / metrics can correlate the runtime
    /// posture against the seal-on-rotation contract.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct MlockState {
        /// `MCL_CURRENT` was set — every page mapped at the call
        /// time is locked.
        pub locked_current: bool,
        /// `MCL_FUTURE` was set — every subsequent allocation
        /// (heap grow, mmap, async stack push) is auto-locked.
        pub locked_future: bool,
    }

    /// Errors specific to the `mlockall` syscall surface.
    ///
    /// Per `mlockall(2)`:
    /// - `EPERM` — caller lacks `CAP_IPC_LOCK` AND `RLIMIT_MEMLOCK`
    ///   is too small for the address space.
    /// - `ENOMEM` — locking would exceed `RLIMIT_MEMLOCK` (older
    ///   kernels can return this instead of EPERM).
    /// - `EAGAIN` — transient; not normally seen for `mlockall`
    ///   but documented; treat as retry-after-backoff.
    /// - `EINVAL` — invalid flag combination; should not happen
    ///   with our hard-coded `MCL_CURRENT | MCL_FUTURE`.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum MlockError {
        /// `EPERM` — lacks privilege OR `RLIMIT_MEMLOCK`.
        /// Recovery: grant `CAP_IPC_LOCK` to the systemd unit OR
        /// raise `LimitMEMLOCK=infinity` in the unit.
        NotPermitted(String),
        /// `ENOMEM` — limit hit.
        InsufficientLimit(String),
        /// `EAGAIN` — transient.
        TemporaryFailure(String),
        /// Unrecognized errno from the kernel.
        UnknownErrno { errno: i32, label: String },
        /// Non-Linux platform — mlockall has different semantics
        /// or doesn't exist.
        UnsupportedPlatform,
    }

    impl std::fmt::Display for MlockError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::NotPermitted(s) => write!(f, "mlockall_not_permitted: {}", s),
                Self::InsufficientLimit(s) => write!(f, "mlockall_insufficient_limit: {}", s),
                Self::TemporaryFailure(s) => write!(f, "mlockall_temporary_failure: {}", s),
                Self::UnknownErrno { errno, label } => {
                    write!(f, "mlockall_unknown_errno_{}: {}", errno, label)
                }
                Self::UnsupportedPlatform => f.write_str("mlockall_unsupported_platform"),
            }
        }
    }

    impl std::error::Error for MlockError {}

    /// Pin all current + future process pages in RAM via
    /// `mlockall(MCL_CURRENT | MCL_FUTURE)`.
    ///
    /// IDEMPOTENCY: calling twice is harmless — kernel ignores the
    /// second call (pages are already locked). The function is
    /// safe to invoke from `harden_process()` AND from any
    /// subsystem that wants belt-and-braces re-application
    /// (TpmKeystore::open could call this defensively after
    /// unsealing, for example).
    ///
    /// PLATFORM: Linux only. Non-Linux returns
    /// `UnsupportedPlatform`. macOS has `mlockall` with similar
    /// semantics but no `RLIMIT_MEMLOCK` guarantee; we don't
    /// support macOS as a deployment target so we don't attempt
    /// to wire it.
    #[cfg(target_os = "linux")]
    pub fn mlock_all_pages() -> Result<MlockState, MlockError> {
        // From <sys/mman.h>:
        //   MCL_CURRENT = 1
        //   MCL_FUTURE  = 2
        //   MCL_ONFAULT = 4 (Linux 4.4+; we don't use it because
        //                   we want the strongest guarantee —
        //                   eager locking)
        //
        // libc::mlockall takes the flags as `c_int`.
        let flags = libc::MCL_CURRENT | libc::MCL_FUTURE;

        // SAFETY: `mlockall` is a kernel syscall taking a single
        // integer flag. It does not touch user memory and cannot
        // violate Rust's aliasing rules. Documented stable since
        // Linux 2.0.
        let rc = unsafe { libc::mlockall(flags) };

        if rc == 0 {
            return Ok(MlockState {
                locked_current: true,
                locked_future: true,
            });
        }

        // Capture errno IMMEDIATELY — any subsequent libc call may
        // clobber it.
        let err = std::io::Error::last_os_error();
        let errno = err.raw_os_error().unwrap_or(0);
        let label = err.to_string();

        Err(match errno {
            libc::EPERM => MlockError::NotPermitted(label),
            libc::ENOMEM => MlockError::InsufficientLimit(label),
            libc::EAGAIN => MlockError::TemporaryFailure(label),
            other => MlockError::UnknownErrno {
                errno: other,
                label,
            },
        })
    }

    /// Non-Linux fallback — mlockall behaviour differs / is absent.
    /// Documented `UnsupportedPlatform` error so the caller can
    /// log the deployment-posture mismatch without crashing.
    #[cfg(not(target_os = "linux"))]
    pub fn mlock_all_pages() -> Result<MlockState, MlockError> {
        Err(MlockError::UnsupportedPlatform)
    }

    /// Audit / metrics accessor — read `/proc/self/status` and
    /// extract the `VmLck:` line. Used by tests + by future
    /// observability metrics to verify the mlock posture is
    /// actually applied.
    ///
    /// Returns the locked-bytes count when the line is present
    /// + parseable; returns `None` on non-Linux platforms or
    /// when the proc file is unreadable (rare — kernel always
    /// emits it).
    #[cfg(target_os = "linux")]
    pub fn proc_self_vm_locked_bytes() -> Option<u64> {
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        for line in status.lines() {
            // Format: "VmLck:\t   12345 kB"
            if let Some(rest) = line.strip_prefix("VmLck:") {
                let trimmed = rest.trim();
                let mut parts = trimmed.split_whitespace();
                let n_str = parts.next()?;
                let unit = parts.next().unwrap_or("kB");
                let n: u64 = n_str.parse().ok()?;
                let multiplier: u64 = match unit {
                    "kB" | "KB" => 1024,
                    "B" => 1,
                    "MB" | "mB" => 1024 * 1024,
                    _ => return None,
                };
                return Some(n * multiplier);
            }
        }
        None
    }

    #[cfg(not(target_os = "linux"))]
    pub fn proc_self_vm_locked_bytes() -> Option<u64> {
        None
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// MlockError Display strings are pinned for audit /
        /// log-grep stability.
        #[test]
        fn mlock_error_display_strings_pinned() {
            assert_eq!(
                format!("{}", MlockError::NotPermitted("eperm".into())),
                "mlockall_not_permitted: eperm",
            );
            assert_eq!(
                format!("{}", MlockError::InsufficientLimit("enomem".into())),
                "mlockall_insufficient_limit: enomem",
            );
            assert_eq!(
                format!("{}", MlockError::TemporaryFailure("eagain".into())),
                "mlockall_temporary_failure: eagain",
            );
            assert_eq!(
                format!("{}", MlockError::UnsupportedPlatform),
                "mlockall_unsupported_platform",
            );
            assert_eq!(
                format!(
                    "{}",
                    MlockError::UnknownErrno {
                        errno: 99,
                        label: "x".into()
                    }
                ),
                "mlockall_unknown_errno_99: x",
            );
        }

        /// MlockState can be constructed + compared by value.
        /// Pin the field shape so audit consumers don't see
        /// silent breakage.
        #[test]
        fn mlock_state_field_shape_pinned() {
            let s = MlockState {
                locked_current: true,
                locked_future: true,
            };
            assert!(s.locked_current);
            assert!(s.locked_future);
            assert_eq!(
                s,
                MlockState {
                    locked_current: true,
                    locked_future: true
                }
            );
        }

        /// MlockError implements std::error::Error so callers
        /// can use `?` interop / wrap in larger error types.
        #[test]
        fn mlock_error_implements_std_error() {
            fn assert_err<E: std::error::Error>() {}
            assert_err::<MlockError>();
        }

        /// On Linux: `mlock_all_pages` returns either Ok
        /// (running as root or with CAP_IPC_LOCK / sufficient
        /// RLIMIT_MEMLOCK) OR a structured Err. NEVER panics.
        /// CI runners typically don't have the cap so we
        /// accept either outcome — what matters is the
        /// shape contract, not the env-dependent verdict.
        #[cfg(target_os = "linux")]
        #[test]
        fn mlock_all_pages_returns_structured_result_no_panic() {
            let result = mlock_all_pages();
            // Either branch is acceptable; the test asserts
            // the function does not panic + returns the
            // expected shape.
            match result {
                Ok(state) => {
                    // When mlockall succeeds, both flags are
                    // active per our hard-coded MCL_CURRENT |
                    // MCL_FUTURE.
                    assert!(state.locked_current);
                    assert!(state.locked_future);
                }
                Err(e) => {
                    // Acceptable error classes in CI: NotPermitted
                    // (no CAP_IPC_LOCK), InsufficientLimit
                    // (RLIMIT_MEMLOCK too small), or UnknownErrno
                    // (unusual env). The unsupported-platform
                    // class is impossible on Linux.
                    assert!(
                        !matches!(e, MlockError::UnsupportedPlatform),
                        "Linux should never return UnsupportedPlatform, got {:?}",
                        e
                    );
                }
            }
        }

        /// Non-Linux platforms always return UnsupportedPlatform.
        #[cfg(not(target_os = "linux"))]
        #[test]
        fn mlock_all_pages_unsupported_on_non_linux() {
            let result = mlock_all_pages();
            assert_eq!(result, Err(MlockError::UnsupportedPlatform));
        }

        /// `proc_self_vm_locked_bytes` parses the kernel's
        /// VmLck format. On Linux, the call returns Some(n) —
        /// the value depends on env (running as root with
        /// mlockall succeeded vs CI without). What matters is
        /// the parser returns Some when the file exists +
        /// has the expected line shape.
        #[cfg(target_os = "linux")]
        #[test]
        fn proc_vm_locked_bytes_returns_some_on_linux() {
            // /proc/self/status always has VmLck on Linux ≥ 2.6.
            let result = proc_self_vm_locked_bytes();
            assert!(
                result.is_some(),
                "expected Some(_) from /proc/self/status VmLck on Linux"
            );
            // Value is always >= 0 (u64); we don't assert >0
            // because non-root CI runs typically have VmLck=0.
        }

        /// `proc_self_vm_locked_bytes` returns None on
        /// non-Linux platforms (no /proc).
        #[cfg(not(target_os = "linux"))]
        #[test]
        fn proc_vm_locked_bytes_none_on_non_linux() {
            assert_eq!(proc_self_vm_locked_bytes(), None);
        }
    }
}
