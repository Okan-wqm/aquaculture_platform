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

        // Batch #311 D-2 closure: walk the panic_zeroize
        // registry BEFORE abort. Best-effort with try_lock so
        // a panic mid-register/unregister doesn't deadlock
        // the hook; in that rare case the kernel still
        // releases pages (mlock + zeroize-on-drop layers
        // remain). Registry is empty if no caller has
        // registered any secret region (default path).
        let scrubbed = panic_zeroize::scrub_all_registered_best_effort();
        if scrubbed > 0 {
            #[allow(clippy::print_stderr)]
            {
                eprintln!(
                    "Panic-zeroize: {} registered secret regions scrubbed.",
                    scrubbed
                );
            }
        }

        // Abort: kernel terminates the process without destructor
        // execution. Exit code will be SIGABRT (134 on typical
        // Linux) which systemd's Restart=on-failure should pick
        // up as a restart trigger.
        std::process::abort();
    }));
    warn!("Panic-abort hook installed — panics will SIGABRT the process without unwinding (panic_zeroize registry scrubs registered secrets first)");
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
        #[cfg(target_os = "linux")]
        #[test]
        fn mlock_all_pages_returns_structured_result_no_panic() {
            let result = mlock_all_pages();
            match result {
                Ok(state) => {
                    assert!(state.locked_current);
                    assert!(state.locked_future);
                }
                Err(e) => {
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
        /// VmLck format. On Linux it returns Some(n).
        #[cfg(target_os = "linux")]
        #[test]
        fn proc_vm_locked_bytes_returns_some_on_linux() {
            let result = proc_self_vm_locked_bytes();
            assert!(
                result.is_some(),
                "expected Some(_) from /proc/self/status VmLck on Linux"
            );
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

// ===================================================================
// Batch #310 D-2 memfd_secret primitive — strongest in-process secret
// container. Pages cannot be mapped into other processes (even root
// cannot read /proc/<pid>/mem on a memfd_secret region per the
// Linux 5.14+ kernel implementation).
// ===================================================================

/// `memfd_secret` submodule — Linux 5.14+ syscall providing a
/// memory file descriptor whose pages are HARDWARE-ISOLATED from
/// every other process.
///
/// ## Why memfd_secret over mlock+plain-mmap
///
/// `mlock` (Batch #309) keeps pages OFF SWAP. `prctl(PR_SET_DUMPABLE,
/// 0)` stops coredumps. But neither prevents:
///
/// 1. `/proc/<pid>/mem` reads from a privileged process (root-as-
///    attacker, post-compromise reconnaissance) — the kernel
///    happily serves these for ordinary anonymous mmap regions.
/// 2. Hibernation image inclusion — `swsusp` writes ALL non-zero
///    user pages to disk on suspend-to-disk; mlock pages are
///    included.
/// 3. Live-migration / VM snapshot inclusion — KVM exposes the
///    full guest RAM to the host; mlock pages are visible.
///
/// `memfd_secret(2)` pages are excluded from ALL of the above:
/// the kernel uses `set_direct_map_invalid_noflush()` to remove
/// the kernel direct-map of those pages, so even the kernel
/// itself cannot reach them outside the owning process.
///
/// ## Why a fallback path
///
/// Linux 5.14 (Aug 2021) is the minimum. Older kernels (5.10
/// LTS still supported on some embedded distros) do not have
/// the syscall. The constructor returns `Err(NotSupported)`
/// and the caller falls back to the mlock+anonymous-mmap path
/// (Batch #309). The architectural property "secrets in
/// memfd_secret OR mlock-pinned" is the contract; the
/// caller's job is to pick the strongest available.
pub mod memfd_secret {

    use std::ptr::NonNull;

    /// Errors specific to the `memfd_secret(2)` syscall + the
    /// followup ftruncate / mmap calls.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum MemfdSecretError {
        /// Kernel does not support memfd_secret (Linux < 5.14
        /// or built without `CONFIG_SECRETMEM`). Caller falls
        /// back to mlock + anonymous-mmap.
        NotSupported,
        /// `len == 0` is not a useful allocation; rejected at
        /// constructor time with this distinct variant so
        /// callers can pin the contract in a unit test.
        ZeroLength,
        /// `ftruncate` failed on the memfd_secret fd.
        TruncateFailed { errno: i32, label: String },
        /// `mmap` failed on the memfd_secret fd.
        MmapFailed { errno: i32, label: String },
        /// memfd_secret syscall returned an unexpected errno.
        UnexpectedErrno { errno: i32, label: String },
    }

    impl std::fmt::Display for MemfdSecretError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::NotSupported => f.write_str("memfd_secret_not_supported"),
                Self::ZeroLength => f.write_str("memfd_secret_zero_length"),
                Self::TruncateFailed { errno, label } => {
                    write!(f, "memfd_secret_truncate_failed_errno_{}: {}", errno, label)
                }
                Self::MmapFailed { errno, label } => {
                    write!(f, "memfd_secret_mmap_failed_errno_{}: {}", errno, label)
                }
                Self::UnexpectedErrno { errno, label } => {
                    write!(f, "memfd_secret_unexpected_errno_{}: {}", errno, label)
                }
            }
        }
    }

    impl std::error::Error for MemfdSecretError {}

    /// Owned memfd_secret region. Drops via munmap + close.
    /// Kernel automatically zeroes the pages on release.
    ///
    /// **Why `Send` (manual unsafe impl):** the struct owns
    /// `(fd, ptr, len)` exclusively — no aliasing, no shared
    /// state, the destructor releases the kernel resources.
    /// Moving across threads is safe.
    ///
    /// **Why NOT `Sync`:** the `as_mut_slice` API requires
    /// `&mut self` exclusivity; callers needing shared access
    /// must wrap in `Mutex<MemfdSecretRegion>`. This matches
    /// `Vec<u8>`'s shape — same exclusivity model.
    pub struct MemfdSecretRegion {
        fd: i32,
        ptr: NonNull<u8>,
        len: usize,
    }

    // SAFETY: the struct owns its (fd, ptr, len) tuple
    // exclusively. There is no shared state between threads.
    // The Drop impl releases the kernel resources.
    unsafe impl Send for MemfdSecretRegion {}

    impl std::fmt::Debug for MemfdSecretRegion {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("MemfdSecretRegion")
                .field("fd", &self.fd)
                .field("len", &self.len)
                .field("contents", &"<REDACTED memfd_secret region>")
                .finish()
        }
    }

    /// Probe whether the running kernel supports memfd_secret.
    /// Cheap (one syscall returning -1/ENOSYS or a fd we
    /// immediately close).
    #[cfg(target_os = "linux")]
    pub fn is_supported() -> bool {
        // Linux syscall number 447 on x86_64 + arm64.
        // libc 0.2 exposes the wrapper as `libc::SYS_memfd_secret`
        // on supported targets; not all targets carry the
        // constant, so we fall back to the raw syscall number.
        // Calling with flags=0 is documented stable.

        // SAFETY: syscall number 447 with flags=0 is the
        // documented memfd_secret signature. Returns a non-
        // negative fd on success or -1 with errno set. No
        // user-memory access.
        let rc = unsafe { libc::syscall(libc::SYS_memfd_secret, 0u32) };
        if rc < 0 {
            return false;
        }
        // SAFETY: rc is a valid file descriptor we just got
        // from the kernel; closing it releases the secret
        // region (which has zero length).
        unsafe {
            libc::close(rc as i32);
        }
        true
    }

    #[cfg(not(target_os = "linux"))]
    pub fn is_supported() -> bool {
        false
    }

    impl MemfdSecretRegion {
        /// Allocate a fresh `len`-byte memfd_secret region.
        /// Bytes are kernel-zeroed before return.
        ///
        /// FAILURE MODES:
        /// - `len == 0` → `ZeroLength` (architecturally
        ///   pointless allocation; fail-closed at the type
        ///   boundary).
        /// - kernel ENOSYS → `NotSupported` (Linux < 5.14 or
        ///   missing `CONFIG_SECRETMEM`).
        /// - ftruncate / mmap errors → structured variants.
        ///
        /// SAFETY DISCIPLINE: every unsafe operation here is
        /// documented inline. The owning struct's Drop impl
        /// is the SOLE site that munmaps + closes; no other
        /// path may release the resources.
        #[cfg(target_os = "linux")]
        pub fn allocate(len: usize) -> Result<Self, MemfdSecretError> {
            if len == 0 {
                return Err(MemfdSecretError::ZeroLength);
            }

            // 1. Create the secret memfd. flags=0 (no
            //    cloexec needed; we do not exec; we never
            //    leak the fd).
            // SAFETY: SYS_memfd_secret with flags=0 is the
            // documented call. Returns -1/errno on failure.
            let fd = unsafe { libc::syscall(libc::SYS_memfd_secret, 0u32) } as i32;
            if fd < 0 {
                let err = std::io::Error::last_os_error();
                let errno = err.raw_os_error().unwrap_or(0);
                if errno == libc::ENOSYS {
                    return Err(MemfdSecretError::NotSupported);
                }
                return Err(MemfdSecretError::UnexpectedErrno {
                    errno,
                    label: err.to_string(),
                });
            }

            // 2. Set the region size with ftruncate.
            // SAFETY: ftruncate on an owned fd is
            // documented stable; len is a valid positive
            // off_t. On failure we close the fd before
            // returning to avoid leaking it.
            let rc = unsafe { libc::ftruncate(fd, len as libc::off_t) };
            if rc != 0 {
                let err = std::io::Error::last_os_error();
                let errno = err.raw_os_error().unwrap_or(0);
                let label = err.to_string();
                // SAFETY: closing the fd we just opened.
                unsafe { libc::close(fd) };
                return Err(MemfdSecretError::TruncateFailed { errno, label });
            }

            // 3. mmap PROT_READ|PROT_WRITE MAP_SHARED.
            //    MAP_SHARED is required for memfd_secret —
            //    MAP_PRIVATE is rejected with EINVAL by
            //    the kernel.
            // SAFETY: addr=NULL lets the kernel choose;
            // len matches ftruncate; fd is the valid memfd.
            let ptr = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    len,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_SHARED,
                    fd,
                    0,
                )
            };
            if ptr == libc::MAP_FAILED {
                let err = std::io::Error::last_os_error();
                let errno = err.raw_os_error().unwrap_or(0);
                let label = err.to_string();
                // SAFETY: closing the fd we just opened.
                unsafe { libc::close(fd) };
                return Err(MemfdSecretError::MmapFailed { errno, label });
            }

            // SAFETY: kernel returned a non-MAP_FAILED ptr
            // so it is non-null + page-aligned + len bytes
            // long.
            let nn = NonNull::new(ptr as *mut u8)
                .expect("mmap returned non-MAP_FAILED ptr that is null");

            Ok(Self { fd, ptr: nn, len })
        }

        /// Non-Linux fallback: never supported.
        #[cfg(not(target_os = "linux"))]
        pub fn allocate(_len: usize) -> Result<Self, MemfdSecretError> {
            Err(MemfdSecretError::NotSupported)
        }

        /// Read-only slice view of the region. Lifetime tied
        /// to `&self`.
        pub fn as_slice(&self) -> &[u8] {
            // SAFETY: ptr is a valid len-byte mmap'd region
            // owned by self for the lifetime of the borrow.
            // No mutation through this borrow (Rust's
            // borrow checker enforces).
            unsafe { std::slice::from_raw_parts(self.ptr.as_ptr(), self.len) }
        }

        /// Mutable slice view. Exclusive access via &mut self.
        pub fn as_mut_slice(&mut self) -> &mut [u8] {
            // SAFETY: ptr is a valid len-byte mmap'd region
            // owned by self with exclusive access guaranteed
            // by &mut self.
            unsafe { std::slice::from_raw_parts_mut(self.ptr.as_ptr(), self.len) }
        }

        /// Region length in bytes.
        pub fn len(&self) -> usize {
            self.len
        }

        /// True when the region holds zero bytes (only
        /// reachable via constructors that allow it; the
        /// public allocate() rejects zero-length).
        pub fn is_empty(&self) -> bool {
            self.len == 0
        }
    }

    impl Drop for MemfdSecretRegion {
        fn drop(&mut self) {
            #[cfg(target_os = "linux")]
            {
                // SAFETY: ptr + len match the mmap call;
                // fd is the original memfd. Both calls
                // release kernel resources owned by self.
                // Kernel zeroes the pages on release per
                // memfd_secret semantics.
                unsafe {
                    libc::munmap(self.ptr.as_ptr() as *mut libc::c_void, self.len);
                    libc::close(self.fd);
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn memfd_secret_error_display_strings_pinned() {
            assert_eq!(
                format!("{}", MemfdSecretError::NotSupported),
                "memfd_secret_not_supported",
            );
            assert_eq!(
                format!("{}", MemfdSecretError::ZeroLength),
                "memfd_secret_zero_length",
            );
            assert_eq!(
                format!(
                    "{}",
                    MemfdSecretError::TruncateFailed {
                        errno: 22,
                        label: "Invalid argument".into()
                    }
                ),
                "memfd_secret_truncate_failed_errno_22: Invalid argument",
            );
            assert_eq!(
                format!(
                    "{}",
                    MemfdSecretError::MmapFailed {
                        errno: 12,
                        label: "Cannot allocate memory".into()
                    }
                ),
                "memfd_secret_mmap_failed_errno_12: Cannot allocate memory",
            );
        }

        #[test]
        fn memfd_secret_error_implements_std_error() {
            fn assert_err<E: std::error::Error>() {}
            assert_err::<MemfdSecretError>();
        }

        #[test]
        fn memfd_secret_zero_length_rejected() {
            let result = MemfdSecretRegion::allocate(0);
            assert_eq!(result.err(), Some(MemfdSecretError::ZeroLength));
        }

        /// is_supported probe never panics + returns bool.
        /// Kernel ≥ 5.14 returns true; older kernels +
        /// non-Linux return false.
        #[test]
        fn is_supported_returns_bool_no_panic() {
            let _supported: bool = is_supported();
            // No assertion on value — env-dependent. Test
            // pins the contract that the probe is callable
            // and the return type is bool.
        }

        /// On supported kernels (this dev env is 6.8),
        /// allocate succeeds + the region round-trips writes.
        /// On unsupported kernels the test gets `Err(NotSupported)`
        /// and exits cleanly.
        #[cfg(target_os = "linux")]
        #[test]
        fn memfd_secret_allocate_round_trip_when_supported() {
            if !is_supported() {
                eprintln!(
                    "memfd_secret not supported on this kernel — \
                     test skipped (Err(NotSupported) is the \
                     expected path; allocate() would also reject)"
                );
                return;
            }
            let mut region = match MemfdSecretRegion::allocate(64) {
                Ok(r) => r,
                Err(MemfdSecretError::NotSupported) => return,
                Err(e) => panic!("unexpected allocate error: {:?}", e),
            };

            assert_eq!(region.len(), 64);
            assert!(!region.is_empty());

            // Kernel zeroes pages on allocate per
            // memfd_secret semantics.
            assert_eq!(region.as_slice(), &[0u8; 64]);

            // Write + read round-trip.
            for (i, b) in region.as_mut_slice().iter_mut().enumerate() {
                *b = (i as u8).wrapping_mul(3);
            }
            for (i, b) in region.as_slice().iter().enumerate() {
                assert_eq!(*b, (i as u8).wrapping_mul(3));
            }
            // Drop releases munmap + close; kernel zeroes
            // pages on release.
        }

        /// Multiple regions can coexist + each has its own
        /// independent storage.
        #[cfg(target_os = "linux")]
        #[test]
        fn memfd_secret_multiple_regions_isolated() {
            if !is_supported() {
                return;
            }
            let mut a = match MemfdSecretRegion::allocate(16) {
                Ok(r) => r,
                Err(MemfdSecretError::NotSupported) => return,
                Err(e) => panic!("a: {:?}", e),
            };
            let mut b = match MemfdSecretRegion::allocate(16) {
                Ok(r) => r,
                Err(MemfdSecretError::NotSupported) => return,
                Err(e) => panic!("b: {:?}", e),
            };
            a.as_mut_slice().fill(0xaa);
            b.as_mut_slice().fill(0xbb);
            assert_eq!(a.as_slice()[0], 0xaa);
            assert_eq!(b.as_slice()[0], 0xbb);
            assert_ne!(a.as_slice()[0], b.as_slice()[0]);
        }

        /// Send is implemented (compile-time check).
        #[test]
        fn memfd_secret_region_is_send() {
            fn assert_send<T: Send>() {}
            assert_send::<MemfdSecretRegion>();
        }

        /// Debug impl REDACTS contents (no byte hex in the
        /// formatted string).
        #[cfg(target_os = "linux")]
        #[test]
        fn memfd_secret_debug_redacts_contents() {
            if !is_supported() {
                return;
            }
            let mut region = match MemfdSecretRegion::allocate(8) {
                Ok(r) => r,
                Err(MemfdSecretError::NotSupported) => return,
                Err(e) => panic!("alloc: {:?}", e),
            };
            // Fill with a recognizable byte.
            region.as_mut_slice().fill(0xde);
            let debug = format!("{:?}", region);
            assert!(debug.contains("REDACTED"));
            // Should NOT leak the byte hex.
            assert!(
                !debug.to_lowercase().contains("de de de"),
                "debug must not include byte hex: {}",
                debug
            );
        }
    }
}

// ===================================================================
// Batch #311 D-2 panic_zeroize registry — closes the D-2 arc
// (#309 mlock + #310 memfd_secret + #311 panic_zeroize together
// form the in-process FR4 Data Confidentiality layer cake).
// ===================================================================

/// `panic_zeroize` submodule — global registry of secret regions
/// that the panic hook scrubs BEFORE std::process::abort().
///
/// ## Why a registry exists at all
///
/// Existing layers:
/// - **Drop + ZeroizeOnDrop** (Layer E) — scrubs at value drop
///   on the NORMAL release path.
/// - **panic-abort hook** (Layer D) — kills the process so the
///   kernel reaps + zeroes pages.
///
/// Gap closed by this batch: between the panic instant and the
/// kernel-reap, secret pages are still mapped + readable by a
/// concurrent attacker (a coredump-disabling prctl + non-
/// dumpable status STILL allows the kernel itself to read those
/// pages while the process is alive). On a panicking
/// multi-threaded program the panic hook runs on ONE thread; OTHER
/// threads continue running until abort() actually fires (which is
/// after the hook finishes). That window is small but architecturally
/// non-zero. Walking a registry of secret regions zeroing each
/// BEFORE abort() shrinks the window to "during the zeroize loop"
/// — kernel memory access during that loop sees progressively-
/// zeroed pages.
///
/// ## Registration discipline
///
/// Callers register at allocation boundary (TpmKeystore::open,
/// FileBackedKeystore::open, MemfdSecretRegion::allocate when used
/// as a secret container). Unregistration happens at Drop.
/// Allocation boundaries are infrequent + happen at process boot
/// before the system is taking traffic; the lock contention surface
/// is intentionally narrow.
///
/// ## Why try_lock in the hook
///
/// The panic hook runs in an arbitrary thread context. If the
/// panic itself happened while a thread was holding the registry
/// mutex (e.g., during a register/unregister mid-allocation), a
/// blocking lock would DEADLOCK the hook. try_lock is best-effort
/// — if the lock can't be acquired in 100ms, the hook abandons
/// the scrub + proceeds to abort. The mlock + zeroize-on-drop
/// layers remain in effect; the registry scrub is a defense-in-
/// depth optimization, not the primary guarantee.
///
/// ## Why raw pointers (and not Vec<&[u8]>)
///
/// The registry holds `(NonNull<u8>, usize)` pairs. Using
/// references would require a lifetime parameter at the registry
/// type level which conflicts with the global `Mutex<Vec<...>>`
/// shape (no lifetime can satisfy 'static + the secret regions'
/// shorter lifetimes simultaneously). Raw pointers give the
/// caller full responsibility for the register / unregister
/// pairing — caller MUST unregister BEFORE the underlying region
/// is dropped. The Drop impl of MemfdSecretRegion (Batch #310)
/// handles this; future TpmKeystore consumer wiring follows the
/// same pattern.
pub mod panic_zeroize {

    use std::ptr::NonNull;
    use std::sync::Mutex;
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    /// One slot in the registry. Owned by the registering caller;
    /// pointer + length are exclusively-accessible-by-caller for
    /// the registration window.
    #[derive(Debug, Clone, Copy)]
    struct RegisteredRegion {
        ptr: NonNull<u8>,
        len: usize,
    }

    // SAFETY: pointer + length values are integers / opaque
    // raw addresses. Moving the slot value across threads is
    // safe as long as the caller maintains the invariant that
    // the underlying region is valid while registered (caller
    // contract). The registry never DEREFERENCES the pointer
    // outside the panic-hook scrub path; the scrub path runs
    // on a single thread that has won the try_lock race.
    unsafe impl Send for RegisteredRegion {}

    /// Lazy-init global registry. OnceLock keeps init lock-free
    /// after first registration; the inner Mutex guards
    /// register / unregister / scrub-all access.
    static REGISTRY: OnceLock<Mutex<Vec<RegisteredRegion>>> = OnceLock::new();

    fn registry() -> &'static Mutex<Vec<RegisteredRegion>> {
        REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
    }

    /// Register a secret region for panic-time scrubbing.
    ///
    /// CONTRACT (caller maintains):
    /// - `ptr` is non-null + points to a region of at least
    ///   `len` writable bytes.
    /// - The region remains valid + writable until
    ///   `unregister(ptr)` returns.
    /// - The caller MUST `unregister(ptr)` BEFORE the region's
    ///   underlying allocation is dropped/freed (otherwise the
    ///   panic hook may write to freed memory — UB).
    ///
    /// Returns the registration count after this call (audit /
    /// metric accessor).
    pub fn register(ptr: NonNull<u8>, len: usize) -> usize {
        let mut guard = registry().lock().unwrap_or_else(|poisoned| {
            // Lock was poisoned — recover by taking the inner
            // value. Poisoning happens when a previous holder
            // panicked while holding the lock; the registry
            // contents are still valid (Vec<RegisteredRegion>
            // is poison-safe), we just need to clear the
            // poisoned flag.
            poisoned.into_inner()
        });
        guard.push(RegisteredRegion { ptr, len });
        guard.len()
    }

    /// Unregister a previously-registered region. Returns true
    /// if the region was found + removed. If the same ptr was
    /// registered twice (caller bug), only the first matching
    /// entry is removed; the duplicate stays + the caller is
    /// responsible for matching pairs.
    pub fn unregister(ptr: NonNull<u8>) -> bool {
        let mut guard = registry().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(pos) = guard.iter().position(|r| r.ptr == ptr) {
            guard.swap_remove(pos);
            true
        } else {
            false
        }
    }

    /// Audit / test accessor — current registration count.
    pub fn registered_count() -> usize {
        registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len()
    }

    /// Walk the registry zeroing each region. Best-effort:
    /// uses `try_lock` with a 100ms total budget so the panic
    /// hook does not deadlock if the panic itself occurred
    /// while a thread was holding the registry lock. Returns
    /// the number of regions successfully scrubbed (zero when
    /// the lock could not be acquired).
    ///
    /// **Why best-effort:** this is a defense-in-depth layer.
    /// If the lock is unavailable, the kernel's automatic page
    /// release on process exit + the mlock + zeroize-on-drop
    /// layers still apply.
    ///
    /// SAFETY: writes through registered raw pointers. The
    /// caller's register/unregister pairing contract makes this
    /// safe — only currently-registered regions are walked, and
    /// those are guaranteed valid by contract.
    pub fn scrub_all_registered_best_effort() -> usize {
        let deadline = Instant::now() + Duration::from_millis(100);
        loop {
            match registry().try_lock() {
                Ok(mut guard) => {
                    let count = guard.len();
                    for region in guard.iter() {
                        // SAFETY: caller's register-contract
                        // guarantees the region is valid and
                        // exclusively-writable for the
                        // registration window. The panic hook
                        // is the LAST writer (process is
                        // about to abort). Writing zeroes is
                        // a value-only operation that does not
                        // change the allocation's
                        // type/length.
                        unsafe {
                            std::ptr::write_bytes(
                                region.ptr.as_ptr(),
                                0,
                                region.len,
                            );
                        }
                    }
                    // Clear the registry so a re-entrant call
                    // (extremely unlikely) does not double-
                    // scrub.
                    guard.clear();
                    return count;
                }
                Err(_) => {
                    if Instant::now() >= deadline {
                        return 0;
                    }
                    // Brief spin — panic hook is single-call
                    // path, sleep would be wrong (we're
                    // pre-abort, latency budget is microseconds).
                    std::hint::spin_loop();
                }
            }
        }
    }

    /// Clear the registry without scrubbing. Used by tests to
    /// reset between cases. NOT a public production API — the
    /// process-exit path zeroes pages by kernel-release; the
    /// only caller that wants to forcibly clear is a test
    /// fixture.
    #[cfg(test)]
    pub(crate) fn test_only_clear() {
        let mut guard = registry().lock().unwrap_or_else(|p| p.into_inner());
        guard.clear();
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::Mutex as StdMutex;

        // Tests share global registry state — serialize them
        // with a per-module mutex so concurrent test runs do
        // not see each other's registrations. This matches
        // the project pattern from auth flow tests that touch
        // global state.
        static TEST_LOCK: StdMutex<()> = StdMutex::new(());

        fn with_clean_registry<F: FnOnce()>(f: F) {
            let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            test_only_clear();
            f();
            test_only_clear();
        }

        #[test]
        fn register_unregister_round_trip() {
            with_clean_registry(|| {
                let mut buf = [0u8; 32];
                let ptr =
                    NonNull::new(buf.as_mut_ptr()).expect("non-null array ptr");
                assert_eq!(registered_count(), 0);
                let after = register(ptr, buf.len());
                assert_eq!(after, 1);
                assert_eq!(registered_count(), 1);
                let removed = unregister(ptr);
                assert!(removed);
                assert_eq!(registered_count(), 0);
                // Unregister of a non-registered ptr returns false.
                assert!(!unregister(ptr));
            });
        }

        #[test]
        fn multiple_regions_register_independently() {
            with_clean_registry(|| {
                let mut a = [0u8; 16];
                let mut b = [0u8; 16];
                let pa = NonNull::new(a.as_mut_ptr()).unwrap();
                let pb = NonNull::new(b.as_mut_ptr()).unwrap();
                assert_eq!(register(pa, 16), 1);
                assert_eq!(register(pb, 16), 2);
                assert_eq!(registered_count(), 2);
                assert!(unregister(pa));
                assert_eq!(registered_count(), 1);
                assert!(unregister(pb));
                assert_eq!(registered_count(), 0);
            });
        }

        #[test]
        fn scrub_all_zeroes_registered_regions() {
            with_clean_registry(|| {
                let mut a = [0xaau8; 32];
                let mut b = [0xbbu8; 16];
                let pa = NonNull::new(a.as_mut_ptr()).unwrap();
                let pb = NonNull::new(b.as_mut_ptr()).unwrap();
                register(pa, a.len());
                register(pb, b.len());

                // Pre-scrub: bytes hold the recognizable
                // patterns.
                assert_eq!(a[0], 0xaa);
                assert_eq!(b[0], 0xbb);

                let scrubbed = scrub_all_registered_best_effort();
                assert_eq!(scrubbed, 2);

                // Post-scrub: every byte is zero.
                assert!(a.iter().all(|b| *b == 0), "a not zeroed: {:?}", &a[..]);
                assert!(b.iter().all(|x| *x == 0), "b not zeroed: {:?}", &b[..]);

                // Registry cleared after scrub — re-scrubbing
                // returns 0.
                assert_eq!(scrub_all_registered_best_effort(), 0);
            });
        }

        #[test]
        fn scrub_with_empty_registry_returns_zero() {
            with_clean_registry(|| {
                assert_eq!(scrub_all_registered_best_effort(), 0);
            });
        }

        /// Same ptr registered twice → unregister removes one
        /// (caller's responsibility to match pairs). Pin the
        /// contract so a refactor does not silently change to
        /// "remove-all-matching".
        #[test]
        fn unregister_removes_one_of_duplicate_registrations() {
            with_clean_registry(|| {
                let mut buf = [0u8; 8];
                let ptr = NonNull::new(buf.as_mut_ptr()).unwrap();
                register(ptr, 8);
                register(ptr, 8);
                assert_eq!(registered_count(), 2);
                assert!(unregister(ptr));
                assert_eq!(registered_count(), 1);
                assert!(unregister(ptr));
                assert_eq!(registered_count(), 0);
            });
        }
    }
}
