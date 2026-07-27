"""Four holes an adversarial audit found in the containment perimeter.

Each of these was written as a fix, shipped, and then found to be bypassable
or inert. They are grouped in one file because they share a root cause: a
control was asserted where it was DEFINED rather than where it is USED, so the
definition looked right and the use was never exercised.

  * ORPHAN-CRITICAL-451 — `sandbox_backend()` accepted firejail, whose branch
    of `wrap_bash_in_sandbox` applied NONE of the eighteen READONLY_PATHS.
    Callers treat a non-None return as proof containment is in force, and
    PLAN.md makes exactly that the S0 exit criterion, so choosing firejail —
    which the operator-facing refusal message actively suggested — cleared the
    gate with the kernel fully writable.
  * ORPHAN-MEDIUM-452 — the bwrap capability probe did not mirror the wrapper,
    in violation of the comment directly above it demanding that it must. The
    wrapper bound `/etc/alternatives` and `/etc/ssl` UNGUARDED; the probe bound
    neither. On a runner image lacking either, the probe reports "available"
    and every write-capable spawn then dies at invocation.
  * ORPHAN-HIGH-453 — `_normalize_declared_path` collapsed a LEADING `./` and
    outer slashes only, so an interior `//` walked a kernel path straight
    through `_check_kernel_self_modification_at_mint`.
  * ORPHAN-HIGH-454 — `_check_no_force_push` read `push_refspecs` and never
    `bash_argv`, while the bash allowlist entry for push ends in `(\\s+\\S+)*`
    — which admits a flag. `git push origin aria-impl-abc123 -f` passed the
    allowlist, matched no long-form deny pattern, and was never examined.

Every test below states the pre-fix behaviour it would have caught. Several
assert the ABSENCE of collateral damage too: a denylist that refuses safe
commands gets worked around, which is a slower way of having no denylist.
"""

from __future__ import annotations

import sys
import unittest
import unittest.mock
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel import implementation_safety as impl  # noqa: E402
from aria_kernel.implementation_safety import (  # noqa: E402
    DENIED_BASH_COMMANDS,
    READONLY_PATHS,
    HardFailContext,
    SandboxUnavailable,
    _argv_forces_a_push,
    _bwrap_probe_argv,
    _check_kernel_self_modification_at_mint,
    _check_no_force_push,
    _normalize_declared_path,
    _system_ro_binds,
    sandbox_backend,
    wrap_bash_in_sandbox,
)


class BwrapIsTheOnlyBackend(unittest.TestCase):
    """ORPHAN-CRITICAL-451."""

    def tearDown(self) -> None:
        impl._bwrap_available.cache_clear()

    def test_no_firejail_fallback_exists_at_all(self) -> None:
        """The strongest available assertion: the branch is not reachable.

        A behavioural test would need firejail installed. What can be pinned
        unconditionally is that no code path can select it — which is the
        actual fix, since the defect was that selecting it cleared the gate.
        """
        self.assertFalse(
            hasattr(impl, "_firejail_available"),
            msg="a firejail backend selector is back; it enforced no READONLY_PATHS",
        )
        self.assertFalse(
            hasattr(impl, "_FIREJAIL_PROBE_ARGV"),
            msg="the firejail probe is back without a confinement assertion",
        )

    def test_backend_is_none_when_bwrap_is_unusable(self) -> None:
        impl._bwrap_available.cache_clear()
        with unittest.mock.patch.object(impl, "_bwrap_available", lambda: False):
            self.assertIsNone(sandbox_backend())

    def test_wrapping_refuses_rather_than_returning_bare_argv(self) -> None:
        """The pre-427 defect, re-pinned: a bare argv is indistinguishable
        from a sandboxed one, so the no-backend path must raise."""
        impl._bwrap_available.cache_clear()
        with unittest.mock.patch.object(impl, "_bwrap_available", lambda: False):
            with self.assertRaises(SandboxUnavailable):
                wrap_bash_in_sandbox(["/bin/true"], workspace_root=_REPO_ROOT)

    def test_the_refusal_does_not_recommend_an_unenforcing_backend(self) -> None:
        """The message is operator-facing instruction, so a wrong one is a
        wrong action: it used to say 'install bwrap or firejail'."""
        impl._bwrap_available.cache_clear()
        with unittest.mock.patch.object(impl, "_bwrap_available", lambda: False):
            try:
                wrap_bash_in_sandbox(["/bin/true"], workspace_root=_REPO_ROOT)
            except SandboxUnavailable as exc:
                self.assertNotIn("firejail", str(exc).lower())
            else:  # pragma: no cover
                self.fail("expected SandboxUnavailable")


class ProbeMirrorsWrapper(unittest.TestCase):
    """ORPHAN-MEDIUM-452."""

    def tearDown(self) -> None:
        impl._bwrap_available.cache_clear()

    def test_every_system_bind_the_wrapper_uses_is_in_the_probe(self) -> None:
        impl._bwrap_available.cache_clear()
        with unittest.mock.patch.object(impl, "_bwrap_available", lambda: True):
            wrapper = wrap_bash_in_sandbox(["/bin/true"], workspace_root=_REPO_ROOT)
        probe = _bwrap_probe_argv()

        def binds(argv: list[str]) -> set[str]:
            return {
                argv[i + 1]
                for i, tok in enumerate(argv)
                if tok == "--ro-bind" and i + 1 < len(argv)
            }

        workspace_binds = {
            str((_REPO_ROOT / ro).resolve()) for ro in READONLY_PATHS
        }
        system_only = binds(wrapper) - workspace_binds
        missing = system_only - binds(probe)
        self.assertEqual(
            missing,
            set(),
            msg=(
                "the probe exercises less than the wrapper, so it can report "
                f"available while the wrapper aborts: {sorted(missing)}"
            ),
        )

    def test_system_binds_are_existence_guarded(self) -> None:
        """bwrap aborts the whole invocation on a bind source it cannot find,
        so an unconditional bind turns a missing /etc/ssl into total loss of
        containment rather than a smaller sandbox."""
        for i, token in enumerate(_system_ro_binds()):
            if token == "--ro-bind":
                self.assertTrue(
                    Path(_system_ro_binds()[i + 1]).exists(),
                    msg=f"{_system_ro_binds()[i + 1]} does not exist on this host",
                )

    def test_a_missing_system_root_drops_out_of_both_sides_together(self) -> None:
        with unittest.mock.patch.object(
            impl, "_SANDBOX_SYSTEM_ROOTS", ("/usr", "/nonexistent-system-root"),
        ):
            flags = _system_ro_binds()
            self.assertIn("/usr", flags)
            self.assertNotIn("/nonexistent-system-root", flags)
            self.assertNotIn("/nonexistent-system-root", _bwrap_probe_argv())


class DeclaredPathNormalization(unittest.TestCase):
    """ORPHAN-HIGH-453."""

    def test_every_spelling_of_a_kernel_path_collapses_to_the_same_form(self) -> None:
        canonical = "aria-kernel/aria_kernel/cli.py"
        for spelling in (
            "aria-kernel/aria_kernel/cli.py",
            "./aria-kernel/aria_kernel/cli.py",
            "/aria-kernel/aria_kernel/cli.py",
            "aria-kernel//aria_kernel/cli.py",          # the bypass
            "aria-kernel/./aria_kernel/cli.py",         # the bypass
            "/aria-kernel///aria_kernel//cli.py/",
            ".//aria-kernel/./aria_kernel//cli.py",
            "aria-kernel\\aria_kernel\\cli.py",
        ):
            with self.subTest(spelling=spelling):
                self.assertEqual(_normalize_declared_path(spelling), canonical)

    def test_traversal_is_preserved_not_silently_resolved(self) -> None:
        """`..` must reach the caller's explicit rejection. Resolving it here
        would turn a traversal attempt into a clean-looking path."""
        self.assertEqual(_normalize_declared_path("docs/../.env"), "docs/../.env")

    def test_the_mint_check_rejects_every_spelling(self) -> None:
        """The end-to-end property. Pre-fix, the `//` variant PASSED."""
        for spelling in (
            "aria-kernel/aria_kernel/cli.py",
            "aria-kernel//aria_kernel/cli.py",
            "aria-kernel/./aria_kernel/cli.py",
            ".//aria-kernel//aria_kernel//cli.py",
            "//.claude//agents//aria-implementer.md",
            "tools//gates/commit-msg-validator.ts",
        ):
            with self.subTest(spelling=spelling):
                result = _check_kernel_self_modification_at_mint(
                    HardFailContext(envelope={"affected_surfaces": [spelling]}),
                )
                self.assertFalse(
                    result.passed,
                    msg=f"{spelling} declared a READONLY surface and passed",
                )

    def test_a_legitimate_surface_still_passes(self) -> None:
        result = _check_kernel_self_modification_at_mint(
            HardFailContext(envelope={"affected_surfaces": ["docs/guides/scada.md"]}),
        )
        self.assertTrue(result.passed, msg=result.reason)


class ForcePushInBashArgv(unittest.TestCase):
    """ORPHAN-HIGH-454."""

    def test_short_and_long_force_forms_are_all_caught(self) -> None:
        for argv in (
            ["git", "push", "origin", "aria-impl-abc123", "-f"],
            ["git", "push", "-f", "origin", "aria-impl-abc123"],
            ["git", "push", "origin", "aria-impl-abc123", "-fu"],
            ["git", "push", "origin", "aria-impl-abc123", "-uf"],
            ["git", "push", "--force", "origin", "aria-impl-abc123"],
            ["git", "push", "--force-with-lease", "origin", "aria-impl-abc123"],
            ["git", "push", "origin", "+aria-impl-abc123"],
        ):
            with self.subTest(argv=" ".join(argv)):
                self.assertIsNotNone(_argv_forces_a_push(argv))
                result = _check_no_force_push(HardFailContext(bash_argv=argv))
                self.assertFalse(result.passed, msg=f"{' '.join(argv)} passed the gate")

    def test_safe_pushes_and_unrelated_commands_are_untouched(self) -> None:
        """Collateral matters: a gate that refuses safe commands gets routed
        around, which is a slower way of having no gate."""
        for argv in (
            ["git", "push", "origin", "aria-impl-abc123"],
            ["git", "push", "origin", "aria-impl-abc123", "--set-upstream"],
            ["git", "log", "-n", "5"],
            ["git", "diff", "--unified=0"],
            ["git", "commit", "-m", "fix something"],
        ):
            with self.subTest(argv=" ".join(argv)):
                self.assertIsNone(_argv_forces_a_push(argv))

    def test_the_deny_pattern_covers_the_short_form_without_overreaching(self) -> None:
        def denied(cmd: str) -> bool:
            return any(p.search(cmd) for p in DENIED_BASH_COMMANDS)

        self.assertTrue(denied("git push origin aria-impl-abc123 -f"))
        self.assertTrue(denied("git push origin aria-impl-abc123 -fu"))
        for safe in (
            "git push origin aria-impl-abc123",
            "git log -n 5",
            "git diff --unified=0",
            "prettier --write report-f.md",
            "nx affected --target=test",
        ):
            with self.subTest(cmd=safe):
                self.assertFalse(denied(safe), msg=f"{safe} was denied")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
