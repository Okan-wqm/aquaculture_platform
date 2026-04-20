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
pub fn harden_process() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        disable_core_dumps()?;
        install_panic_abort_hook();
        info!("Process hardening applied: prctl(PR_SET_DUMPABLE=0) + panic-abort hook");
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Plan §5 Faz 2 Step 2 scope is Linux-only per ADR-019
        // hardware target. Non-Linux builds (developer laptops
        // running macOS/Windows for build-time linting) skip this
        // hardening; systemd + prctl don't exist outside Linux.
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
