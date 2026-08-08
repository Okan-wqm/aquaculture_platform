"""The gold corpus finally has both of its declared consumers.

`replay_judges_on_goldset` and `compute_replay_recall` have existed since Plan
025 §C and were called by nothing but their own unit tests. The module answers
the only honest version of "are the judges still any good" — does a judge get a
verdict right on a finding it has never seen — and no cycle, CLI verb or
workflow ever asked it. The comment on `goldset_proposal` even states that the
corpus it mints "is what judge_replay scores judges against"; the phase that
would do the scoring simply never existed.

These tests pin the wiring, and equally pin what it must NOT do: mint work on a
platform that has promoted no corpus, and fail a cycle when a replay breaks.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel.goldset import list_active_goldset_tool_ids


def _context(base_dir: str):
    """A real PhaseContext, built the way the cycle builds one.

    Constructing the dataclass by hand would pin a field list this test does
    not care about and would break every time a phase gains a new input.
    """
    return cycle_mod.build_phase_context(
        cycle_id="cyc-judge-replay",
        workspace_root=Path(base_dir),
        base_dir=Path(base_dir),
    )


def _write_active_goldset(root: Path, tool_id: str, items: list[dict]) -> None:
    active = root / "goldsets" / "active"
    active.mkdir(parents=True, exist_ok=True)
    (active / f"{tool_id}.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "status": "active",
                "tool_id": tool_id,
                "curator": "operator",
                "true_positive_items": items,
                "known_false_positive_items": [],
            },
            indent=2,
        ),
        encoding="utf-8",
    )


class JudgeReplayPhaseTest(unittest.TestCase):
    def test_phase_is_registered_after_the_corpus_that_feeds_it(self) -> None:
        names = [p.name for p in cycle_mod.CYCLE_PHASES]

        self.assertIn("judge_replay", names)
        # Order is the point: it scores judges against the corpus the previous
        # phase mints, so running it first would score against yesterday's.
        self.assertLess(names.index("goldset_proposal"), names.index("judge_replay"))

    def test_phase_records_its_result_and_never_fails_the_cycle(self) -> None:
        phase = next(p for p in cycle_mod.CYCLE_PHASES if p.name == "judge_replay")

        self.assertEqual(phase.state_key, "judge_replay")
        # A replay that crashed measured nothing. It must not take down a cycle
        # whose real work succeeded — the same reasoning goldset_proposal uses.
        self.assertEqual(phase.on_error, "record_and_continue")
        self.assertEqual(phase.precondition, cycle_mod.WRITES_PERMITTED)

    def test_mints_nothing_when_no_corpus_has_been_promoted(self) -> None:
        # Promotion is an operator act. On a platform where nobody has promoted
        # a corpus, this phase must be a recorded no-op rather than a surprise
        # bill: it should not even reach the judge fan-out.
        with TemporaryDirectory() as tmp:
            context = _context(tmp)
            with patch.object(cycle_mod, "replay_judges_on_goldset") as replay:
                result = cycle_mod._phase_judge_replay(context)

            replay.assert_not_called()
            self.assertEqual(result["active_goldset_tools"], [])
            self.assertEqual(result["minted_total"], 0)

    def test_replays_every_tool_that_has_a_promoted_corpus(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_active_goldset(root, "tool-a", [{"run_id": "r1", "finding_id": "f1"}])
            _write_active_goldset(root, "tool-b", [{"run_id": "r2", "finding_id": "f2"}])

            context = _context(tmp)
            with patch.object(
                cycle_mod,
                "replay_judges_on_goldset",
                return_value={"status": "dispatched", "replayed_items": 1, "minted": [{"request_id": "x"}]},
            ) as replay:
                with patch.object(cycle_mod, "compute_replay_recall", return_value={"judges": []}):
                    result = cycle_mod._phase_judge_replay(context)

            replayed = sorted(call.kwargs["tool_id"] for call in replay.call_args_list)
            self.assertEqual(replayed, ["tool-a", "tool-b"])
            self.assertEqual(result["minted_total"], 2)

    def test_reports_recall_alongside_the_dispatch(self) -> None:
        # Dispatching envelopes is not the deliverable; the recall number is.
        # A phase that only minted work would leave the question unanswered.
        with TemporaryDirectory() as tmp:
            context = _context(tmp)
            with patch.object(cycle_mod, "compute_replay_recall", return_value={"status": "insufficient_evidence"}):
                result = cycle_mod._phase_judge_replay(context)

            self.assertEqual(result["recall"], {"status": "insufficient_evidence"})


class ActiveGoldsetListingTest(unittest.TestCase):
    def test_reads_the_tool_id_from_the_record_not_the_filename(self) -> None:
        # `_safe_tool_id` sanitises names on the way in, so parsing the filename
        # back would be a second, lossy copy of that mapping.
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            active = root / "goldsets" / "active"
            active.mkdir(parents=True)
            (active / "sanitised-name.json").write_text(
                json.dumps({"tool_id": "scope/real name", "status": "active"}), encoding="utf-8"
            )

            self.assertEqual(list_active_goldset_tool_ids(base_dir=tmp), ["scope/real name"])

    def test_one_unreadable_corpus_does_not_hide_the_others(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            active = root / "goldsets" / "active"
            active.mkdir(parents=True)
            (active / "broken.json").write_text("{not json", encoding="utf-8")
            (active / "good.json").write_text(json.dumps({"tool_id": "tool-b"}), encoding="utf-8")

            self.assertEqual(list_active_goldset_tool_ids(base_dir=tmp), ["tool-b"])

    def test_returns_empty_when_nothing_was_ever_promoted(self) -> None:
        with TemporaryDirectory() as tmp:
            self.assertEqual(list_active_goldset_tool_ids(base_dir=tmp), [])


if __name__ == "__main__":
    unittest.main()
