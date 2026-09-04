"""Tests for Plan 019 Phase 8.B CI executor."""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

# tools/aria-poc is not on PYTHONPATH by default — add it.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402


class DispatchBudgetTests(unittest.TestCase):
    """ORPHAN-HIGH-472 — `_validate_cost_cap` is now `_validate_dispatch_budget`.

    The rename is not cosmetic: the USD half of the old gate is gone, because
    ARIA runs on a Claude Code subscription session and nothing is charged per
    run. The envelope-shape heuristic survives as an independent pre-flight,
    and the time ceiling is the part that actually binds.
    """

    def setUp(self) -> None:
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        self.tools.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_envelope_shape_under_limit_passes(self) -> None:
        with patch.dict(os.environ, {"MAX_TURNS_PER_RUN": "12"}):
            ci_executor._validate_dispatch_budget(
                request={"evidence_refs": ["a"] * 5},
                tools_dir=self.tools,
                timeout_seconds=600,
            )

    def test_envelope_shape_over_limit_rejects(self) -> None:
        with patch.dict(os.environ, {"MAX_TURNS_PER_RUN": "5"}):
            # cap = 5 * 4 = 20; 25 refs exceeds.
            with self.assertRaises(ci_executor.CostCapExceeded):
                ci_executor._validate_dispatch_budget(
                    request={"evidence_refs": ["x"] * 25},
                    tools_dir=self.tools,
                    timeout_seconds=600,
                )

    def test_no_usd_env_var_can_refuse_a_dispatch(self) -> None:
        # The old gate read MAX_BUDGET_USD_PER_CYCLE. Setting it absurdly low
        # must now change nothing at all — if this ever fails, a dollar figure
        # has crept back onto the decision path.
        with patch.dict(
            os.environ,
            {"MAX_BUDGET_USD_PER_CYCLE": "0.0001", "MAX_BUDGET_USD_PER_RUN": "0.0001",
             "MAX_TURNS_PER_RUN": "12"},
        ):
            ci_executor._validate_dispatch_budget(
                request={"evidence_refs": ["a"] * 5},
                tools_dir=self.tools,
                timeout_seconds=600,
            )

    @staticmethod
    def _started_at(seconds_ago: int) -> str:
        from datetime import datetime, timedelta, timezone

        return (
            datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")

    def test_gate_uses_the_values_production_actually_supplies(self) -> None:
        """TEST-CRITICAL-001 — the test that would have caught the outage.

        The first version of these tests passed timeout_seconds=600, a value
        _max_timeout_seconds() cannot return on either lane. With the real
        pair (cap 1800 == MAX_TIMEOUT_SECONDS 1800) the gate refused EVERY
        dispatch at any elapsed > 0: claim, refuse, release, exit 0, forever,
        with the job green and no agent ever running. Both numbers are now
        READ FROM THEIR SOURCES, so a future retune of either the job timeout
        or the per-run timeout that makes the gate unsatisfiable fails here.
        """
        from aria_kernel.tool_registry import ensure_tools_dir
        from aria_kernel.workflow_contract_registry import cycle_wall_clock_cap_seconds

        tools = ensure_tools_dir(self.tools)
        for workflow_id in ("aria-agent-executor", "aria-auto-cycle"):
            with self.subTest(workflow=workflow_id):
                cap = cycle_wall_clock_cap_seconds(workflow_id)
                with patch.dict(
                    os.environ,
                    {
                        "GITHUB_WORKFLOW_REF":
                            f"o/r/.github/workflows/{workflow_id}.yml@refs/heads/main",
                        "GITHUB_RUN_STARTED_AT": self._started_at(120),
                        "MAX_TIMEOUT_SECONDS": "1800",
                        "MAX_TURNS_PER_RUN": "12",
                    },
                ):
                    per_run = ci_executor._max_timeout_seconds()
                    self.assertGreater(
                        cap - 120, per_run,
                        f"{workflow_id}: a run of {per_run}s cannot start 120s into a "
                        f"{cap}s budget — the gate would refuse every dispatch",
                    )
                    # Two minutes into the job is the normal case, and it must
                    # be allowed with the real numbers, not with test literals.
                    ci_executor._validate_dispatch_budget(
                        request={"evidence_refs": ["a"]},
                        tools_dir=tools,
                        timeout_seconds=per_run,
                    )

    def test_exhausted_job_wall_clock_refuses_the_dispatch(self) -> None:
        """ORPHAN-CRITICAL-495 — no cycle_id anywhere in this test, on purpose.

        The first version of this gate accounted against request["cycle_id"],
        which 15 of 17 mint paths never set, so it was inert on essentially
        every dispatch. The ceiling now derives from elapsed job time, which
        needs nothing threaded through the envelope.
        """
        from aria_kernel.budget import WallClockExhausted
        from aria_kernel.tool_registry import ensure_tools_dir
        from aria_kernel.workflow_contract_registry import cycle_wall_clock_cap_seconds

        tools = ensure_tools_dir(self.tools)
        cap = cycle_wall_clock_cap_seconds("aria-agent-executor")
        with patch.dict(
            os.environ,
            {
                "GITHUB_WORKFLOW_REF":
                    "o/r/.github/workflows/aria-agent-executor.yml@refs/heads/main",
                # Derived from the real cap so this stays a genuine exhaustion
                # case if the timeout is ever retuned.
                "GITHUB_RUN_STARTED_AT": self._started_at(cap - 60),
                "MAX_TIMEOUT_SECONDS": "1800",
                "MAX_TURNS_PER_RUN": "12",
            },
        ):
            with self.assertRaises(WallClockExhausted):
                ci_executor._validate_dispatch_budget(
                    request={"evidence_refs": ["a"]},
                    tools_dir=tools,
                    timeout_seconds=ci_executor._max_timeout_seconds(),
                )

    def test_cycle_id_reaches_the_envelope(self) -> None:
        # TEST-CRITICAL-002 — the wall-clock ledger recorded nothing because
        # the envelope main() builds never copied cycle_id off the request row.
        #
        # This pinned the hand-copy line as source text; the envelope now
        # comes from the kernel's fuse_prompt_envelope (a second projection in
        # the executor is how the prompt binding died twice), so the property
        # is asserted on the projection itself.
        from aria_kernel.agent_invocations import fuse_prompt_envelope

        envelope = fuse_prompt_envelope({"cycle_id": "cyc-42", "claim_id": "c1"})

        self.assertEqual(envelope.get("cycle_id"), "cyc-42")

    def test_workflow_id_is_parsed_from_the_github_ref(self) -> None:
        with patch.dict(
            os.environ,
            {"GITHUB_WORKFLOW_REF":
                "o/r/.github/workflows/aria-auto-cycle.yml@refs/heads/main"},
        ):
            self.assertEqual(ci_executor._current_workflow_id(), "aria-auto-cycle")

    def test_run_duration_is_recorded_against_the_cycle(self) -> None:
        from aria_kernel.budget import cycle_wall_clock_spent
        from aria_kernel.tool_registry import ensure_tools_dir

        tools = ensure_tools_dir(self.tools)
        ci_executor._record_run_wall_clock(
            request={"cycle_id": "c1"},
            tools_dir=tools,
            request_id="AIR-x",
            seconds=42.5,
        )
        self.assertAlmostEqual(
            cycle_wall_clock_spent(cycle_id="c1", base_dir=tools), 42.5
        )

    def test_recording_failure_never_fails_the_run(self) -> None:
        # Accounting must not convert a completed agent run into a failed
        # one. Missing a row costs one over-run cycle; raising here costs the
        # work the agent just did.
        ci_executor._record_run_wall_clock(
            request={"cycle_id": "c1"},
            tools_dir="/nonexistent/path/that/cannot/be/written",
            request_id="AIR-x",
            seconds=1.0,
        )

    def test_duration_is_booked_in_a_finally_not_only_on_success(self) -> None:
        """Source-level, because exercising it needs a full main() run.

        A run that timed out or was refused still burned the time. Booking it
        only on the success path would under-count precisely in the case the
        ceiling exists to catch — a cycle whose runs keep dying slowly.
        """
        src = (Path(_POC_DIR) / "ci_executor.py").read_text(encoding="utf-8")
        # Plan 032 Faz 032d added an earlier `finally:` (credential revocation in
        # invoke_claude_cli); the invariant is about the arm that ENCLOSES the
        # recording, so anchor on the recording and walk back to its finally.
        record_idx = src.index("        _record_run_wall_clock(\n")
        finally_idx = src.rindex("    finally:\n", 0, record_idx)
        between = src[finally_idx:record_idx]
        self.assertNotIn("except", between, "recording must sit in the finally arm")
        self.assertIn("_run_started_at = time.monotonic()", src)

    def test_retired_usd_helpers_are_gone(self) -> None:
        # A tunable that gates nothing is worse than no tunable: an operator
        # who lowers it believes they have tightened something.
        self.assertFalse(hasattr(ci_executor, "_max_budget_usd"))
        self.assertFalse(hasattr(ci_executor, "_max_budget_usd_per_cycle"))
        self.assertFalse(hasattr(ci_executor, "_estimate_envelope_cost_usd"))


class LeaseTokenRedactionTests(unittest.TestCase):
    def test_redact_replaces_token_in_message(self) -> None:
        out = ci_executor._redact_lease_in_message(
            "submit failed: lease=secret-abc-123 mismatch", "secret-abc-123"
        )
        self.assertNotIn("secret-abc-123", out)
        self.assertIn("<lease-token-redacted>", out)

    def test_redact_passes_through_when_no_token(self) -> None:
        out = ci_executor._redact_lease_in_message("clean message", None)
        self.assertEqual(out, "clean message")

    def test_argv_never_contains_lease_token(self) -> None:
        # The executor passes lease tokens via env var only. The argv
        # construction in `main()` references `--lease-token-from-env
        # ARIA_LEASE_TOKEN` — assert by inspecting the source.
        src = (Path(_POC_DIR) / "ci_executor.py").read_text(encoding="utf-8")
        # Required: the env-var transit pattern.
        self.assertIn("--lease-token-from-env", src)
        self.assertIn("LEASE_TOKEN_ENV_VAR", src)
        # Forbidden: any direct argv passing of `lease_token` variable.
        self.assertNotIn('"--lease-token", lease_token', src)
        self.assertNotIn("'--lease-token', lease_token", src)


class InvokeCodexCliTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-ci-"))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_mock_mode_writes_envelope_to_output_path(self) -> None:
        out_path = self.tmp / "response.json"
        prompt_path = self.tmp / "prompt.md"
        prompt_path.write_text("# Test prompt", encoding="utf-8")
        # Plan 024 v3 §B-8 — invoke_claude_cli requires real
        # lease identity (claim_id + agent_id) when in mock mode so
        # the envelope can pass the Plan 023 §A-5 lease binding +
        # Plan 024 §H-4 role match. Tests pass dummy real-shaped
        # values here.
        with patch.dict(os.environ, {ci_executor.MOCK_MODE_ENV_VAR: "1"}):
            exit_code = ci_executor.invoke_claude_cli(
                request_id="REQ-test-1",
                subagent_type="aria-evidence-judge",
                prompt_file=prompt_path,
                output_path=out_path,
                timeout_seconds=300,
                claim_id="claim_test_aaaaaaaa",
                agent_id="ci-executor:gha-test",
                role="evidence_judgment",
                must_satisfy=[],
            )
        self.assertEqual(exit_code, 0)
        self.assertTrue(out_path.exists())
        envelope = json.loads(out_path.read_text(encoding="utf-8"))
        self.assertEqual(envelope["$schema"], "aria/agent-response/v1")
        self.assertEqual(envelope["request_id"], "REQ-test-1")
        self.assertEqual(envelope["details"]["verdict"]["model"], "mock")

    def test_unavailable_when_no_binary_and_no_mock(self) -> None:
        out_path = self.tmp / "response.json"
        prompt_path = self.tmp / "prompt.md"
        prompt_path.write_text("# Test prompt", encoding="utf-8")
        with patch.dict(os.environ, {
            ci_executor.MOCK_MODE_ENV_VAR: "0",
            "CLAUDE_CLI_BINARY": "__aria_missing_claude_for_test__",
        }):
            with self.assertRaises(ci_executor.ClaudeCliUnavailable) as ctx:
                # Plan 025 §B — role is now a required keyword (no
                # default); pass a real-shaped role here. The
                # ClaudeCliUnavailable branch does NOT consume role
                # but the function signature requires it.
                ci_executor.invoke_claude_cli(
                    request_id="REQ-test-2",
                    subagent_type="aria-evidence-judge",
                    prompt_file=prompt_path,
                    output_path=out_path,
                    timeout_seconds=300,
                    role="evidence_judgment",
                )
        # Plan ARIA-V3 §B1 — spike doc was promoted to proven-contract
        # doc (DEBT-2026-05-08-001 retired by commit cf30da50). The
        # ClaudeCliUnavailable message now cites the load-bearing
        # proven-contract doc as the argv SSoT instead of the
        # spike-era "contract gap" language.
        self.assertIn("claude", str(ctx.exception))
        self.assertIn("ci_executor_contract_proven.md", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
