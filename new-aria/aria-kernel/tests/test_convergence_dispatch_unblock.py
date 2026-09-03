"""E1 — the three defects that made convergence structurally impossible.

Independent end-to-end audit found the autonomous arc had nine full stops;
these are the three that sit earliest and block everything downstream:

* F2 — one shared claim identity for every role, which ARIA's OWN
  independence check reads as an echo chamber, downgrading every
  CONVERGED verdict to `cross_review_self_agreement`;
* F3 — after the durable-store cutover the in-cycle dispatcher resolved
  its executor path inside the STATE tree (which holds ledgers, not
  code), so every in-cycle dispatch spawned a nonexistent file;
* F6 — the coverage critic was dispatched without the required
  `agent_id`, raising TypeError on every poll into a bare `except: pass`.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from aria_kernel import convergence_drainer as cd

from aria_kernel.planner_dispatch_hook import _default_ci_executor_path
from aria_kernel.worker_dispatch_hook import _default_worker_executor_path

REPO_ROOT = Path(__file__).resolve().parents[2]


class RoleScopedIdentityTests(unittest.TestCase):
    def test_drainer_no_longer_dispatches_at_all(self) -> None:
        # CL-1 (ORPHAN-725) — the inline dispatcher these tests used to
        # exercise is deliberately DEAD: the executor lane is the single
        # consumer of every convergence role (the X1 topology), so
        # role-scoped identity now lives where the claim happens —
        # ci_executor — not in the drainer. The drainer must neither
        # import nor call the planner dispatch hook.
        import inspect

        source = inspect.getsource(cd)
        self.assertNotIn("dispatch_one_pending_planner_request", source)
        self.assertFalse(hasattr(cd, "_inline_agent_id"))
        self.assertFalse(hasattr(cd, "_CONVERGENCE_INLINE_DISPATCH_ROLES"))

    def test_shared_identity_fails_and_role_scoped_passes(self) -> None:
        # The gate reads agent_id from the CLAIMS ledger by request_id, so
        # this exercises the real reader against both shapes.
        import json
        import tempfile

        from aria_kernel.independence_check import (
            RoundDispatch,
            verify_principal_disjointness,
        )

        def _run(agent_ids: dict[str, str]) -> tuple[bool, list[str]]:
            with tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp)
                (base / "agent-invocations").mkdir(parents=True)
                rows = [
                    {"request_id": f"AIR-{role}", "claim_id": f"c-{role}", "agent_id": agent_id}
                    for role, agent_id in agent_ids.items()
                ]
                (base / "agent-invocations" / "claims.jsonl").write_text(
                    "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8"
                )
                dispatches = [
                    RoundDispatch(role=role, request_id=f"AIR-{role}", revision_id=f"rev-{role}", agent_text="t")
                    for role in agent_ids
                ]
                return verify_principal_disjointness(dispatches=dispatches, base_dir=base)

        shared = "convergence:1234"
        passed_shared, reasons = _run({
            "primary": shared, "challenger": shared, "cross_review": shared,
        })
        self.assertFalse(passed_shared)
        self.assertTrue(any("same_agent_id" in r for r in reasons), reasons)

        # CL-1: the drainer no longer mints identities (it no longer
        # claims anything); role-scoped ids are the EXECUTOR's discipline.
        # The disjointness reader's contract is unchanged — pin it with
        # explicitly role-scoped ids of the same shape.
        passed_scoped, reasons_scoped = _run({
            role: f"convergence:{role}"
            for role in ("primary", "challenger", "cross_review")
        })
        self.assertTrue(passed_scoped, reasons_scoped)


class ExecutorPathTests(unittest.TestCase):
    def test_executor_paths_resolve_into_the_code_tree(self) -> None:
        # The durable store lives at <repo>/.aria-state-store/tools; the
        # pre-fix arithmetic (base_dir.parent) resolved the executor inside
        # it, where no code exists.
        store_tools = REPO_ROOT / ".aria-state-store" / "tools"
        ci = _default_ci_executor_path(store_tools)
        worker = _default_worker_executor_path(store_tools)
        for resolved in (ci, worker):
            self.assertTrue(resolved.is_file(), resolved)
            self.assertNotIn(".aria-state-store", str(resolved))
        self.assertEqual(ci.resolve().parents[2], REPO_ROOT)


class CriticDispatchTests(unittest.TestCase):
    def test_critic_is_minted_for_the_executor_not_dispatched_inline(self) -> None:
        # CL-1 (ORPHAN-725) — the critic envelope is MINTED by the
        # coverage step and DELIVERED by the executor lane on a later
        # cycle; the adjudication folds from the results ledger. The
        # F6 agent_id defect class this pin guarded cannot recur because
        # the call it guarded no longer exists.
        import inspect

        source = inspect.getsource(cd)
        self.assertIn("issue_completeness_critic_envelope", source)
        self.assertIn("_read_critic_result_once", source)
        self.assertNotIn('planner_roles=("completeness_critique",)', source)


if __name__ == "__main__":
    unittest.main()
