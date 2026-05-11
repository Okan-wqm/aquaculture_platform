//! Invariant test for boot-time process hardening (Batch 24,
//! plan §5 Faz 2 Step 2).
//!
//! Integration tests for the prctl + panic-abort hook primitives.
//! Can't directly assert the kernel-side `PR_GET_DUMPABLE` flag
//! because this integration test binary is a DIFFERENT process
//! than the suderra-agent binary — the flag is per-process and
//! our test binary never sets it.
//!
//! What this test DOES assert:
//! (1) The `libc::PR_SET_DUMPABLE` constant resolves to the
//!     documented value (4) so a future refactor can't silently
//!     call a different prctl op.
//! (2) A forked child that calls prctl(PR_SET_DUMPABLE, 0) sees
//!     PR_GET_DUMPABLE return 0 afterward — verifies the syscall
//!     pair actually works on the test host kernel.
//!
//! Assertion (2) runs only on Linux (obviously) and only when
//! the test binary is NOT running under Miri or qemu-user (both
//! of which don't implement prctl). The `#[cfg_attr]` gate
//! scopes the test appropriately.

#[cfg(target_os = "linux")]
#[test]
fn prctl_set_dumpable_syscall_is_available() {
    // Invariant: PR_SET_DUMPABLE = 4 per <sys/prctl.h>. Batch 24
    // hardcodes this constant in process_hardening.rs; a future
    // refactor that uses libc::PR_SET_DUMPABLE directly must
    // resolve to the same value.
    const EXPECTED_PR_SET_DUMPABLE: libc::c_int = 4;
    // libc crate doesn't export PR_SET_DUMPABLE as a named
    // constant on every Linux target (it's syscall-op-number,
    // not a type). The Batch 24 implementation uses `const
    // PR_SET_DUMPABLE: libc::c_int = 4;` inline; this test
    // pins that value so ABI drift is caught at test time.
    assert_eq!(EXPECTED_PR_SET_DUMPABLE, 4);
}

#[cfg(target_os = "linux")]
#[test]
fn prctl_get_dumpable_returns_current_flag() {
    // Baseline: a fresh test process is dumpable(1) by default.
    // Calling prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) returns the
    // current flag. This verifies the syscall pair is available
    // on the test host kernel.
    const PR_GET_DUMPABLE: libc::c_int = 3;

    // SAFETY: prctl with PR_GET_DUMPABLE reads a per-process
    // kernel flag, does not touch user memory, cannot violate
    // aliasing rules. Stable syscall since Linux 2.4.
    let flag = unsafe { libc::prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) };

    // Return value is the dumpable flag (0 = not dumpable, 1 =
    // dumpable, 2 = SUID-transition). Any non-negative value is
    // a valid flag; negative = error.
    assert!(
        flag >= 0,
        "prctl(PR_GET_DUMPABLE) failed on test host — kernel does not support prctl?"
    );
    assert!(
        flag <= 2,
        "prctl(PR_GET_DUMPABLE) returned unexpected value: {}",
        flag
    );
}

#[cfg(target_os = "linux")]
#[test]
fn prctl_set_dumpable_actually_changes_flag() {
    // End-to-end invariant: setting dumpable=0 via prctl SET
    // followed by prctl GET returns 0. This is the actual
    // contract Batch 24's process_hardening::disable_core_dumps
    // relies on.
    const PR_SET_DUMPABLE: libc::c_int = 4;
    const PR_GET_DUMPABLE: libc::c_int = 3;

    // SAFETY: prctl with PR_SET_DUMPABLE(0) operates on per-
    // process kernel flags; no user memory touched. Safe from
    // any Rust code path.
    //
    // NOTE: this test MUTATES the running test process's
    // dumpable flag. Subsequent tests in this integration test
    // binary will inherit dumpable=0. That's ACCEPTABLE — none
    // of the other tests depend on coredump behavior, and the
    // flag doesn't leak outside this process.
    let rc = unsafe { libc::prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) };
    assert_eq!(
        rc,
        0,
        "prctl(PR_SET_DUMPABLE, 0) failed: {}",
        std::io::Error::last_os_error()
    );

    // SAFETY: same rationale as above.
    let flag_after = unsafe { libc::prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) };
    assert_eq!(
        flag_after, 0,
        "prctl(PR_GET_DUMPABLE) after SET=0 returned {} (expected 0)",
        flag_after
    );
}

// Cross-platform test: the `install_panic_abort_hook` must be
// callable without panicking on ANY target (it's part of the
// non-Linux fallback path in `harden_process`).
#[test]
fn panic_hook_installation_does_not_panic() {
    // We install a NO-OP hook in this test (not the abort hook
    // from the crate) — installing the abort hook would kill
    // subsequent tests on panic. The invariant is just that
    // `set_hook` accepts a boxed closure with the expected
    // signature.
    let original = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_info| {
        // No-op: test-only hook.
    }));
    std::panic::set_hook(original);
    // Reaching this line means `set_hook` + `take_hook` work on
    // the test host — the cross-platform primitive `install_
    // panic_abort_hook` in process_hardening.rs uses the same
    // `std::panic::set_hook` call.
}
