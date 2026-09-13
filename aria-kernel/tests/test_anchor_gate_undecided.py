"""The anchor gate's git is bounded by the probe session, and a non-answer is undecided.

`next_pending_request` refuses a candidate whose `target_sha` this checkout
cannot reach (ORPHAN-MEDIUM-492) — a TERMINAL verdict, written to the claims
ledger as `anchor_stale`. The two git probes behind it ran through a 5 s
`subprocess.run` that returned `False` when git did not answer, and the gate
read two `False`s as "the commit is not here AND the clone is not shallow":
one stalled git on a loaded runner marked a healthy request stale for good.

Pinned here:

* both probes run on ONE `GitProbeSession` per selection (bounded, retried,
  one clock for the whole poll);
* a non-answer is `AnchorVerdict(undecided=<reason>)`, never a refusal; the
  candidate is skipped, stays PENDING, and no `anchor_stale` row is written;
* age still decides without git: a request stale by age is refused even
  while git is not answering;
* a selection that could claim nothing AND could not decide something
  raises `AnchorVerificationUnavailable` — not "nothing pending" — after
  writing one `agent_request_anchor_undecided` governance row; the CLI turns
  it into a named stop the drain reads (`anchor_verification_unavailable`).
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import agent_invocations, evidence_probe
from aria_kernel.agent_invocations import (
    ANCHOR_UNDECIDED_GOVERNANCE_KIND,
    ANCHOR_VERIFICATION_UNAVAILABLE_STOP_REASON,
    AnchorVerdict,
    AnchorVerificationUnavailable,
    _anchor_refusal_reason,
    create_agent_invocation_request,
    derive_request_state,
    next_pending_request,
)
from aria_kernel.evidence_probe import PROBE_TIMEOUT, GitProbeSession
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor_drain  # noqa: E402

_REAL_GIT = shutil.which("git")


def _short_session() -> GitProbeSession:
    return GitProbeSession(
        attempt_timeout_seconds=0.2, attempts=2, backoff_seconds=(0.01,), liveness_seconds=5.0,
    )


class _StalledGit:
    """A `git` on PATH that stalls on the subcommands named and delegates the rest."""

    def __init__(self, *stall_on: str) -> None:
        self._stall_on = stall_on

    def __enter__(self) -> "_StalledGit":
        self._dir = Path(tempfile.mkdtemp(prefix="aria-stalled-git-"))
        cases = "|".join(f"*{verb}*" for verb in self._stall_on)
        fake = self._dir / "git"
        fake.write_text(
            "#!/bin/sh\n"
            f'case " $* " in {cases}) exec sleep 5;; esac\n'
            f'exec "{_REAL_GIT}" "$@"\n',
            encoding="utf-8",
        )
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self._env = mock.patch.dict(
            os.environ, {"PATH": f"{self._dir}{os.pathsep}{os.environ.get('PATH', '')}"},
        )
        self._env.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._env.stop()
        shutil.rmtree(self._dir, ignore_errors=True)


def _git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "commit.gpgsign=false", *args],
        cwd=str(root), text=True, capture_output=True, check=True,
    ).stdout.strip()


class _RepoWithTools:
    def __enter__(self) -> tuple[Path, Path, str]:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        _git(root, "init", "-q")
        _git(root, "config", "user.email", "test@example.com")
        _git(root, "config", "user.name", "Test User")
        (root / "seed.txt").write_text("seed\n", encoding="utf-8")
        _git(root, "add", "seed.txt")
        _git(root, "commit", "-q", "-m", "seed")
        tools = root / "aria-tools"
        ensure_tools_dir(tools)
        return root, tools, _git(root, "rev-parse", "HEAD")

    def __exit__(self, *exc: object) -> None:
        self._tmp.cleanup()


def _seed(tools: Path, *, target_sha: str | None, prompt: str = "plan it") -> dict:
    return create_agent_invocation_request(
        target_agent="aria-primary-planner",
        role="primary_plan",
        suggested_prompt=prompt,
        must_satisfy=[{"id": "anchor-test", "description": "request names its tree"}],
        allowed_scope=["aria-kernel/**"],
        target_sha=target_sha,
        base_dir=tools,
    )


def _set_anchor_window(repo_root: Path, *, max_age_seconds: int) -> None:
    config = repo_root / "aria-config"
    config.mkdir(parents=True, exist_ok=True)
    (config / "genesis_policy.json").write_text(
        json.dumps({"agent_request_anchor": {"max_age_seconds": max_age_seconds}}), encoding="utf-8",
    )


def _rows(tools: Path, name: str, surface: str) -> list[dict]:
    path = tools / name
    return load_declared_jsonl(path, expected_surface=surface) if path.exists() else []


class TheVerdictIsTriState(unittest.TestCase):
    def test_a_current_anchor_and_a_missing_one_are_decided_on_the_session(self) -> None:
        with _RepoWithTools() as (root, _tools, head):
            session = _short_session()
            current = _anchor_refusal_reason(
                {"target_sha": head, "created_at": "2099-01-01T00:00:00Z"}, root, probes=session,
            )
            self.assertEqual(current, AnchorVerdict())
            missing = _anchor_refusal_reason(
                {"target_sha": "0" * 40, "created_at": "2099-01-01T00:00:00Z"}, root, probes=session,
            )
            self.assertEqual(missing, AnchorVerdict(refusal="anchor_unreachable"))
            self.assertEqual(session.stalled_attempts, 0)

    def test_a_non_answer_is_undecided_not_unreachable(self) -> None:
        with _RepoWithTools() as (root, _tools, head):
            with _StalledGit("cat-file"):
                verdict = _anchor_refusal_reason(
                    {"target_sha": head, "created_at": "2099-01-01T00:00:00Z"},
                    root, probes=_short_session(),
                )
            self.assertEqual(verdict, AnchorVerdict(undecided=PROBE_TIMEOUT))
            self.assertIsNone(verdict.refusal)
            # The shallow probe stalling after an answered "not here" is the
            # same non-answer: absence alone never proves unreachability.
            with _StalledGit("is-shallow-repository"):
                verdict = _anchor_refusal_reason(
                    {"target_sha": "0" * 40, "created_at": "2099-01-01T00:00:00Z"},
                    root, probes=_short_session(),
                )
            self.assertEqual(verdict, AnchorVerdict(undecided=PROBE_TIMEOUT))

    def test_age_decides_without_git(self) -> None:
        with _RepoWithTools() as (root, _tools, head):
            with _StalledGit("cat-file"):
                verdict = _anchor_refusal_reason(
                    {"target_sha": head, "created_at": "2000-01-01T00:00:00Z"},
                    root, probes=_short_session(), max_age_seconds=1,
                )
            self.assertEqual(verdict, AnchorVerdict(refusal="anchor_expired"))


class TheSelectionSkipsWhatItCannotDecide(unittest.TestCase):
    def _short_sessions(self):
        # `next_pending_request` constructs its session by name at call time.
        return mock.patch.object(evidence_probe, "GitProbeSession", new=lambda **kw: _short_session())

    def test_nothing_claimable_and_something_undecided_is_named_not_empty(self) -> None:
        with _RepoWithTools() as (root, tools, head):
            req = _seed(tools, target_sha=head)
            with _StalledGit("cat-file"), self._short_sessions():
                with self.assertRaises(AnchorVerificationUnavailable) as caught:
                    next_pending_request(role="primary_plan", base_dir=tools)
            self.assertEqual(caught.exception.request_ids, [req["request_id"]])
            self.assertEqual(caught.exception.reasons, {req["request_id"]: PROBE_TIMEOUT})
            self.assertIn(ANCHOR_VERIFICATION_UNAVAILABLE_STOP_REASON, str(caught.exception))
            # PENDING, no terminal row, and one governance row saying why.
            self.assertEqual(derive_request_state(request_id=req["request_id"], base_dir=tools), "PENDING")
            claims = _rows(tools, "agent-invocations/claims.jsonl", "agent_invocation_claims")
            self.assertEqual([r for r in claims if r.get("event") == "anchor_stale"], [])
            governance = [
                r for r in _rows(tools, "governance.jsonl", "tools_governance")
                if r.get("kind") == ANCHOR_UNDECIDED_GOVERNANCE_KIND
            ]
            self.assertEqual(len(governance), 1)
            self.assertEqual(governance[0]["details"]["request_ids"], [req["request_id"]])
            self.assertIsNone(governance[0]["details"]["selected_request_id"])
            # Once git answers again the same request is claimable.
            nxt = next_pending_request(role="primary_plan", base_dir=tools)
            self.assertEqual(nxt["request_id"], req["request_id"])

    def test_an_undecided_candidate_does_not_hide_an_unanchored_one(self) -> None:
        with _RepoWithTools() as (root, tools, head):
            anchored = _seed(tools, target_sha=head, prompt="anchored")
            free = _seed(tools, target_sha=None, prompt="free")
            with _StalledGit("cat-file"), self._short_sessions():
                nxt = next_pending_request(role="primary_plan", base_dir=tools)
            self.assertEqual(nxt["request_id"], free["request_id"])
            self.assertEqual(derive_request_state(request_id=anchored["request_id"], base_dir=tools), "PENDING")
            governance = [
                r for r in _rows(tools, "governance.jsonl", "tools_governance")
                if r.get("kind") == ANCHOR_UNDECIDED_GOVERNANCE_KIND
            ]
            self.assertEqual(governance[0]["details"]["selected_request_id"], free["request_id"])

    def test_age_still_refuses_while_git_is_not_answering(self) -> None:
        with _RepoWithTools() as (root, tools, head):
            req = _seed(tools, target_sha=head)
            _set_anchor_window(root, max_age_seconds=0)
            with _StalledGit("cat-file"), self._short_sessions():
                self.assertIsNone(next_pending_request(role="primary_plan", base_dir=tools))
            self.assertEqual(derive_request_state(request_id=req["request_id"], base_dir=tools), "ANCHOR_STALE")

    def test_the_poll_path_has_no_git_of_its_own(self) -> None:
        # Source pin: the module spawns no subprocess; every probe is the
        # session's. The 5 s `_git_ok` is gone.
        source = Path(agent_invocations.__file__).read_text(encoding="utf-8")
        self.assertNotIn("def _git_ok", source)
        self.assertNotIn("subprocess.run(", source)
        self.assertNotIn("timeout=5", source)


class TheCliAndTheDrainNameTheStop(unittest.TestCase):
    def test_the_planner_dispatch_hook_reports_the_condition_without_raising(self) -> None:
        # The hook's contract: operational failures are a status dict, one
        # tick each, never a raise into the daemon loop — and never a second
        # probe clock spent on the next role for the same non-answer.
        from aria_kernel.planner_dispatch_hook import dispatch_one_pending_planner_request

        asked: list[str] = []

        def raising(*, role, base_dir):
            asked.append(role)
            raise AnchorVerificationUnavailable(request_ids=["AIR-9"], reasons={"AIR-9": PROBE_TIMEOUT})

        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            agent_invocations, "next_pending_request", new=raising,
        ):
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            tick = dispatch_one_pending_planner_request(
                base_dir=tools, agent_id="planner-1", planner_roles=("primary_plan", "challenger_plan"),
            )
        self.assertEqual(tick["status"], "anchor_undecided")
        self.assertEqual(tick["undecided_request_ids"], ["AIR-9"])
        self.assertIsNone(tick["request_id"])
        self.assertEqual(asked, ["primary_plan"])

    def test_the_cli_prints_a_structured_stop_and_exits_non_zero(self) -> None:
        from aria_kernel import cli

        with _RepoWithTools() as (root, tools, head):
            _seed(tools, target_sha=head)
            with _StalledGit("cat-file"), mock.patch.object(
                evidence_probe, "GitProbeSession", new=lambda **kw: _short_session(),
            ), mock.patch("sys.stdout") as stdout:
                rc = cli.main(["--tools-dir", str(tools), "agent", "next-pending", "--role", "primary_plan"])
        self.assertEqual(rc, 1)
        printed = "".join(call.args[0] for call in stdout.write.call_args_list)
        payload = json.loads(printed)
        self.assertEqual(payload["stop_reason"], ANCHOR_VERIFICATION_UNAVAILABLE_STOP_REASON)
        self.assertEqual(len(payload["undecided_request_ids"]), 1)

    def test_the_drain_reads_the_named_stop(self) -> None:
        stop = json.dumps({
            "stop_reason": ANCHOR_VERIFICATION_UNAVAILABLE_STOP_REASON,
            "undecided_request_ids": ["AIR-1"],
            "reasons": {"AIR-1": PROBE_TIMEOUT},
        })

        class _Proc:
            returncode = 1
            stdout = stop
            stderr = ""

        with mock.patch.object(ci_executor_drain.subprocess, "run", return_value=_Proc()):
            candidate, error = ci_executor_drain._next_pending_for_role(
                tools_dir=Path("/nonexistent"), repo_root=_REPO_ROOT, role_filter=None, attempted=set(),
            )
        self.assertIsNone(candidate)
        self.assertEqual(error, ANCHOR_VERIFICATION_UNAVAILABLE_STOP_REASON)

        class _Crash:
            returncode = 1
            stdout = "Traceback ..."
            stderr = "boom"

        with mock.patch.object(ci_executor_drain.subprocess, "run", return_value=_Crash()):
            _candidate, error = ci_executor_drain._next_pending_for_role(
                tools_dir=Path("/nonexistent"), repo_root=_REPO_ROOT, role_filter=None, attempted=set(),
            )
        self.assertEqual(error, "next_pending_failed")


if __name__ == "__main__":
    unittest.main()
