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
    ANCHOR_HISTORY_UNAVAILABLE,
    _anchor_repo_root,
    create_agent_invocation_request,
    derive_request_state,
    next_pending_request,
)
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


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
    def test_normal_worktree_marker_resolves_repository_root(self) -> None:
        with _repo_with_tools() as (root, tools, _head):
            self.assertEqual(_anchor_repo_root(tools), root.resolve())

    def test_linked_worktree_marker_resolves_repository_root(self) -> None:
        """A linked worktree stores a gitdir pointer in its .git file."""
        with tempfile.TemporaryDirectory() as tmp:
            common = Path(tmp) / "common"
            common.mkdir()
            _git(common, "init", "-q")
            _git(common, "config", "user.email", "test@example.com")
            _git(common, "config", "user.name", "Test User")
            (common / "seed.txt").write_text("seed\n", encoding="utf-8")
            _git(common, "add", "seed.txt")
            _git(common, "commit", "-q", "-m", "seed")

            linked = Path(tmp) / "linked"
            _git(
                common,
                "worktree",
                "add",
                "-q",
                "--detach",
                str(linked),
                "HEAD",
            )
            self.assertTrue((linked / ".git").is_file())
            tools = linked / "aria-tools"
            ensure_tools_dir(tools)

            self.assertEqual(_anchor_repo_root(tools), linked.resolve())

    def test_empty_git_directory_does_not_activate_anchor_enforcement(self) -> None:
        """A host-owned empty .git ancestor is not a repository authority."""
        with tempfile.TemporaryDirectory() as tmp:
            false_root = Path(tmp) / "not-a-repository"
            false_root.mkdir()
            (false_root / ".git").mkdir()
            tools = false_root / "aria-tools"
            ensure_tools_dir(tools)
            _set_anchor_window(false_root, max_age_seconds=0)
            req = _seed(tools, target_sha=None)

            self.assertIsNone(_anchor_repo_root(tools))
            nxt = next_pending_request(role="primary_plan", base_dir=tools)
            self.assertIsNotNone(nxt)
            self.assertEqual(nxt["request_id"], req["request_id"])
            self.assertEqual(
                derive_request_state(request_id=req["request_id"], base_dir=tools),
                "PENDING",
            )
            self.assertEqual(_claim_events(tools, req["request_id"]), [])

    def test_malformed_or_broken_gitdir_pointer_is_not_a_repository(self) -> None:
        marker_contents = (
            "",
            "not-a-gitdir-pointer\n",
            "gitdir:\n",
            "gitdir: missing-git-directory\n",
        )
        for content in marker_contents:
            with self.subTest(content=content), tempfile.TemporaryDirectory() as tmp:
                false_root = Path(tmp) / "not-a-repository"
                false_root.mkdir()
                (false_root / ".git").write_text(content, encoding="utf-8")
                tools = false_root / "aria-tools"
                ensure_tools_dir(tools)

                self.assertIsNone(_anchor_repo_root(tools))

    def test_current_anchor_is_still_returned(self) -> None:
        # The acceptance direction. A gate that refused everything would
        # "fix" the stale queue by making ARIA unable to run at all.
        with _repo_with_tools() as (_root, tools, head):
            req = _seed(tools, target_sha=head)
            nxt = next_pending_request(role="primary_plan", base_dir=tools)
            self.assertIsNotNone(nxt)
            self.assertEqual(nxt["request_id"], req["request_id"])

    def test_request_without_an_anchor_is_still_claimable(self) -> None:
        """ORPHAN-CRITICAL-495 — absence of a SHA is not grounds for refusal.

        Only 6 of 17 mint paths pass target_sha. The other 11 include this
        branch's own HUMAN_REQUIRED adjudication panel
        (human_required_adjudication.py:226) and the operator's
        `aria-kernel agent request` CLI (cli.py:2951). Refusing on a missing
        anchor marked all of them terminally ANCHOR_STALE — a guard that
        kills the queue it was written to protect.
        """
        with _repo_with_tools() as (_root, tools, _head):
            req = _seed(tools, target_sha=None)
            nxt = next_pending_request(role="primary_plan", base_dir=tools)
            self.assertIsNotNone(nxt, "an unanchored request must remain claimable")
            self.assertEqual(nxt["request_id"], req["request_id"])
            self.assertEqual(
                derive_request_state(request_id=req["request_id"], base_dir=tools),
                "PENDING",
            )

    def test_an_unanchored_request_is_still_refused_once_it_ages_out(self) -> None:
        # Age is what actually clears the stranded queue, and it needs no
        # anchor: created_at is on every row. So the ~20 pre-07-17 requests
        # are caught whether or not they carry a SHA.
        with _repo_with_tools() as (root, tools, _head):
            req = _seed(tools, target_sha=None)
            _set_anchor_window(root, max_age_seconds=0)
            self.assertIsNone(next_pending_request(role="primary_plan", base_dir=tools))
            self.assertEqual(
                derive_request_state(request_id=req["request_id"], base_dir=tools),
                "ANCHOR_STALE",
            )

    def test_request_anchored_to_an_unknown_commit_is_refused(self) -> None:
        # Force-push / rebase / a tree this checkout never had. The fixture
        # clone is WHOLE (git init, not a depth-limited clone), so the
        # fabricated sha's absence is a fact and is recorded as one.
        with _repo_with_tools() as (root, tools, _head):
            self.assertEqual(_git(root, "rev-parse", "--is-shallow-repository"), "false")
            req = _seed(tools, target_sha="0" * 40)
            self.assertIsNone(next_pending_request(role="primary_plan", base_dir=tools))
            self.assertEqual(
                derive_request_state(request_id=req["request_id"], base_dir=tools),
                "ANCHOR_STALE",
            )
            events = _claim_events(tools, req["request_id"])
            self.assertEqual([e["reason"] for e in events], ["anchor_unreachable"])

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
            req = _seed(tools, target_sha="0" * 40)
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
            self.assertEqual(events[0]["reason"], "anchor_unreachable")

    def test_a_stale_request_does_not_hide_a_current_one_behind_it(self) -> None:
        # Ordering: the stale row is OLDER, so it is inspected first. If the
        # gate returned None on the first refusal instead of continuing, a
        # healthy request would starve behind a poisoned one.
        with _repo_with_tools() as (_root, tools, head):
            stale = _seed(tools, target_sha="0" * 40, prompt="stale-one")
            good = _seed(tools, target_sha=head, prompt="good-one")
            nxt = next_pending_request(role="primary_plan", base_dir=tools)
            self.assertIsNotNone(nxt)
            self.assertEqual(nxt["request_id"], good["request_id"])
            self.assertEqual(
                derive_request_state(request_id=stale["request_id"], base_dir=tools),
                "ANCHOR_STALE",
            )

    def test_an_anchor_absent_from_a_shallow_clone_is_refused_by_name_and_nothing_is_written(self) -> None:
        """A commit cut by the clone depth is not a commit that never existed.

        Every reason the gate returns is written as a terminal ANCHOR_STALE
        event, so on a shallow clone "absent" must not be returned at all:
        the gate cannot tell a force-pushed-away anchor from one the clone
        simply does not reach, and a guess written as a terminal fact is
        irreversible. The gate raises ``GovernanceError`` naming
        ``ANCHOR_HISTORY_UNAVAILABLE`` instead — the same probe the twin
        refuses with (``git_probe``) — and the ledger is untouched, so the
        executor fails loudly and the request is judged for real once the
        operator unshallows the clone.

        History: until 2026-09-12 the lanes ran on actions/checkout's
        depth-1 default and this arm was softened by the same probe, so the
        01:00 producer's requests survived to the 02:00 consumer
        (ORPHAN-CRITICAL-469). The lanes now check out the whole history
        (``fetch-depth: 0``, pinned by
        tests/invariants/test_kernel_lanes_check_out_full_history.py); a
        clone that does not hold it is refused, not judged.
        """
        with _repo_with_tools() as (root, tools, head):
            # A second commit, then a shallow re-clone that keeps only the
            # tip: `head` is a real ancestor that this clone does not hold.
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

                with self.assertRaises(GovernanceError) as refused:
                    next_pending_request(role="primary_plan", base_dir=shallow_tools)
                self.assertTrue(
                    str(refused.exception).startswith(f"{ANCHOR_HISTORY_UNAVAILABLE}: "),
                    str(refused.exception),
                )
                self.assertIn(head, str(refused.exception))
                # Nothing recorded: no claim event, no terminal state, no
                # governance row. The request is still PENDING for the
                # whole clone to judge.
                self.assertEqual(_claim_events(shallow_tools, req["request_id"]), [])
                self.assertEqual(
                    derive_request_state(request_id=req["request_id"], base_dir=shallow_tools),
                    "PENDING",
                )
                governance = shallow_tools / "governance.jsonl"
                self.assertNotIn(
                    "agent_request_refused_stale_anchor",
                    governance.read_text(encoding="utf-8") if governance.exists() else "",
                )

                # The refusal is the checkout's, not the request's: once the
                # clone is whole the same request is judged, and the anchor
                # it names is an ancestor of HEAD — so it is current.
                _git(shallow, "fetch", "-q", "--unshallow")
                self.assertEqual(
                    _git(shallow, "rev-parse", "--is-shallow-repository"), "false"
                )
                nxt = next_pending_request(role="primary_plan", base_dir=shallow_tools)
                self.assertIsNotNone(nxt)
                self.assertEqual(nxt["request_id"], req["request_id"])

    def test_shallow_clone_still_refuses_an_aged_request(self) -> None:
        # Age needs no history: the tip IS the anchor here, so the clone
        # holds it, and the request is refused for its age alone.
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
