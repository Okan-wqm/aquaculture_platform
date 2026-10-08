"""ARIA-HIGH-358 — a reader of every request derives their states with ONE ledger load.

Measured 2026-10-06 on a copy of the runner's state store (1,866 requests):
the per-request ``derive_request_state`` costs 0.96 s a row, because it
reloads the request, claim and result ledgers. The batch
``derive_request_states`` returns the same states for all rows in 8.9 s.
Four readers walked every request with the per-request form:

* the handoff snapshot, taken twice by every auto-cycle and every executor
  run (22-27 min each);
* the human-required lease and anchor sweep, every cycle (~30 min);
* the daily report's Plan 016 claim count (~28 min);
* the consensus-arbitration pending set, and the ``state=`` filter of
  ``list_agent_invocation_requests``.

About 108 of an auto-cycle's ~170 minutes, and 50 of an executor run's ~95,
went to reloading the same three files.

Two pins. The behavioural one runs each reader against a fixture and refuses
any per-request derivation (a call without the batch's ``_ledgers``). The
static one names every call site of the per-request form, with the reason its
loop is bounded. A new call site, or a stale entry, fails the build, so a
reader added later cannot reintroduce the N-fold reload without saying why.
"""
from __future__ import annotations

import ast
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import agent_invocations as invocations
from aria_kernel.agent_invocations import create_agent_invocation_request, list_agent_invocation_requests
from aria_kernel.handoff_ledger import take_handoff_snapshot
from aria_kernel.human_required import sweep_lease_lifecycle_for_human_required
from aria_kernel.judge_fanout import CONSENSUS_ARBITRATION_ROLE, pending_arbitration_group_ids
from aria_kernel.plan_016_metrics import compute_plan_016_metrics
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.request_admission import admit_request

_REPO_ROOT = Path(__file__).resolve().parents[2]
_FIXTURE_REQUESTS = 6

# Every call site of the per-request form, keyed (repo path, enclosing
# function), with why its loop cannot grow with the request ledger. The batch
# form's own call (it passes ``_ledgers``) is not a site.
BOUNDED_PER_REQUEST_SITES: dict[tuple[str, str], str] = {
    ("aria-kernel/aria_kernel/agent_invocations.py", "claim_request"):
        "one request: the claim being taken",
    ("aria-kernel/aria_kernel/converged_delivery.py", "live_implementation_request_ids"):
        "only the implementation requests of one plan (convergence_id + role filter) are derived",
    ("aria-kernel/aria_kernel/autonomy_orchestrator.py", "_drain_next_cycle_queue"):
        "one request per pending queue item; the queue is capped by ARIA_NEXT_CYCLE_QUEUE_DEPTH",
    ("aria-kernel/aria_kernel/human_required_adjudication.py", "fold_adjudication"):
        "the request ids of one adjudication panel",
    ("aria-kernel/aria_kernel/human_required_adjudication.py", "_panel_is_terminally_dead"):
        "the request ids of one adjudication panel",
    ("aria-kernel/aria_kernel/mission_dispatch.py", "in_flight_mission_request"):
        "only rows matching one mission's marker and contract are derived",
    ("aria-kernel/aria_kernel/implementation_settlement.py", "settle_orphaned_plan"):
        "one request: an orphaned plan's newest implementation request, when the reaper settles it",
    ("aria-kernel/aria_kernel/outage_causality.py", "request_awaits_provider"):
        "one request: a stalled plan's newest request, or one orphaned plan's implementation request",
    ("aria-kernel/aria_kernel/step_request.py", "step_request_disposition"):
        "the requests of one (plan, role, round) step: at most 1 + MAX_STEP_REQUEST_REMINTS",
    ("aria-kernel/aria_kernel/review_runner.py", "run_review_runner"):
        "polls the one request it minted",
    ("aria-kernel/aria_kernel/specialist_review_runner.py", "run_specialist_review_runner"):
        "one request per selected specialist",
    ("tools/aria-poc/ci_executor.py", "_held_request_state"):
        "one request: the lease guard's held request",
    ("tools/aria-poc/ci_executor.py", "_adaptive_pre_claim_admission"):
        "one request: the candidate the pre-claim admission checks",
}

_SCANNED_ROOTS = ("aria-kernel/aria_kernel", "tools/aria-poc")


def _per_request_sites() -> set[tuple[str, str]]:
    """(path, outermost enclosing function) of every per-request derivation call."""
    sites: set[tuple[str, str]] = set()
    for root in _SCANNED_ROOTS:
        for path in sorted((_REPO_ROOT / root).rglob("*.py")):
            rel = path.relative_to(_REPO_ROOT).as_posix()
            if "/tests/" in rel or "/invariants/" in rel:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            names = {"derive_request_state"} if rel.endswith("agent_invocations.py") else set()
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and (node.module or "").endswith("agent_invocations"):
                    names |= {a.asname or a.name for a in node.names if a.name == "derive_request_state"}
            if not names:
                continue
            for top in ast.walk(tree):
                if not isinstance(top, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                for node in ast.walk(top):
                    if not isinstance(node, ast.Call):
                        continue
                    func = node.func
                    called = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
                    if called in names and not any(k.arg == "_ledgers" for k in node.keywords):
                        sites.add((rel, top.name))
    # A nested function's call is attributed to every enclosing def that
    # ast.walk reaches; keep the outermost one, the name a reader looks for.
    outermost: set[tuple[str, str]] = set()
    for rel in {r for r, _ in sites}:
        tree = ast.parse((_REPO_ROOT / rel).read_text(encoding="utf-8"))
        nested = {
            inner.name
            for outer in ast.walk(tree) if isinstance(outer, (ast.FunctionDef, ast.AsyncFunctionDef))
            for inner in ast.walk(outer)
            if inner is not outer and isinstance(inner, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        outermost |= {(r, name) for r, name in sites if r == rel and name not in nested}
    return outermost


class EveryPerRequestCallSiteIsBounded(unittest.TestCase):
    def test_the_call_sites_are_exactly_the_named_bounded_ones(self) -> None:
        found = _per_request_sites()
        unnamed = sorted(found - set(BOUNDED_PER_REQUEST_SITES))
        stale = sorted(set(BOUNDED_PER_REQUEST_SITES) - found)
        self.assertEqual(
            unnamed, [],
            "per-request derive_request_state reached from a site that does not say why its loop is "
            "bounded; a reader of every request uses derive_request_states (one ledger load)",
        )
        self.assertEqual(stale, [], "a named site no longer calls derive_request_state; drop it")


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-358-"))
        self.tools = self._tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self.repo = self._tmp / "repo"
        for sub in ("docs/aria/plans", "aria-findings", "aria-debts"):
            (self.repo / sub).mkdir(parents=True, exist_ok=True)
        self.ids = [self._mint(i) for i in range(_FIXTURE_REQUESTS)]

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _mint(self, i: int, *, role: str = "evidence_judgment", group: str | None = None) -> str:
        row = create_agent_invocation_request(
            target_agent="aria-consensus-arbiter" if role == CONSENSUS_ARBITRATION_ROLE else "aria-evidence-judge",
            role=role,
            suggested_prompt=f"judge {i}",
            must_satisfy=[{"id": "verdict", "description": "verdict"}],
            allowed_scope=["**"],
            finding_id=f"F-{i}",
            finding_fingerprint=f"fp-{i}",
            tool_id="tool-a",
            run_id="run-1",
            judgment_group_id=group or f"judge:tool-a:{i}",
            cycle_id="cyc-1",
            target_sha="a" * 40,
            base_dir=self.tools,
            admission=admit_request("operator_cli.request", role, base_dir=self.tools),
        )
        return str(row["request_id"])

    def per_request_calls(self, reader: Any) -> tuple[Any, int]:
        """Run ``reader`` and count derivations that did not come from the batch."""
        original = invocations.derive_request_state
        count = {"n": 0}

        def counting(**kwargs: Any) -> str:
            if kwargs.get("_ledgers") is None:
                count["n"] += 1
            return original(**kwargs)

        with patch.object(invocations, "derive_request_state", side_effect=counting):
            result = reader()
        return result, count["n"]


class ReadersOfEveryRequestLoadTheLedgersOnce(_Store):
    def test_the_handoff_snapshot(self) -> None:
        snap, singles = self.per_request_calls(lambda: take_handoff_snapshot(
            session_id="s-358", trigger="manual", base_dir=self.tools, repo_root=self.repo,
        ))
        self.assertEqual(singles, 0)
        self.assertEqual(sorted(r["request_id"] for r in snap["pending_requests"]), sorted(self.ids))

    def test_the_human_required_sweep(self) -> None:
        result, singles = self.per_request_calls(
            lambda: sweep_lease_lifecycle_for_human_required(base_dir=self.tools))
        self.assertEqual(singles, 0)
        self.assertEqual(result["created"], [])

    def test_the_plan_016_claim_count(self) -> None:
        metrics, singles = self.per_request_calls(lambda: compute_plan_016_metrics(base_dir=self.tools))
        self.assertEqual(singles, 0)
        self.assertEqual(metrics["aria_agent_claim_active"], 0)

    def test_the_pending_arbitration_groups(self) -> None:
        self._mint(99, role=CONSENSUS_ARBITRATION_ROLE, group="judge:tool-a:split")
        groups, singles = self.per_request_calls(lambda: pending_arbitration_group_ids(base_dir=self.tools))
        self.assertEqual(singles, 0)
        self.assertEqual(groups, {"judge:tool-a:split"})

    def test_the_state_filter_of_the_request_list(self) -> None:
        rows, singles = self.per_request_calls(
            lambda: list_agent_invocation_requests(base_dir=self.tools, state="pending"))
        self.assertEqual(singles, 0)
        self.assertEqual(sorted(r["request_id"] for r in rows), sorted(self.ids))


if __name__ == "__main__":
    unittest.main()
