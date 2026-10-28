"""WP-D1 — the hermetic single-change entry: cycle mode ``change_review``.

DESIGN-discovery §(b) step 0 and row D1: a new cycle mode takes one change
``(base, head)`` plus an explicit store and runs the production loop for that
one subject without GitHub. Today the only way to review one commit is the
decision-test script's Stage J, which imports private kernel functions
(``_select_findings``, ``_sample_id``, ``_resolve_workspace_head_sha``) and
re-implements the judgment pipeline beside the kernel — a second entrance.

Red tests, on a fixture repository with two commits and an empty store:

  (i)   a missing or unresolvable base or head is refused BY NAME, before the
        lifecycle ledger records a cycle that never was;
  (ii)  only the ``change_review`` phase set runs — every other phase is a
        recorded ``mode_not_included:change_review`` skip, and no GitHub phase
        is in the set;
  (iii) a GitHub-env and network tripwire stays untouched for a whole run;
  (iv)  a second invocation on the same subject mints nothing new
        (idempotency stays ``minted_subject_refs``: no new ledger);
  (v)   admission admits an operator subject on an empty store — the producer
        ``change_review.operator_subject`` is critical_path, so a room run is
        never held at the door (DESIGN risk 6), while
        ``change_review.merge_feed`` is discretionary.

Plus the CLI front door: ``cycle run --mode change_review --change-base B
--change-head H`` reaches ``run_cycle`` with the subject, and the default
mode stays ``standard`` so the nightly invocation is unchanged.

New API pinned here (red at the base because it does not exist yet): the
``change_review`` member of ``CYCLE_MODES``, the ``change_base`` /
``change_head`` keyword arguments of ``run_enterprise_cycle``, the subject
name ``change:<base>..<head>``, the two producers, and the three CLI flags.
Every test reaches that API only after an assertion on it, so the red is an
assertion failure, never an import or collection error.
"""

from __future__ import annotations

import contextlib
import io
import os
import shutil
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import cli as cli_mod
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.cycle import CYCLE_MODES, CYCLE_PHASES, run_enterprise_cycle
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.pr_tracking import CHANGE_INTELLIGENCE_ROLE
from aria_kernel.request_admission import (
    ADMISSIONS_SURFACE,
    CRITICAL_PATH,
    DISCRETIONARY,
    PRODUCER_CLASSES,
    admissions_path,
    admit_request,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

MODE = "change_review"
OPERATOR_PRODUCER = "change_review.operator_subject"
MERGE_FEED_PRODUCER = "change_review.merge_feed"
# The phases that talk to GitHub (HARNESS §2.4: the only GitHub users among
# the cycle phases). The room has no GitHub, so neither may be in the set.
GITHUB_PHASES = ("pr_ci_scan", "pr_lifecycle")
TRIPWIRE_TOKEN = "aria-d1-tripwire-token-6c1f0e"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True,
    ).stdout.strip()


def _two_commit_repo(root: Path) -> tuple[Path, str, str]:
    """A repository whose history is exactly one change: base, then head."""
    repo = root / "repo"
    (repo / "apps" / "orders" / "src").mkdir(parents=True)
    _git(repo, "init", "-q", "--initial-branch=main")
    _git(repo, "config", "user.email", "fixture@aria.test")
    _git(repo, "config", "user.name", "Aria Fixture")
    _git(repo, "config", "gc.auto", "0")
    source = repo / "apps" / "orders" / "src" / "order.ts"
    source.write_text("export const total = (a: number, b: number): number => a + b;\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "base: order total")
    base = _git(repo, "rev-parse", "HEAD")
    source.write_text("export const total = (a: number, b: number): number => a - b;\n", encoding="utf-8")
    _git(repo, "commit", "-q", "-am", "head: change order total")
    head = _git(repo, "rev-parse", "HEAD")
    return repo, base, head


class _ChangeReviewFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-change-review-"))
        self.repo, self.base, self.head = _two_commit_repo(self.tmp)
        self.tools = self.tmp / "aria-tools"
        self.workspace_base = self.tmp / "ws"
        self.subject = f"change:{self.base}..{self.head}"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _require_mode(self) -> None:
        self.assertIn(
            MODE, CYCLE_MODES,
            "cycle mode `change_review` is not in the closed vocabulary — "
            "one change cannot be reviewed through the kernel's own entry",
        )

    def _run(self, cycle_id: str, *, tools: Path | None = None, **subject: Any) -> dict[str, Any]:
        self._require_mode()
        if not subject:
            subject = {"change_base": self.base, "change_head": self.head}
        return run_enterprise_cycle(
            workspace_root=self.repo,
            cycle_id=cycle_id,
            base_dir=tools or self.tools,
            workspace_base=self.workspace_base,
            mode=MODE,
            **subject,
        )

    def _subject_requests(self) -> list[dict[str, Any]]:
        return [
            row for row in list_agent_invocation_requests(base_dir=self.tools, role=CHANGE_INTELLIGENCE_ROLE)
            if row.get("subject_ref") == self.subject
        ]


class ModeDeclarationTests(unittest.TestCase):
    def test_change_review_is_a_member_of_the_closed_mode_vocabulary(self) -> None:
        self.assertIn(MODE, CYCLE_MODES)

    def test_the_change_review_set_carries_the_change_owner_and_no_github_phase(self) -> None:
        tagged = {phase.name for phase in CYCLE_PHASES if MODE in phase.modes}
        self.assertIn(
            "change_intelligence", tagged,
            "the change-review owner (pr_tracking.dispatch_change_intelligence) "
            "runs through this phase; without it the mode reviews nothing",
        )
        for name in GITHUB_PHASES:
            with self.subTest(phase=name):
                self.assertNotIn(name, tagged, "the room has no GitHub; a GitHub phase cannot be in the set")


class SubjectRefusalTests(_ChangeReviewFixture):
    """(i) A change review without both ends of the change is refused by name."""

    def test_a_missing_or_unresolvable_end_is_refused_by_name_before_any_ledger_write(self) -> None:
        self._require_mode()
        absent_sha = "0" * 40
        cases = (
            ("change_base", {"change_head": self.head}),
            ("change_head", {"change_base": self.base}),
            ("change_base", {"change_base": absent_sha, "change_head": self.head}),
            ("change_head", {"change_base": self.base, "change_head": absent_sha}),
        )
        for index, (named, subject) in enumerate(cases):
            with self.subTest(named=named, subject=sorted(subject)):
                tools = self.tmp / f"tools-refusal-{index}"
                with self.assertRaises(GovernanceError) as ctx:
                    self._run(f"cr-refused-{index}", tools=tools, **subject)
                self.assertIn(named, str(ctx.exception), "the refusal must name the end that is missing")
                self.assertFalse(
                    (tools / "cycles.jsonl").exists(),
                    "a refused subject must not leave a started row for a cycle that never ran",
                )


class ChangeReviewRunTests(_ChangeReviewFixture):
    def test_only_the_change_review_phase_set_runs(self) -> None:
        """(ii) every phase outside the set is a skip that names the mode."""
        state = self._run("cr-phase-set")
        self.assertEqual(state["status"], "completed", state.get("failed_phases"))
        tagged = {phase.name for phase in CYCLE_PHASES if MODE in phase.modes}
        ran = {name for name, outcome in state["phases"].items() if outcome["outcome"] == "ran"}
        self.assertIn("change_intelligence", ran)
        self.assertLessEqual(ran, tagged, f"phases outside the change_review set ran: {sorted(ran - tagged)}")
        for phase in CYCLE_PHASES:
            if phase.name in tagged:
                continue
            with self.subTest(phase=phase.name):
                outcome = state["phases"][phase.name]
                self.assertEqual(outcome["outcome"], "skipped")
                self.assertEqual(outcome["reason"], f"mode_not_included:{MODE}")

    def test_an_operator_subject_is_admitted_and_minted_on_an_empty_store(self) -> None:
        """(v) end to end: the room's subject is not held at the door."""
        self._run("cr-admit")
        requests = self._subject_requests()
        # SE-5 — the change touches one service (apps/orders): its service seat and the lens, both for the subject.
        self.assertEqual(len(requests), 2, "two change-intelligence requests (service seat, lens) for the operator's subject")
        for request in requests:
            self.assertEqual(request.get("target_sha"), self.head, "the change is reviewed at its head")
            minted = [
                row for row in load_declared_jsonl(admissions_path(self.tools), expected_surface=ADMISSIONS_SURFACE)
                if row.get("row_type") == "minted" and row.get("request_id") == request.get("request_id")
            ]
            self.assertEqual([(row.get("producer"), row.get("purpose_class")) for row in minted],
                             [(OPERATOR_PRODUCER, CRITICAL_PATH)])

    def test_a_second_invocation_on_the_same_subject_mints_nothing_new(self) -> None:
        """(iv) cycle → drain → cycle: the second cycle re-asks nothing."""
        self._run("cr-first")
        first = [row.get("request_id") for row in list_agent_invocation_requests(base_dir=self.tools)]
        self.assertEqual(len(self._subject_requests()), 2, "the first invocation mints the subject's two seats")
        self._run("cr-second")
        second = [row.get("request_id") for row in list_agent_invocation_requests(base_dir=self.tools)]
        self.assertEqual(second, first, "a second invocation on the same subject minted new requests")


class _Tripwire:
    """GitHub credentials, a `gh`/`curl` on PATH, a git remote and the socket
    layer, each wired to record any use. "Untouched" means every record is
    empty after a whole change-review cycle and the token appears in no file
    the run wrote."""

    def __init__(self, root: Path, repo: Path) -> None:
        self.root, self.repo = root, repo
        self.calls = root / "tripwire-calls.log"
        self.network: list[str] = []
        self._stack = contextlib.ExitStack()

    def __enter__(self) -> "_Tripwire":
        bin_dir = self.root / "tripwire-bin"
        bin_dir.mkdir()
        recorder = f'#!/bin/sh\necho "$0 $*" >> "{self.calls}"\nexit 1\n'
        for name in ("gh", "curl", "wget", "ssh", "git-upload-pack-tripwire", "git-receive-pack-tripwire"):
            path = bin_dir / name
            path.write_text(recorder, encoding="utf-8")
            path.chmod(0o755)
        remote = self.root / "origin.git"
        _git(self.root, "init", "-q", "--bare", str(remote))
        _git(self.repo, "remote", "add", "origin", str(remote))
        _git(self.repo, "config", "remote.origin.uploadpack", str(bin_dir / "git-upload-pack-tripwire"))
        _git(self.repo, "config", "remote.origin.receivepack", str(bin_dir / "git-receive-pack-tripwire"))
        self._stack.enter_context(mock.patch.dict(os.environ, {
            "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
            "GH_TOKEN": TRIPWIRE_TOKEN,
            "GITHUB_TOKEN": TRIPWIRE_TOKEN,
            "GITHUB_REPOSITORY": "aria-tripwire/fixture",
            "GH_CONFIG_DIR": str(self.root / "tripwire-gh"),
        }))
        real_connect, real_connect_ex = socket.socket.connect, socket.socket.connect_ex

        def _guard(real):
            def guarded(sock, address):
                if sock.family in (socket.AF_INET, socket.AF_INET6):
                    self.network.append(f"connect {address!r}")
                    raise OSError("aria-d1 network tripwire")
                return real(sock, address)
            return guarded

        def _lookup(host, *args, **kwargs):
            self.network.append(f"getaddrinfo {host!r}")
            raise socket.gaierror("aria-d1 network tripwire")

        self._stack.enter_context(mock.patch.object(socket.socket, "connect", _guard(real_connect)))
        self._stack.enter_context(mock.patch.object(socket.socket, "connect_ex", _guard(real_connect_ex)))
        self._stack.enter_context(mock.patch.object(socket, "getaddrinfo", _lookup))
        return self

    def __exit__(self, *exc: object) -> None:
        self._stack.close()

    def invocations(self) -> list[str]:
        return self.calls.read_text(encoding="utf-8").splitlines() if self.calls.exists() else []


class HermeticRunTests(_ChangeReviewFixture):
    def test_a_github_env_and_network_tripwire_stays_untouched(self) -> None:
        """(iii) one whole change-review cycle, with GitHub armed around it."""
        self._require_mode()
        with _Tripwire(self.tmp, self.repo) as tripwire:
            state = self._run("cr-tripwire")
        self.assertEqual(tripwire.invocations(), [], "a GitHub/network binary or the git remote was invoked")
        self.assertEqual(tripwire.network, [], "the run opened a network connection or resolved a host")
        self.assertEqual(state["status"], "completed", state.get("failed_phases"))
        self.assertEqual(state["phases"]["change_intelligence"]["outcome"], "ran")
        leaked = [
            str(path) for root in (self.tools, self.workspace_base, self.repo)
            for path in root.rglob("*")
            if path.is_file() and ".git" not in path.relative_to(root).parts
            and TRIPWIRE_TOKEN.encode() in path.read_bytes()
        ]
        self.assertEqual(leaked, [], "the GitHub token reached a file the run wrote")


class ProducerAdmissionTests(unittest.TestCase):
    """(v) the two producers, classified in PRODUCER_CLASSES."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-change-review-admission-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_the_operator_subject_is_critical_path_and_admitted_on_an_empty_store(self) -> None:
        self.assertIn(OPERATOR_PRODUCER, PRODUCER_CLASSES.keys())
        self.assertEqual(PRODUCER_CLASSES[OPERATOR_PRODUCER].roles.get(CHANGE_INTELLIGENCE_ROLE), CRITICAL_PATH)
        admission = admit_request(
            OPERATOR_PRODUCER, CHANGE_INTELLIGENCE_ROLE,
            base_dir=ensure_tools_dir(self.tmp / "aria-tools"), cycle_id="cr-door",
        )
        self.assertTrue(admission.admitted, admission.reason)

    def test_the_merge_feed_is_discretionary(self) -> None:
        self.assertIn(MERGE_FEED_PRODUCER, PRODUCER_CLASSES.keys())
        self.assertEqual(PRODUCER_CLASSES[MERGE_FEED_PRODUCER].roles.get(CHANGE_INTELLIGENCE_ROLE), DISCRETIONARY)


class CycleRunFlagTests(unittest.TestCase):
    """`cycle run --mode change_review --change-base B --change-head H`."""

    def _parse(self, argv: list[str]) -> Any:
        try:
            with contextlib.redirect_stderr(io.StringIO()) as err:
                return cli_mod.build_parser().parse_args(argv)
        except SystemExit as exc:
            self.fail(f"`aria-kernel {' '.join(argv)}` is a usage error (exit {exc.code}): {err.getvalue()}")

    def test_the_default_mode_stays_standard(self) -> None:
        args = self._parse(["cycle", "run", "--cycle-id", "nightly"])
        self.assertEqual(getattr(args, "mode", None), "standard")

    def test_the_change_review_flags_reach_the_cycle(self) -> None:
        argv = [
            "cycle", "run", "--cycle-id", "cr-cli", "--workspace-root", "/nonexistent/room",
            "--mode", MODE, "--change-base", "a" * 40, "--change-head", "b" * 40,
        ]
        args = self._parse(argv)
        self.assertEqual(
            (getattr(args, "mode", None), getattr(args, "change_base", None), getattr(args, "change_head", None)),
            (MODE, "a" * 40, "b" * 40),
        )
        with tempfile.TemporaryDirectory(prefix="aria-change-review-cli-") as td, \
                mock.patch.object(cli_mod, "run_cycle", return_value={"status": "completed"}) as run_cycle, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli_mod.main([*argv, "--tools-dir", td]), 0)
        run_cycle.assert_called_once()
        kwargs = run_cycle.call_args.kwargs
        self.assertEqual(
            (kwargs.get("mode"), kwargs.get("change_base"), kwargs.get("change_head")),
            (MODE, "a" * 40, "b" * 40),
        )


if __name__ == "__main__":
    unittest.main()
