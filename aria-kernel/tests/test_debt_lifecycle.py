"""ARIA-LOW-605 — the debt lifecycle is kernel-enforced (CONTRACTS §6.6).

Every status after OPEN on a committed aria-debts/*.json was a hand edit the
kernel's event ledger never saw: debt.py wrote exactly one event
(``debt_emitted``), replay applied exactly that event, no path moved a debt
to IN_PROGRESS/RESOLVED/WITHDRAWN, nothing ever derived OVERDUE, and the
consumers (reflection, cycle_guard, surface_manifest_validator,
handoff_ledger) each kept a private copy of the status vocabulary — one that
read a field index rows do not even carry (``status`` vs ``current_status``).

These tests run at the real entries: ``emit_debt``/``transition_debt``/
``import_committed_debts``/``show_debt``/``list_debts`` in a seeded repo,
``cycle_guard._open_debt_count`` over its own index, reflection's
filesystem scan, the surface validator, the handoff projection, and the
``python -m aria_kernel debt …`` CLI verbs. The committed production corpus
(the six aria-debts/*.json in this repository, imported into a temp state
root via ARIA_REPO_STATE_ROOT so the checkout is never written) is the
fixture for the drift invariant.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel.debt import (
    UNRESOLVED_DEBT_STATUSES,
    effective_debt_status,
    emit_debt,
    import_committed_debts,
    is_unresolved_debt,
    list_debts,
    show_debt,
    transition_debt,
)
from aria_kernel.finding import emit_finding
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMITTED_DEBTS_DIR = REPO_ROOT / "aria-debts"
PAST_DUE = "2026-07-06T07:37:04Z"  # frozen past due date, same shape as the committed corpus


def _hermetic_env() -> dict[str, str]:
    """Every GIT_* variable dropped (HANDOVER §2: the worktree GIT_DIR leak)."""
    return {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, env=_hermetic_env())


def _seed_repo() -> Path:
    """A temp repo that looks like the production checkout for emit_*."""
    tmp = Path(tempfile.mkdtemp(prefix="aria-debt-lifecycle-"))
    for i in range(1, 4):
        path = tmp / "apps" / "farm-service" / "src" / "database" / "migrations" / f"000{i}-create.ts"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(f"line {n}" for n in range(1, 45)) + "\n", encoding="utf-8")
    _git(tmp, "init", "-q")
    _git(tmp, "config", "user.email", "aria-test@example.com")
    _git(tmp, "config", "user.name", "ARIA Test")
    _git(tmp, "add", "apps")
    _git(tmp, "commit", "-q", "-m", "seed evidence")
    workspace_base = tmp / "workspaces"
    paths = workspace_paths(tmp, workspace_base)
    ensure_workspace(paths)
    ensure_tools_dir(tmp / "aria-tools")
    return tmp


def _good_evidence(n: int = 2) -> list[dict[str, object]]:
    return [
        {"ref": f"apps/farm-service/src/database/migrations/000{i}-create.ts:42", "summary": f"migration {i}"}
        for i in range(1, n + 1)
    ]


def _future_due(days: int = 30) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _emit_one(repo: Path, *, due: str | None = None, severity: str = "MEDIUM") -> tuple[Path, Path, dict]:
    tools = repo / "aria-tools"
    finding = emit_finding(
        repo_root=repo,
        base_dir=tools,
        claim_type="duplication",
        claim_summary="three migrations share boilerplate",
        severity="LOW",
        evidences=_good_evidence(3),
        facts=["a", "b", "c"],
        scope_files=["m1.ts", "m2.ts", "m3.ts"],
    )
    debt = emit_debt(
        repo_root=repo,
        base_dir=tools,
        originating_finding_id=finding["finding_id"],
        root_cause_summary="Migration generator copies the column-add block verbatim across three files",
        short_term_action={
            "kind": "test_added",
            "ref": "apps/farm-service/src/database/migrations/0001-create.ts:1",
            "rationale": "Regression test asserts the three migrations produce identical AST nodes",
        },
        permanent_fix_required="Extract shared column-add helper and have each migration call it",
        permanent_fix_owner="platform-data-team",
        due_date=due or _future_due(80),
        severity=severity,
    )
    return tools, finding, debt


def _committed_debt_ids() -> list[str]:
    return sorted(p.name[: -len(".json")] for p in COMMITTED_DEBTS_DIR.glob("DEBT-*.json"))


class TempRepoTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)


class CommittedCorpusImportTests(unittest.TestCase):
    """`debt import-committed` replays the six committed aria-debts/*.json
    into the (temp) state-root ledger; the replay must reproduce each
    committed document's lifecycle exactly, and a second run must append
    nothing (the two copies cannot drift)."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-debt-state-")
        self.state_root = Path(self._tmp.name)
        # A private tools root under the temp state root: no shared/global
        # aria-tools is read or written by these tests.
        self.tools = self.state_root / "aria-tools"
        self.tools.mkdir(parents=True, exist_ok=True)
        self.env = mock.patch.dict(
            os.environ, {"ARIA_REPO_STATE_ROOT": str(self.state_root)}
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self._tmp.cleanup)

    def test_import_reproduces_every_committed_status_history(self) -> None:
        summary = import_committed_debts(repo_root=REPO_ROOT, base_dir=self.tools)
        self.assertEqual(summary["debts"], _committed_debt_ids())
        for debt_id in _committed_debt_ids():
            committed = json.loads(
                (COMMITTED_DEBTS_DIR / f"{debt_id}.json").read_text(encoding="utf-8")
            )
            replayed = show_debt(REPO_ROOT, debt_id)
            self.assertEqual(
                replayed["current_status"],
                committed["current_status"],
                debt_id,
            )
            self.assertEqual(
                replayed["status_history"],
                committed["status_history"],
                debt_id,
            )
            self.assertEqual(
                replayed.get("withdrawn_reason"),
                committed.get("withdrawn_reason"),
                debt_id,
            )
            self.assertEqual(
                replayed.get("resolved_by_commit"),
                committed.get("resolved_by_commit"),
                debt_id,
            )

    def test_second_import_appends_nothing(self) -> None:
        import_committed_debts(repo_root=REPO_ROOT, base_dir=self.tools)
        events_path = self.state_root / "aria-debts" / "debt-events.jsonl"
        first = events_path.read_bytes()
        summary = import_committed_debts(repo_root=REPO_ROOT, base_dir=self.tools)
        self.assertEqual(summary["appended_events"], 0)
        self.assertEqual(events_path.read_bytes(), first)

    def test_in_progress_past_due_lists_as_overdue(self) -> None:
        # DEBT-2026-05-07-001 is the production shape: IN_PROGRESS by a
        # commit hand edit, due 2026-07-06, no kernel event ever moved it.
        import_committed_debts(repo_root=REPO_ROOT, base_dir=self.tools)
        rows = {r["debt_id"]: r for r in list_debts(REPO_ROOT)}
        row = rows["DEBT-2026-05-07-001"]
        self.assertEqual(row["current_status"], "IN_PROGRESS")
        self.assertEqual(row["effective_status"], "OVERDUE")
        doc = show_debt(REPO_ROOT, "DEBT-2026-05-07-001")
        self.assertEqual(effective_debt_status(doc), "OVERDUE")
        self.assertTrue(is_unresolved_debt(doc))
        self.assertEqual(UNRESOLVED_DEBT_STATUSES, ("OPEN", "IN_PROGRESS", "OVERDUE"))


class DerivedOverdueConsumerTests(unittest.TestCase):
    """The overdue debt never leaves any consumer's open count."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-debt-consumers-")
        self.repo = Path(self._tmp.name)
        debts = self.repo / "aria-debts"
        debts.mkdir(parents=True)
        # A committed-shape corpus: OPEN not due, IN_PROGRESS past due
        # (the DEBT-2026-05-07-001 shape), a hand-edited stored-OVERDUE row,
        # a RESOLVED row and a WITHDRAWN row.
        for debt_id, status, due, extra in (
            ("DEBT-2026-10-01-001", "OPEN", _future_due(30), {}),
            ("DEBT-2026-10-01-002", "IN_PROGRESS", PAST_DUE, {}),
            ("DEBT-2026-10-01-003", "OVERDUE", PAST_DUE, {}),
            ("DEBT-2026-10-01-004", "RESOLVED", PAST_DUE, {}),
            (
                "DEBT-2026-10-01-005",
                "WITHDRAWN",
                PAST_DUE,
                {"withdrawn_reason": "Operator withdrew it: the platform pivot removed the surface"},
            ),
        ):
            (debts / f"{debt_id}.json").write_text(
                json.dumps(
                    {
                        "$schema": "aria/architectural-debt/v1",
                        "debt_id": debt_id,
                        "current_status": status,
                        "due_date": due,
                        "status_history": [{"status": status, "at": "2026-10-01T00:00:00Z", "by": "manual:operator"}],
                        **extra,
                    }
                ),
                encoding="utf-8",
            )
        (debts / "_index.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "debts": [
                        {"debt_id": d, "current_status": s, "due_date": due, "path": f"{d}.json"}
                        for d, s, due, _extra in (
                            ("DEBT-2026-10-01-001", "OPEN", _future_due(30), {}),
                            ("DEBT-2026-10-01-002", "IN_PROGRESS", PAST_DUE, {}),
                            ("DEBT-2026-10-01-003", "OVERDUE", PAST_DUE, {}),
                            ("DEBT-2026-10-01-004", "RESOLVED", PAST_DUE, {}),
                            ("DEBT-2026-10-01-005", "WITHDRAWN", PAST_DUE, {}),
                        )
                    ],
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_cycle_guard_open_count_includes_overdue(self) -> None:
        from aria_kernel.cycle_guard import _open_debt_count

        self.assertEqual(_open_debt_count(self.repo), 3)

    def test_reflection_scan_counts_overdue_open_and_loud(self) -> None:
        from aria_kernel.reflection import _scan_debts_filesystem

        pivot = _scan_debts_filesystem(self.repo / "aria-debts")
        self.assertEqual(pivot["total"], 5)
        self.assertEqual(pivot["open"], 3)
        self.assertEqual(pivot["overdue"], 2)

    def test_handoff_open_debts_excludes_closed_and_names_the_status(self) -> None:
        from aria_kernel.handoff_ledger import _open_debts

        rows = _open_debts(self.repo)
        self.assertEqual(
            sorted(r["debt_id"] for r in rows),
            ["DEBT-2026-10-01-001", "DEBT-2026-10-01-002", "DEBT-2026-10-01-003"],
        )
        by_id = {r["debt_id"]: r for r in rows}
        self.assertEqual(by_id["DEBT-2026-10-01-002"]["status"], "OVERDUE")
        self.assertEqual(by_id["DEBT-2026-10-01-001"]["status"], "OPEN")

    def test_surface_validator_flags_closed_debt_cited_as_open(self) -> None:
        from aria_kernel.surface_manifest_validator import validate_plan_doc_freshness

        plans = self.repo / "docs" / "aria" / "plans"
        plans.mkdir(parents=True)
        (plans / "p1.md").write_text(
            "DEBT-2026-10-01-004 stays in progress until the helper lands.\n"
            "DEBT-2026-10-01-005 stays open per the old plan.\n",
            encoding="utf-8",
        )
        failures = validate_plan_doc_freshness(repo_root=self.repo)
        flagged = {f["debt_id"] for f in failures}
        self.assertIn("DEBT-2026-10-01-004", flagged)
        self.assertIn("DEBT-2026-10-01-005", flagged)


class TransitionModelTests(TempRepoTestCase):
    def test_open_to_in_progress_by_commit_ref(self) -> None:
        _, _, debt = _emit_one(self.repo)
        debt_id = debt["debt_id"]
        updated = transition_debt(
            repo_root=self.repo,
                base_dir=self.tools,
            debt_id=debt_id,
            to_status="IN_PROGRESS",
            by="commit:afd590368",
        )
        self.assertEqual(updated["current_status"], "IN_PROGRESS")
        self.assertEqual(
            [h["status"] for h in updated["status_history"]],
            ["OPEN", "IN_PROGRESS"],
        )
        self.assertEqual(updated["status_history"][1]["by"], "commit:afd590368")
        # The ledger — not the JSON edit — carries it now.
        events = [
            json.loads(line)
            for line in (self.repo / "aria-debts" / "debt-events.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(
            [e["event"] for e in events],
            ["debt_emitted", "debt_status_changed"],
        )
        self.assertEqual(show_debt(self.repo, debt_id)["current_status"], "IN_PROGRESS")

    def test_open_to_in_progress_refuses_anonymous_actor(self) -> None:
        _, _, debt = _emit_one(self.repo)
        with self.assertRaisesRegex(GovernanceError, "operator act or a commit ref"):
            transition_debt(
                repo_root=self.repo,
                base_dir=self.tools, debt_id=debt["debt_id"], to_status="IN_PROGRESS", by="someone"
            )

    def test_resolved_requires_merge_sha_and_reverified_chain(self) -> None:
        _, finding, debt = _emit_one(self.repo)
        debt_id = debt["debt_id"]
        transition_debt(repo_root=self.repo, base_dir=self.tools, debt_id=debt_id, to_status="IN_PROGRESS", by="commit:afd590368")
        with self.assertRaisesRegex(GovernanceError, "fix_merge_sha"):
            transition_debt(
                repo_root=self.repo,
                base_dir=self.tools, debt_id=debt_id, to_status="RESOLVED", by="manual:operator"
            )
        with self.assertRaisesRegex(GovernanceError, "40-hex"):
            transition_debt(
                repo_root=self.repo,
                base_dir=self.tools,
                debt_id=debt_id,
                to_status="RESOLVED",
                by="manual:operator",
                fix_merge_sha="not-a-sha",
            )
        # The originating finding's evidence chain must still be there.
        events_path = self.repo / "aria-findings" / "finding-events.jsonl"
        saved_events = events_path.read_bytes()
        for path in (self.repo / "aria-findings").glob("F-*.json"):
            path.unlink()
        events_path.write_text("", encoding="utf-8")
        with self.assertRaisesRegex(GovernanceError, "originating finding"):
            transition_debt(
                repo_root=self.repo,
                base_dir=self.tools,
                debt_id=debt_id,
                to_status="RESOLVED",
                by="manual:operator",
                fix_merge_sha="a" * 40,
            )
        events_path.write_bytes(saved_events)
        updated = transition_debt(
            repo_root=self.repo,
                base_dir=self.tools,
            debt_id=debt_id,
            to_status="RESOLVED",
            by="manual:operator",
            fix_merge_sha="b" * 40,
        )
        self.assertEqual(updated["current_status"], "RESOLVED")
        self.assertEqual(updated["resolved_by_commit"], "b" * 40)
        self.assertTrue(updated.get("resolved_at"))
        self.assertEqual(
            updated["originating_finding_evidence_chain_id"],
            finding["evidence_chain_id"],
        )

    def test_resolved_to_open_is_refused(self) -> None:
        _, _, debt = _emit_one(self.repo)
        debt_id = debt["debt_id"]
        transition_debt(repo_root=self.repo, base_dir=self.tools, debt_id=debt_id, to_status="RESOLVED", by="manual:operator", fix_merge_sha="c" * 40)
        with self.assertRaisesRegex(GovernanceError, "illegal debt transition"):
            transition_debt(repo_root=self.repo, base_dir=self.tools, debt_id=debt_id, to_status="OPEN", by="manual:operator")

    def test_replay_refuses_a_forged_backwards_event(self) -> None:
        from aria_kernel.ledger import append_declared_jsonl

        _, _, debt = _emit_one(self.repo)
        debt_id = debt["debt_id"]
        transition_debt(repo_root=self.repo, base_dir=self.tools, debt_id=debt_id, to_status="IN_PROGRESS", by="commit:afd590368")
        transition_debt(repo_root=self.repo, base_dir=self.tools, debt_id=debt_id, to_status="RESOLVED", by="manual:operator", fix_merge_sha="d" * 40)
        # A well-chained but illegal row (RESOLVED -> OPEN) cannot launder
        # state through replay: the state machine is enforced at read too.
        append_declared_jsonl(
            self.repo / "aria-debts" / "debt-events.jsonl",
            {
                "schema_version": 1,
                "event": "debt_status_changed",
                "event_id": f"debt:{debt_id}:status:999",
                "debt_id": debt_id,
                "from_status": "RESOLVED",
                "to_status": "OPEN",
                "at": "2026-10-20T00:00:00Z",
                "by": "commit:" + "e" * 40,
            },
            expected_surface="repo_debt_events",
        )
        with self.assertRaisesRegex(GovernanceError, "illegal debt transition"):
            show_debt(self.repo, debt_id)

    def test_withdrawn_without_reason_is_refused(self) -> None:
        _, _, debt = _emit_one(self.repo)
        with self.assertRaisesRegex(GovernanceError, "withdrawn_reason"):
            transition_debt(
                repo_root=self.repo,
                base_dir=self.tools, debt_id=debt["debt_id"], to_status="WITHDRAWN", by="manual:operator"
            )
        with self.assertRaisesRegex(GovernanceError, "banned phrase"):
            transition_debt(
                repo_root=self.repo,
                base_dir=self.tools,
                debt_id=debt["debt_id"],
                to_status="WITHDRAWN",
                by="manual:operator",
                withdrawn_reason="for now we ignore it",
            )
        updated = transition_debt(
            repo_root=self.repo,
                base_dir=self.tools,
            debt_id=debt["debt_id"],
            to_status="WITHDRAWN",
            by="manual:operator",
            withdrawn_reason="Superseded by the shared migration helper rolling out fleet-wide",
        )
        self.assertEqual(updated["current_status"], "WITHDRAWN")
        self.assertIn("Superseded", updated["withdrawn_reason"])

    def test_transition_to_overdue_is_refused_because_it_is_derived(self) -> None:
        _, _, debt = _emit_one(self.repo)
        with self.assertRaisesRegex(GovernanceError, "OVERDUE is derived"):
            transition_debt(
                repo_root=self.repo,
                base_dir=self.tools, debt_id=debt["debt_id"], to_status="OVERDUE", by="manual:operator"
            )

    def test_unknown_debt_and_unknown_status_are_refused(self) -> None:
        _, _, _ = _emit_one(self.repo)
        with self.assertRaisesRegex(GovernanceError, "not found"):
            transition_debt(
                repo_root=self.repo,
                base_dir=self.tools, debt_id="DEBT-2026-10-01-999", to_status="IN_PROGRESS", by="manual:operator"
            )
        with self.assertRaisesRegex(GovernanceError, "unknown debt status"):
            transition_debt(
                repo_root=self.repo,
                base_dir=self.tools, debt_id="DEBT-2026-10-01-999", to_status="CANCELLED", by="manual:operator"
            )


class DebtCliVerbTests(TempRepoTestCase):
    def _cli(self, *argv: str) -> int:
        from aria_kernel.cli import main as cli_main

        return cli_main(["--tools-dir", str(self.tools), "debt", *argv]) or 0

    def test_transition_verb_moves_the_debt(self) -> None:
        _, _, debt = _emit_one(self.repo)
        rc = self._cli(
            "transition",
            "--repo-root",
            str(self.repo),
            "--debt",
            debt["debt_id"],
            "--to",
            "IN_PROGRESS",
            "--by",
            "commit:afd590368",
        )
        self.assertEqual(rc, 0)
        self.assertEqual(show_debt(self.repo, debt["debt_id"])["current_status"], "IN_PROGRESS")

    def test_import_committed_verb_is_idempotent(self) -> None:
        # A committed-shape corpus in a temp checkout, imported through
        # the real CLI argv path (the state root is the temp repo itself).
        debts = self.repo / "aria-debts"
        debts.mkdir(exist_ok=True)
        (debts / "DEBT-2026-10-01-001.json").write_text(
            json.dumps(
                {
                    "$schema": "aria/architectural-debt/v1",
                    "debt_id": "DEBT-2026-10-01-001",
                    "current_status": "IN_PROGRESS",
                    "due_date": PAST_DUE,
                    "status_history": [
                        {"status": "OPEN", "at": "2026-10-01T00:00:00Z", "by": "manual:operator"},
                        {"status": "IN_PROGRESS", "at": "2026-10-02T00:00:00Z", "by": "commit:afd590368"},
                    ],
                }
            ),
            encoding="utf-8",
        )
        rc = self._cli("import-committed", "--repo-root", str(self.repo))
        self.assertEqual(rc, 0)
        rows = list_debts(self.repo)
        self.assertEqual([r["debt_id"] for r in rows], ["DEBT-2026-10-01-001"])
        self.assertEqual(rows[0]["effective_status"], "OVERDUE")
        events_path = debts / "debt-events.jsonl"
        first = events_path.read_bytes()
        rc = self._cli("import-committed", "--repo-root", str(self.repo))
        self.assertEqual(rc, 0)
        self.assertEqual(events_path.read_bytes(), first)


if __name__ == "__main__":
    unittest.main()
