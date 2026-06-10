"""Plan ARIA-V3 Phase A1 — required ``auto_merge_runner`` injection.

Closes GAP-2 architecturally. Pre-V3 the orchestrator had
``auto_merge_runner: Callable | None = None`` so the loop silently
skipped auto-merge whenever the operator forgot to inject one. V3
makes the parameter REQUIRED (no ``Optional``, no default) and
supplies a profile-derived factory.

Invariants locked:

  * I-V3-01 — ``run_autonomy_orchestrator`` parameter ``auto_merge_runner``
    has NO default value AND its type annotation contains neither
    ``Optional`` nor ``| None``. A future refactor that re-adds the
    default fails this test (Tier-1: the wrong shape is impossible
    by inspection).
  * I-V3-02 — ``select_auto_merge_runner`` returns ``NoOpAutoMergeRunner``
    for the four profiles that do not permit auto-merge
    (``observe``, ``standard``, ``frozen``) and the noop returns
    ``merges_completed=0`` + ``status="skipped"``.
  * I-V3-03 — ``select_auto_merge_runner`` returns ``RealAutoMergeRunner``
    for ``strict`` (and ``autonomous`` once Phase B2 lands). The
    real runner imports and references ``auto_merge.merge_if_green``
    (verified by source inspection so a future no-op refactor
    cannot silently break the wrapping).
"""

from __future__ import annotations

import inspect
import sys
import unittest
from pathlib import Path
from typing import Any, Union, get_args, get_origin, get_type_hints


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


class PhaseA1RequiredAutoMergeRunner(unittest.TestCase):
    def test_i_v3_01_auto_merge_runner_has_no_default(self) -> None:
        from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator

        sig = inspect.signature(run_autonomy_orchestrator)
        self.assertIn(
            "auto_merge_runner",
            sig.parameters,
            msg="run_autonomy_orchestrator must accept auto_merge_runner",
        )
        param = sig.parameters["auto_merge_runner"]
        self.assertIs(
            param.default,
            inspect.Parameter.empty,
            msg=(
                "auto_merge_runner must have NO default value (Plan "
                "ARIA-V3 §A1 makes it REQUIRED). Found default: "
                f"{param.default!r}"
            ),
        )
        self.assertEqual(
            param.kind,
            inspect.Parameter.KEYWORD_ONLY,
            msg="auto_merge_runner must be keyword-only for clarity at callsites",
        )

    def test_i_v3_01_auto_merge_runner_annotation_is_not_optional(self) -> None:
        """A `Callable | None` or `Optional[Callable]` annotation
        would technically allow the parameter to accept None at
        runtime, undoing the Tier-1 guarantee. Verify the annotation
        is a non-Optional reference.
        """
        from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator

        sig = inspect.signature(run_autonomy_orchestrator)
        param = sig.parameters["auto_merge_runner"]
        annotation_str = str(param.annotation)
        for forbidden in ("Optional", "| None", "None |", "NoneType"):
            self.assertNotIn(
                forbidden,
                annotation_str,
                msg=(
                    f"auto_merge_runner annotation must not be Optional. "
                    f"Found {forbidden!r} in {annotation_str!r}"
                ),
            )

    def test_i_v3_02_select_returns_noop_for_observe(self) -> None:
        from aria_kernel.auto_merge_runners import (
            NoOpAutoMergeRunner,
            select_auto_merge_runner,
        )

        runner = select_auto_merge_runner(profile="observe")
        self.assertIsInstance(runner, NoOpAutoMergeRunner)
        result = runner(base_dir=str(self._tmpdir()), workspace_root=None)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["merges_completed"], 0)
        self.assertIn("observe", result["reason"])

    def test_i_v3_02_select_returns_noop_for_standard(self) -> None:
        from aria_kernel.auto_merge_runners import (
            NoOpAutoMergeRunner,
            select_auto_merge_runner,
        )

        runner = select_auto_merge_runner(profile="standard")
        self.assertIsInstance(runner, NoOpAutoMergeRunner)

    def test_i_v3_02_select_returns_noop_for_frozen(self) -> None:
        from aria_kernel.auto_merge_runners import (
            NoOpAutoMergeRunner,
            select_auto_merge_runner,
        )

        runner = select_auto_merge_runner(profile="frozen")
        self.assertIsInstance(runner, NoOpAutoMergeRunner)

    def test_i_v3_03_select_returns_real_for_strict(self) -> None:
        from aria_kernel.auto_merge_runners import (
            RealAutoMergeRunner,
            select_auto_merge_runner,
        )

        runner = select_auto_merge_runner(profile="strict")
        self.assertIsInstance(runner, RealAutoMergeRunner)
        self.assertEqual(runner.profile, "strict")

    def test_i_v3_03_real_runner_imports_merge_if_green(self) -> None:
        """Source-level invariant: the Real runner's __call__ must
        reference ``merge_if_green`` from ``auto_merge``. A refactor
        that silently no-ops this wrap is caught by source-string
        inspection.
        """
        from aria_kernel import auto_merge_runners

        source = inspect.getsource(auto_merge_runners.RealAutoMergeRunner)
        self.assertIn("merge_if_green", source)
        self.assertIn("auto_merge", source)

    def test_i_v3_03_real_runner_dry_run_true_under_strict(self) -> None:
        """Under ``strict`` profile the Real runner MUST call
        ``merge_if_green`` with ``dry_run=True``. The autonomous
        profile (Phase B2) is the only profile that flips this to
        False. This invariant locks the strict-observation semantic
        so a future profile-table edit cannot accidentally promote
        strict to real-merge.
        """
        from aria_kernel.auto_merge_runners import RealAutoMergeRunner

        captured: list[dict[str, Any]] = []

        def _fake_merge_if_green(**kwargs: Any) -> dict[str, Any]:
            captured.append(kwargs)
            return {"decision": "blocked", "merges_completed": 0}

        # Patch auto_merge.merge_if_green via attribute monkeypatch in
        # the same module the runner imports from.
        import aria_kernel.auto_merge as auto_merge_module

        original = auto_merge_module.merge_if_green
        auto_merge_module.merge_if_green = _fake_merge_if_green
        try:
            runner = RealAutoMergeRunner(
                profile="strict",
                adapter_factory=lambda: object(),
                pr_enumerator=lambda adapter: [42],
                readiness_claim_resolver=lambda adapter, pr_number, base_dir: "claim-42",
            )
            runner(base_dir="/tmp", workspace_root="/tmp")
        finally:
            auto_merge_module.merge_if_green = original
        self.assertEqual(len(captured), 1)
        self.assertIs(captured[0]["dry_run"], True)

    def test_i_v3_03_real_runner_missing_dependencies_blocks(self) -> None:
        from aria_kernel.auto_merge_runners import RealAutoMergeRunner

        result = RealAutoMergeRunner(profile="strict")(
            base_dir="/tmp",
            workspace_root="/tmp",
        )
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "real_auto_merge_runner_missing_dependencies")
        self.assertIn("github_adapter_factory", result["missing_dependencies"])
        self.assertIn("pr_enumerator", result["missing_dependencies"])
        self.assertIn("readiness_claim_resolver", result["missing_dependencies"])

    def test_select_rejects_unknown_profile(self) -> None:
        """Unknown profile → ValueError. Tier-1: factory cannot
        silently default to NoOp or Real on an unrecognised name.
        """
        from aria_kernel.auto_merge_runners import select_auto_merge_runner

        with self.assertRaises(ValueError):
            select_auto_merge_runner(profile="permissive")

    def _tmpdir(self) -> Path:
        import tempfile
        return Path(tempfile.mkdtemp(prefix="aria-i-v3-01-"))


if __name__ == "__main__":
    unittest.main()
