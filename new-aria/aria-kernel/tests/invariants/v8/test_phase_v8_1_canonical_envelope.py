"""Plan ARIA-V8.1 — canonical envelope pipeline invariants.

Closes Bug 4 surface (3 live ARIA runs all produced challenger envelopes
that bridge rejected with "plan content must be a JSON object"). The
fix has 3 structural anchors:

1. Planner agent .md files live at .claude/agents/ (runtime location),
   NOT in .claude/agents/_maintenance/ (which CLAUDE.md describes as
   "not dispatchable from runtime").
2. The agent prompts contain the canonical plan_content schema list
   (schema_version, title, summary, affected_surfaces, key_changes,
   validation_commands, evidence_refs) so the Opus model produces
   structurally-correct envelopes.
3. ``plan_convergence_bridge._canonicalize_challenger_payload`` wraps
   the agent's plan_content with kernel-state-derived metadata
   (source_revision_id, source_plan_content_hash) so
   ``_normalize_challenger_plan`` accepts the submission.
4. ``ci_executor._pre_submit_validate_envelope`` fails fast on agent
   schema drift BEFORE submit subprocess, releasing the claim with a
   precise reason instead of wasting an Opus cycle on a doomed submit.

Invariants:

- I-V8.1-01 — aria-primary-planner.md + aria-challenger-planner.md exist
  at .claude/agents/ runtime location.
- I-V8.1-02 — both agent .md files contain the canonical plan_content
  required-fields list in their prompt body.
- I-V8.1-03 — plan_convergence_bridge contains the
  _canonicalize_challenger_payload helper.
- I-V8.1-04 — ci_executor contains _pre_submit_validate_envelope helper
  + the _PLAN_CONTENT_REQUIRED tuple matching kernel canonical.
- I-V8.1-05 — _canonicalize_challenger_payload extracts plan_content
  from any of 4 known locations + falls back to kernel state for
  source metadata.
"""
from __future__ import annotations

import inspect
import sys
import unittest
from pathlib import Path
from unittest import mock

from . import _helpers  # noqa: F401

from aria_kernel import plan_convergence_bridge
# WS2 — the canonical plan_content required-field set is owned by the
# kernel (plan_convergence.PLAN_CONTENT_REQUIRED, the SSoT). This test
# used to carry its own CANONICAL_FIELDS literal — a 5th hardcoded copy
# that could silently drift from the kernel. We now import the kernel
# constant and iterate it, so the kernel is the ONE source.
from aria_kernel.plan_convergence import PLAN_CONTENT_REQUIRED


REPO_ROOT = Path(__file__).resolve().parents[4]
AGENTS_DIR = REPO_ROOT / ".claude" / "agents"


class TestCanonicalEnvelopePipeline(unittest.TestCase):

    def test_i_v8_1_01_planner_agents_at_runtime_location(self):
        """Both aria-primary-planner and aria-challenger-planner MUST
        live at .claude/agents/ (runtime), not at .claude/agents/_maintenance/.
        The drainer mints envelopes with these target_agent literals;
        claude CLI resolves to the runtime location only."""
        primary = AGENTS_DIR / "aria-primary-planner.md"
        challenger = AGENTS_DIR / "aria-challenger-planner.md"
        self.assertTrue(primary.exists(), f"missing: {primary}")
        self.assertTrue(challenger.exists(), f"missing: {challenger}")
        # AND must NOT be in _maintenance/ — promoted to runtime.
        self.assertFalse(
            (AGENTS_DIR / "_maintenance" / "aria-primary-planner.md").exists(),
            "aria-primary-planner.md must be promoted to runtime, not duplicated in _maintenance/",
        )
        self.assertFalse(
            (AGENTS_DIR / "_maintenance" / "aria-challenger-planner.md").exists(),
            "aria-challenger-planner.md must be promoted to runtime, not duplicated in _maintenance/",
        )

    def test_i_v8_1_02_agent_prompts_reference_canonical_knowledge(self):
        """Plan ARIA-V8.5 — the canonical plan_content schema lives in
        a shared knowledge file (single source of truth, DDD anti-
        corruption layer pattern). Agent prompts reference the
        knowledge file; the canonical seven fields are listed there.

        This invariant verifies BOTH halves of the V8.5 architecture:
        - Agent prompts MUST point at the knowledge file
        - Knowledge file MUST contain the canonical seven fields +
          plan_content top-level naming
        """
        knowledge_file = REPO_ROOT / ".claude" / "knowledge" / "layer-2-aria-canonical-envelope.md"
        self.assertTrue(
            knowledge_file.exists(),
            f"shared canonical envelope knowledge file missing at {knowledge_file}",
        )
        knowledge_content = knowledge_file.read_text(encoding="utf-8")
        for field in PLAN_CONTENT_REQUIRED:
            self.assertIn(
                field, knowledge_content,
                f"knowledge file MUST list canonical field {field!r}",
            )
        self.assertIn("plan_content", knowledge_content)

        # Each planner agent prompt references the knowledge file +
        # mentions plan_content as the relevant top-level key
        for agent_name in ("aria-primary-planner.md", "aria-challenger-planner.md"):
            with self.subTest(agent=agent_name):
                content = (AGENTS_DIR / agent_name).read_text(encoding="utf-8")
                self.assertIn(
                    "layer-2-aria-canonical-envelope.md", content,
                    f"{agent_name} prompt must reference the shared canonical envelope knowledge file",
                )
                self.assertIn(
                    "plan_content", content,
                    f"{agent_name} prompt must reference plan_content top-level key",
                )

    def test_i_v8_1_03_bridge_has_canonicalize_helper(self):
        """plan_convergence_bridge MUST have the
        _canonicalize_challenger_payload helper that wraps agent output
        with kernel-state-derived envelope metadata."""
        self.assertTrue(
            hasattr(plan_convergence_bridge, "_canonicalize_challenger_payload"),
            "_canonicalize_challenger_payload helper missing",
        )
        helper = plan_convergence_bridge._canonicalize_challenger_payload
        src = inspect.getsource(helper)
        # Must look up fold_plan_state for kernel state
        self.assertIn(
            "fold_plan_state", src,
            "_canonicalize_challenger_payload MUST fetch kernel state via fold_plan_state",
        )
        # Must extract plan_content from MULTIPLE known locations
        self.assertIn(
            'response.get("plan_content")', src,
            "_canonicalize_challenger_payload MUST honor top-level plan_content (V8.1 agent contract)",
        )

    def test_i_v8_1_04_ci_executor_has_validator_helper(self):
        """tools/aria-poc/ci_executor.py MUST have
        _pre_submit_validate_envelope + _PLAN_CONTENT_REQUIRED tuple
        that mirrors the kernel canonical schema.

        WS2 strengthens this beyond a static literal scan: ci_executor's
        RUNTIME `_PLAN_CONTENT_REQUIRED` MUST equal the kernel SSoT
        constant (PLAN_CONTENT_REQUIRED). This proves ci_executor mirrors
        the kernel — not merely that it happens to contain the same
        string literals somewhere in its source."""
        ci_path = REPO_ROOT / "tools" / "aria-poc" / "ci_executor.py"
        src = ci_path.read_text(encoding="utf-8")
        self.assertIn(
            "_pre_submit_validate_envelope", src,
            "ci_executor MUST define _pre_submit_validate_envelope",
        )
        self.assertIn(
            "_PLAN_CONTENT_REQUIRED", src,
            "ci_executor MUST define _PLAN_CONTENT_REQUIRED tuple",
        )
        for field in PLAN_CONTENT_REQUIRED:
            self.assertIn(
                f'"{field}"', src,
                f"ci_executor _PLAN_CONTENT_REQUIRED MUST include {field!r}",
            )
        # The validator must be wired into the submit path (called
        # before the subprocess.run)
        self.assertIn(
            "_pre_submit_validate_envelope(", src,
            "_pre_submit_validate_envelope MUST be called from the dispatch path",
        )
        # WS2 — runtime mirror proof: import ci_executor and assert its
        # active _PLAN_CONTENT_REQUIRED equals the kernel SSoT constant.
        # ci_executor imports PLAN_CONTENT_REQUIRED from the kernel in its
        # try-block (with an identical literal fallback); this assertion
        # is the live drift guard for that import.
        ci_tools_dir = REPO_ROOT / "tools" / "aria-poc"
        if str(ci_tools_dir) not in sys.path:
            sys.path.insert(0, str(ci_tools_dir))
        import ci_executor  # noqa: PLC0415 — repo-path import, intentional
        self.assertEqual(
            tuple(ci_executor._PLAN_CONTENT_REQUIRED),
            tuple(PLAN_CONTENT_REQUIRED),
            "ci_executor._PLAN_CONTENT_REQUIRED MUST mirror the kernel "
            "SSoT plan_convergence.PLAN_CONTENT_REQUIRED exactly (same "
            "fields, same order).",
        )

    def test_i_v8_1_05_canonicalize_extracts_from_known_locations(self):
        """_canonicalize_challenger_payload MUST locate plan_content
        across 4 known agent output shapes + fall back to kernel state
        for source_revision_id + source_plan_content_hash."""
        canonical_pc = {
            "schema_version": 1,
            "title": "test",
            "summary": "test summary",
            "affected_surfaces": [{"paths": ["a.py"]}],
            "key_changes": ["change A"],
            "validation_commands": [{"cmd": "echo"}],
            "evidence_refs": ["a.py:1"],
        }
        kernel_state = {
            "latest_revision": {
                "revision_id": "rev-primary-001",
                "content_hash": "sha256:abc",
            }
        }

        shapes = [
            # Case A: top-level response.plan_content (V8.1 agent contract)
            {"response_extra": {"plan_content": canonical_pc}, "details": {}},
            # Case B: details.challenger.plan_content (kernel canonical)
            {"response_extra": {}, "details": {"challenger": {"plan_content": canonical_pc}}},
            # Case C: details.plan.plan_content (alt nesting)
            {"response_extra": {}, "details": {"plan": {"plan_content": canonical_pc}}},
            # Case D: details.plan_content (semi-canonical)
            {"response_extra": {}, "details": {"plan_content": canonical_pc}},
        ]
        for idx, shape in enumerate(shapes):
            with self.subTest(case=chr(ord("A") + idx)):
                response = {"request_id": "AIR-x-c2f18a9f", "agent_id": "aria-challenger-planner"}
                response.update(shape["response_extra"])
                with mock.patch(
                    "aria_kernel.plan_convergence.fold_plan_state",
                    return_value=kernel_state,
                ):
                    out = plan_convergence_bridge._canonicalize_challenger_payload(
                        response=response,
                        details=shape["details"],
                        plan_id="plan-test",
                        base_dir=None,
                    )
                self.assertEqual(out["plan_content"], canonical_pc, f"case {idx}: plan_content not extracted")
                self.assertEqual(out["source_revision_id"], "rev-primary-001")
                self.assertEqual(out["source_plan_content_hash"], "sha256:abc")
                self.assertTrue(out["challenger_revision_id"].startswith("chal-plan-test-"))


if __name__ == "__main__":
    unittest.main()
