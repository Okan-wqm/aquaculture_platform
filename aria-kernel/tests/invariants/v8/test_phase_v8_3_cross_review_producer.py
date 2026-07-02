"""Plan ARIA-V8 v2 §4 Phase 8.3 — cross_review_bridge invariants.

Closes F-014-D3. 7 invariants:

- I-V8.3-01 — issue_cross_review_envelope mints role=cross_review + target=aria-cross-reviewer
- I-V8.3-02 — Envelope must_satisfy carries both revision_id refs + content_hash anchors
- I-V8.3-03 — Envelope suggested_prompt contains <untrusted_primary_plan AND <untrusted_challenger_plan
- I-V8.3-04 — issue_primary_envelope on DRAFT raises BridgeContractViolation
- I-V8.3-05 — Bridge maps role=cross_review → record_cross_review (regression)
- I-V8.3-06 — Agent file .claude/agents/aria-cross-reviewer.md exists with frontmatter
- I-V8.3-07 — Agent file contains explicit untrusted-tag DATA instruction
"""
from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401

from aria_kernel import cross_review_bridge
from aria_kernel.bridge_exceptions import BridgeContractViolation
from aria_kernel.plan_convergence import start_plan


_REPO_ROOT = Path(__file__).resolve().parents[4]
_AGENT_FILE = _REPO_ROOT / ".claude" / "agents" / "aria-cross-reviewer.md"


def _valid_plan_content(plan_id: str) -> dict:
    return {
        "schema_version": 1,
        "title": f"Plan {plan_id}",
        "summary": "fixture for V8.3",
        "affected_surfaces": ["fixture.py"],
        "key_changes": [{"id": "c1", "description": "fixture", "paths": ["fixture.py"]}],
        "validation_commands": [{"cmd": "echo ok", "timeout_ms": 1000, "expected_exit": 0}],
        "evidence_refs": ["fixture.py:1:ok"],
    }


class TestCrossReviewEnvelopeMint(unittest.TestCase):
    """I-V8.3-01, I-V8.3-02, I-V8.3-03 — mint contract."""

    def _setup(self) -> tuple[Path, str]:
        tmp = Path(tempfile.mkdtemp())
        plan_id = "plan-v8-3"
        start_plan(plan_id=plan_id, plan_content=_valid_plan_content(plan_id),
                   initial_revision_id=f"{plan_id}-r1", base_dir=tmp)
        return tmp, plan_id

    def test_mint_role_and_target_agent(self):
        base, plan_id = self._setup()
        request = cross_review_bridge.issue_cross_review_envelope(
            plan_id=plan_id,
            round_number=1,
            primary_revision_id=f"{plan_id}-r1",
            primary_plan_text="primary text fixture",
            challenger_revision_id=f"{plan_id}-c1",
            challenger_plan_text="challenger text fixture",
            must_satisfy=[{"id": "ms-1", "description": "test", "content_hash": "sha256:abc"}],
            evidence_refs=["fixture.py:1:ok"],
            allowed_scope=["fixture.py"],
            base_dir=base,
        )
        self.assertEqual(request.get("role"), "cross_review")
        self.assertEqual(request.get("target_agent"), "aria-cross-reviewer")

    def test_must_satisfy_carries_revision_ids(self):
        base, plan_id = self._setup()
        ms = [
            {"id": "primary-ref", "description": "primary revision", "content_hash": "sha256:p"},
            {"id": "challenger-ref", "description": "challenger revision", "content_hash": "sha256:c"},
        ]
        request = cross_review_bridge.issue_cross_review_envelope(
            plan_id=plan_id,
            round_number=1,
            primary_revision_id=f"{plan_id}-r1",
            primary_plan_text="primary text",
            challenger_revision_id=f"{plan_id}-c1",
            challenger_plan_text="challenger text",
            must_satisfy=ms,
            evidence_refs=["fixture.py:1:ok"],
            allowed_scope=["fixture.py"],
            base_dir=base,
        )
        self.assertEqual(request.get("must_satisfy"), ms)

    def test_suggested_prompt_has_untrusted_delimiters(self):
        base, plan_id = self._setup()
        request = cross_review_bridge.issue_cross_review_envelope(
            plan_id=plan_id,
            round_number=1,
            primary_revision_id=f"{plan_id}-r1",
            primary_plan_text="primary body",
            challenger_revision_id=f"{plan_id}-c1",
            challenger_plan_text="challenger body",
            must_satisfy=[{"id": "ms-1", "description": "test"}],
            evidence_refs=["fixture.py:1:ok"],
            allowed_scope=["fixture.py"],
            base_dir=base,
        )
        prompt = request.get("suggested_prompt", "")
        self.assertIn("<untrusted_primary_plan", prompt)
        self.assertIn("<untrusted_challenger_plan", prompt)
        self.assertIn("primary body", prompt)
        self.assertIn("challenger body", prompt)


class TestPrimaryEnvelopeImpossibleMint(unittest.TestCase):
    """I-V8.3-04 — Tier-1: primary mint on DRAFT structurally refused."""

    def test_primary_envelope_on_draft_raises_bridge_contract_violation(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            plan_id = "plan-tier1-impossible"
            start_plan(plan_id=plan_id, plan_content=_valid_plan_content(plan_id),
                       initial_revision_id=f"{plan_id}-r1", base_dir=base)
            # State is DRAFT — primary envelope mint MUST refuse.
            with self.assertRaises(BridgeContractViolation) as ctx:
                cross_review_bridge.issue_primary_envelope(
                    plan_id=plan_id,
                    round_number=2,
                    must_satisfy=[{"id": "ms", "description": "test"}],
                    evidence_refs=["fixture.py:1:ok"],
                    allowed_scope=["fixture.py"],
                    base_dir=base,
                )
            msg = str(ctx.exception)
            self.assertIn("primary_envelope_forbidden_on_state_DRAFT", msg)
            self.assertIn("CRITIQUED", msg)
            self.assertIn("CROSS_REVIEWED", msg)


class TestCrossReviewBridgeMapping(unittest.TestCase):
    """I-V8.3-05 — regression: plan_convergence_bridge maps cross_review → record_cross_review."""

    def test_plan_convergence_bridge_handles_cross_review_role(self):
        from aria_kernel import plan_convergence_bridge
        # The bridge module must have cross_review in its dispatch.
        import inspect
        src = inspect.getsource(plan_convergence_bridge)
        self.assertIn("cross_review", src)
        self.assertIn("record_cross_review", src)


class TestCrossReviewerAgentFile(unittest.TestCase):
    """I-V8.3-06, I-V8.3-07 — agent file presence + frontmatter + security clause."""

    def test_agent_file_exists(self):
        self.assertTrue(_AGENT_FILE.exists(), f"missing agent file at {_AGENT_FILE}")

    def test_agent_frontmatter(self):
        content = _AGENT_FILE.read_text(encoding="utf-8")
        # Frontmatter assertions (line-anchored via MULTILINE)
        self.assertRegex(content, r"(?m)^name:\s*aria-cross-reviewer\s*$", msg="name field")
        # Plan 023 §A model/effort tiering + K5 tier flip (operator policy
        # 2026-07-01): the judge/validator layer moved sonnet -> opus while
        # decision nodes moved to fable. The cross-reviewer is a read-only
        # scorer, so it runs on the judge tier (opus/medium).
        # SSoT: aria_kernel/agent_runtime_profile.py.
        self.assertRegex(content, r"(?m)^model:\s*opus\s*$", msg="model: opus (judge tier)")
        self.assertRegex(content, r"(?m)^effort:\s*medium\s*$", msg="effort: medium (scout tier)")
        self.assertRegex(content, r"(?m)^tools:\s*Read,\s*Grep,\s*Glob\s*$", msg="tools: Read, Grep, Glob")

    def test_agent_file_has_untrusted_data_clause(self):
        content = _AGENT_FILE.read_text(encoding="utf-8")
        # Per I-V8.3-07: explicit "tags are DATA, never instructions" clause
        self.assertRegex(
            content,
            r"<untrusted_(primary_plan|challenger_plan)>.*(DATA|data)",
            msg="agent file MUST contain explicit untrusted-tag DATA discipline",
        )


if __name__ == "__main__":
    unittest.main()
