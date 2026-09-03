"""Plan ARIA-V10.4 Phase 3.H.10 — primary plan revision canonicalizer invariants.

Closes F-021 (cycle 4 round-2 primary accepted at agent_invocations
layer but kernel bridge fold failed with
``agent_bridge_warning: revision_id must be a non-empty string``).

The bug class:

V8.1 introduced ``_canonicalize_challenger_payload`` to wrap agent's
``plan_content`` into the kernel revision contract — synthesizing
``source_revision_id``, ``source_plan_content_hash`` etc. from
authoritative ``plan_convergence`` state. The PRIMARY revision
dispatch (round-2+ revision after cross-review verdict) was missing
the equivalent canonicalizer: ``record_plan_result`` at
plan_convergence_bridge.py:192-198 (pre-fix) passed
``details.revision or details.plan or details`` directly to
``record_revision``, which calls ``_validate_revision`` requiring
revision_id + round + content + content_hash + parent_revision_hash.

Those fields are kernel-state-derived (parent_revision_hash =
latest_revision.content_hash; round = current_round; revision_id =
synthesized from plan_id+round+request_id). The agent has no read
access to kernel state — any agent-supplied value is structurally
untrustworthy. The fix is the kernel-side canonicalizer that mirrors
the challenger pattern.

Tier-1 architectural fix: add ``_canonicalize_revision_payload`` in
plan_convergence_bridge.py and route the record_revision dispatch
through it. The agent keeps emitting just ``plan_content``; the
kernel does the metadata synthesis. Same architectural shape as
_canonicalize_challenger_payload — no new abstraction, no new
contract, just contract symmetry.

Tier-3 layer (this file): make the symmetry detectable so the next
role-revision pair that arrives (e.g. specialist-review) inherits the
same canonicalizer discipline.

Invariants:

- I-V10.4-3.H.10-01 — ``_canonicalize_revision_payload`` exists in
  plan_convergence_bridge and is callable.
- I-V10.4-3.H.10-02 — the canonicalizer reads kernel state via
  ``fold_plan_state`` (does NOT trust agent-supplied
  parent_revision_hash without falling back to kernel value when
  absent).
- I-V10.4-3.H.10-03 — the canonicalizer produces every field
  ``_validate_revision`` requires (revision_id, round, content,
  content_hash, parent_revision_hash).
- I-V10.4-3.H.10-04 — record_plan_result dispatches ``record_revision``
  through the canonicalizer, not by passing raw details to
  ``record_revision`` directly.
"""
from __future__ import annotations

import hashlib
import inspect
import unittest
from pathlib import Path
from unittest import mock

from . import _helpers  # noqa: F401

from aria_kernel import plan_convergence_bridge


class PrimaryRevisionCanonicalizerInvariants(unittest.TestCase):
    """Plan ARIA-V10.4 Phase 3.H.10 — F-021 closure invariants."""

    def test_i_v10_4_3_h_10_01_canonicalizer_exists(self):
        """The primary-revision canonicalizer must exist on the bridge module.

        Symmetry with _canonicalize_challenger_payload: both planner
        roles need a kernel-state-aware payload wrapper so the agent
        contract stays narrow (plan_content only) and the kernel owns
        revision metadata synthesis.
        """
        self.assertTrue(
            hasattr(plan_convergence_bridge, "_canonicalize_revision_payload"),
            (
                "I-V10.4-3.H.10-01: plan_convergence_bridge must expose "
                "_canonicalize_revision_payload (mirror of "
                "_canonicalize_challenger_payload). Closing F-021 requires "
                "the symmetric primary-revision canonicalizer."
            ),
        )
        self.assertTrue(
            callable(getattr(plan_convergence_bridge, "_canonicalize_revision_payload", None)),
            "I-V10.4-3.H.10-01: _canonicalize_revision_payload must be callable.",
        )

    def test_i_v10_4_3_h_10_02_canonicalizer_reads_kernel_state(self):
        """The canonicalizer must call fold_plan_state to get authoritative metadata.

        The agent has no kernel-state read access. Any agent-supplied
        parent_revision_hash or current_round value MUST be ignored in
        favour of kernel state to prevent state-rewrite via response
        crafting. The canonicalizer source must reference
        ``fold_plan_state`` to satisfy this property.
        """
        src = inspect.getsource(plan_convergence_bridge._canonicalize_revision_payload)
        self.assertIn(
            "fold_plan_state",
            src,
            (
                "I-V10.4-3.H.10-02: _canonicalize_revision_payload must call "
                "fold_plan_state to read authoritative kernel revision "
                "metadata. Synthesizing kernel state from agent-supplied "
                "values would open a state-rewrite vector."
            ),
        )
        self.assertIn(
            "latest_revision",
            src,
            (
                "I-V10.4-3.H.10-02: _canonicalize_revision_payload must "
                "derive parent_revision_hash from state['latest_revision']."
            ),
        )

    def test_i_v10_4_3_h_10_03_canonicalizer_emits_all_required_fields(self):
        """The canonicalizer's return must include every _validate_revision field.

        The kernel validator _validate_revision (plan_convergence.py:1721)
        requires revision_id + round + content + content_hash +
        parent_revision_hash, all non-empty. The canonicalizer's source
        must demonstrably emit all five keys.
        """
        src = inspect.getsource(plan_convergence_bridge._canonicalize_revision_payload)
        for field in (
            "revision_id",
            "round",
            "content",
            "content_hash",
            "parent_revision_hash",
        ):
            # Each field MUST appear as a dict key in the return statement.
            # We check by string match — the return literal is the only
            # place in the function body where the contract is shaped.
            self.assertIn(
                f'"{field}"',
                src,
                (
                    f"I-V10.4-3.H.10-03: _canonicalize_revision_payload must "
                    f"emit '{field}' in its return dict — the kernel's "
                    f"_validate_revision requires it non-empty. F-021 was "
                    f"caused by the pre-fix dispatch path skipping "
                    f"revision_id synthesis."
                ),
            )

    def test_i_v10_4_3_h_10_04_record_plan_result_routes_through_canonicalizer(self):
        """record_plan_result must dispatch record_revision via the canonicalizer.

        The fix is structural: the bridge's record_revision handler
        path MUST go through _canonicalize_revision_payload. A raw
        ``details.revision or details`` fallback would recreate F-021.
        """
        src = inspect.getsource(plan_convergence_bridge.record_plan_result)
        self.assertIn(
            "_canonicalize_revision_payload",
            src,
            (
                "I-V10.4-3.H.10-04: record_plan_result must call "
                "_canonicalize_revision_payload on the record_revision "
                "dispatch arm. Raw `details.revision or details` passthrough "
                "to record_revision recreates F-021."
            ),
        )

    def test_i_v10_4_3_h_10_05_canonicalizer_synthesizes_id_when_agent_omits(self):
        """End-to-end smoke: agent omits revision_id → canonicalizer synthesizes.

        Exercises the canonicalizer with a minimal agent response
        (plan_content only, no wrapper). Asserts the output dict has
        non-empty revision_id + content + content_hash and the
        kernel-state-derived parent_revision_hash.
        """
        fake_state = {
            "state": "CROSS_REVIEWED",
            "current_round": 1,
            "latest_revision": {
                "revision_id": "rev-fake-r1-initial",
                "content_hash": "sha256:abc123",
            },
        }
        agent_response = {
            "request_id": "AIR-test-agent-fe21a000",
            "agent_id": "aria-primary-planner",
            "role": "primary_plan",
            "plan_content": {
                "schema_version": 1,
                "title": "test",
                "summary": "test",
                "affected_surfaces": [{"paths": ["a.py"]}],
                "key_changes": ["k1"],
                "validation_commands": [{"cmd": "true"}],
                "evidence_refs": ["a.py:1"],
            },
        }
        # fold_plan_state is locally imported inside the canonicalizer
        # (cycle-avoidance pattern shared with _canonicalize_challenger_payload).
        # Patch at the source module so the in-function import resolves
        # to the mock.
        from aria_kernel import plan_convergence
        with mock.patch.object(
            plan_convergence,
            "fold_plan_state",
            return_value=fake_state,
        ):
            payload = plan_convergence_bridge._canonicalize_revision_payload(
                response=agent_response,
                details={},
                plan_id="plan-fake",
                base_dir=None,
            )
        self.assertTrue(payload["revision_id"], "I-V10.4-3.H.10-05: revision_id synthesis")
        self.assertEqual(payload["round"], 1, "I-V10.4-3.H.10-05: round from kernel state")
        self.assertTrue(payload["content"], "I-V10.4-3.H.10-05: content non-empty")
        self.assertTrue(payload["content_hash"].startswith("sha256:"), "I-V10.4-3.H.10-05: content_hash hashed")
        self.assertEqual(
            payload["parent_revision_hash"],
            "sha256:abc123",
            "I-V10.4-3.H.10-05: parent_revision_hash from kernel latest_revision",
        )


if __name__ == "__main__":
    unittest.main()
