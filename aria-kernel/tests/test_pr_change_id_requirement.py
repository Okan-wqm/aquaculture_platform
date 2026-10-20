"""Plan 026R §D.3 — PR change_id requirement + reverse lookup.

4 tests:

* open_pr_for_action(dry_run=False, change_id=None) → raise.
* change_id persists on pr-lifecycle row when provided.
* change_for_pr(pr_number) reverse-lookup resolves.
* cycle pr_lifecycle phase forward (dry_run=True, no change_id, OK
  — the dry-run preview path does not require change_id).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.auto_merge import change_for_pr, record_pr_lifecycle
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.operator_acts import operator_set_profile


class PRChangeIdRequirementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-d3-"))
        self.base = self.tmp / "aria-tools"
        operator_set_profile("strict", base_dir=self.base)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_change_id_required_for_non_dry_run(self) -> None:
        from aria_kernel.pr_manager import open_pr_for_action
        # The function checks change_id BEFORE other validations when
        # dry_run is False. Use mock so we don't need the full proposal
        # state machine.
        with patch(
            "aria_kernel.pr_manager.get_proposal",
            return_value={"proposal_id": "p-d3", "title": "t"},
        ):
            with self.assertRaises(GovernanceError) as ctx:
                open_pr_for_action(
                    proposal_id="p-d3",
                    workspace_root=self.tmp,
                    base_dir=self.base,
                    dry_run=False,
                    change_id=None,
                )
            self.assertIn("open_pr_change_id_required", str(ctx.exception))

    def test_change_id_persists_on_pr_lifecycle_row(self) -> None:
        # Test record_pr_lifecycle's change_id passthrough directly so
        # we don't need the full open_pr_for_action gh-subprocess path.
        pr_payload = {
            "number": 42,
            "head_sha": "abc1234",
            "base_branch": "main",
            "change_id": "ch-d3",
            "proposal_id": "p-d3",
        }
        row = record_pr_lifecycle(
            pr_payload, event="opened", base_dir=self.base,
        )
        self.assertEqual(row["change_id"], "ch-d3")

    def test_change_for_pr_reverse_lookup_resolves(self) -> None:
        pr_payload = {
            "number": 99,
            "head_sha": "deadbeef",
            "base_branch": "main",
            "change_id": "ch-reverse-99",
            "proposal_id": "p-d3",
        }
        record_pr_lifecycle(pr_payload, event="opened", base_dir=self.base)
        resolved = change_for_pr(99, base_dir=self.base)
        self.assertEqual(resolved, "ch-reverse-99")
        # Missing PR returns None.
        self.assertIsNone(change_for_pr(1000, base_dir=self.base))

    def test_dry_run_preview_no_change_id_ok(self) -> None:
        # Dry-run preview path does not require change_id. The cycle
        # pr_lifecycle phase (cycle.py:638) uses this path to build
        # PR bodies without committing to a specific change anchor.
        from aria_kernel.pr_manager import open_pr_for_action
        # We expect the change_id guard NOT to raise; downstream
        # state (proposal lookup, action validation) may still fail
        # but the §D.3 guard does not.
        with patch(
            "aria_kernel.pr_manager.get_proposal",
            return_value={"proposal_id": "p-d3", "title": "t"},
        ):
            try:
                open_pr_for_action(
                    proposal_id="p-d3",
                    workspace_root=self.tmp,
                    base_dir=self.base,
                    dry_run=True,
                    change_id=None,
                )
            except GovernanceError as exc:
                self.assertNotIn(
                    "open_pr_change_id_required", str(exc),
                    "dry-run preview should NOT require change_id",
                )


# merge-delivery-1 (ARIA-HIGH-521) — the fields that bind a PR to ARIA's
# change. Only the rows that name the PR as ARIA's (`opened`, `pr_dry_run`)
# carry them; every other row writes them null.
_BINDING_FIELDS = ("task_id", "proposal_id", "assignment_id", "change_id")
_DELIVERED = "d" * 40
_UPDATED = "e" * 40


class ObservationsCannotBindTests(unittest.TestCase):
    """merge-delivery-1 — a PR is bound to its change by the row that opened it, never by an observation.

    The merge lane appends ``record_pr_lifecycle(pr, event="observed")`` on
    every evaluation, from GitHub's payload. That row used to copy any binding
    field the payload carried and was the row the pre-merge perimeter read
    last, so GitHub's payload (no ``change_id``) unbound every ARIA PR and a
    payload carrying one re-bound it.
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-md1-"))
        self.base = self.tmp / "aria-tools"
        operator_set_profile("strict", base_dir=self.base)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _rows(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.tool_registry import ensure_tools_dir

        path = ensure_tools_dir(self.base) / "pr-lifecycle.jsonl"
        return load_declared_jsonl(path, expected_surface="pr_lifecycle") if path.exists() else []

    def _open(self, number: int, change_id: str, *, proposal_id: str = "p-opener") -> dict:
        return record_pr_lifecycle(
            {"number": number, "head_sha": _DELIVERED, "base_branch": "main", "change_id": change_id,
             "proposal_id": proposal_id, "task_id": "t-opener", "merge_route": {"human_merge": True}},
            event="opened", base_dir=self.base, assignment_id="asg-opener",
        )

    def test_an_observation_cannot_carry_or_change_a_binding(self) -> None:
        self._open(51, "chg-opener")
        observed = record_pr_lifecycle(
            {"number": 51, "head_sha": _UPDATED, "base_branch": "main", "change_id": "chg_forged",
             "proposal_id": "p-forged", "task_id": "t-forged", "assignment_id": "asg-forged",
             "merge_route": {"human_merge": False}},
            event="observed", base_dir=self.base,
        )
        persisted = self._rows()[-1]
        for row in (observed, persisted):
            self.assertEqual({field: row[field] for field in _BINDING_FIELDS}, dict.fromkeys(_BINDING_FIELDS))
            self.assertNotIn("merge_route", row)
            # What GitHub observed is still recorded.
            self.assertEqual((row["event"], row["pr_number"], row["head_sha"]), ("observed", 51, _UPDATED))
        self.assertEqual(change_for_pr(51, base_dir=self.base), "chg-opener")

    def test_a_legacy_observation_carrying_a_change_does_not_bind_the_pr(self) -> None:
        # A row the pre-fix writer left: an observation that copied a change_id
        # from its payload. The triple gate's reader (change_for_pr) keeps the
        # change the PR was opened for.
        from aria_kernel.tool_registry import ensure_tools_dir
        from tests._helpers.declared_fixtures import append_declared_fixture

        self._open(56, "chg-opener")
        append_declared_fixture(
            ensure_tools_dir(self.base) / "pr-lifecycle.jsonl",
            {"schema_version": 1, "recorded_at": "2026-10-16T00:00:00Z", "event": "observed", "pr_number": 56,
             "head_sha": _UPDATED, "base_branch": "main", "change_id": "chg-legacy-observation"},
            expected_surface="pr_lifecycle",
        )
        self.assertEqual(change_for_pr(56, base_dir=self.base), "chg-opener")

    def test_the_event_is_required_and_its_vocabulary_is_closed(self) -> None:
        with self.assertRaises(TypeError):
            record_pr_lifecycle({"number": 52, "change_id": "c"}, base_dir=self.base)  # type: ignore[call-arg]
        with self.assertRaisesRegex(ValueError, r"^pr_lifecycle_event_unknown:pr_open$"):
            record_pr_lifecycle({"number": 52, "change_id": "c"}, event="pr_open", base_dir=self.base)
        # A caller's explicit binding on a row that binds nothing is refused, not dropped.
        with self.assertRaisesRegex(ValueError, r"^pr_lifecycle_binding_on_non_binding_event:observed$"):
            record_pr_lifecycle({"number": 52}, event="observed", base_dir=self.base, assignment_id="asg-x")
        self.assertEqual(self._rows(), [])
        # The owned terminal events keep their one writer (ARIA-HIGH-390).
        with self.assertRaisesRegex(GovernanceError, "has_one_writer"):
            record_pr_lifecycle({"number": 52}, event="merged", base_dir=self.base)

    def test_the_binding_is_the_latest_opened_row_of_the_pr(self) -> None:
        from aria_kernel.merge_record import pr_change_binding

        opened = self._open(53, "chg-A", proposal_id="p-A")
        record_pr_lifecycle({"number": 53, "head_sha": _UPDATED, "base_branch": "main"},
                            event="observed", base_dir=self.base)
        binding = pr_change_binding(self._rows(), pr_number=53)
        self.assertEqual(binding.row["ledger_hash"], opened["ledger_hash"])
        self.assertEqual((binding.change_id, binding.proposal_id, binding.delivered_head_sha, binding.base_branch,
                          binding.bound_change_ids), ("chg-A", "p-A", _DELIVERED, "main", ("chg-A",)))
        self.assertIsNone(pr_change_binding(self._rows(), pr_number=54))
        # A value that is not a PR number names no PR: never "any PR's" binding
        # (None) and never PR 1's (True == 1).
        self._open(1, "chg-pr-one")
        for not_a_number in (None, True):
            self.assertIsNone(pr_change_binding(self._rows(), pr_number=not_a_number))  # type: ignore[arg-type]
        # A second opened row naming another change: the latest names the
        # change, and every change ever bound stays visible to the readers
        # that refuse an ambiguous PR.
        self._open(53, "chg-B", proposal_id="p-B")
        rebound = pr_change_binding(self._rows(), pr_number=53)
        self.assertEqual((rebound.change_id, rebound.proposal_id, rebound.bound_change_ids),
                         ("chg-B", "p-B", ("chg-A", "chg-B")))
        self.assertEqual(change_for_pr(53, base_dir=self.base), "chg-B")

    def test_the_reverted_suite_reads_the_proposal_the_pr_was_opened_for(self) -> None:
        # The self-revert producer re-runs the reverted change's suite under
        # the ceiling of the proposal the PR was opened for: the opened row's
        # binding, never a later row's (a row written before observations
        # were made unable to bind could carry another proposal).
        from aria_kernel.self_revert import _reverted_suite
        from aria_kernel.tool_registry import ensure_tools_dir
        from tests._helpers.declared_fixtures import append_declared_fixture

        self._open(55, "chg-reverted", proposal_id="p-opened-for")
        append_declared_fixture(
            ensure_tools_dir(self.base) / "pr-lifecycle.jsonl",
            {"schema_version": 1, "recorded_at": "2026-10-16T00:00:00Z", "event": "observed", "pr_number": 55,
             "head_sha": _UPDATED, "base_branch": "main", "proposal_id": "p-legacy-observation"},
            expected_surface="pr_lifecycle",
        )
        with patch("aria_kernel.implementation_delivery._staged_suite",
                   return_value=(["npm test"], 1234)) as staged:
            commands, timeout_ms = _reverted_suite({"change_id": "chg-reverted"}, pr_number=55, base_dir=self.base)
        staged.assert_called_once_with(proposal_id="p-opened-for", base_dir=self.base)
        self.assertEqual((commands, timeout_ms), ([], 1234))


if __name__ == "__main__":
    unittest.main()
