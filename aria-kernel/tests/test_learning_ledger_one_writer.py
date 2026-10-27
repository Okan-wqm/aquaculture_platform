"""F1.1 — memory/learning-events.jsonl has one writer: ``memory.record_learning_event``.

WHY THIS EXISTS. The learning journal had three writers: ``memory`` (the private
``_record_learning_event``), ``goldset.propose_goldset`` and
``pr_tracking._mark_beliefs_for_revalidation``, the last two appending the row by
hand with a copy of the owner's field list (ARIA-LOW-732, ownership atlas family
``learning_log``). A ledger with three spellings of one row drifts the first time
one of them changes, and nothing stopped a fourth. PLAN-v2 §2 'Öğrenme günlüğü':
the owner is the public ``memory.record_learning_event`` with a CLOSED event-kind
vocabulary, the two copies call it, and a second writer is red in the one-owner
invariant (tests/invariants/test_atlas_one_owner.py, ``learning_log``).

THE API THIS PINS (new in F1.1; at the branch base ``record_learning_event`` does
not exist, so each test that needs it reports an assertion failure, not an import
error). The signature is the private function's, renamed:
  aria_kernel.memory.record_learning_event(root, *, cycle_id, event_type,
      target_type, target_id, repo_state_id, base_commit_sha, evidence_hashes,
      details=None) -> the stored row
  event kinds written today and so the whole vocabulary (nothing new):
      belief_proposed, belief_corrected, belief_confirmed, evidence_invalidated,
      goldset_promoted
  any other kind raises ``GovernanceError`` naming it, before anything is written.
The READERS apply no vocabulary: rows already on the ledger stay readable as they
are (no migration), whatever kind an older writer gave them.
"""
from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import goldset, memory, pr_tracking
from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.reflection import _render_learning_events_section
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SURFACE = "memory_learning_events"
_CHAIN_FIELDS = ("recorded_at", "ledger_hash", "previous_ledger_hash")
_KINDS = ("belief_proposed", "belief_corrected", "belief_confirmed", "evidence_invalidated", "goldset_promoted")
# Plausible next kinds, and the one the pre-vocabulary tests invented: none is written, so none is accepted.
_REFUSED = ("belief_recorded", "belief_withdrawn", "belief_decayed", "goldset_proposed", "evidence_revalidated",
            "Belief_Confirmed", "goldset_promoted ")
_OLD_NAME = "_record_learning_event"
_OLD_NAME_ROOTS = ("aria-kernel", "tools/aria-poc", "tools/aria")
_HASH = "sha256:" + "a" * 64
_SHA = "c" * 40


def _owner() -> Any:
    owner = getattr(memory, "record_learning_event", None)
    if owner is None:
        raise AssertionError("F1.1: aria_kernel.memory.record_learning_event (the one learning-ledger writer) does not exist")
    return owner


def _call(root: Path, event_type: str, **overrides: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "cycle_id": "cyc-f11", "event_type": event_type, "target_type": "belief", "target_id": "B-1",
        "repo_state_id": None, "base_commit_sha": None, "evidence_hashes": [],
    }
    return _owner()(root, **{**fields, **overrides})


def _rows(root: Path) -> list[dict[str, Any]]:
    path = root / "memory" / "learning-events.jsonl"
    return load_declared_jsonl(path, expected_surface=_SURFACE) if path.exists() else []


def _content(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if key not in _CHAIN_FIELDS}


class _Tools(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def routed_through_the_owner(self) -> mock.MagicMock:
        """The owner, wrapped, wherever a caller can hold it: ``memory.record_learning_event`` for a lookup at call
        time and the name bound in goldset or pr_tracking by ``from .memory import record_learning_event``."""
        spy = mock.MagicMock(wraps=_owner())
        for module in (memory, goldset, pr_tracking):
            if hasattr(module, "record_learning_event"):
                patcher = mock.patch.object(module, "record_learning_event", spy)
                patcher.start()
                self.addCleanup(patcher.stop)
        return spy


class TheOwnerHasAClosedVocabulary(_Tools):
    def test_every_kind_written_today_is_accepted(self) -> None:
        for kind in _KINDS:
            with self.subTest(kind=kind):
                self.assertEqual(_call(self.root, kind)["event_type"], kind)
        self.assertEqual([row["event_type"] for row in _rows(self.root)], list(_KINDS))

    def test_an_unknown_kind_is_refused_by_name_and_writes_nothing(self) -> None:
        for kind in _REFUSED:
            with self.subTest(kind=kind):
                with self.assertRaises(GovernanceError) as refused:
                    _call(self.root, kind)
                self.assertIn(kind, str(refused.exception))
        self.assertEqual(_rows(self.root), [])

    def test_an_empty_kind_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            _call(self.root, "")
        self.assertEqual(_rows(self.root), [])


class TheOwnerKeepsEveryExistingRow(_Tools):
    def test_a_row_has_the_fields_every_writer_gave_it(self) -> None:
        _call(self.root, "belief_confirmed", repo_state_id="rs-1", base_commit_sha=_SHA, evidence_hashes=[_HASH])
        _call(self.root, "belief_corrected", details={"status": "supported"})
        first, second = _rows(self.root)
        self.assertEqual(_content(first) | {"recorded_at": None}, {
            "schema_version": 1, "recorded_at": None, "cycle_id": "cyc-f11", "event_type": "belief_confirmed",
            "target_type": "belief", "target_id": "B-1", "repo_state_id": "rs-1", "base_commit_sha": _SHA,
            "evidence_hashes": [_HASH], "details": {},
        })
        self.assertEqual(second["details"], {"status": "supported"})

    def test_rows_written_before_the_vocabulary_stay_byte_identical_chained_and_readable(self) -> None:
        # Pre-F1.1 goldset shape, and a kind no writer gives today: the readers apply no vocabulary and nothing migrates.
        legacy = {
            "schema_version": 1, "recorded_at": "2026-09-01T00:00:00+00:00", "cycle_id": "cyc-old",
            "event_type": "belief_recorded", "target_type": "tool", "target_id": "tool-x", "repo_state_id": None,
            "base_commit_sha": None, "evidence_hashes": [], "details": {},
        }
        path = self.root / "memory" / "learning-events.jsonl"
        append_declared_jsonl(path, legacy, expected_surface=_SURFACE)
        before = path.read_bytes()
        _call(self.root, "belief_confirmed")
        self.assertTrue(path.read_bytes().startswith(before), "an existing row changed on disk")
        old, new = _rows(self.root)
        self.assertEqual(new["previous_ledger_hash"], old["ledger_hash"])
        rendered = "\n".join(_render_learning_events_section(self.root))
        self.assertIn("belief_recorded×1", rendered)
        self.assertIn("belief_confirmed×1", rendered)


class TheCallersRouteThroughTheOwnerAndWriteTheSameRows(_Tools):
    def test_goldset_promotion_calls_the_owner_and_keeps_its_row(self) -> None:
        for i in range(20):
            record_operator_feedback(tool_id="tool-x", run_id=f"tp{i}", finding_id=f"tp{i}", verdict="true_positive",
                                     severity="medium", note="gt", source_type="human", base_dir=self.root)
        for i in range(10):
            record_operator_feedback(tool_id="tool-x", run_id=f"fp{i}", finding_id=f"fp{i}", verdict="false_positive",
                                     severity="low", note="gt", source_type="human", base_dir=self.root)
        spy = self.routed_through_the_owner()
        self.assertEqual(goldset.propose_goldset(tool_id="tool-x", cycle_id="cyc-f11", base_dir=self.root)["status"], "ready")
        self.assertEqual([call.kwargs["event_type"] for call in spy.call_args_list], ["goldset_promoted"])
        (row,) = _rows(self.root)
        self.assertEqual(_content(row) | {"recorded_at": None}, {
            "schema_version": 1, "recorded_at": None, "cycle_id": "cyc-f11", "event_type": "goldset_promoted",
            "target_type": "tool", "target_id": "tool-x", "repo_state_id": None, "base_commit_sha": None,
            "evidence_hashes": [], "details": {"true_positive_count": 20, "known_false_positive_count": 10},
        })

    def test_a_blocked_goldset_proposal_writes_no_learning_row(self) -> None:
        spy = self.routed_through_the_owner()
        self.assertEqual(goldset.propose_goldset(tool_id="tool-x", base_dir=self.root)["status"], "blocked")
        spy.assert_not_called()
        self.assertEqual(_rows(self.root), [])

    def test_pr_tracking_revalidation_calls_the_owner_and_keeps_its_row(self) -> None:
        pr_tracking.append_jsonl(self.root / "memory" / "beliefs.jsonl", {
            "belief_id": "B-1", "claim": "c", "status": "supported", "evidence_refs": ["x.py"],
            "evidence_hashes": [_HASH], "repo_state_id": "rs-1", "base_commit_sha": _SHA,
        })
        spy = self.routed_through_the_owner()
        pr_tracking._mark_beliefs_for_revalidation(self.root, "cyc-f11", [{"belief_id": "B-1"}])
        self.assertEqual([call.kwargs["event_type"] for call in spy.call_args_list], ["evidence_invalidated"])
        (row,) = _rows(self.root)
        self.assertEqual(_content(row) | {"recorded_at": None}, {
            "schema_version": 1, "recorded_at": None, "cycle_id": "cyc-f11", "event_type": "evidence_invalidated",
            "target_type": "belief", "target_id": "B-1", "repo_state_id": "rs-1", "base_commit_sha": _SHA,
            "evidence_hashes": [_HASH], "details": {"reason": "PR or merge changed evidence reference"},
        })


class TheOldPrivateNameIsGoneEverywhere(unittest.TestCase):
    def test_no_module_or_test_names_the_private_writer(self) -> None:
        name = re.compile(rf"\b{_OLD_NAME}\b")
        hits = [
            f"{path.relative_to(_REPO_ROOT).as_posix()}:{number}"
            for root in _OLD_NAME_ROOTS for path in sorted((_REPO_ROOT / root).rglob("*.py")) if path != Path(__file__).resolve()
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1) if name.search(line)
        ]
        self.assertEqual(hits, [], "F1.1: every caller of the old private name is updated in the same commit")


if __name__ == "__main__":
    unittest.main()
