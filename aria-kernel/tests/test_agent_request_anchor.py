"""ORPHAN-MEDIUM-492 — a request may only be claimed against the tree it names.

``target_sha`` has always been minted onto the request row (it is the commit
the plan's evidence is grounded at, see
``convergence_drainer._resolve_workspace_head_sha``) and hashed into the
context envelope. Nothing on the selection path ever read it, so
``next_pending_request`` returned the oldest PENDING row regardless of whether
the repo had moved underneath it.

That is not hypothetical: ORPHAN-CRITICAL-469 stranded ~20 requests in the live
``aria-tools-state`` artifact, minted before 2026-07-17 against a tree that is
now 60+ commits back. With the queue bridge repaired, the first executor run
would have claimed one and dispatched an agent against a plan that no longer
describes the repo.
"""
from __future__ import annotations

import contextlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    create_agent_invocation_request,
    derive_request_state,
    next_pending_request,
)
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir


def _git(root: Path, *args: str) -> str:
    completed = subprocess.run(
        # commit.gpgsign is true in this environment's global config, and a
        # fixture repo has no signing key. Without the override `git commit`
        # exits 128 and the test reddens for a reason unrelated to what it
        # asserts -- the same class of untrustworthy signal as a gate that
        # reports ok while blocked.
        ["git", "-c", "commit.gpgsign=false", *args],
        cwd=str(root),
        text=True,
        capture_output=True,
        check=True,
    )
    return completed.stdout.strip()


@contextlib.contextmanager
def _repo_with_tools():
    """A real git work tree with the tools dir INSIDE it.

    The anchor is resolved from the tools dir, so the tools dir has to live in
    the repo for enforcement to engage -- which is exactly the production
    layout (``--tools-dir aria-tools`` under the checkout).
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _git(root, "init", "-q")
        _git(root, "config", "user.email", "test@example.com")
        _git(root, "config", "user.name", "Test User")
        (root / "seed.txt").write_text("seed\n", encoding="utf-8")
        _git(root, "add", "seed.txt")
        _git(root, "commit", "-q", "-m", "seed")
        head = _git(root, "rev-parse", "HEAD")
        tools = root / "aria-tools"
        ensure_tools_dir(tools)
        yield root, tools, head


def _seed(tools: Path, *, target_sha: str | None, prompt: str = "plan it") -> dict:
    return create_agent_invocation_request(
        target_agent="aria-primary-planner",
        role="primary_plan",
        suggested_prompt=prompt,
        must_satisfy=[{"id": "anchor-test", "criterion": "request names its tree"}],
        allowed_scope=["aria-kernel/**"],
        target_sha=target_sha,
        base_dir=tools,
    )


def _set_anchor_window(repo_root: Path, *, max_age_seconds: int) -> None:
    """Operator override, at the path genesis_policy actually reads."""
    config = repo_root / "aria-config"
    config.mkdir(parents=True, exist_ok=True)
    (config / "genesis_policy.json").write_text(
        json.dumps({"agent_request_anchor": {"max_age_seconds": max_age_seconds}}),
        encoding="utf-8",
    )


def _claim_events(tools: Path, request_id: str) -> list[dict]:
    return [
        row
        for row in load_declared_jsonl(
            tools / "agent-invocations" / "claims.jsonl",
            expected_surface="agent_invocation_claims",
        )
        if row.get("request_id") == request_id
    ]


class AnchorGateTests(unittest.TestCase):
    def test_current_anchor_is_still_returned(self) -> None:
        # The acceptance direction. A gate that refused everything would
        # "fix" the stale queue by making ARIA unable to run at all.
        with _repo_with_tools() as (_root, tools, head):
            req = _seed(tools, target_sha=head)
            nxt = next_pending_request(role="primary_plan", base_dir=tools)
            self.assertIsNotNone(nxt)
            self.assertEqual(nxt["request_id"], req["request_id"])

    def test_request_without_an_anchor_is_refused(self) -> None:
        # The ~20 stranded rows predate the field entirely.
        with _repo_with_tools() as (_root, tools, _head):
            req = _seed(tools, target_sha=None)
            self.assertIsNone(next_pending_request(role="primary_plan", base_dir=tools))
            self.assertEqual(
                derive_request_state(request_id=req["request_id"], base_dir=tools),
                "ANCHOR_STALE",
            )

    def test_request_anchored_to_an_unknown_commit_is_refused(self) -> None:
        # Force-push / rebase / a tree this checkout never had.
        with _repo_with_tools() as (_root, tools, _head):
            req = _seed(tools, target_sha="0" * 40)
            self.assertIsNone(next_pending_request(role="primary_plan", base_dir=tools))
            self.assertEqual(
                derive_request_state(request_id=req["request_id"], base_dir=tools),
                "ANCHOR_STALE",
            )

    def test_reachable_but_expired_anchor_is_refused(self) -> None:
        """The live case, and the reason reachability alone is not enough.

        The stranded requests are anchored at commits that ARE ancestors of
        HEAD -- same branch, just 60+ commits back. A gate that only asked
        "does this commit exist" would have passed every one of them.
        """
        with _repo_with_tools() as (root, tools, head):
            req = _seed(tools, target_sha=head)
            # The window is operator policy, so the test moves the window
            # rather than the request. Ageing created_at in place is not an
            # option and should not be: requests.jsonl is hash-chained and
            # rewriting it raises LedgerIntegrityError -- the integrity gate
            # doing its job.
            _set_anchor_window(root, max_age_seconds=0)

            self.assertIsNone(next_pending_request(role="primary_plan", base_dir=tools))
            self.assertEqual(
                derive_request_state(request_id=req["request_id"], base_dir=tools),
                "ANCHOR_STALE",
            )

    def test_refusal_is_recorded_exactly_once_across_polls(self) -> None:
        """The executor polls; the ledger must not grow per poll.

        This is why the refusal is written as a terminal ledger event rather
        than recomputed: after the first refusal the request stops being a
        PENDING candidate, so the git evaluation never runs for it again.
        """
        with _repo_with_tools() as (_root, tools, _head):
            req = _seed(tools, target_sha=None)
            for _ in range(4):
                self.assertIsNone(
                    next_pending_request(role="primary_plan", base_dir=tools)
                )
            events = [
                row
                for row in _claim_events(tools, req["request_id"])
                if row.get("event") == "anchor_stale"
            ]
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["reason"], "anchor_missing")

    def test_a_stale_request_does_not_hide_a_current_one_behind_it(self) -> None:
        # Ordering: the stale row is OLDER, so it is inspected first. If the
        # gate returned None on the first refusal instead of continuing, a
        # healthy request would starve behind a poisoned one.
        with _repo_with_tools() as (_root, tools, head):
            stale = _seed(tools, target_sha=None, prompt="stale-one")
            good = _seed(tools, target_sha=head, prompt="good-one")
            nxt = next_pending_request(role="primary_plan", base_dir=tools)
            self.assertIsNotNone(nxt)
            self.assertEqual(nxt["request_id"], good["request_id"])
            self.assertEqual(
                derive_request_state(request_id=stale["request_id"], base_dir=tools),
                "ANCHOR_STALE",
            )

    def test_shallow_clone_does_not_kill_a_cross_run_request(self) -> None:
        """The production layout, and the case that nearly made this worse.

        `actions/checkout` defaults to fetch-depth: 1 and neither ARIA lane
        overrides it, so a request minted by the 01:00 producer and consumed
        by the 02:00 executor has an anchor that is simply ABSENT from the
        consumer's clone. Reading that absence as "unreachable" would mark
        every cross-run request terminally ANCHOR_STALE and destroy the queue
        ORPHAN-CRITICAL-469 exists to carry — irreversibly, since the state is
        terminal. Absence in a partial clone is not evidence of absence.
        """
        with _repo_with_tools() as (root, tools, head):
            # A second commit, then a shallow re-clone that keeps only the
            # tip: `head` is now a real ancestor that this clone cannot see.
            (root / "second.txt").write_text("second\n", encoding="utf-8")
            _git(root, "add", "second.txt")
            _git(root, "commit", "-q", "-m", "second")

            with tempfile.TemporaryDirectory() as shallow_tmp:
                shallow = Path(shallow_tmp) / "shallow"
                _git(
                    Path(shallow_tmp), "clone", "--depth", "1",
                    f"file://{root}", str(shallow),
                )
                self.assertEqual(
                    _git(shallow, "rev-parse", "--is-shallow-repository"), "true"
                )
                self.assertFalse(
                    subprocess.run(
                        ["git", "cat-file", "-e", f"{head}^{{commit}}"],
                        cwd=str(shallow), capture_output=True,
                    ).returncode == 0,
                    "fixture precondition: the old anchor must be absent here",
                )
                shallow_tools = shallow / "aria-tools"
                ensure_tools_dir(shallow_tools)
                req = _seed(shallow_tools, target_sha=head)

                nxt = next_pending_request(
                    role="primary_plan", base_dir=shallow_tools
                )
                self.assertIsNotNone(
                    nxt, "a cross-run request must survive a shallow checkout"
                )
                self.assertEqual(nxt["request_id"], req["request_id"])

    def test_shallow_clone_still_refuses_an_aged_request(self) -> None:
        # The guard above must not become a blanket exemption: age needs no
        # history, so the stale-queue case this whole finding is about is
        # still caught on exactly the checkout production uses.
        with _repo_with_tools() as (root, tools, head):
            with tempfile.TemporaryDirectory() as shallow_tmp:
                shallow = Path(shallow_tmp) / "shallow"
                _git(
                    Path(shallow_tmp), "clone", "--depth", "1",
                    f"file://{root}", str(shallow),
                )
                shallow_tools = shallow / "aria-tools"
                ensure_tools_dir(shallow_tools)
                req = _seed(shallow_tools, target_sha=head)
                _set_anchor_window(shallow, max_age_seconds=0)

                self.assertIsNone(
                    next_pending_request(role="primary_plan", base_dir=shallow_tools)
                )
                self.assertEqual(
                    derive_request_state(
                        request_id=req["request_id"], base_dir=shallow_tools
                    ),
                    "ANCHOR_STALE",
                )

    def test_enforcement_is_off_when_there_is_no_repo_to_be_stale_against(self) -> None:
        # A tools dir outside any work tree has no tree the request could be
        # stale relative to, so queue semantics are unchanged. This is what
        # keeps the existing lease-lifecycle fixtures meaningful.
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            req = _seed(tools, target_sha=None)
            nxt = next_pending_request(role="primary_plan", base_dir=tools)
            self.assertIsNotNone(nxt)
            self.assertEqual(nxt["request_id"], req["request_id"])


if __name__ == "__main__":
    unittest.main()
