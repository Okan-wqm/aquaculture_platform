"""ARIA-HIGH-199 — ARIA reverts its own bad merge, and only its own.

A real origin/workspace git pair carries the merge being reverted, so the
revert, its purity proof and its conflict handling run against git itself;
GitHub is the two seams the kernel already has — the checks reader (fake)
and the one ``gh pr create`` in ``pr_manager`` (stubbed at its subprocess).
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

from aria_kernel import cycle, pr_manager, self_revert
from aria_kernel.auto_merge import _evaluate_triple_gate, record_pr_lifecycle
from aria_kernel.change_ledger import (
    CHANGE_RECORD_SCHEMA,
    _find_committed,
    _find_planned,
    emit_change_planned,
)
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.self_merge_freeze import active_freeze, freeze_ledger_path
from aria_kernel.self_revert import (
    DECISION_CONFLICT,
    DECISION_CREDENTIAL_UNAVAILABLE,
    DECISION_IMPURE,
    DECISION_LANDED,
    DECISION_NOT_ATTRIBUTABLE,
    DECISION_NOT_PERMITTED,
    DECISION_OPENED,
    DECISION_REVERT_OF_REVERT,
    DECISION_VALIDATION_FAILED,
    DECISION_VALIDATION_UNAVAILABLE,
    TRIGGER_CHANGE_OUTCOME,
    TRIGGER_POST_MERGE_CI,
    load_self_reverts,
    revert_branch_for,
    run_self_revert_producer,
)
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.validation_runs_ledger import list_validation_runs_for_change, record_validation_run
from aria_kernel.validation_suite import CANONICAL_VALIDATION_COMMANDS_EXECUTABLE

MERGED_PR = 41
REVERT_PR = 77
LINES = [f"line {n}\n" for n in range(1, 11)]


class FakeReader:
    """The checks reader's read surface, answering from a fixed table."""

    def __init__(self, runs_by_sha: dict[str, list[dict[str, Any]]]) -> None:
        self.runs_by_sha = runs_by_sha
        self.asked: list[str] = []

    def readable(self) -> tuple[bool, str]:
        return (True, "ok")

    def runs_for_commit(self, sha: str) -> list[dict[str, Any]]:
        self.asked.append(sha)
        return list(self.runs_by_sha.get(sha, []))


def _run(name: str, conclusion: str) -> dict[str, Any]:
    return {"name": name, "status": "completed", "conclusion": conclusion, "headBranch": "main"}


class SelfRevertTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.origin = root / "origin.git"
        self.workspace = root / "workspace"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], check=True)
        subprocess.run(["git", "clone", "-q", str(self.origin), str(self.workspace)], check=True, capture_output=True)
        self._git("config", "user.email", "aria@example.invalid")
        self._git("config", "user.name", "ARIA")
        self._git("checkout", "-q", "-b", "main")
        self._write("docs/runbooks/guide.md", "".join(LINES))
        self._write("docs/runbooks/other.md", "other\n")
        self._git("add", ".")
        self._git("commit", "-q", "-m", "docs: seed")
        self.parent_sha = self._out("rev-parse", "HEAD")
        changed = list(LINES)
        changed[4] = "line 5 CHANGED BY ARIA\n"
        self._write("docs/runbooks/guide.md", "".join(changed))
        self._git("commit", "-q", "-am", "docs: the merge that goes bad")
        self.merge_sha = self._out("rev-parse", "HEAD")
        self._git("push", "-q", "origin", "main")

        self.tools = root / "aria-tools"
        ensure_tools_dir(self.tools)
        set_profile("strict", operator_approval_ref="test-fixture", base_dir=self.tools)
        planned = emit_change_planned(
            plan_id="plan-guide", finding_id="F-100", intended_affected_files=["docs/runbooks/guide.md"],
            intended_validation_refs=["npm run lint"], architectural_tier=2, base_dir=self.tools,
        )
        self.reverted_change_id = planned["change_id"]
        record_pr_lifecycle(
            {"number": MERGED_PR, "base_branch": "main", "head_sha": "e" * 40,
             "change_id": self.reverted_change_id, "changed_files": ["docs/runbooks/guide.md"]},
            event="opened", base_dir=self.tools,
        )
        # The suite that validated the reverted change before ARIA merged it.
        log = root / "reverted-suite.log"
        log.write_text("ok\n", encoding="utf-8")
        for command in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE:
            record_validation_run(
                change_id=self.reverted_change_id, cmd=command, exit_code=0, duration_ms=1_000,
                log_path=str(log), commit_sha="e" * 40, runner_identity="aria-executor:REQ-merged",
                change_author_identity="agent:aria-implementer",
                started_at="2026-09-24T10:00:00+00:00", completed_at="2026-09-24T10:01:00+00:00",
                base_dir=self.tools,
            )
        # The contained room, faked at its one seam: every command of the
        # suite runs as `true` (green) unless a test makes it `false`.
        self.suite_exit = "true"
        self.suite_argvs: list[list[str]] = []

        self.gh_calls: list[list[str]] = []
        real_run = subprocess.run

        def fake_run(argv: Any, *args: Any, **kwargs: Any) -> Any:
            if isinstance(argv, list) and argv[:3] == ["gh", "pr", "create"]:
                self.gh_calls.append(list(argv))
                return subprocess.CompletedProcess(argv, 0, f"https://github.com/o/r/pull/{REVERT_PR}\n", "")
            return real_run(argv, *args, **kwargs)

        patcher = mock.patch.object(pr_manager.subprocess, "run", side_effect=fake_run)
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {"ARIA_DRY_RUN": "true"})
        env.start()
        self.addCleanup(env.stop)

    # -- fixture helpers --------------------------------------------------

    def _git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=self.workspace, check=True, capture_output=True)

    def _out(self, *args: str, cwd: Path | None = None) -> str:
        return subprocess.run(
            ["git", *args], cwd=cwd or self.workspace, check=True, capture_output=True, text=True,
        ).stdout.strip()

    def _write(self, relpath: str, text: str) -> None:
        path = self.workspace / relpath
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def _aria_merged(self, pr_number: int = MERGED_PR) -> None:
        append_declared_jsonl(
            self.tools / "auto-merge-decisions.jsonl",
            {"schema_version": 1, "recorded_at": "2026-09-25T00:00:00Z", "pr_number": pr_number,
             "head_sha": "e" * 40, "decision": "merged", "eligible": True},
            expected_surface="auto_merge_decisions",
        )

    def _merge_outcome(self, *, pr_number: int = MERGED_PR, head_ref: str = "aria-impl-0123456789abcdef",
                       merge_sha: str | None = None, status: str = "red",
                       red_jobs: tuple[str, ...] = ("build-status",)) -> None:
        append_declared_jsonl(
            self.tools / "ci" / "merge-outcomes.jsonl",
            {"schema_version": 1, "recorded_at": "2026-09-25T01:00:00Z", "cycle_id": "cyc-1",
             "pr_number": pr_number, "head_ref": head_ref, "merge_sha": merge_sha or self.merge_sha,
             "red_jobs": list(red_jobs) if status == "red" else [], "pending_jobs": [], "status": status},
            expected_surface="merge_outcomes",
        )

    def _produce(self, reader: FakeReader | None = None,
                 triggers: tuple[str, ...] = (TRIGGER_POST_MERGE_CI,)) -> dict[str, Any]:
        def sandbox(worktree: Path) -> Any:
            def wrap(argv: list[str], environment: Any) -> list[str]:
                self.suite_argvs.append(list(argv))
                if argv[:2] == ["sh", "-c"]:
                    return list(argv)  # the room probe runs as itself
                return [self.suite_exit]
            return wrap

        return run_self_revert_producer(
            cycle_id="cyc-revert", base_dir=self.tools, workspace_root=self.workspace,
            reader=reader, triggers=triggers, validation_sandbox=sandbox,
        )

    def _green_parent(self) -> FakeReader:
        return FakeReader({self.parent_sha: [_run("build-status", "success"), _run("lint", "success")]})

    def _origin_branches(self) -> list[str]:
        out = subprocess.run(
            ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
            cwd=self.origin, check=True, capture_output=True, text=True,
        ).stdout
        return sorted(line for line in out.splitlines() if line)

    def _decisions(self) -> list[str]:
        return [str(row["decision"]) for row in load_self_reverts(base_dir=self.tools)]

    # -- attribution ------------------------------------------------------

    def test_a_red_that_was_already_red_on_the_parent_reverts_nothing(self) -> None:
        self._aria_merged()
        self._merge_outcome()
        reader = FakeReader({self.parent_sha: [_run("build-status", "failure")]})
        first = self._produce(reader)
        second = self._produce(reader)
        self.assertIn(self.parent_sha, reader.asked)
        self.assertIsNone(active_freeze(base_dir=self.tools))
        self.assertFalse(freeze_ledger_path(self.tools).exists())
        self.assertEqual(self._origin_branches(), ["main"])
        self.assertEqual(self.gh_calls, [])
        # The non-attribution is visible, once per distinct evidence.
        self.assertEqual(self._decisions(), [DECISION_NOT_ATTRIBUTABLE])
        row = load_self_reverts(base_dir=self.tools)[0]
        self.assertEqual(row["evidence"]["unattributable_jobs"], {"build-status": ["failure"]})
        self.assertEqual(first["decisions"][0]["decision"], DECISION_NOT_ATTRIBUTABLE)
        self.assertEqual(second["decisions"], [])

    def test_a_red_job_with_no_run_on_the_parent_is_not_attributable(self) -> None:
        self._aria_merged()
        self._merge_outcome()
        self._produce(FakeReader({self.parent_sha: [_run("lint", "success")]}))
        self.assertIsNone(active_freeze(base_dir=self.tools))
        self.assertEqual(self._decisions(), [DECISION_NOT_ATTRIBUTABLE])
        row = load_self_reverts(base_dir=self.tools)[0]
        self.assertEqual(row["evidence"]["unattributable_jobs"], {"build-status": []})

    def test_a_human_merge_is_not_arias_to_revert(self) -> None:
        self._merge_outcome()
        result = self._produce(self._green_parent())
        self.assertIsNone(active_freeze(base_dir=self.tools))
        self.assertEqual(load_self_reverts(base_dir=self.tools), [])
        self.assertEqual(self.gh_calls, [])
        self.assertEqual(result["skipped"], [{"pr_number": MERGED_PR, "reason": "not_an_aria_merge"}])

    # -- the revert -------------------------------------------------------

    def test_an_attributable_red_freezes_then_opens_exactly_one_pure_revert(self) -> None:
        self._aria_merged()
        self._merge_outcome()
        first_effect_saw_freeze: list[bool] = []
        real_git = self_revert._git

        def observing_git(args: list[str], **kwargs: Any) -> Any:
            if args and args[0] in {"worktree", "revert", "push"} and not first_effect_saw_freeze:
                first_effect_saw_freeze.append(active_freeze(base_dir=self.tools) is not None)
            return real_git(args, **kwargs)

        with mock.patch.object(self_revert, "_git", side_effect=observing_git):
            result = self._produce(self._green_parent())
        self.assertEqual(first_effect_saw_freeze, [True], "the freeze lands before any git effect")

        branch = revert_branch_for(self.merge_sha)
        self.assertEqual(branch, f"aria/revert/{self.merge_sha[:12]}")
        self.assertEqual(self._origin_branches(), sorted(["main", branch]))
        tip = self._out("rev-parse", f"refs/heads/{branch}", cwd=self.origin)
        self.assertEqual(self._out("rev-parse", f"{tip}^", cwd=self.origin), self.merge_sha)
        self.assertEqual(
            self._out("show", f"{tip}:docs/runbooks/guide.md", cwd=self.origin),
            "".join(LINES).strip(),
        )
        self.assertEqual(len(self.gh_calls), 1)
        argv = self.gh_calls[0]
        self.assertEqual(argv[argv.index("--head") + 1], branch)
        self.assertEqual(argv[argv.index("--base") + 1], "main")

        freeze = active_freeze(base_dir=self.tools)
        assert freeze is not None
        self.assertEqual(freeze["merge_sha"], self.merge_sha)
        self.assertEqual(freeze["revert"], {"pr_number": REVERT_PR, "head_sha": tip})

        rows = load_self_reverts(base_dir=self.tools)
        self.assertEqual([row["decision"] for row in rows], [DECISION_OPENED])
        opened = rows[0]
        self.assertEqual(opened["key"], f"revert:{self.merge_sha}")
        self.assertTrue(opened["purity"]["pure"])
        self.assertEqual(opened["purity"]["revert_files"], ["docs/runbooks/guide.md"])
        self.assertEqual(opened["purity"]["revert_patch_id"], opened["purity"]["inverse_patch_id"])
        self.assertEqual(result["decisions"][0]["decision"], DECISION_OPENED)

        # The revert is a change of the ledger's own kind, bound to its PR.
        change_id = opened["change_id"]
        planned = _find_planned(self.tools, change_id)
        assert planned is not None
        self.assertEqual(planned["intended_affected_files"], ["docs/runbooks/guide.md"])
        self.assertEqual(planned["finding_id"], "F-100")
        self.assertEqual(planned["rollback_ref"], self.merge_sha)
        committed = _find_committed(self.tools, change_id)
        assert committed is not None
        self.assertEqual(committed["commit_sha"], tip)
        lifecycle = load_declared_jsonl(self.tools / "pr-lifecycle.jsonl", expected_surface="pr_lifecycle")
        self.assertIn((REVERT_PR, change_id, "opened"),
                      {(row.get("pr_number"), row.get("change_id"), row.get("event")) for row in lifecycle})

        # The revert re-ran the reverted change's own suite at its tip, and
        # its chain passes the merge authority's real triple gate.
        runs = list_validation_runs_for_change(change_id, base_dir=self.tools)
        self.assertEqual(sorted(run["cmd"] for run in runs), sorted(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE))
        self.assertEqual({run["commit_sha"] for run in runs}, {tip})
        self.assertEqual({run["status"] for run in runs}, {"ok"})
        self.assertEqual(opened["validated"]["change_id"], change_id)
        gate = _evaluate_triple_gate(pr_number=REVERT_PR, head_sha=tip, base_dir=self.tools)
        self.assertTrue(gate["passed"], gate)

        # The workspace checkout the cycle runs in was never moved.
        self.assertEqual(self._out("rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertEqual(self._out("worktree", "list", "--porcelain").count("worktree "), 1)

        # A second trigger for the same merge is a no-op.
        again = self._produce(self._green_parent())
        self.assertEqual(len(self.gh_calls), 1)
        self.assertEqual(self._decisions(), [DECISION_OPENED])
        self.assertEqual(again["decisions"], [])
        self.assertEqual(freeze_ledger_path(self.tools).read_text(encoding="utf-8").count("self_merge_frozen"), 1)

    def test_an_impure_revert_is_refused_before_any_pr(self) -> None:
        # main moved on: a later commit rewrote a context line of the hunk,
        # so the revert applies but is not the exact inverse of the merge.
        self._git("pull", "-q", "origin", "main")
        moved = (self.workspace / "docs/runbooks/guide.md").read_text(encoding="utf-8").splitlines(keepends=True)
        moved[2] = "line 3 rewritten later\n"
        self._write("docs/runbooks/guide.md", "".join(moved))
        self._git("commit", "-q", "-am", "docs: later neighbour edit")
        self._git("push", "-q", "origin", "main")
        self._aria_merged()
        self._merge_outcome()
        self._produce(self._green_parent())
        self.assertEqual(self._decisions(), [DECISION_IMPURE])
        row = load_self_reverts(base_dir=self.tools)[0]
        self.assertFalse(row["purity"]["pure"])
        self.assertNotEqual(row["purity"]["revert_patch_id"], row["purity"]["inverse_patch_id"])
        self.assertEqual(self.gh_calls, [])
        self.assertEqual(self._origin_branches(), ["main"])
        freeze = active_freeze(base_dir=self.tools)
        assert freeze is not None
        self.assertIsNone(freeze["revert"])
        self.assertTrue((self.tools / "human-required" / f"self-revert-{self.merge_sha[:12]}.json").exists())

    def test_a_conflicting_revert_is_aborted_and_the_freeze_stays(self) -> None:
        self._git("pull", "-q", "origin", "main")
        moved = (self.workspace / "docs/runbooks/guide.md").read_text(encoding="utf-8").splitlines(keepends=True)
        moved[4] = "line 5 rewritten again by a human\n"
        self._write("docs/runbooks/guide.md", "".join(moved))
        self._git("commit", "-q", "-am", "docs: overlapping edit")
        self._git("push", "-q", "origin", "main")
        self._aria_merged()
        self._merge_outcome()
        self._produce(self._green_parent())
        self.assertEqual(self._decisions(), [DECISION_CONFLICT])
        self.assertEqual(self.gh_calls, [])
        self.assertEqual(self._origin_branches(), ["main"])
        self.assertIsNotNone(active_freeze(base_dir=self.tools))
        self.assertTrue((self.tools / "human-required" / f"self-revert-{self.merge_sha[:12]}.json").exists())
        self.assertEqual(self._out("worktree", "list", "--porcelain").count("worktree "), 1)
        self.assertEqual(self._out("status", "--porcelain"), "")
        # Terminal: a later trigger does not retry the conflict.
        self._produce(self._green_parent())
        self.assertEqual(self._decisions(), [DECISION_CONFLICT])

    def test_a_red_on_a_revert_never_produces_a_revert_of_the_revert(self) -> None:
        self._aria_merged()
        self._merge_outcome(head_ref=f"aria/revert/{'b' * 12}")
        self._produce(self._green_parent())
        self.assertEqual(self._decisions(), [DECISION_REVERT_OF_REVERT])
        self.assertEqual(self.gh_calls, [])
        self.assertEqual(self._origin_branches(), ["main"])
        freeze = active_freeze(base_dir=self.tools)
        assert freeze is not None
        self.assertEqual(freeze["merge_sha"], self.merge_sha)

    def test_a_profile_without_pr_create_still_freezes_and_asks_a_human(self) -> None:
        set_profile("standard", operator_approval_ref="test-fixture", base_dir=self.tools)
        self._aria_merged()
        self._merge_outcome()
        self._produce(self._green_parent())
        self.assertIsNotNone(active_freeze(base_dir=self.tools))
        self.assertEqual(self._decisions(), [DECISION_NOT_PERMITTED])
        self.assertEqual(self._origin_branches(), ["main"])
        self.assertEqual(self.gh_calls, [])

    # -- the regression trigger -------------------------------------------

    def test_a_regression_verdict_reverts_the_merge_it_names(self) -> None:
        self._aria_merged()
        self._merge_outcome(status="green")
        append_declared_jsonl(
            self.tools / "change-ledger" / "outcome.jsonl",
            {"$schema": CHANGE_RECORD_SCHEMA, "schema_version": 1, "event": "change_outcome",
             "change_id": self.reverted_change_id, "verdict": "regression", "merged_pr_number": MERGED_PR,
             "recorded_at": "2026-09-25T02:00:00Z", "readings": []},
            expected_surface="change_outcome",
        )
        self._produce(None, triggers=(TRIGGER_CHANGE_OUTCOME,))
        rows = load_self_reverts(base_dir=self.tools)
        self.assertEqual([row["decision"] for row in rows], [DECISION_OPENED])
        self.assertEqual(rows[0]["trigger"], TRIGGER_CHANGE_OUTCOME)
        self.assertEqual(len(self.gh_calls), 1)
        freeze = active_freeze(base_dir=self.tools)
        assert freeze is not None
        self.assertEqual(freeze["trigger"], TRIGGER_CHANGE_OUTCOME)

    # -- the landed revert -------------------------------------------------

    def test_a_revert_that_lands_green_records_rollback_success_once(self) -> None:
        self._aria_merged()
        self._merge_outcome()
        self._produce(self._green_parent())
        self._aria_merged(REVERT_PR)
        self._merge_outcome(pr_number=REVERT_PR, head_ref=revert_branch_for(self.merge_sha),
                            merge_sha="c" * 40, status="green")
        self._produce(self._green_parent())
        self._produce(self._green_parent())
        self.assertEqual(self._decisions(), [DECISION_OPENED, DECISION_LANDED])
        events = load_declared_jsonl(
            self.tools / "enterprise" / "acceptance-events.jsonl", expected_surface="enterprise_acceptance_events",
        )
        self.assertEqual([(row["event_type"], row["pr_number"]) for row in events], [("rollback_success", REVERT_PR)])
        # Landing does not lift the freeze: that is the operator's act.
        self.assertIsNotNone(active_freeze(base_dir=self.tools))

    def test_a_red_suite_at_the_revert_tip_is_not_validated_and_opens_no_pr(self) -> None:
        self._aria_merged()
        self._merge_outcome()
        self.suite_exit = "false"
        self._produce(self._green_parent())
        self.assertEqual(self._decisions(), [DECISION_VALIDATION_FAILED])
        row = load_self_reverts(base_dir=self.tools)[0]
        change_id = row["change_id"]
        self.assertFalse((self.tools / "change-ledger" / "validated.jsonl").exists()
                         and change_id in (self.tools / "change-ledger" / "validated.jsonl").read_text())
        self.assertEqual(row["failed_commands"], sorted(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE))
        self.assertEqual(self.gh_calls, [])
        self.assertEqual(self._origin_branches(), ["main"])
        freeze = active_freeze(base_dir=self.tools)
        assert freeze is not None
        self.assertIsNone(freeze["revert"])
        self.assertTrue((self.tools / "human-required" / f"self-revert-{self.merge_sha[:12]}.json").exists())
        # Terminal: a later trigger does not re-run it.
        self.suite_exit = "true"
        self._produce(self._green_parent())
        self.assertEqual(self._decisions(), [DECISION_VALIDATION_FAILED])

    def test_a_host_without_the_validation_sandbox_opens_no_pr_and_retries(self) -> None:
        from aria_kernel.implementation_safety import SandboxUnavailable

        self._aria_merged()
        self._merge_outcome()

        def no_sandbox(worktree: Path) -> Any:
            raise SandboxUnavailable("sandbox_backend_unavailable: bwrap is not usable on this host")

        for _ in range(2):
            run_self_revert_producer(
                cycle_id="cyc-revert", base_dir=self.tools, workspace_root=self.workspace,
                reader=self._green_parent(), triggers=(TRIGGER_POST_MERGE_CI,), validation_sandbox=no_sandbox,
            )
        self.assertEqual(self._decisions(), [DECISION_VALIDATION_UNAVAILABLE])
        self.assertEqual(self.gh_calls, [])
        self.assertEqual(self._origin_branches(), ["main"])
        self.assertIsNotNone(active_freeze(base_dir=self.tools))
        self.assertTrue((self.tools / "human-required" / f"self-revert-{self.merge_sha[:12]}.json").exists())
        # The host's refusal is not the revert's: a host that can build it proceeds.
        self._produce(self._green_parent())
        self.assertEqual(self._decisions(), [DECISION_VALIDATION_UNAVAILABLE, DECISION_OPENED])

    def test_a_credential_that_cannot_be_minted_leaves_nothing_on_the_remote_and_retries(self) -> None:
        from aria_kernel import delivery_credentials

        self._aria_merged()
        self._merge_outcome()
        with mock.patch.object(delivery_credentials, "mint_installation_token", side_effect=RuntimeError("no app")):
            self._produce(self._green_parent())
            self._produce(self._green_parent())
        self.assertEqual(self._decisions(), [DECISION_CREDENTIAL_UNAVAILABLE])
        self.assertIsNotNone(active_freeze(base_dir=self.tools))
        self.assertEqual(self._origin_branches(), ["main"])
        self.assertEqual(self._out("branch", "--list", revert_branch_for(self.merge_sha)), "")
        self.assertEqual(self.gh_calls, [])
        change_id = load_self_reverts(base_dir=self.tools)[0]["change_id"]
        committed = _find_committed(self.tools, change_id)
        assert committed is not None
        suite_runs = len(list_validation_runs_for_change(change_id, base_dir=self.tools))
        # Not terminal: once the lane can mint, the SAME revert commit meets
        # the chain it already validated, and nothing re-runs.
        self._produce(self._green_parent())
        self.assertEqual(self._decisions(), [DECISION_CREDENTIAL_UNAVAILABLE, DECISION_OPENED])
        opened = load_self_reverts(base_dir=self.tools)[-1]
        self.assertEqual((opened["change_id"], opened["head_sha"]), (change_id, committed["commit_sha"]))
        self.assertEqual(len(list_validation_runs_for_change(change_id, base_dir=self.tools)), suite_runs)
        gate = _evaluate_triple_gate(pr_number=REVERT_PR, head_sha=opened["head_sha"], base_dir=self.tools)
        self.assertTrue(gate["passed"], gate)


class SelfRevertCycleWiringTests(unittest.TestCase):
    """Both triggers are called from the cycle phase that produces their evidence."""

    def _context(self, root: Path) -> SimpleNamespace:
        return SimpleNamespace(cycle_id="cyc-w", base_dir=root / "aria-tools", workspace_root=root)

    def test_the_pr_ci_scan_runs_the_post_merge_trigger_with_its_reader(self) -> None:
        reader = object()
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch("aria_kernel.github_adapters.select_checks_reader", return_value=reader), \
                mock.patch.object(cycle, "get_profile", return_value="strict"), \
                mock.patch("aria_kernel.own_pr_ci.scan_own_prs", return_value={}), \
                mock.patch("aria_kernel.own_pr_ci.scan_merged_own_prs", return_value={"red": [41]}), \
                mock.patch("aria_kernel.own_pr_ci.scan_repo_pr_health", return_value={}), \
                mock.patch("aria_kernel.implementation_reconciler.reconcile_recorded_implementations",
                           return_value={}), \
                mock.patch.object(self_revert, "run_self_revert_producer",
                                  return_value={"status": "ran"}) as producer:
            result = cycle._phase_pr_ci_scan(self._context(Path(tmp)))
        self.assertEqual(result["self_revert"], {"status": "ran"})
        kwargs = producer.call_args.kwargs
        self.assertIs(kwargs["reader"], reader)
        self.assertEqual(kwargs["triggers"], (TRIGGER_POST_MERGE_CI,))

    def test_the_outcome_phase_runs_the_regression_trigger(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch("aria_kernel.change_outcome.evaluate_change_outcomes", return_value={"evaluated": 1}), \
                mock.patch.object(self_revert, "run_self_revert_producer",
                                  return_value={"status": "ran"}) as producer:
            result = cycle._phase_change_outcome_evaluation(self._context(Path(tmp)))
        self.assertEqual(result, {"evaluated": 1, "self_revert": {"status": "ran"}})
        self.assertEqual(producer.call_args.kwargs["triggers"], (TRIGGER_CHANGE_OUTCOME,))


if __name__ == "__main__":
    unittest.main()
