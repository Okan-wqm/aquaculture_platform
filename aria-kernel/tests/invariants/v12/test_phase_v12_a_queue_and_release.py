"""Plan 032 Faz 032a — the queue is read once, and every release reason has an owner.

Invariants:
  I-V12-QUEUE-01    `next_pending_request` derives the whole queue's states
                    with ONE batch fold, never per candidate (29 minutes on
                    the 725-row backlog of 2026-09-02, to answer "nothing").
  I-V12-RELEASE-01  fault ownership is by literal OR prefix: parameterised
                    executor reasons (`claude_cli_exit_<n>`, `submit_timeout_<n>s`,
                    `plan_content_invalid:<errs>`, `agent_refused:<class>`)
                    resolve to harness or request, never to the default bucket.
  I-V12-RELEASE-02  every release site in the executor — literal AND f-string —
                    classifies; a new parameterised reason without a prefix row
                    fails here instead of burning budgets in production.
  I-V12-RELEASE-03  an unclassified reason still charges the request (the
                    standing fail-toward-the-human rule) AND lands an
                    `unclassified_release_reason` governance row.
  I-V12-RHYTHM-01   the chain's minimum spacing is policy (`rhythm.min_interval_hours`),
                    defaulting to the code-side floor and mergeable from the
                    operator override.
"""
from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import agent_invocations
from aria_kernel.agent_invocations import (
    HARNESS_FAULT_RELEASE_REASON_PREFIXES,
    HARNESS_FAULT_RELEASE_REASONS,
    REQUEST_FAULT_RELEASE_REASON_PREFIXES,
    REQUEST_FAULT_RELEASE_REASONS,
    _is_harness_fault_reason,
    claim_request,
    classify_release_reason,
    create_agent_invocation_request,
    next_pending_request,
    release_claim,
)
from aria_kernel.cycle_rhythm import MIN_CYCLE_INTERVAL_HOURS
from aria_kernel.genesis_policy import rhythm_policy
from aria_kernel.governance_reader import read_governance_rows
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[4]
_EXECUTOR = _REPO_ROOT / "tools" / "aria-poc" / "ci_executor.py"


def _seed(tools: Path, prompt: str) -> dict:
    return create_agent_invocation_request(
        target_agent="aria-challenger-planner",
        role="challenger_plan",
        suggested_prompt=prompt,
        must_satisfy=[{"id": "v12-queue", "criterion": "the queue is read once"}],
        allowed_scope=["aria-kernel/**"],
        convergence_id="conv-v12",
        base_dir=tools,
    )


class QueueReadOnce(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_I_V12_QUEUE_01_selection_uses_one_batch_fold(self) -> None:
        first = _seed(self.tools, "prompt-1")
        _seed(self.tools, "prompt-2")
        _seed(self.tools, "prompt-3")
        batch = agent_invocations.derive_request_states
        single = agent_invocations.derive_request_state
        reloads: list[str] = []

        def fold(*args, **kwargs):
            # The batch form feeds the single fold pre-loaded ledgers; a call
            # WITHOUT them is the per-candidate reload this invariant forbids.
            if kwargs.get("_ledgers") is None:
                reloads.append(str(kwargs.get("request_id")))
            return single(*args, **kwargs)

        with mock.patch.object(
            agent_invocations, "derive_request_states", wraps=batch,
        ) as batched, mock.patch.object(
            agent_invocations, "derive_request_state", side_effect=fold,
        ):
            picked = next_pending_request(role="challenger_plan", base_dir=self.tools)

        self.assertEqual(picked["request_id"], first["request_id"])
        self.assertEqual(batched.call_count, 1)
        self.assertEqual(reloads, [], "selection must not reload ledgers per candidate")


class ReleaseReasonOwnership(unittest.TestCase):
    def test_I_V12_RELEASE_01_prefixes_resolve_parameterised_reasons(self) -> None:
        self.assertEqual(classify_release_reason("claude_cli_exit_1"), "harness")
        self.assertEqual(classify_release_reason("submit_timeout_120s"), "harness")
        self.assertEqual(classify_release_reason("plan_content_invalid:plan_content:absent_or_not_object"), "request")
        self.assertEqual(classify_release_reason("agent_refused:scope"), "request")
        self.assertEqual(classify_release_reason("lease_expired"), "request")
        self.assertEqual(classify_release_reason("prompt_hash_binding_mismatch"), "harness")
        self.assertEqual(classify_release_reason("something_nobody_named"), "unclassified")
        # The standing rule: unclassified still charges the request.
        self.assertFalse(_is_harness_fault_reason("something_nobody_named"))
        self.assertTrue(_is_harness_fault_reason("submit_timeout_120s"))
        # The two prefix tables cannot overlap.
        self.assertFalse(set(HARNESS_FAULT_RELEASE_REASON_PREFIXES) & set(REQUEST_FAULT_RELEASE_REASON_PREFIXES))
        self.assertFalse(HARNESS_FAULT_RELEASE_REASONS & REQUEST_FAULT_RELEASE_REASONS)

    def test_I_V12_RELEASE_02_every_executor_release_site_is_owned(self) -> None:
        source = _EXECUTOR.read_text(encoding="utf-8")
        literal = set(re.findall(r'reason="([a-z_]+)"', source))
        # f-string sites: the static text before the first placeholder is the
        # prefix the kernel must own (`reason=f"submit_timeout_{N}s"` -> `submit_timeout_`).
        fstring = set(re.findall(r'reason=f"([a-z_:]+)\{', source))
        self.assertTrue(fstring, "the executor releases with parameterised reasons; none found")

        unowned = sorted(
            [r for r in literal if classify_release_reason(r) == "unclassified"]
            + [p for p in fstring if classify_release_reason(p + "x") == "unclassified"]
        )
        self.assertEqual(unowned, [], f"release reasons with no fault-ownership row: {unowned}")


class UnclassifiedIsSaidOutLoud(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_I_V12_RELEASE_03_unclassified_reason_charges_and_records(self) -> None:
        req = _seed(self.tools, "prompt-1")
        claim = claim_request(request_id=req["request_id"], agent_id="worker-1", base_dir=self.tools)

        release_claim(
            claim_id=claim["claim_id"], agent_id="worker-1",
            lease_token=claim["lease_token"], reason="a_reason_nobody_classified",
            base_dir=self.tools,
        )

        rows = list(read_governance_rows(self.tools / "governance.jsonl"))
        kinds = [row.get("kind") for row in rows]
        self.assertIn("unclassified_release_reason", kinds)
        self.assertIn("agent_requeued", kinds)
        requeued = [row for row in rows if row.get("kind") == "agent_requeued"][-1]
        self.assertEqual(requeued["details"]["requeue_count"], 1, "still charged to the request")

    def test_I_V12_RELEASE_03_a_classified_reason_records_no_unclassified_row(self) -> None:
        req = _seed(self.tools, "prompt-1")
        claim = claim_request(request_id=req["request_id"], agent_id="worker-1", base_dir=self.tools)

        release_claim(
            claim_id=claim["claim_id"], agent_id="worker-1",
            lease_token=claim["lease_token"], reason="submit_timeout_120s",
            base_dir=self.tools,
        )

        kinds = [row.get("kind") for row in read_governance_rows(self.tools / "governance.jsonl")]
        self.assertNotIn("unclassified_release_reason", kinds)


class RhythmSpacingIsPolicy(unittest.TestCase):
    def test_I_V12_RHYTHM_01_default_is_the_code_floor_and_override_merges(self) -> None:
        self.assertEqual(rhythm_policy()["min_interval_hours"], MIN_CYCLE_INTERVAL_HOURS)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "aria-config").mkdir()
            (root / "aria-config" / "genesis_policy.json").write_text(
                json.dumps({
                    "$schema": "aria/genesis-policy/v1",
                    "schema_version": 1,
                    "rhythm": {"min_interval_hours": 2.0, "not_a_key": 1},
                }),
                encoding="utf-8",
            )
            block = rhythm_policy(root)

        self.assertEqual(block["min_interval_hours"], 2.0)
        self.assertEqual(block["backlog_cap"], 25)
        self.assertNotIn("not_a_key", block)

    def test_the_live_override_lowers_the_brake_and_lengthens_the_anchor(self) -> None:
        policy = json.loads((_REPO_ROOT / "aria-config" / "genesis_policy.json").read_text(encoding="utf-8"))
        self.assertEqual(policy["rhythm"]["min_interval_hours"], 2.0)
        self.assertEqual(policy["agent_request_anchor"]["max_age_seconds"], 7 * 24 * 3600)


if __name__ == "__main__":
    unittest.main()
