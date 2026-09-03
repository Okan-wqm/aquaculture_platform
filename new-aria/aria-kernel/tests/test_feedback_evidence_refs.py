"""Plan 022 C-1 — feedback derive_pressure must populate evidence_refs.

Pre-Plan-022 derive_pressure() collected `refs` from pressure_items[*].refs
but wrote `"evidence_refs": []` to the pressure event row, breaking the
operator feedback → pressure → triage → impact dispatch loop.

This suite pins the fix:
1. evidence_refs == sorted(unique refs) — path/ref-string type.
2. feedback_event_ids == sorted(source feedback event_id set) — FB-... ID-string type.
3. The two lists carry DIFFERENT types (refs are file/path strings; event_ids are
   FB-... identifiers); the v1 audit's "intersection ≥1" assertion was wrong
   because intersection between path-strings and event-id-strings is structurally
   empty on real data.
4. pressure_evidence_fingerprint API structurally excludes evidence_refs (only
   primitive + subtype + feedback_event_ids), so adding evidence_refs to the
   row body is idempotent — Plan 016 history fingerprints unchanged.
"""
from __future__ import annotations

import argparse
import inspect
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback import (
    add_feedback,
    build_feedback_event,
    pressure_evidence_fingerprint,
)
from aria_kernel.pressure import list_workspace_pressures
from aria_kernel.workspace import ensure_workspace, workspace_paths


def _args(**overrides) -> argparse.Namespace:
    defaults = {
        "kind": "unknown_capability",
        "summary": "summary",
        "ref": "apps/api/src/app.ts",
        "concept": "concept",
        "source": "operator",
        "surface": None,
        "failure_mode": None,
        "parser_kind": None,
        "capability_gap_key": None,
        "evidence_ref": [],
    }
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


class _FeedbackTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.workspace_base = Path(self.tmp.name) / "workspaces"
        self.paths = workspace_paths(self.repo, self.workspace_base)
        ensure_workspace(self.paths)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _emit(self, *, kind: str, ref: str, gap_key: str = "backend:schema_drift:ts") -> None:
        event = build_feedback_event(
            _args(kind=kind, ref=ref, summary=f"{kind} on {ref}",
                  capability_gap_key=gap_key),
        )
        add_feedback(self.paths, event)


class EvidenceRefsPopulationTests(_FeedbackTestCase):
    def test_unknown_capability_pressure_carries_evidence_refs(self) -> None:
        # ≥3 unknown_capability + ≥3 unique refs satisfies derive_pressure's
        # UNKNOWN/repeated_unknown_capability gate (3-threshold).
        for ref in ("apps/x/foo.ts:1", "apps/x/foo.ts:42", "apps/y/bar.ts:7"):
            self._emit(kind="unknown_capability", ref=ref)
        rows = list_workspace_pressures(self.paths)
        self.assertEqual(len(rows), 1)
        evt = rows[0]
        # Plan 022 C-1: evidence_refs MUST be populated with the unique refs.
        self.assertEqual(
            sorted(evt["evidence_refs"]),
            sorted({"apps/x/foo.ts:1", "apps/x/foo.ts:42", "apps/y/bar.ts:7"}),
        )

    def test_missed_signal_pressure_carries_evidence_refs(self) -> None:
        for ref in ("docs/a.md:5", "docs/b.md:9", "docs/c.md:11"):
            self._emit(kind="missed_signal", ref=ref)
        rows = list_workspace_pressures(self.paths)
        rep_rows = [r for r in rows if r.get("primitive") == "REPETITION"]
        self.assertEqual(len(rep_rows), 1)
        self.assertEqual(
            sorted(rep_rows[0]["evidence_refs"]),
            sorted({"docs/a.md:5", "docs/b.md:9", "docs/c.md:11"}),
        )

    def test_false_positive_pressure_carries_evidence_refs(self) -> None:
        for ref in ("apps/p/q.ts:2", "apps/p/q.ts:16", "apps/r/s.ts:3"):
            self._emit(kind="false_positive", ref=ref)
        rows = list_workspace_pressures(self.paths)
        contradictions = [
            r for r in rows
            if r.get("primitive") == "CONTRADICTION"
            and r.get("subtype") == "repeated_false_positive"
        ]
        self.assertEqual(len(contradictions), 1)
        self.assertEqual(
            sorted(contradictions[0]["evidence_refs"]),
            sorted({"apps/p/q.ts:2", "apps/p/q.ts:16", "apps/r/s.ts:3"}),
        )


class EvidenceRefsTypeSeparationTests(_FeedbackTestCase):
    """Audit-correction: evidence_refs and feedback_event_ids carry DIFFERENT
    types. v1 audit's "intersection ≥1" assertion was structurally wrong.
    """

    def test_evidence_refs_are_path_strings_event_ids_are_fe_strings(self) -> None:
        for ref in ("apps/x/foo.ts:1", "apps/x/foo.ts:42", "apps/y/bar.ts:7"):
            self._emit(kind="unknown_capability", ref=ref)
        rows = list_workspace_pressures(self.paths)
        evt = next(r for r in rows if r.get("primitive") == "UNKNOWN")

        # evidence_refs: every entry contains a path separator and is NOT
        # a feedback event_id.
        for ref in evt["evidence_refs"]:
            self.assertIn("/", ref, f"evidence_ref must look like a path: {ref!r}")
            self.assertFalse(
                ref.startswith("FB-"),
                f"evidence_ref must NOT be an event_id: {ref!r}",
            )

        # feedback_event_ids: every entry starts with FB- prefix.
        for eid in evt["feedback_event_ids"]:
            self.assertTrue(
                eid.startswith("FB-"),
                f"feedback_event_id must start with FB-: {eid!r}",
            )

        # Intersection on real data is structurally empty (different types).
        # This pins the audit-correction.
        self.assertEqual(
            set(evt["evidence_refs"]) & set(evt["feedback_event_ids"]),
            set(),
        )


class FingerprintIdempotenceTests(unittest.TestCase):
    """pressure_evidence_fingerprint must NOT depend on evidence_refs.
    Adding evidence_refs to the row body keeps Plan 016 history fingerprints
    idempotent — no migration needed.
    """

    def test_fingerprint_excludes_evidence_refs(self) -> None:
        primitive, subtype = "UNKNOWN", "repeated_unknown_capability"
        event_ids = ["FB-event-1", "FB-event-2", "FB-event-3"]
        fp1 = pressure_evidence_fingerprint(primitive, subtype, event_ids)
        fp2 = pressure_evidence_fingerprint(primitive, subtype, event_ids)
        self.assertEqual(fp1, fp2)
        # API contract: function does not even accept evidence_refs.
        sig = inspect.signature(pressure_evidence_fingerprint)
        self.assertNotIn("evidence_refs", sig.parameters)


if __name__ == "__main__":
    unittest.main()
