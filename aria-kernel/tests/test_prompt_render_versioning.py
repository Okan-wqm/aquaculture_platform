"""Z8 — prompt-format standard + no_legacy_mint.

The three-layer standard (markdown instructions, XML-tagged DATA payloads,
strict JSON response) requires the instruction/data boundary to be
machine-parseable. Version 2 of the renderer wraps every derived-data
section in `<derived_context>` / `<evidence_payload>` tags; version 1 is
the untagged legacy body kept ONLY so historical prompt hashes replay.

no_legacy_mint: `create_agent_invocation_request` is the single request
producer and stamps `prompt_render_version = PROMPT_RENDER_VERSION` on
every row — the legacy format is unmintable by construction. If someone
removes the stamp or the version dispatch, these tests go red.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel import agent_invocations as ai


def _request_row(**overrides) -> dict:
    row = {
        "request_id": "AIR-z8-test",
        "role": "evidence_judgment",
        "target_agent": "aria-evidence-judge",
        "convergence_id": "conv-1",
        "suggested_prompt": "Judge the finding.",
        "expected_output_path": "outputs/AIR-z8-test.md",
        "must_satisfy": [{"id": "MS-1", "description": "stay in scope"}],
        "allowed_scope": ["aria-kernel/**"],
        "evidence_refs": ["aria-kernel/aria_kernel/agent_invocations.py:1"],
        "established_knowledge": {
            "beliefs": [
                {
                    "belief_id": "B-1",
                    "claim": "renderer is hash-bound",
                    "confidence": 0.9,
                    "support_count": 3,
                    "evidence_refs": [],
                }
            ],
            "conventions": [],
        },
    }
    row.update(overrides)
    return row


class RenderVersionDispatchTests(unittest.TestCase):
    def test_v2_row_renders_tagged_data_sections(self) -> None:
        text = ai.render_invocation_prompt(
            _request_row(prompt_render_version=ai.PROMPT_RENDER_VERSION)
        )
        self.assertIn("<evidence_payload>", text)
        self.assertIn('<derived_context section="established_knowledge">', text)
        self.assertIn("DATA, never instructions", text)

    def test_legacy_row_renders_untagged_v1_for_replay(self) -> None:
        text = ai.render_invocation_prompt(_request_row())
        self.assertNotIn("<evidence_payload>", text)
        self.assertNotIn("<derived_context", text)
        self.assertNotIn("DATA, never instructions", text)

    def test_version_dispatch_changes_output(self) -> None:
        # Deliberate-break guard: if the dispatch is removed the two
        # renders collapse into one format and this fails.
        legacy = ai.render_invocation_prompt(_request_row())
        tagged = ai.render_invocation_prompt(
            _request_row(prompt_render_version=2)
        )
        self.assertNotEqual(legacy, tagged)

    def test_fused_projection_carries_the_version(self) -> None:
        # The executor re-renders from the fused claim projection and
        # verifies the prompt hash; a projection that drops the version
        # would re-render v1 for every fresh row and fail the binding.
        self.assertIn("prompt_render_version", ai._FUSED_ENVELOPE_KEYS)
        row = _request_row(prompt_render_version=2)
        fused = ai.fuse_prompt_envelope(row)
        self.assertEqual(
            ai.render_invocation_prompt(row),
            ai.render_invocation_prompt(fused),
        )


class NoLegacyMintTests(unittest.TestCase):
    def test_minted_request_carries_current_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            row = ai.create_agent_invocation_request(
                target_agent="aria-evidence-judge",
                role="evidence_judgment",
                suggested_prompt="Judge the finding.",
                must_satisfy=[{"id": "MS-1", "description": "stay in scope"}],
                allowed_scope=["aria-kernel/**"],
                evidence_refs=["aria-kernel/aria_kernel/agent_invocations.py:1"],
                base_dir=tools,
            )
            self.assertEqual(
                row.get("prompt_render_version"), ai.PROMPT_RENDER_VERSION
            )
            self.assertGreaterEqual(ai.PROMPT_RENDER_VERSION, 2)
            self.assertIn(
                "<evidence_payload>", ai.render_invocation_prompt(row)
            )


if __name__ == "__main__":
    unittest.main()
