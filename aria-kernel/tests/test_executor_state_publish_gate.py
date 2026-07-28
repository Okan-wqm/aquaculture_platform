"""ORPHAN-CRITICAL-484 — the canonical aria-tools-state publish must require
positive proof the tree descends from a RESTORED tree.

The defect
==========
The executor's publish gate was `state_valid == 'true'`, and the integrity
verifier reports valid=true for a freshly BOOTSTRAPPED tree. On a run where the
restore does not happen, `actions/checkout` still materialises the git-tracked
`aria-tools/` files, and the steps that run BEFORE the verify step — `agent
next-pending` and the two `handoff snapshot` calls — create the missing
integrity_index.json. So by the time the gate is evaluated the tree looks
healthy, and a queue-less tree is published under the canonical name, burying
the producer's queue with no automated path back.

Two auditors disagreed about this and the first refutation was wrong in an
instructive way: it ran `integrity verify` on the checkout-only tree IN
ISOLATION (exit 1, bootstrap_incomplete) and concluded the gate fails closed.
But that is not the state the gate sees — the intervening steps have already
indexed the tree. Verifying a step in isolation is not verifying the job.

Why a YAML test rather than an execution test: reproducing this needs an
artifact round-trip across two scheduled workflow runs, which no local harness
can stage. The reachable regression is an edit to these conditions, so that is
what is pinned — structurally, on the parsed graph rather than on text.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import yaml

WF = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "aria-agent-executor.yml"
CANONICAL = "aria-tools-state"


def _steps() -> list[dict]:
    doc = yaml.safe_load(WF.read_text(encoding="utf-8"))
    return doc["jobs"]["executor"]["steps"]


def _by_name(fragment: str) -> dict:
    for step in _steps():
        if fragment in (step.get("name") or ""):
            return step
    raise AssertionError(f"no step whose name contains {fragment!r}")


class PublishGateTests(unittest.TestCase):

    def test_the_restore_step_exposes_an_id_the_gate_can_read(self) -> None:
        self.assertEqual(_by_name("Restore aria-tools state").get("id"), "restore_state")

    def test_ancestry_proof_is_written_only_on_the_success_path(self) -> None:
        """`restored=true` must be emitted AFTER extraction, never on the
        no-artifact fail-open branch — absence is what blocks the publish."""
        body = _by_name("Restore aria-tools state")["run"]
        self.assertIn('fh.write("restored=true', body)
        extract_at = body.index('zf.extractall("aria-tools")')
        write_at = body.index('fh.write("restored=true')
        self.assertLess(extract_at, write_at, "proof must follow a real extraction")
        # The fail-open exit must come BEFORE the write, so a missing artifact
        # cannot claim ancestry.
        self.assertLess(body.index("SystemExit(0)"), write_at)
        # Target an actual WRITE, not the bare string: the step's own comment
        # says "there is no restored=false", and matching prose made the first
        # version of this assertion fail on correct code.
        self.assertNotIn(
            'fh.write("restored=false', body,
            "there must be no false case to get wrong — absence is the signal",
        )

    def test_the_canonical_publish_requires_both_validity_and_ancestry(self) -> None:
        step = next(
            s for s in _steps()
            if (s.get("with") or {}).get("name") == CANONICAL
        )
        cond = step["if"]
        self.assertIn("steps.integrity.outputs.state_valid == 'true'", cond)
        self.assertIn(
            "steps.restore_state.outputs.restored == 'true'", cond,
            "a bootstrapped tree passes integrity; only ancestry distinguishes it",
        )

    def test_a_blocked_publish_still_preserves_the_tree(self) -> None:
        q = _by_name("Quarantine unverified aria-tools state")
        self.assertIn("steps.restore_state.outputs.restored != 'true'", q["if"])
        self.assertTrue(
            (q.get("with") or {}).get("overwrite"),
            "github.run_id repeats across re-run attempts, so a re-attempted "
            "quarantine upload 409s without overwrite",
        )

    def test_a_blocked_publish_cannot_report_green(self) -> None:
        """The failure is absorbing — each silent night buries the good artifact
        one run deeper — so it must be loud."""
        fail = _by_name("Fail when aria-tools state was not published")
        self.assertIn("steps.restore_state.outputs.restored != 'true'", fail["if"])
        self.assertIn("exit 1", fail["run"])

    def test_the_publish_gate_is_strictly_stronger_than_the_producers(self) -> None:
        """The consumer overwrites what the producer wrote, so it may never have
        a weaker gate. Compares the two workflows rather than trusting prose."""
        producer = WF.with_name("aria-auto-cycle.yml")
        pdoc = yaml.safe_load(producer.read_text(encoding="utf-8"))
        pconds = [
            s.get("if", "") for j in pdoc["jobs"].values()
            for s in j.get("steps", [])
            if (s.get("with") or {}).get("name") == CANONICAL
        ]
        self.assertTrue(pconds, "producer must also publish the canonical artifact")
        consumer = next(
            s for s in _steps() if (s.get("with") or {}).get("name") == CANONICAL
        )["if"]
        for pcond in pconds:
            self.assertIn("state_valid", pcond)
        self.assertIn("state_valid", consumer)


if __name__ == "__main__":
    unittest.main()
