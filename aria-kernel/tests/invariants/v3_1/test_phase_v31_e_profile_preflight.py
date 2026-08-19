"""Plan ARIA-V3.1-E — profile + preflight + budget SSoT invariants.

Closes 6-validator audit findings:

* C-2 (CLI `--profile` bypasses set_profile SOC2 audit trail)
* H-9 (required-kwarg `profile` breaking change caller migration)
* H-13 (`--implementer-poll-seconds` distinct from challenger_timeout)
* H-15 partial (Tier-1 honesty — orchestrator body uses kwarg SSoT)

Invariants:

* I-V31-E-01 — argparse rejects `--profile autonomous` without
  `--operator-approval-ref` (behavioral CLI test).
* I-V31-E-02 — `run_autonomy_orchestrator` signature has
  `profile: str` REQUIRED (no default) + `implementer_poll_seconds:
  float = 1800.0`.
* I-V31-E-03 — autonomous + invalid preflight → orchestrator raises
  GovernanceError + emits `autonomy_orchestrator_refused` event with
  `bypass_profile_gate=True`.
* I-V31-E-04 — orchestrator body contains ZERO direct `get_profile(`
  calls (the profile kwarg is the cycle-execution SSoT).
* I-V31-E-05 — all `run_autonomy_orchestrator(...)` callers pass
  `profile=` (grep invariant; closes H-9 staging).
* I-V31-E-06 — CLI override emits `runtime_profile_changed` audit
  row in `runtime-profile-history.jsonl` (behavioral SOC2 test).
"""
from __future__ import annotations

import inspect
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel" / "aria_kernel"


class ProfileCliArgparseTests(unittest.TestCase):
    """Plan ARIA-V3.1-E-1 — argparse contract for autonomy run."""

    def test_i_v31_e_01_autonomous_requires_operator_approval_ref(self) -> None:
        """Plan ARIA-V3.1-E-1 — `--profile autonomous` without
        `--operator-approval-ref` exits with rc=2 + the operator-
        actionable error message.
        """
        sys.path.insert(0, str(_REPO_ROOT / "aria-kernel"))
        try:
            from aria_kernel.cli import main as cli_main
            from aria_kernel.runtime_profile import set_profile
        finally:
            sys.path.pop(0)
        tmp = Path(tempfile.mkdtemp(prefix="v31e-1-"))
        base = tmp / "aria-tools"
        # Seed a known persisted profile so set_profile inside main
        # has somewhere to write.
        set_profile(
            "standard", operator_approval_ref="seed",
            base_dir=base,
        )
        err_buf = io.StringIO()
        with redirect_stderr(err_buf), redirect_stdout(io.StringIO()):
            rc = cli_main([
                "--tools-dir", str(base),
                "autonomy", "run",
                "--workspace-root", str(tmp),
                "--profile", "autonomous",
                "--max-cycles", "1",
            ])
        self.assertEqual(rc, 2,
                         "autonomous without operator-approval-ref must rc=2")
        self.assertIn(
            "operator-approval-ref", err_buf.getvalue(),
            "stderr must explain the required flag",
        )


class OrchestratorSignatureTests(unittest.TestCase):
    """Plan ARIA-V3.1-E-2/3/4 — orchestrator signature + body SSoT."""

    def test_i_v31_e_02_profile_required_and_poll_seconds_default(self) -> None:
        from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
        sig = inspect.signature(run_autonomy_orchestrator)
        self.assertIn("profile", sig.parameters)
        profile_param = sig.parameters["profile"]
        self.assertEqual(
            profile_param.default, inspect.Parameter.empty,
            "profile MUST be a REQUIRED kwarg (no default)",
        )
        self.assertEqual(
            profile_param.kind, inspect.Parameter.KEYWORD_ONLY,
            "profile MUST be keyword-only",
        )
        # K6 (ORPHAN-CRITICAL-727) — REWRITTEN PIN. This used to assert
        # `implementer_poll_seconds` was a parameter defaulting to 1800.0.
        # That is now false, deliberately: the V9 implementation phase mints
        # the envelope and returns, because the executor lane claims it in a
        # LATER workflow run and nothing the cycle waited for could arrive
        # inside the cycle. With the poll gone the budget had no reader, and a
        # knob nothing reads is a promise to the operator that nothing keeps.
        self.assertNotIn(
            "implementer_poll_seconds", sig.parameters,
            "the V9 implementation phase no longer polls; a poll budget "
            "parameter would be a knob with no reader",
        )

    def test_i_v31_e_04_orchestrator_body_has_zero_get_profile_calls(self) -> None:
        """Plan ARIA-V3.1-E-4 — orchestrator uses ONLY the profile
        kwarg. The `get_profile(` import was removed from the
        runtime-import line + the body no longer calls it.
        """
        path = _KERNEL_ROOT / "autonomy_orchestrator.py"
        src = path.read_text(encoding="utf-8")
        self.assertNotIn(
            "from .runtime_profile import enforce_profile_for_action, get_profile",
            src,
            "get_profile import line not yet purged",
        )
        # Body-level call: NOT in import lines (lines starting with `from`).
        body_lines = [
            line for line in src.splitlines()
            if not line.lstrip().startswith(("from ", "import ", "#"))
        ]
        body_src = "\n".join(body_lines)
        # The orchestrator's body MAY reference get_profile inside
        # commentary about removed code — but actual function calls
        # must not exist. Regex matches `get_profile(` as a callable
        # invocation, not the bare identifier.
        callsites = re.findall(r"\bget_profile\s*\(", body_src)
        self.assertEqual(
            callsites, [],
            f"orchestrator body still calls get_profile(): {callsites}",
        )


class PreflightFailFastTests(unittest.TestCase):
    """Plan ARIA-V3.1-E-3 — autonomous preflight fail-fast."""

    def test_i_v31_e_03_autonomous_preflight_failure_raises(self) -> None:
        """Plan ARIA-V3.1-E-3 — under profile=autonomous, an invalid
        preflight verdict raises GovernanceError + emits the
        `autonomy_orchestrator_refused` governance event.

        Synthetic preflight via monkeypatch — returns
        valid=False with a fixed failure_classes tuple. The
        orchestrator must surface that as `autonomous_profile_-
        preconditions_not_met` in the GovernanceError message.
        """
        from aria_kernel.autonomy_orchestrator import (
            run_autonomy_orchestrator,
        )
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import (
            GovernanceError, ensure_tools_dir,
        )
        from aria_kernel import preflight as _preflight_mod
        tmp = Path(tempfile.mkdtemp(prefix="v31e-3-"))
        base = tmp / "aria-tools"
        # autonomous persisted so the orchestrator body's profile
        # snapshot matches the kwarg + the action gate permits the
        # post-refusal governance write via bypass_profile_gate=True.
        ensure_tools_dir(base)
        set_profile(
            "autonomous", operator_approval_ref="v31e3-test",
            base_dir=base,
        )
        # Synthetic failing verdict.
        fake_verdict = _preflight_mod.PreflightVerdict(
            valid=False,
            profile="autonomous",
            reasons=("synthetic_failure_test",),
            branch="main",
            repo=None,
            gh_token_present=False,
            gh_app_installation=False,
            signing_key_present=False,
            immutable_paths_count=0,
            bash_allowlist_count=0,
            failure_classes=("missing_gh_token",),
        )
        original = _preflight_mod.verify_preflight
        _preflight_mod.verify_preflight = lambda **kw: fake_verdict
        try:
            with self.assertRaises(GovernanceError) as ctx:
                run_autonomy_orchestrator(
                    base_dir=base,
                    workspace_root=str(tmp),
                    profile="autonomous",
                    max_cycles=1,
                    # Minimal happy-path fakes — these never fire
                    # because the preflight gate raises before the
                    # cycle loop starts.
                    auto_merge_runner=lambda **kw: {"status": "skipped"},
                    github_adapter=object(),
                    convergence_runner=lambda **kw: {"arbiter_verdict": "split"},
                    review_runner=lambda **kw: {"review_verdict": "gaps_open"},
                    specialist_review_runner=lambda **kw: {
                        "consolidated_verdict": "specialists_unavailable",
                    },
                    plan_synthesizer=lambda **kw: None,
                    skill_genesis_drainer=lambda **kw: {"aggregate_verdict": "no_requests"},
                    cycle_runner=lambda **kw: {"status": "ok"},
                    planner_drainer=lambda **kw: {"claims_dispatched": 0},
                    worker_drainer=lambda **kw: {"assignments_dispatched": 0},
                    bridge_drainer=lambda **kw: {"status": "ok"},
                )
            self.assertIn(
                "autonomous_profile_preconditions_not_met",
                str(ctx.exception),
            )
        finally:
            _preflight_mod.verify_preflight = original


class CallerMigrationTests(unittest.TestCase):
    """Plan ARIA-V3.1-E-5 — every caller passes `profile=` kwarg."""

    def test_i_v31_e_05_all_callers_pass_profile_kwarg(self) -> None:
        """Plan ARIA-V3.1-E-5 — grep invariant.

        Locate every `run_autonomy_orchestrator(` invocation site in
        the kernel + tests. Each must be either:
        * Followed (within 3 lines) by `profile=` (test fakes), OR
        * Forward to `**kwargs` where kwargs are pre-populated with
          `profile=...` in the helper assembly.

        The grep approach is intentionally simple — false positives
        on dynamic kwargs are acceptable; the test catches the
        common static case where a future PR introduces a new caller
        that forgets the new required kwarg.
        """
        # The CLI surface uses `profile=profile` explicitly.
        cli_src = (_KERNEL_ROOT / "cli.py").read_text(encoding="utf-8")
        self.assertIn(
            "profile=profile",
            cli_src,
            "CLI `run_autonomy_orchestrator(profile=profile, ...)` call missing",
        )
        # Test helpers pre-populate kwargs dict.
        helper_pins = [
            (_REPO_ROOT / "aria-kernel/tests/test_autonomy_orchestrator.py",
             'profile="standard"'),
            (_REPO_ROOT / "aria-kernel/tests/invariants/v5/test_phase_v5_1_convergence_gate.py",
             'profile="standard"'),
            (_REPO_ROOT / "aria-kernel/tests/invariants/v5/test_phase_v5_2_review_gate.py",
             'profile="standard"'),
            (_REPO_ROOT / "aria-kernel/tests/invariants/v6/test_phase_v6_1_specialist_gate.py",
             'profile="standard"'),
            (_REPO_ROOT / "aria-kernel/tests/invariants/v7/test_phase_v7_2_orchestrator_try_except.py",
             'profile="standard"'),
            (_REPO_ROOT / "aria-kernel/tests/invariants/v3_3/test_phase_v3_3_reflection_ordering.py",
             'profile="standard"'),
        ]
        for path, pin in helper_pins:
            self.assertTrue(path.exists(), f"caller file missing: {path}")
            text = path.read_text(encoding="utf-8")
            self.assertIn(
                pin, text,
                f"{path.name}: caller `{pin}` not found — V3.1-E "
                "migration regression",
            )


class CliOverrideAuditTests(unittest.TestCase):
    """Plan ARIA-V3.1-E-6 — CLI override audit row."""

    def test_i_v31_e_06_cli_override_emits_runtime_profile_changed(self) -> None:
        """Plan ARIA-V3.1-E-6 — `--profile <new>` from a persisted
        state that differs emits a `runtime_profile_changed` row in
        `runtime-profile-history.jsonl` (SOC2 audit trail; closes
        C-2).
        """
        sys.path.insert(0, str(_REPO_ROOT / "aria-kernel"))
        try:
            from aria_kernel.cli import main as cli_main
            from aria_kernel.runtime_profile import (
                PROFILE_HISTORY_FILENAME, set_profile,
            )
        finally:
            sys.path.pop(0)
        tmp = Path(tempfile.mkdtemp(prefix="v31e-6-"))
        base = tmp / "aria-tools"
        # Persisted state = observe; CLI override to standard.
        set_profile(
            "observe", operator_approval_ref="seed-observe",
            base_dir=base,
        )
        history_path = base / PROFILE_HISTORY_FILENAME
        rows_before = history_path.read_text(encoding="utf-8").splitlines()
        # Use a fake runner so the orchestrator does not actually
        # spawn LLM subprocesses; we only care about the CLI
        # set_profile() side-effect.
        from unittest.mock import patch
        with patch(
            "aria_kernel.autonomy_orchestrator.run_autonomy_orchestrator",
            lambda **kw: {
                "cycles_completed": 0,
                "planner_claims_dispatched": 0,
                "worker_assignments_dispatched": 0,
                "auto_merges_completed": 0,
                "exit_reason": "max_cycles",
                "exits_clean": True,
                "per_cycle": [],
            },
        ), redirect_stdout(io.StringIO()):
            rc = cli_main([
                "--tools-dir", str(base),
                "autonomy", "run",
                "--workspace-root", str(tmp),
                "--profile", "standard",
                "--max-cycles", "1",
            ])
        self.assertEqual(rc, 0)
        rows_after = history_path.read_text(encoding="utf-8").splitlines()
        new_rows = rows_after[len(rows_before):]
        self.assertTrue(
            new_rows,
            "CLI override did not append a runtime-profile-history row",
        )
        # Last new row has the active_profile we requested.
        last = json.loads(new_rows[-1])
        self.assertEqual(last["active_profile"], "standard")
        self.assertEqual(last["previous_profile"], "observe")
        self.assertEqual(last["set_by"], "autonomy-cli")
        self.assertTrue(last["operator_approval_ref"].startswith("cli-flag:"))


if __name__ == "__main__":
    unittest.main()
