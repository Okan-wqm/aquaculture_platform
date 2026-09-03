"""Plan ARIA-V3.1-A — plan source mining wire invariants.

Closes 6-validator audit findings:

* C-5 (ORPHAN body injection): every external-source string in
  plan_content runs through `sanitize_untrusted_text` BEFORE landing
  in the convergence prompt.
* H-2 (iterative fallback): V9PressureSourceProvider visits ALL
  ranked candidates before delegating to V7 git_diff.
* H-8 (envelope/content split): `_pressure_source_type` lives in
  envelope.metadata, NOT in plan_content (content_hash unchanged
  semantics).
* H-14 (fail-fast under autonomous): empty V9.4 candidate set under
  `profile == "autonomous"` raises GovernanceError instead of
  silently falling to V7.

Invariants:

* I-V31-A-01 — V9PressureSourceProvider.synthesize is callable +
  iterates 5-source candidate ranking.
* I-V31-A-02 — convert_candidate_to_plan_content handles all 4
  non-git_diff PlanCandidateSource values + invokes
  sanitize_untrusted_text on every external-source string field.
* I-V31-A-03 — CyclePlanEnvelope is a frozen dataclass with
  content + metadata separation.
* I-V31-A-04 — plan_content (envelope.content) does NOT include
  _pressure_source_type key.
* I-V31-A-05 — iterative candidate loop visits all candidates
  before V7 fallback (behavioral test with mock [None, None, valid]).
* I-V31-A-06 — V7 fallback under autonomous profile RAISES.
* I-V31-A-07 — V7GitDiffProvider sets metadata['_pressure_source_type']
  = 'git_diff'.
* I-V31-A-08 — governance event 'plan_candidate_conversion_skipped'
  emitted per skipped candidate.
* I-V31-A-09 — the hard-refuse/soft-fall branch is DERIVED from
  ACTION_PERMISSIONS['pr_merge'] (ORPHAN-HIGH-728), and the soft-fall
  emits 'plan_source_v7_fallback_engaged' so the substitution is visible
  to the reviewer of the PR a proposal-class profile may open.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from dataclasses import is_dataclass, fields
from pathlib import Path
from unittest.mock import patch


class CyclePlanEnvelopeShapeTests(unittest.TestCase):
    """Plan ARIA-V3.1-A — envelope/content split invariant."""

    def test_i_v31_a_03_envelope_is_frozen_dataclass_with_content_and_metadata(self) -> None:
        from aria_kernel.cycle_phases import CyclePlanEnvelope
        self.assertTrue(is_dataclass(CyclePlanEnvelope))
        # Frozen — assigning to fields raises FrozenInstanceError.
        env = CyclePlanEnvelope(content={"x": 1}, metadata={"y": 2})
        with self.assertRaises(Exception):
            env.content = {}  # type: ignore[misc]
        # Exactly content + metadata fields.
        names = {f.name for f in fields(CyclePlanEnvelope)}
        self.assertEqual(names, {"content", "metadata"})


class ConvertCandidateToPlanContentTests(unittest.TestCase):
    """Plan ARIA-V3.1-A — candidate-to-envelope conversion."""

    def test_i_v31_a_02_handles_all_four_source_types(self) -> None:
        """Plan ARIA-V3.1-A-2 — every PlanCandidateSource except
        GIT_DIFF (which goes through V7 fallback) yields a valid
        CyclePlanEnvelope on the canonical candidate shape."""
        from aria_kernel.plan_candidate_source import PlanCandidateSource
        from aria_kernel.plan_synthesizer import convert_candidate_to_plan_content
        cases = [
            {
                "source_type": PlanCandidateSource.OPERATOR_FEEDBACK.value,
                "candidate_id": "op-1",
                "priority": "high",
                "request": "Add invariant for X",
                "authored_at": "2026-05-19T00:00:00Z",
                "signature_kid": "kid-1",
                "title_hint": "Operator request op-1",
            },
            {
                "source_type": PlanCandidateSource.FAILING_CI.value,
                "candidate_id": "ci-run-12345",
                "workflow_name": "ci-affected",
                "head_sha": "abc123def456",
                "title_hint": "Fix failing CI workflow 'ci-affected'",
            },
            {
                "source_type": PlanCandidateSource.ORPHAN_FINDING.value,
                "candidate_id": "ORPHAN-HIGH-099",
                "severity": "HIGH",
                "raw_id": "099",
                "title_hint": "Address ORPHAN-HIGH-099",
            },
            {
                "source_type": PlanCandidateSource.F_FINDING.value,
                "candidate_id": "F-099",
                "mtime": 1000.0,
                "path": "/tmp/aria-findings/F-099.json",
                "title_hint": "Process aging F-finding F-099",
            },
        ]
        for case in cases:
            envelope = convert_candidate_to_plan_content(case)
            self.assertIsNotNone(envelope,
                                 f"conversion None for {case['source_type']!r}")
            assert envelope is not None  # type narrow for mypy
            # content has all 7 required fields.
            for field in (
                "schema_version", "title", "summary", "affected_surfaces",
                "key_changes", "validation_commands", "evidence_refs",
            ):
                self.assertIn(field, envelope.content,
                              f"{case['source_type']}: missing {field}")
            # metadata threading.
            self.assertEqual(
                envelope.metadata.get("_pressure_source_type"),
                case["source_type"],
            )
            self.assertEqual(
                envelope.metadata.get("_candidate_id"), case["candidate_id"],
            )

    def test_i_v31_a_02_sanitize_applied_to_external_strings(self) -> None:
        """Plan ARIA-V3.1-A-2 closing C-5: external-source strings
        with adversarial payloads (HTML, bidi, control chars) emerge
        sanitized in plan_content fields."""
        from aria_kernel.plan_candidate_source import PlanCandidateSource
        from aria_kernel.plan_synthesizer import convert_candidate_to_plan_content
        attack = "innocent <script>alert('xss')</script>"
        candidate = {
            "source_type": PlanCandidateSource.OPERATOR_FEEDBACK.value,
            "candidate_id": "op-attack",
            "priority": "high",
            "request": attack,
            "authored_at": "2026-05-19T00:00:00Z",
            "signature_kid": "kid-attack",
            "title_hint": attack,
        }
        env = convert_candidate_to_plan_content(candidate)
        self.assertIsNotNone(env)
        assert env is not None
        # < / > stripped via HTML-encode.
        self.assertNotIn("<script>", env.content["title"])
        self.assertNotIn("<script>", env.content["summary"])

    def test_i_v31_a_04_plan_content_omits_pressure_source_type(self) -> None:
        """Plan ARIA-V3.1-A-4 — plan_content dict (envelope.content)
        does NOT carry `_pressure_source_type` (closes H-8 content_hash
        pollution)."""
        from aria_kernel.plan_candidate_source import PlanCandidateSource
        from aria_kernel.plan_synthesizer import convert_candidate_to_plan_content
        env = convert_candidate_to_plan_content({
            "source_type": PlanCandidateSource.ORPHAN_FINDING.value,
            "candidate_id": "ORPHAN-HIGH-1",
            "severity": "HIGH",
            "raw_id": "1",
            "title_hint": "Test",
        })
        self.assertIsNotNone(env)
        assert env is not None
        self.assertNotIn("_pressure_source_type", env.content)
        # But metadata DOES carry it.
        self.assertIn("_pressure_source_type", env.metadata)


class V9PressureSourceProviderTests(unittest.TestCase):
    """Plan ARIA-V3.1-A — V9PressureSourceProvider iteration + fail-fast."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="v31a-")).resolve()
        self.base = self.tmp / "aria-tools"
        self.base.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_i_v31_a_01_v9_provider_is_callable(self) -> None:
        """Plan ARIA-V3.1-A-1 — V9PressureSourceProvider instantiates
        + responds to .synthesize() with a CyclePlanEnvelope-or-None
        return type. Behavioral specifics (which source wins) are
        covered by tests 5/6/8.
        """
        from aria_kernel.cycle_phases import (
            CyclePlanEnvelope, V9PressureSourceProvider,
        )
        provider = V9PressureSourceProvider()
        # Empty ranked list (forced via patch) → V7 fallback fires;
        # V7 against the empty test workspace returns None.
        with patch(
            "aria_kernel.plan_synthesizer.rank_candidate_sources",
            return_value=[],
        ):
            result = provider.synthesize(
                cycle_id="cyc-test",
                workspace_root=self.tmp,
                base_dir=self.base,
                profile="standard",
            )
        # None OR a CyclePlanEnvelope — both shapes are protocol-valid.
        self.assertTrue(
            result is None or isinstance(result, CyclePlanEnvelope),
            f"synthesize must return Envelope | None, got {type(result)!r}",
        )

    def test_i_v31_a_05_iterative_loop_visits_all_candidates(self) -> None:
        """Plan ARIA-V3.1-A-5 — when 2 candidates yield None and the
        3rd yields a valid envelope, the provider returns the 3rd.

        Pre-V3.1-A behavior: fell back to V7 immediately on first
        None. The fix iterates the full ranked list before falling
        back."""
        from aria_kernel.cycle_phases import (
            CyclePlanEnvelope, V9PressureSourceProvider,
        )
        provider = V9PressureSourceProvider()
        valid_env = CyclePlanEnvelope(
            content={
                "schema_version": 1,
                "title": "valid",
                "summary": "ok",
                "affected_surfaces": ["x.py"],
                "key_changes": [{"id": "k1", "description": "d", "paths": ["x.py"]}],
                "validation_commands": [{"cmd": "echo", "timeout_ms": 1000, "expected_exit": 0}],
                "evidence_refs": ["x.py:1"],
            },
            metadata={"_pressure_source_type": "operator_feedback"},
        )
        call_count = [0]
        def fake_convert(candidate):
            call_count[0] += 1
            if call_count[0] >= 3:
                return valid_env
            return None
        with patch(
            "aria_kernel.plan_synthesizer.rank_candidate_sources",
            return_value=[
                {"candidate_id": "a", "source_type": "orphan_finding"},
                {"candidate_id": "b", "source_type": "f_finding"},
                {"candidate_id": "c", "source_type": "operator_feedback"},
            ],
        ), patch(
            "aria_kernel.plan_synthesizer.convert_candidate_to_plan_content",
            side_effect=fake_convert,
        ):
            result = provider.synthesize(
                cycle_id="cyc-iter",
                workspace_root=self.tmp,
                base_dir=self.base,
                profile="standard",
            )
        self.assertEqual(call_count[0], 3)
        self.assertEqual(
            result.metadata["_pressure_source_type"], "operator_feedback",
        )

    def test_i_v31_a_06_autonomous_no_candidates_raises(self) -> None:
        """Plan ARIA-V3.1-A-6 — under profile=autonomous, when ALL
        candidates fail conversion the provider raises GovernanceError
        instead of silently falling to V7."""
        from aria_kernel.cycle_phases import V9PressureSourceProvider
        from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
        ensure_tools_dir(self.base)
        provider = V9PressureSourceProvider()
        with patch(
            "aria_kernel.plan_synthesizer.rank_candidate_sources",
            return_value=[
                {"candidate_id": "a", "source_type": "orphan_finding"},
            ],
        ), patch(
            "aria_kernel.plan_synthesizer.convert_candidate_to_plan_content",
            return_value=None,
        ):
            with self.assertRaises(GovernanceError) as ctx:
                provider.synthesize(
                    cycle_id="cyc-auto",
                    workspace_root=self.tmp,
                    base_dir=self.base,
                    profile="autonomous",
                )
        self.assertIn(
            "v9_4_source_conversion_failed_for_all_candidates",
            str(ctx.exception),
        )

    def test_i_v31_a_09_fallback_hardness_is_read_from_the_action_table(self) -> None:
        """I-V31-A-09 (ORPHAN-HIGH-728) — WHICH profiles hard-refuse a
        substituted plan source comes from `ACTION_PERMISSIONS["pr_merge"]`,
        not from the literal `"autonomous"`.

        The distinction the branch encodes is landing authority, not name: a
        profile that can merge its own work has no reviewer between it and
        `main`, so it must refuse a plan it did not select. A profile that can
        only PROPOSE falls through, and the substitution reaches a human on
        the pull request — which only works if the fall is DECLARED, so the
        governance row is part of the contract too.

        Proven by moving the cell: granting `strict` `pr_merge` in the table
        alone must flip strict from soft-fall to refusal, with no edit here or
        in `plan_source`.
        """
        from aria_kernel.cycle_phases import V9PressureSourceProvider
        from aria_kernel.runtime_profile import ACTION_PERMISSIONS
        from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

        ensure_tools_dir(self.base)
        provider = V9PressureSourceProvider()

        def _synthesize(profile: str):
            with patch(
                "aria_kernel.plan_synthesizer.rank_candidate_sources",
                return_value=[{"candidate_id": "a", "source_type": "orphan_finding"}],
            ), patch(
                "aria_kernel.plan_synthesizer.convert_candidate_to_plan_content",
                return_value=None,
            ), patch(
                "aria_kernel.plan_synthesizer.synthesize_plan_content_from_cycle",
                return_value={
                    "schema_version": 1,
                    "title": "v7-diff",
                    "summary": "auto-discovered",
                    "problem_statement": "p",
                    "proposed_changes": [],
                    "risks": [],
                    "acceptance_criteria": [],
                },
            ):
                return provider.synthesize(
                    cycle_id="cyc-derived",
                    workspace_root=self.tmp,
                    base_dir=self.base,
                    profile=profile,
                )

        # Proposal-class today: soft-fall, and the fall is on the record.
        self.assertIsNotNone(_synthesize("strict"))
        rows = [
            json.loads(line)
            for line in (self.base / "governance.jsonl").read_text(
                encoding="utf-8",
            ).splitlines() if line.strip()
        ]
        declared = [
            row for row in rows
            if row.get("kind") == "plan_source_v7_fallback_engaged"
        ]
        self.assertEqual(len(declared), 1, "a silent substitution is the defect")
        self.assertEqual(declared[0]["details"]["profile"], "strict")

        # Move the cell; the branch must follow it.
        widened = dict(ACTION_PERMISSIONS)
        widened["pr_merge"] = frozenset({"strict", "autonomous"})
        with patch("aria_kernel.runtime_profile.ACTION_PERMISSIONS", widened):
            with self.assertRaises(GovernanceError) as ctx:
                _synthesize("strict")
        self.assertIn(
            "v9_4_source_conversion_failed_for_all_candidates", str(ctx.exception),
        )

    def test_i_v31_a_07_v7_fallback_sets_git_diff_pressure_source(self) -> None:
        """Plan ARIA-V3.1-A-7 — V7GitDiffProvider lifts its plan_content
        into a CyclePlanEnvelope with metadata='_pressure_source_type=
        git_diff'."""
        from aria_kernel.cycle_phases import V7GitDiffProvider
        provider = V7GitDiffProvider()
        with patch(
            "aria_kernel.plan_synthesizer.synthesize_plan_content_from_cycle",
            return_value={
                "schema_version": 1,
                "title": "v7-diff",
                "summary": "auto-discovered",
                "affected_surfaces": ["a.py"],
                "key_changes": [{"id": "k1", "description": "d", "paths": ["a.py"]}],
                "validation_commands": [{"cmd": "echo", "timeout_ms": 1000, "expected_exit": 0}],
                "evidence_refs": ["a.py:1"],
            },
        ):
            env = provider.synthesize(
                cycle_id="cyc-v7",
                workspace_root=self.tmp,
                base_dir=self.base,
                profile="standard",
            )
        self.assertIsNotNone(env)
        assert env is not None
        self.assertEqual(env.metadata["_pressure_source_type"], "git_diff")

    def test_i_v31_a_08_governance_event_emitted_per_skip(self) -> None:
        """Plan ARIA-V3.1-A-8 — each skipped candidate emits a
        `plan_candidate_conversion_skipped` governance event so the
        operator audit trail surfaces iteration history."""
        from aria_kernel.cycle_phases import V9PressureSourceProvider
        from aria_kernel.tool_registry import ensure_tools_dir
        ensure_tools_dir(self.base)
        provider = V9PressureSourceProvider()
        with patch(
            "aria_kernel.plan_synthesizer.rank_candidate_sources",
            return_value=[
                {"candidate_id": "skip-a", "source_type": "orphan_finding"},
                {"candidate_id": "skip-b", "source_type": "f_finding"},
            ],
        ), patch(
            "aria_kernel.plan_synthesizer.convert_candidate_to_plan_content",
            return_value=None,
        ):
            provider.synthesize(
                cycle_id="cyc-skip",
                workspace_root=self.tmp,
                base_dir=self.base,
                profile="standard",  # not autonomous; falls to V7
            )
        gov_path = self.base / "governance.jsonl"
        self.assertTrue(gov_path.exists())
        rows = [
            json.loads(line) for line in
            gov_path.read_text(encoding="utf-8").splitlines() if line.strip()
        ]
        skip_events = [
            r for r in rows
            if r.get("kind") == "plan_candidate_conversion_skipped"
        ]
        self.assertEqual(len(skip_events), 2)
        skipped_ids = {e["details"]["candidate_id"] for e in skip_events}
        self.assertEqual(skipped_ids, {"skip-a", "skip-b"})


if __name__ == "__main__":
    unittest.main()
