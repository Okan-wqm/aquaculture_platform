"""ARIA-HIGH-222 — a lane's recorded facts survive a publish race; no claim is dropped.

* ``state publish`` — the verb every aria workflow runs — published
  single-attempt: a lane that lost the fast-forward race was refused and its
  rows died with the runner. It now publishes through
  ``state_store.publish_with_contention_replay`` (which had no production
  caller), and commits nothing when no row changed.
* A merge's own decision row reached aria/state only at the lane's end, so a
  lost publish merged a PR nothing recorded and self-revert could never see
  it. ``merge_pr_if_ready`` records a ``merge_intent`` row and PUBLISHES it
  before the merge call, refuses to merge when it cannot, and self-revert
  counts an intent whose PR later merged at that head as ARIA's merge.
* ``aria-readiness-claim`` shared one global concurrency group, which keeps
  one pending run and replaces it: claims were dropped. It is keyed on the
  head the completed run tested.
* The merge lane's candidates are open PRs whose current head holds a claim;
  a run with none publishes nothing.
"""
from __future__ import annotations

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import yaml  # type: ignore[import-untyped]

from aria_kernel.auto_merge_runners import enumerate_prs_with_readiness_claims
from aria_kernel.cli import main as cli_main
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl, read_jsonl
from aria_kernel.merge_authority import merge_pr_if_ready
from aria_kernel.self_revert import _aria_merged_prs
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    checkout_state_store,
    publish_with_contention_replay,
    tools_root,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.tools_binding import bind_tools_root
from tests._helpers.declared_fixtures import append_declared_fixture

_REPO_ROOT = Path(__file__).resolve().parents[2]
_REPO_HASH = "repohash0222"
_HEAD = "a" * 40


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


class _TwoLanes(unittest.TestCase):
    """Two clones of one remote, each with its own aria/state store."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.remote = self.base / "remote.git"
        self.remote.mkdir()
        _git(self.remote, "init", "--bare", "--initial-branch=main", ".")
        self.repo_a = self._clone("work-a", seed=True)
        from aria_kernel import state_store

        ack = patch.dict("os.environ", {BOOTSTRAP_ACK_ENV: state_store._repository_identity(self.repo_a)})
        ack.start()
        self.addCleanup(ack.stop)
        self.repo_b = self._clone("work-b", seed=False)

    def _clone(self, name: str, *, seed: bool) -> Path:
        repo = self.base / name
        repo.mkdir()
        for argv in (
            ("init", "--initial-branch=main", "."),
            ("config", "user.email", "aria@example.invalid"),
            ("config", "user.name", "ARIA Test"),
            ("config", "commit.gpgsign", "false"),
            ("remote", "add", "origin", str(self.remote)),
        ):
            _git(repo, *argv)
        if seed:
            (repo / "README.md").write_text("seed\n", encoding="utf-8")
            _git(repo, "add", "README.md")
            _git(repo, "commit", "--no-gpg-sign", "-m", "seed")
            _git(repo, "push", "origin", "main")
        else:
            _git(repo, "fetch", "origin", "main")
            _git(repo, "checkout", "-B", "main", "origin/main")
        return repo

    def _store(self, repo: Path, name: str):
        return checkout_state_store(repo, store_dir=self.base / name)

    def _append(self, store, cycle_id: str) -> None:
        root = tools_root(store)
        root.mkdir(parents=True, exist_ok=True)
        if not (root / "repo_identity.json").exists():
            bind_tools_root(tools_dir=root, workspace_root=store.repo_root, reason="bind the lane's store")
        append_declared_fixture(
            root / "cycles.jsonl",
            {"schema_version": 2, "cycle_id": cycle_id, "event": "started"},
            expected_surface="cycles",
        )

    def _cli_publish(self, repo: Path, store, snapshot_id: str) -> tuple[int, dict]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli_main([
                "state", "publish", "--repo-root", str(repo), "--repo-hash", _REPO_HASH,
                "--store-dir", str(store.root), "--snapshot-id", snapshot_id, "--cycle-id", snapshot_id,
            ])
        return code, json.loads(out.getvalue())


class StatePublishSurvivesTheRaceTests(_TwoLanes):
    def test_the_lane_that_lost_the_race_still_publishes_its_rows(self) -> None:
        # Both lanes stand on the one published aria/state tip, as every
        # workflow does. (Two stores bootstrapped before the branch exists
        # would each mint their own genesis commit: unrelated histories,
        # which is a different refusal from the race this test is about.)
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "cycle-seed")
        seeded = publish_with_contention_replay(
            store_a, snapshot_id="snap-seed", cycle_id="cycle-seed", lane="test", repo_hash=_REPO_HASH,
        )
        self.assertTrue(seeded["published"])
        _git(self.repo_b, "fetch", "origin")
        store_b = self._store(self.repo_b, "store-b")
        self.assertFalse(store_b.bootstrapped)
        self.assertEqual(
            _git(store_b.root, "rev-parse", "HEAD").strip(),
            _git(self.remote, "rev-parse", "refs/heads/aria/state").strip(),
        )
        self._append(store_a, "cycle-won")
        self._append(store_b, "cycle-lost-the-race")
        # Lane A pushes first; lane B's store still stands on the old tip.
        first = publish_with_contention_replay(
            store_a, snapshot_id="snap-a", cycle_id="cycle-won", lane="test", repo_hash=_REPO_HASH,
        )
        self.assertTrue(first["published"])
        code, verdict = self._cli_publish(self.repo_b, store_b, "snap-b")
        self.assertEqual(code, 0, verdict)
        self.assertTrue(verdict["published"], verdict)
        self.assertGreaterEqual(verdict["attempts"], 2)
        # Lane B's store now IS the published tip, carrying both lanes' rows.
        cycles = [str(row["cycle_id"]) for row in read_jsonl(tools_root(store_b) / "cycles.jsonl")]
        self.assertIn("cycle-won", cycles)
        self.assertIn("cycle-lost-the-race", cycles)
        self.assertEqual(
            _git(store_b.root, "rev-parse", "HEAD").strip(),
            _git(self.remote, "rev-parse", "refs/heads/aria/state").strip(),
        )

    def test_a_store_with_no_new_rows_publishes_nothing(self) -> None:
        store_a = self._store(self.repo_a, "store-a")
        self._append(store_a, "cycle-1")
        code, verdict = self._cli_publish(self.repo_a, store_a, "snap-1")
        self.assertEqual(code, 0, verdict)
        self.assertTrue(verdict["published"])
        tip = _git(self.remote, "rev-parse", "refs/heads/aria/state").strip()
        code, again = self._cli_publish(self.repo_a, store_a, "snap-2")
        self.assertEqual(code, 0, again)
        self.assertFalse(again["published"])
        self.assertEqual(again["reason"], "no_row_changes")
        self.assertEqual(_git(self.remote, "rev-parse", "refs/heads/aria/state").strip(), tip)


class _Adapter:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def get_open_issues(self, *, labels):
        return {"readable": True, "issues": []}

    def get_pr(self, pr_number: int) -> dict:
        return {
            "number": pr_number, "state": "OPEN", "repository": "okan/aqua",
            "base_branch": "main", "head_ref": "feat/x", "head_sha": _HEAD,
        }

    def merge_pr(self, pr_number: int, **kwargs) -> dict:
        self.calls.append("merge")
        return {"merged": True}


def _gates() -> list:
    return [
        patch("aria_kernel.merge_authority.assert_merge_authority_available", return_value="autonomous"),
        patch("aria_kernel.merge_authority.assert_merge_authorized", return_value="autonomous"),
        patch("aria_kernel.merge_authority.assert_self_merge_not_frozen", return_value=None),
        patch("aria_kernel.merge_authority.record_risk_decision_for_pr",
              return_value={"valid": True, "lane": "L1", "policy_hash": "ph"}),
        patch("aria_kernel.merge_authority.assert_autonomy_unlocked", return_value=SimpleNamespace(counts={})),
        patch("aria_kernel.merge_authority.verify_enterprise_readiness",
              return_value=SimpleNamespace(valid=True, failure_classes=(), reasons=())),
        patch("aria_kernel.merge_authority.verify_runner_attestation", return_value={}),
        patch("aria_kernel.merge_authority.verify_rollback_bundle", return_value={}),
        patch("aria_kernel.merge_authority.ensure_pre_merge_incident_row", return_value={"ledger_hash": "x"}),
        patch("aria_kernel.merge_authority._merge_if_green_with_executor",
              return_value={"decision": "proceed", "eligible": True, "head_sha": _HEAD, "pr_number": 7}),
        patch("aria_kernel.merge_authority._evaluate_triple_gate", return_value={"passed": True, "change_id": "c"}),
        patch("aria_kernel.merge_authority.collect_github_snapshot", return_value={}),
        patch("aria_kernel.merge_authority.evaluate_auto_merge", return_value={"eligible": True, "head_sha": _HEAD}),
        patch("aria_kernel.merge_authority.run_hard_fail_checks",
              return_value=SimpleNamespace(passed=True, failures=(), results=())),
    ]


class MergeIntentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        for item in _gates():
            item.start()
            self.addCleanup(item.stop)

    def _decisions(self) -> list[dict]:
        return load_declared_jsonl(self.tools / "auto-merge-decisions.jsonl", expected_surface="auto_merge_decisions")

    def test_the_intent_is_published_before_the_merge_call(self) -> None:
        adapter = _Adapter()

        def publisher(intent: dict) -> dict:
            # The intent is on the ledger when it is published, and nothing
            # has been merged yet.
            self.assertEqual(adapter.calls, [])
            self.assertEqual(self._decisions()[-1]["decision"], "merge_intent")
            adapter.calls.append("publish")
            return {"published": True}

        result = merge_pr_if_ready(
            adapter=adapter, pr_number=7, base_dir=self.tools, readiness_claim_id="claim:7:aaaaaaaaaaaa",
            intent_publisher=publisher,
        )
        self.assertEqual(adapter.calls, ["publish", "merge"])
        self.assertEqual(result["decision"], "merged")
        intent = next(row for row in self._decisions() if row["decision"] == "merge_intent")
        self.assertEqual((intent["pr_number"], intent["head_sha"]), (7, _HEAD))
        self.assertEqual(intent["readiness_claim_id"], "claim:7:aaaaaaaaaaaa")

    def test_an_intent_that_did_not_publish_stops_the_merge(self) -> None:
        from aria_kernel.state_store import StateStoreRefusal

        for label, publisher in (
            ("refused", lambda intent: (_ for _ in ()).throw(StateStoreRefusal("state_publish_contention_unresolved"))),
            ("not_published", lambda intent: {"published": False, "reason": "no_row_changes"}),
            ("absent", None),
        ):
            with self.subTest(publisher=label):
                adapter = _Adapter()
                result = merge_pr_if_ready(
                    adapter=adapter, pr_number=7, base_dir=self.tools,
                    readiness_claim_id="claim:7:aaaaaaaaaaaa", intent_publisher=publisher,
                )
                self.assertEqual(adapter.calls, [])
                self.assertEqual(result["decision"], "blocked")
                self.assertEqual(result["stage"], "merge_intent")

    def test_the_merge_lane_publishes_intents_from_its_store(self) -> None:
        from aria_kernel import cli

        seen: dict = {}

        def fake_runner(**kwargs):
            seen.update(kwargs)
            return lambda *, base_dir, workspace_root: {"status": "ok", "merges_completed": 0}

        with patch("aria_kernel.auto_merge_runners.select_auto_merge_runner", side_effect=fake_runner), \
             patch("aria_kernel.github_adapters.select_github_adapter", return_value=object()), \
             patch("sys.stdout"):
            cli.main(["--tools-dir", str(self.tools), "merge-lane", "run", "--pr", "7"])
        self.assertTrue(callable(seen["intent_publisher"]))


class SelfRevertSeesAPublishedIntentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def _decision(self, pr_number: int, decision: str, head_sha: str) -> None:
        append_declared_jsonl(
            self.tools / "auto-merge-decisions.jsonl",
            {"schema_version": 1, "pr_number": pr_number, "head_sha": head_sha, "decision": decision},
            expected_surface="auto_merge_decisions",
        )

    def _merged_at(self, pr_number: int, head_sha: str) -> None:
        append_declared_jsonl(
            self.tools / "ci" / "merge-outcomes.jsonl",
            {"schema_version": 1, "pr_number": pr_number, "head_ref": "aria-impl-0123456789abcdef",
             "head_sha": head_sha, "merge_sha": "f" * 40, "red_jobs": [], "pending_jobs": [], "status": "green"},
            expected_surface="merge_outcomes",
        )

    def test_an_intent_whose_pr_merged_at_that_head_is_an_aria_merge(self) -> None:
        self._decision(7, "merge_intent", _HEAD)
        self.assertEqual(_aria_merged_prs(self.tools), set())
        self._merged_at(7, _HEAD)
        self.assertEqual(_aria_merged_prs(self.tools), {7})

    def test_an_intent_for_another_head_is_not(self) -> None:
        self._decision(8, "merge_intent", _HEAD)
        self._merged_at(8, "b" * 40)
        self.assertEqual(_aria_merged_prs(self.tools), set())

    def test_an_implementation_branch_is_one_of_arias_own_prs(self) -> None:
        from aria_kernel.own_pr_ci import is_own_pr_head

        self.assertTrue(is_own_pr_head("aria-impl-0123456789abcdef"))
        self.assertFalse(is_own_pr_head("aria-impl-not-hex"))
        self.assertFalse(is_own_pr_head("feature/aria-impl-0123456789abcdef"))

    def test_the_post_merge_reconciler_records_the_head_it_merged_at(self) -> None:
        from aria_kernel.own_pr_ci import merge_outcomes_path, scan_merged_own_prs

        class Reader:
            def readable(self):
                return True, "ok"

            def list_merged_own_prs(self, *, limit):
                return [{"number": 9, "headRefName": "aria-impl-0123456789abcdef",
                         "headRefOid": _HEAD, "mergeCommit": {"oid": "f" * 40}}]

            def runs_for_commit(self, sha):
                return [{"name": "build-status", "status": "completed", "conclusion": "success",
                         "headBranch": "main"}]

        scan_merged_own_prs(cycle_id="cyc", base_dir=self.tools, reader=Reader())
        rows = load_declared_jsonl(merge_outcomes_path(self.tools), expected_surface="merge_outcomes")
        self.assertEqual(rows[-1]["head_sha"], _HEAD)


class CandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def _claim(self, pr_number: int, head_sha: str) -> None:
        append_declared_jsonl(
            self.tools / "enterprise" / "readiness-claims.jsonl",
            {"readiness_claim_id": f"claim:{pr_number}:{head_sha[:12]}", "pr_number": pr_number,
             "head_sha": head_sha, "row_id": f"claim-row:{pr_number}", "row_type": "readiness_claim"},
            expected_surface="enterprise_readiness_claims",
            bypass_profile_gate=True,
        )

    def test_only_open_prs_whose_live_head_is_claimed_are_candidates(self) -> None:
        self._claim(1, "a" * 40)   # open, claimed head
        self._claim(2, "b" * 40)   # merged long ago
        self._claim(3, "c" * 40)   # open, but pushed since the claim

        class Adapter:
            def list_open_pull_request_heads(self):
                return {1: "a" * 40, 3: "d" * 40, 4: "e" * 40}

        self.assertEqual(enumerate_prs_with_readiness_claims(Adapter(), base_dir=self.tools), [1])

    def test_an_adapter_that_observes_nothing_has_no_candidates(self) -> None:
        self._claim(1, "a" * 40)

        class Recording:
            def list_open_pull_request_heads(self):
                return None

        self.assertEqual(enumerate_prs_with_readiness_claims(Recording(), base_dir=self.tools), [])

    def test_the_live_listing_pages_to_the_end(self) -> None:
        from aria_kernel.auto_merge import GhCliGitHubAdapter

        adapter = GhCliGitHubAdapter.__new__(GhCliGitHubAdapter)
        adapter.owner, adapter.repo = "okan", "aqua"
        with patch.object(GhCliGitHubAdapter, "_gh_stdout", return_value="1\t" + "a" * 40 + "\n2\t" + "b" * 40 + "\n") as gh:
            heads = adapter.list_open_pull_request_heads()
        self.assertEqual(heads, {1: "a" * 40, 2: "b" * 40})
        self.assertIn("--paginate", gh.call_args.args[0])


class WorkflowWiringTests(unittest.TestCase):
    def _workflow(self, name: str) -> dict:
        return yaml.safe_load((_REPO_ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8"))

    def test_claims_queue_per_head_not_globally(self) -> None:
        group = self._workflow("aria-readiness-claim.yml")["concurrency"]["group"]
        self.assertIn("github.event.workflow_run.head_sha", group)
        self.assertFalse(self._workflow("aria-readiness-claim.yml")["concurrency"]["cancel-in-progress"])

    def test_the_merge_step_can_publish_intents_and_a_run_without_candidates_publishes_nothing(self) -> None:
        steps = self._workflow("aria-merge-runner.yml")["jobs"]["merge"]["steps"]
        names = [step.get("name") for step in steps]
        by_name = {step.get("name"): step for step in steps}
        self.assertLess(names.index("Mint the aria/state push credential"), names.index("Run the merge lane"))
        merge = by_name["Run the merge lane"]
        self.assertEqual(merge["id"], "merge")
        self.assertEqual(merge["env"]["GIT_CONFIG_KEY_0"], "http.https://github.com/.extraheader")
        self.assertIn("steps.publish_credential.outputs.header", merge["env"]["GIT_CONFIG_VALUE_0"])
        self.assertIn("candidates=$(jq -r '(.candidates_evaluated // 0)", merge["run"])
        # ARIA-HIGH-221 — a merge-queue settlement is recorded work too.
        self.assertIn("((.queue_settled // []) | length)", merge["run"])
        publish = " ".join(str(by_name["Publish ARIA state to the aria/state branch"]["if"]).split())
        self.assertIn("steps.merge.outputs.candidates != '0'", publish)

    def test_the_state_publish_verb_is_the_contention_replay(self) -> None:
        import inspect

        from aria_kernel import cli

        source = inspect.getsource(cli._handle_state_store_command)
        self.assertIn("publish_with_contention_replay(", source)


if __name__ == "__main__":
    unittest.main()
