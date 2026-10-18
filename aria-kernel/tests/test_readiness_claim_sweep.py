"""ARIA-HIGH-222 — a claim the claim lane did not make is made by the backstop.

The claim lane (aria-readiness-claim.yml) runs once per completed, green
``aria-merge-authority`` pull-request run. It takes the aria/state writer
lease for 300 s at most; the executor holds that lease for up to 650 minutes
and the cycle for up to 440, so a completion that lands while either runs
yields green and claims nothing. Nothing produced that head's claim again:
the merge lane only consumes claims, and a dispatch of the claim lane is
refused. A yield was terminal for the head.

The backstop is the lane's hourly schedule, which asks
``readiness sweep-claimless`` for a head to claim: an open PR whose live head
holds no claim row and has a completed, successful ``pull_request`` run of
aria-merge-authority whose proof artifact is still published. The claim it
then assembles is bound to THAT run (``--workflow-run-id``), so
``readiness_claim_current_run_unproven`` still guards it.

These tests drive the real CLI verb against a fake ``gh`` on PATH that serves
GitHub's REST shapes, and the claim end to end through the production
producer (the durability suite's fixture).
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel.auto_merge_runners import enumerate_prs_with_readiness_claims
from aria_kernel.cli import main as cli_main
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests.test_readiness_claim_durability import _HEAD, _ClaimFixture

_REPO = "okan/aqua"
_RUNS = f"repos/{_REPO}/actions/workflows/aria-merge-authority.yml/runs"
_PULLS = f"repos/{_REPO}/pulls"

# A fake `gh`: `repo view` names the repository; `api` serves the route the
# fixture file holds for the endpoint (pages as GitHub returns them; with
# --slurp, the array of pages). The open-PR listing is projected exactly as
# the adapter's --jq asks (number <TAB> head sha). Every call is logged.
_FAKE_GH = """#!{python}
import json, os, sys
argv = sys.argv[1:]
with open(os.environ["ARIA_FAKE_GH_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(argv) + "\\n")
with open(os.environ["ARIA_FAKE_GH_FIXTURE"], encoding="utf-8") as handle:
    fixture = json.load(handle)
if argv[:2] == ["repo", "view"]:
    print(json.dumps({{"owner": {{"login": "okan"}}, "name": "aqua"}}))
    sys.exit(0)
if argv and argv[0] == "api":
    path = [a for a in argv[1:] if a not in ("--paginate", "--slurp")][0]
    route = fixture.get(path.split("?", 1)[0])
    if route is None:
        sys.stderr.write("gh: Not Found (HTTP 404)\\n")
        sys.exit(1)
    if "fail" in route:
        sys.stderr.write(route["fail"] + "\\n")
        sys.exit(1)
    if "--jq" in argv:
        for page in route["pages"]:
            for pr in page:
                print(str(pr["number"]) + "\\t" + pr["head"]["sha"])
        sys.exit(0)
    print(json.dumps(route["pages"] if "--slurp" in argv else route["pages"][0]))
    sys.exit(0)
sys.stderr.write("fake gh: unexpected call\\n")
sys.exit(2)
"""


def _run(run_id: int, head_sha: str, **overrides: Any) -> dict[str, Any]:
    row = {
        "id": run_id, "name": "aria-merge-authority",
        "path": ".github/workflows/aria-merge-authority.yml",
        "event": "pull_request", "status": "completed", "conclusion": "success",
        "head_sha": head_sha, "run_attempt": 1, "created_at": "2026-10-18T10:00:00Z",
    }
    row.update(overrides)
    return row


def _proof(run_id: int, attempt: int = 1, *, expired: bool = False) -> dict[str, Any]:
    return {
        "id": run_id + 900_000, "name": f"aria-merge-authority-proof-{run_id}-{attempt}",
        "expired": expired, "expires_at": "2026-10-25T10:00:00Z",
    }


class _FakeGitHub:
    """The repository as `gh` would show it: open PRs, runs, artifacts."""

    def __init__(self, test: unittest.TestCase) -> None:
        directory = tempfile.TemporaryDirectory(prefix="aria-claim-sweep-")
        test.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        gh = self.bin / "gh"
        gh.write_text(_FAKE_GH.format(python=sys.executable), encoding="utf-8")
        gh.chmod(0o755)
        self.fixture_path = self.root / "fixture.json"
        self.log_path = self.root / "gh.log"
        self.log_path.write_text("", encoding="utf-8")
        self.pulls: list[dict[str, Any]] = []
        self.runs: list[dict[str, Any]] = []
        self.artifacts: dict[int, list[dict[str, Any]]] = {}
        self.failures: dict[str, str] = {}
        environment = patch.dict(os.environ, {
            "PATH": f"{self.bin}:{os.defpath}",
            "ARIA_FAKE_GH_FIXTURE": str(self.fixture_path),
            "ARIA_FAKE_GH_LOG": str(self.log_path),
        })
        environment.start()
        test.addCleanup(environment.stop)

    def open_pr(self, number: int, head_sha: str) -> None:
        self.pulls.append({"number": number, "head": {"sha": head_sha}})

    def completed_run(self, run: dict[str, Any], *, proof: dict[str, Any] | None = None) -> None:
        self.runs.append(run)
        self.artifacts[run["id"]] = [] if proof is None else [proof]

    def write(self) -> None:
        routes: dict[str, Any] = {
            _PULLS: {"pages": [self.pulls]},
            _RUNS: {"pages": [{"total_count": len(self.runs), "workflow_runs": self.runs}]},
        }
        for run_id, artifacts in self.artifacts.items():
            routes[f"repos/{_REPO}/actions/runs/{run_id}/artifacts"] = {
                "pages": [{"total_count": len(artifacts), "artifacts": artifacts}],
            }
        for endpoint, reason in self.failures.items():
            routes[endpoint] = {"fail": reason}
        self.fixture_path.write_text(json.dumps(routes), encoding="utf-8")

    def calls(self) -> list[list[str]]:
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines()]


def _sweep(tools: Path, workspace: Path, *, now: datetime, limit: int = 1) -> tuple[int, dict]:
    argv = ["readiness", "sweep-claimless", "--workspace-root", str(workspace),
            "--limit", str(limit), "--tools-dir", str(tools)]
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()), \
            patch("aria_kernel.readiness_claim_sweep._utc_now", return_value=now):
        try:
            code = cli_main(argv) or 0
        except SystemExit as exc:  # argparse refuses an unknown verb
            code = int(exc.code or 0)
    text = out.getvalue()
    return code, (json.loads(text) if text.strip() else {})


def _claim_row(tools: Path, pr_number: int, head_sha: str) -> None:
    append_declared_jsonl(
        tools / "enterprise" / "readiness-claims.jsonl",
        {"readiness_claim_id": f"claim:{pr_number}:{head_sha[:12]}", "pr_number": pr_number,
         "head_sha": head_sha, "row_id": f"claim-row:{pr_number}", "row_type": "readiness_claim"},
        expected_surface="enterprise_readiness_claims",
        bypass_profile_gate=True,
    )


_NOW = datetime(2026, 10, 18, 12, 23, tzinfo=timezone.utc)
_A, _B, _C, _D = ("a" * 40, "b" * 40, "c" * 40, "d" * 40)


class SweepTests(unittest.TestCase):
    def setUp(self) -> None:
        self.github = _FakeGitHub(self)
        self.tools = ensure_tools_dir(self.github.root / "aria-tools")
        self.workspace = self.github.root / "workspace"
        self.workspace.mkdir()

    def test_a_claimless_head_with_a_green_merge_authority_run_is_the_target(self) -> None:
        # The claim lane yielded on the writer lease: the run is green, the
        # head is open, and no claim row names it.
        self.github.open_pr(77, _A)
        self.github.completed_run(_run(123456, _A), proof=_proof(123456))
        self.github.write()
        code, swept = _sweep(self.tools, self.workspace, now=_NOW)
        self.assertEqual(code, 0, swept)
        self.assertEqual(swept["targets"], [
            {"pr_number": 77, "head_sha": _A, "workflow_run_id": "123456", "run_attempt": 1},
        ])
        # The listing asked GitHub only for completed, green pull-request
        # runs created inside the proof artifact's retention.
        runs_call = next(c for c in self.github.calls() if any(_RUNS in a for a in c))
        query = next(a for a in runs_call if _RUNS in a).split("?", 1)[1]
        self.assertIn("event=pull_request", query)
        self.assertIn("status=success", query)
        self.assertIn("created=%3E%3D2026-10-11T12%3A23%3A00Z", query)
        self.assertIn("--paginate", runs_call)

    def test_a_claimed_head_is_not_swept_again(self) -> None:
        _claim_row(self.tools, 77, _A)
        self.github.open_pr(77, _A)
        self.github.completed_run(_run(123456, _A), proof=_proof(123456))
        self.github.write()
        code, swept = _sweep(self.tools, self.workspace, now=_NOW)
        self.assertEqual(code, 0)
        self.assertEqual(swept["targets"], [])
        self.assertEqual(swept["claimless"], [])

    def test_only_a_completed_green_pull_request_run_of_the_live_head_binds_it(self) -> None:
        self.github.open_pr(10, _A)
        self.github.open_pr(11, _B)
        self.github.open_pr(12, _C)
        self.github.open_pr(13, _D)
        self.github.completed_run(_run(1, _A, event="push"), proof=_proof(1))
        self.github.completed_run(_run(2, _B, conclusion="failure"), proof=_proof(2))
        self.github.completed_run(_run(3, _C, name="aria-kernel"), proof=_proof(3))
        # PR 13 was pushed since its run: the run tested an older head.
        self.github.completed_run(_run(4, "e" * 40), proof=_proof(4))
        self.github.write()
        code, swept = _sweep(self.tools, self.workspace, now=_NOW)
        self.assertEqual(code, 0)
        self.assertEqual(swept["targets"], [])
        self.assertEqual(
            sorted((row["pr_number"], row["reason"]) for row in swept["unclaimable"]),
            [(n, "merge_authority_run_absent") for n in (10, 11, 12, 13)],
        )

    def test_the_newest_attempt_binds_and_its_own_proof_artifact_must_be_published(self) -> None:
        self.github.open_pr(20, _A)
        self.github.open_pr(21, _B)
        # PR 20: the re-run attempt 2 is the run; only attempt 1's proof is
        # published, so it is not claimable.
        self.github.completed_run(_run(30, _A, run_attempt=2), proof=_proof(30, attempt=1))
        # PR 21: its proof expired.
        self.github.completed_run(_run(31, _B), proof=_proof(31, expired=True))
        self.github.write()
        code, swept = _sweep(self.tools, self.workspace, now=_NOW)
        self.assertEqual(code, 0)
        self.assertEqual(swept["targets"], [])
        self.assertEqual(
            sorted((row["pr_number"], row["reason"]) for row in swept["unclaimable"]),
            [(20, "merge_authority_proof_artifact_unavailable"),
             (21, "merge_authority_proof_artifact_unavailable")],
        )

    def test_an_unclaimable_head_does_not_starve_the_others(self) -> None:
        # Three claimable heads, one target per run: consecutive hourly runs
        # rotate through all of them, so a head whose claim keeps failing
        # cannot hold the backstop on itself.
        for number, head, run_id in ((40, _A, 50), (41, _B, 51), (42, _C, 52)):
            self.github.open_pr(number, head)
            self.github.completed_run(_run(run_id, head), proof=_proof(run_id))
        self.github.write()
        chosen = set()
        for hour in range(3):
            code, swept = _sweep(self.tools, self.workspace, now=_NOW + timedelta(hours=hour))
            self.assertEqual(code, 0)
            self.assertEqual(len(swept["targets"]), 1)
            chosen.add(swept["targets"][0]["pr_number"])
        self.assertEqual(chosen, {40, 41, 42})

    def test_an_unreadable_listing_is_a_named_failure_never_an_empty_sweep(self) -> None:
        self.github.open_pr(77, _A)
        self.github.failures[_RUNS] = "gh: Resource not accessible by integration (HTTP 403)"
        self.github.write()
        # The verb raises (the lane's step goes red by name); it never
        # prints a sweep with no targets.
        with self.assertRaisesRegex(GovernanceError, "actions_listing_failed:.*HTTP 403"):
            _sweep(self.tools, self.workspace, now=_NOW)


class ProofArtifactNameTests(unittest.TestCase):
    def test_the_sweep_names_the_artifact_the_lanes_upload_and_fetch(self) -> None:
        from aria_kernel.readiness_claim_sweep import merge_authority_proof_artifact_name

        workflows = Path(__file__).resolve().parents[2] / ".github" / "workflows"
        uploaded = (workflows / "aria-merge-authority.yml").read_text(encoding="utf-8")
        fetched = (workflows / "aria-readiness-claim.yml").read_text(encoding="utf-8")
        self.assertIn("name: aria-merge-authority-proof-${{ github.run_id }}-${{ github.run_attempt }}", uploaded)
        self.assertIn("aria-merge-authority-proof-${RUN_ID}-${attempt}", fetched)
        self.assertEqual(merge_authority_proof_artifact_name(7, 2), "aria-merge-authority-proof-7-2")


class BackstopClaimTests(_ClaimFixture):
    """The yielded head is claimed by the backstop, bound to the swept run."""

    def test_a_yielded_head_is_claimed_by_a_later_sweep(self) -> None:
        github = _FakeGitHub(self)
        github.open_pr(77, _HEAD)
        # The completed aria-merge-authority run the claim lane yielded on.
        github.completed_run(_run(123456, _HEAD), proof=_proof(123456))
        github.write()

        # The yield left nothing: no claim, so the merge lane has no candidate.
        class OpenHeads:
            def list_open_pull_request_heads(self) -> dict[int, str]:
                return {77: _HEAD}

        self.assertEqual(enumerate_prs_with_readiness_claims(OpenHeads(), base_dir=self.tools), [])

        code, swept = _sweep(self.tools, self.workspace, now=_NOW)
        self.assertEqual(code, 0, swept)
        (target,) = swept["targets"]
        self.assertEqual((target["pr_number"], target["head_sha"]), (77, _HEAD))
        # The claim is assembled for the swept run; the producer's guard
        # (readiness_claim_current_run_unproven) is what binds it.
        self.assertEqual(target["workflow_run_id"], "123456")
        produced = self._produce()
        self.assertFalse(produced["already_recorded"])
        self.assertIn(target["workflow_run_id"], produced["workflow_run_ids"])

        self.assertEqual(enumerate_prs_with_readiness_claims(OpenHeads(), base_dir=self.tools), [77])
        code, again = _sweep(self.tools, self.workspace, now=_NOW + timedelta(hours=1))
        self.assertEqual(code, 0)
        self.assertEqual(again["targets"], [])


if __name__ == "__main__":
    unittest.main()
