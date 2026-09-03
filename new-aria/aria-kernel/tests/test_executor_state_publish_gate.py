"""ORPHAN-CRITICAL-484/488 — the state publish must require positive proof
that the tree descends from a RESTORED tree.

The defect
==========
The executor's publish gate was `state_valid == 'true'`, and the integrity
verifier reports valid=true for a freshly BOOTSTRAPPED tree. On a run where the
restore does not happen, `actions/checkout` still materialises the git-tracked
`aria-tools/` files, and the steps that run BEFORE the verify step — `agent
next-pending` and the two `handoff snapshot` calls — create the missing
integrity_index.json. So by the time the gate is evaluated the tree looks
healthy, and a queue-less tree was published under the canonical artifact name,
burying the producer's queue with no automated path back.

Two auditors disagreed about this and the first refutation was wrong in an
instructive way: it ran `integrity verify` on the checkout-only tree IN
ISOLATION (exit 1, bootstrap_incomplete) and concluded the gate fails closed.
But that is not the state the gate sees — the intervening steps have already
indexed the tree. Verifying a step in isolation is not verifying the job.

RE-AIMED BY THE LANE CUTOVER (PLAN Wave 1 PR 2.6b), and re-aiming it was not
optional. Every assertion here used to identify the publish by the artifact name
`aria-tools-state` and read the restore for `zf.extractall`. After the cutover
NOTHING in either workflow matches those, so this file failed loudly on the
first run — which is the good outcome, and the reason it is a `next(...)` over a
parsed graph rather than a search that quietly finds nothing.

The PROPERTY did not change with the transport, so the assertions did not
weaken: a publish still needs validity AND ancestry, the three restore outcomes
are still mutually exclusive, and the producer's gate still may not be weaker
than the consumer's. What changed is that the store's fast-forward-only push now
enforces ancestry on the SERVER as well, so these gates are defence in depth
rather than the only thing standing between a failed restore and an erased
history.

Why a YAML test rather than an execution test: reproducing the original needs a
round-trip across two scheduled workflow runs, which no local harness can stage.
The reachable regression is an edit to these conditions, so that is what is
pinned — structurally, on the parsed graph rather than on text.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import yaml

WF = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "aria-agent-executor.yml"
PRODUCER = WF.with_name("aria-auto-cycle.yml")

# The artifact name that used to BE the state. Nothing may publish under it
# again: an artifact cannot enforce ancestry, so a lane that restored from one
# would prefer whichever copy was newest over whichever descended from the tip.
RETIRED_CANONICAL = "aria-tools-state"

# How a publish is recognised — by what it DOES, not by what it is called. A
# renamed step is not the regression this file guards against; a second publish,
# or a publish whose gate lost a term, is.
PUBLISH_COMMAND = "state publish"


def _steps(path: Path = WF) -> list[dict]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    return [step for job in doc["jobs"].values() for step in job.get("steps", [])]


def _by_name(fragment: str, path: Path = WF) -> dict:
    for step in _steps(path):
        if fragment in (step.get("name") or ""):
            return step
    raise AssertionError(f"no step whose name contains {fragment!r}")


def _publish_steps(path: Path = WF) -> list[dict]:
    return [
        step for step in _steps(path)
        if PUBLISH_COMMAND in str(step.get("run") or "")
    ]


def _the_publish(path: Path = WF) -> dict:
    found = _publish_steps(path)
    if len(found) != 1:
        raise AssertionError(
            f"{path.name}: expected exactly one step running `{PUBLISH_COMMAND}`, "
            f"found {len(found)} — a second publish is a second transaction "
            f"around one hash-chained ledger"
        )
    return found[0]


def _script_of(step: dict) -> str:
    """The shell a step runs, following a LOCAL composite action.

    RC-6 moved the restore body out of both workflows and into a shared action,
    because the two hand-copied heredocs had drifted: only the executor's wrote
    the 484/488 proof outputs, so the producer lane could publish a
    bootstrap-empty tree over the accumulated state. These assertions then
    failed on the extraction — the property was untouched, the `run:` key had
    simply moved.

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
        self.assertEqual(_by_name("Restore ARIA state").get("id"), "restore_state")

    def test_a_genuine_first_run_can_still_publish(self) -> None:
        """ORPHAN-CRITICAL-488 — the 484 gate made a newborn ARIA impossible.

        `restored=true` is written only after a real restore, so a first ever
        run left it unset, the publish was blocked and the fail step turned the
        job red. Permanently: with nothing published, the next run is also a
        first run. The fix distinguishes THREE outcomes at the only step that
        knows which occurred; a failure, a skipped step and a crash still write
        neither and still block.
        """
        body = _script_of(_by_name("Restore ARIA state"))
        # The signal is DERIVED from the kernel's own verdict, so the two
        # outcomes cannot both be claimed: one name is computed, then written.
        self.assertIn('signal = "bootstrap" if verdict["bootstrapped"] else "restored"', body)
        self.assertIn('fh.write(f"{signal}=true', body)
        self.assertIn("bootstrap", _the_publish()["if"])

    def test_the_three_states_are_mutually_exclusive_in_the_gate(self) -> None:
        """publish = restored OR bootstrap; quarantine/fail = neither. A state
        that satisfies both gates, or neither, would be a hole."""
        publish = _the_publish()["if"]
        fail = _by_name("Fail when ARIA state was not published")["if"]
        self.assertIn("restored == 'true' || steps.restore_state.outputs.bootstrap == 'true'", publish)
        self.assertIn("restored != 'true' && steps.restore_state.outputs.bootstrap != 'true'", fail)

    def test_ancestry_proof_is_written_only_on_the_success_path(self) -> None:
        """The proof must be written on the branch where the checkout SUCCEEDED,
        never alongside the refusal or transport-failure paths — absence is what
        blocks the publish."""
        body = _script_of(_by_name("Restore ARIA state"))
        write_at = body.index('fh.write(f"{signal}=true')
        # The failure branch (`else` of the `if <checkout succeeded>`) must come
        # after the write, i.e. the write lives inside the success branch.
        self.assertLess(write_at, body.index('STATUS=$?'))
        self.assertLess(write_at, body.index('exit "$STATUS"'))
        # Target an actual WRITE, not the bare string: the step's own comment
        # says "there is no restored=false", and matching prose made the first
        # version of this assertion fail on correct code.
        self.assertNotIn(
            'fh.write("restored=false', body,
            "there must be no false case to get wrong — absence is the signal",
        )

    def test_the_publish_requires_both_validity_and_ancestry(self) -> None:
        cond = _the_publish()["if"]
        self.assertIn("steps.integrity.outputs.state_valid == 'true'", cond)
        self.assertIn(
            "steps.restore_state.outputs.restored == 'true'", cond,
            "a bootstrapped tree passes integrity; only ancestry distinguishes it",
        )

    def test_a_blocked_publish_still_preserves_the_tree(self) -> None:
        q = _by_name("Quarantine unverified ARIA state")
        self.assertIn("steps.restore_state.outputs.restored != 'true'", q["if"])
        self.assertTrue(
            (q.get("with") or {}).get("overwrite"),
            "github.run_id repeats across re-run attempts, so a re-attempted "
            "quarantine upload 409s without overwrite",
        )

    def test_a_blocked_publish_cannot_report_green(self) -> None:
        """A run that does real work and persists none of it must be loud."""
        fail = _by_name("Fail when ARIA state was not published")
        self.assertIn("steps.restore_state.outputs.restored != 'true'", fail["if"])
        self.assertIn("exit 1", fail["run"])

    def test_the_publish_gate_is_strictly_stronger_than_the_producers(self) -> None:
        """Both lanes push the same branch, so the consumer may never have a
        weaker gate. Compares the two workflows rather than trusting prose."""
        pcond = _the_publish(PRODUCER)["if"]
        consumer = _the_publish()["if"]
        # "Strictly stronger" used to be asserted as "both mention state_valid",
        # which is not a comparison at all — it would have held while the
        # producer published on integrity ALONE and the consumer additionally
        # required ancestry, and it did hold, for exactly that reason, for as
        # long as the drift existed. The real property is that every guard term
        # the producer relies on is also present in the consumer's condition.
        for term in ("state_valid", "restore_state.outputs.restored",
                     "restore_state.outputs.bootstrap"):
            self.assertIn(term, pcond, f"producer gate lost {term}")
            self.assertIn(term, consumer, f"consumer gate weaker than producer on {term}")

    def test_no_lane_republishes_under_the_retired_canonical_name(self) -> None:
        """The cutover's actual claim, asserted where the gate lives.

        `aria-tools-state` was the name the old restore selected. Publishing
        under it again would make the artifact authoritative alongside the
        branch — two sources of truth for one ledger, and the one that cannot
        enforce ancestry would win whenever it was newer.
        """
        for path in (WF, PRODUCER):
            names = [
                (step.get("with") or {}).get("name")
                for step in _steps(path)
            ]
            self.assertNotIn(RETIRED_CANONICAL, names, f"{path.name} still publishes it")


if __name__ == "__main__":
    unittest.main()
