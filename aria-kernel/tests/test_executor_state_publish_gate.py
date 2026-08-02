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


def _script_of(step: dict) -> str:
    """The shell a step runs, following a LOCAL composite action.

    RC-6 moved the restore body out of both workflows and into
    `.github/actions/restore-aria-tools-state`, because the two hand-copied
    heredocs had drifted: only the executor's wrote the 484/488 proof outputs,
    so the producer lane could publish a bootstrap-empty tree over the
    accumulated state. These assertions then failed on the extraction — the
    property was untouched, the `run:` key had simply moved.

    Following the `uses:` is the same correction the sandbox containment
    contract needed for the same reason. A composite action's steps run inside
    the calling job; reading them is reading what the job runs, not guessing.
    Deliberately local-only: a third-party `uses:` is SHA-pinned and reviewed as
    a dependency.
    """
    if isinstance(step.get("run"), str):
        return step["run"]
    uses = step.get("uses")
    if isinstance(uses, str) and uses.startswith("./"):
        action_dir = WF.resolve().parents[2] / uses[2:]
        for filename in ("action.yml", "action.yaml"):
            candidate = action_dir / filename
            if candidate.is_file():
                doc = yaml.safe_load(candidate.read_text(encoding="utf-8"))
                return "\n".join(
                    inner["run"]
                    for inner in doc.get("runs", {}).get("steps", [])
                    if isinstance(inner.get("run"), str)
                )
    raise AssertionError(f"step {step.get('name')!r} runs no resolvable script")


class PublishGateTests(unittest.TestCase):

    def test_the_restore_step_exposes_an_id_the_gate_can_read(self) -> None:
        self.assertEqual(_by_name("Restore aria-tools state").get("id"), "restore_state")

    def test_a_genuine_first_run_can_still_publish(self) -> None:
        """ORPHAN-CRITICAL-488 — the 484 gate made a newborn ARIA impossible.

        `restored=true` is written only after a real extraction, so a first ever
        run — no prior artifact — left it unset, the publish was blocked and the
        fail step turned the job red. Permanently: with no artifact published,
        the next run is also a first run. The fix distinguishes THREE states at
        the only step that knows which occurred; a failure, a skipped step and a
        crash still write neither and still block.
        """
        body = _script_of(_by_name("Restore aria-tools state"))
        self.assertIn('fh.write("bootstrap=true', body)
        # bootstrap is claimed ONLY on the no-live-artifact branch, before the
        # clean exit — never after a failed download.
        self.assertLess(body.index('fh.write("bootstrap=true'), body.index("SystemExit(0)"))
        self.assertLess(body.index('fh.write("bootstrap=true'), body.index('zf.extractall'))

        step = next(
            s for s in _steps() if (s.get("with") or {}).get("name") == CANONICAL
        )
        self.assertIn("steps.restore_state.outputs.bootstrap == 'true'", step["if"])

    def test_the_three_states_are_mutually_exclusive_in_the_gate(self) -> None:
        """publish = restored OR bootstrap; quarantine/fail = neither. A state
        that satisfies both gates, or neither, would be a hole."""
        publish = next(
            s for s in _steps() if (s.get("with") or {}).get("name") == CANONICAL
        )["if"]
        fail = _by_name("Fail when aria-tools state was not published")["if"]
        self.assertIn("restored == 'true' || steps.restore_state.outputs.bootstrap == 'true'", publish)
        self.assertIn("restored != 'true' && steps.restore_state.outputs.bootstrap != 'true'", fail)

    def test_ancestry_proof_is_written_only_on_the_success_path(self) -> None:
        """`restored=true` must be emitted AFTER extraction, never on the
        no-artifact fail-open branch — absence is what blocks the publish."""
        body = _script_of(_by_name("Restore aria-tools state"))
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
        # "Strictly stronger" used to be asserted as "both mention state_valid",
        # which is not a comparison at all — it would have held while the
        # producer published on integrity ALONE and the consumer additionally
        # required ancestry, and it did hold, for exactly that reason, for as
        # long as the drift existed. The real property is that every guard term
        # the producer relies on is also present in the consumer's condition.
        for term in ("state_valid", "restore_state.outputs.restored",
                     "restore_state.outputs.bootstrap"):
            for pcond in pconds:
                self.assertIn(term, pcond, f"producer gate lost {term}")
            self.assertIn(term, consumer, f"consumer gate weaker than producer on {term}")


if __name__ == "__main__":
    unittest.main()
