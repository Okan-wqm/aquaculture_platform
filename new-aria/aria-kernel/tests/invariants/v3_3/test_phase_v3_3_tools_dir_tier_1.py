"""Plan ARIA-V3.3 Phase 3.1 — tools_dir Tier-1 rewrite invariants.

Closes F-010-D4 (deferred-from-V3.2 architectural-scope-too-large
follow-up): the pre-V3.3 ``tools_dir(None)`` fallback returned a
CWD-relative ``Path("aria-tools")`` literal. When the kernel was
invoked from inside the ``aria-kernel/`` subdir (operator typo, CI
working-dir misalignment, agent dispatch into a kernel subprocess),
the relative path resolved against the wrong cwd and silently created
a SHADOW ``aria-kernel/aria-tools/`` tree. Reflection then read the
shadow ledger (handful of stale rows) instead of the canonical
worktree-rooted aria-tools (~29+ fresh rows). The daily report
``Total governance events: 4`` was the operator-visible symptom.

V3.3 §2a closes the class via Tier-1 — "make impossible":

  * ``tools_dir`` resolution order: explicit path → ARIA_TOOLS_DIR
    env → walk-up to first ``<ancestor>/aria-tools/
    repo_identity.json`` → raise ``GovernanceError("tools_root_
    unresolvable")``.
  * Every successful return is an ABSOLUTE Path. The CWD-relative
    interpretation can no longer happen.
  * CLI entry consumes the same resolution funnel so ``args.tools_dir``
    is also always-absolute or None.

Five invariant cases (I-V3.3-01..04, 08):
  * I-V3.3-01 — ``tools_dir`` returns absolute from any cwd.
  * I-V3.3-02 — walks up to the first initialized aria-tools.
  * I-V3.3-03 — raises ``tools_root_unresolvable`` on detached cwd
    (no env, no walk-up match).
  * I-V3.3-04 — no shadow ``aria-tools/`` is ever created under a
    kernel subdir even when the operator runs from inside it.
  * I-V3.3-08 — ``ARIA_TOOLS_DIR`` env beats walk-up (operator env
    is the override; structural ambient context defers to it).
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


class PhaseV3_3ToolsDirTier1(unittest.TestCase):
    def setUp(self) -> None:
        from tests.invariants.v3_3._helpers import clear_aria_tools_env
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v3_3-tools-dir-"))
        self.original_cwd = os.getcwd()
        # Plan ARIA-V3.3 R-A4 — clear inherited env so the test's
        # walk-up + raise behavior isn't masked by an operator env var.
        self._env_snapshot = clear_aria_tools_env()

    def tearDown(self) -> None:
        from tests.invariants.v3_3._helpers import restore_aria_tools_env
        os.chdir(self.original_cwd)
        restore_aria_tools_env(self._env_snapshot)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # I-V3.3-01 — explicit path always returns absolute, regardless of cwd.
    def test_i_v3_3_01_explicit_path_returns_absolute_from_any_cwd(
        self,
    ) -> None:
        from aria_kernel.tool_registry import tools_dir
        from tests.invariants.v3_3._helpers import seed_initialized_tools_root

        canonical = seed_initialized_tools_root(self.tmp / "canonical")

        # chdir into a sibling dir that is NOT an ancestor of canonical.
        sibling = self.tmp / "sibling"
        sibling.mkdir()
        os.chdir(sibling)

        # Pre-V3.3: Path("aria-tools") (CWD-relative) would resolve to
        # <sibling>/aria-tools — a SHADOW. V3.3: explicit path
        # short-circuits to absolute.
        resolved = tools_dir(canonical)
        self.assertTrue(
            resolved.is_absolute(),
            msg=(
                f"tools_dir(explicit) must always return absolute "
                f"path; got {resolved!r}"
            ),
        )
        self.assertEqual(
            resolved, canonical.resolve(),
            msg=(
                f"explicit path must resolve to the operator-supplied "
                f"absolute target; got {resolved!r} expected "
                f"{canonical.resolve()!r}"
            ),
        )

    # I-V3.3-02 — walk-up locates canonical aria-tools from any descendant.
    def test_i_v3_3_02_walk_up_finds_canonical_from_descendant(
        self,
    ) -> None:
        from aria_kernel.tool_registry import (
            _walk_up_to_bound_identity,
            tools_dir,
        )
        from tests.invariants.v3_3._helpers import seed_initialized_tools_root

        workspace = self.tmp / "workspace"
        canonical = seed_initialized_tools_root(workspace)

        # The defect scenario: kernel invoked from inside the
        # aria-kernel/ subdir. Pre-V3.3 this created a shadow
        # workspace/aria-kernel/aria-tools/. V3.3: walk-up finds the
        # canonical workspace/aria-tools/.
        kernel_subdir = workspace / "aria-kernel"
        kernel_subdir.mkdir()
        nested_inner = kernel_subdir / "tests" / "deep" / "deeper"
        nested_inner.mkdir(parents=True)
        os.chdir(nested_inner)

        # Walk-up resolver locates the canonical ancestor aria-tools.
        discovered = _walk_up_to_bound_identity(nested_inner)
        self.assertEqual(
            discovered, canonical.resolve(),
            msg=(
                f"_walk_up_to_bound_identity must return the FIRST "
                f"ancestor's aria-tools, not None and not a shadow; "
                f"got {discovered!r} expected {canonical.resolve()!r}"
            ),
        )

        # The public surface (tools_dir(None)) routes through walk-up.
        resolved = tools_dir()
        self.assertEqual(resolved, canonical.resolve())

    # I-V3.3-03 — detached cwd raises tools_root_unresolvable.
    def test_i_v3_3_03_detached_cwd_raises_unresolvable(self) -> None:
        from aria_kernel.tool_registry import GovernanceError, tools_dir

        # /tmp has no aria-tools/ ancestor (the system tmp is not part
        # of any worktree). With no env + no explicit path + no
        # walk-up match, tools_dir MUST raise — pre-V3.3 it silently
        # created a CWD-relative shadow.
        detached = Path(tempfile.mkdtemp(prefix="aria-v3_3-detached-"))
        try:
            os.chdir(detached)
            with self.assertRaises(GovernanceError) as ctx:
                tools_dir()
            self.assertIn("tools_root_unresolvable", str(ctx.exception))
            # The error MUST point operators at the remediation path
            # (migrate-tools-bootstrap CLI) — a generic raise without
            # a how-to-fix message is a worse operator experience
            # than the pre-V3.3 silent shadow.
            self.assertIn("migrate-tools-bootstrap", str(ctx.exception))
        finally:
            shutil.rmtree(detached, ignore_errors=True)

    # I-V3.3-04 — kernel invocation from inside aria-kernel subdir
    # creates no shadow tree.
    def test_i_v3_3_04_no_shadow_under_aria_kernel_subdir(self) -> None:
        from aria_kernel.tool_registry import ensure_tools_dir, tools_dir
        from tests.invariants.v3_3._helpers import seed_initialized_tools_root

        workspace = self.tmp / "workspace"
        canonical = seed_initialized_tools_root(workspace)
        kernel_subdir = workspace / "aria-kernel"
        kernel_subdir.mkdir()
        # Snapshot the kernel subdir's children pre-call so we can
        # diff after — the post-V3.3 invariant is "kernel subdir
        # gains NO aria-tools child even when invoked from inside".
        pre_children = set(kernel_subdir.iterdir())

        os.chdir(kernel_subdir)
        # The full ensure-path (which pre-V3.3 was the shadow-creating
        # codepath via silent bootstrap on Path("aria-tools")).
        resolved = tools_dir()
        ensure_tools_dir(resolved)

        # Post-V3.3: the kernel subdir gains NO ``aria-tools`` child.
        # The resolved path is the canonical ancestor's aria-tools.
        post_children = set(kernel_subdir.iterdir())
        shadow_path = kernel_subdir / "aria-tools"
        self.assertFalse(
            shadow_path.exists(),
            msg=(
                f"V3.3 §2a F-010-D4 — kernel invocation from inside "
                f"aria-kernel/ created a SHADOW aria-tools tree at "
                f"{shadow_path!r}. tools_dir must walk up to the "
                f"canonical ancestor instead of CWD-relative fallback."
            ),
        )
        self.assertEqual(
            pre_children, post_children,
            msg=(
                f"V3.3 §2a — kernel invocation from inside the "
                f"aria-kernel subdir must NOT modify the subdir's "
                f"children. Pre={pre_children!r} post={post_children!r}."
            ),
        )
        self.assertEqual(
            resolved, canonical.resolve(),
            msg=(
                f"tools_dir() walked UP and resolved to the canonical "
                f"aria-tools at the worktree root."
            ),
        )

    # I-V3.3-08 — ARIA_TOOLS_DIR env beats walk-up (operator override).
    def test_i_v3_3_08_env_var_beats_walk_up(self) -> None:
        from aria_kernel.tool_registry import tools_dir
        from tests.invariants.v3_3._helpers import seed_initialized_tools_root

        # Two initialized tools roots: one would be found via walk-up,
        # the other is the operator's explicit override.
        ancestor_tools = seed_initialized_tools_root(self.tmp / "ancestor")
        override_tools = seed_initialized_tools_root(self.tmp / "override")

        # cwd inside ancestor's worktree — walk-up would normally
        # return ancestor_tools.
        descendant = self.tmp / "ancestor" / "deep" / "nested"
        descendant.mkdir(parents=True)
        os.chdir(descendant)

        # Operator overrides via env.
        os.environ["ARIA_TOOLS_DIR"] = str(override_tools)
        try:
            resolved = tools_dir()
        finally:
            del os.environ["ARIA_TOOLS_DIR"]

        self.assertEqual(
            resolved, override_tools.resolve(),
            msg=(
                f"ARIA_TOOLS_DIR env MUST take precedence over the "
                f"walk-up ancestor discovery (operator-explicit "
                f"override beats structural inference). Got {resolved!r} "
                f"expected {override_tools.resolve()!r}."
            ),
        )


if __name__ == "__main__":
    unittest.main()
