"""The oscillation streak resets when a belief heals — ORPHAN-MEDIUM-808.

`oscillation_guard` ships a three-part contract: `record_reopen` increments,
`record_resolution` resets, `guard_fix_dispatch` decides. Production wired
exactly one third of it — the incrementer, from
`memory._apply_diff_to_existing_beliefs`. Neither the reset nor the decider had
a production caller.

The missing reset is the half that matters, and its absence is not merely
"a control is dormant". `reopen_streak` tail-scans governance newest-first and
stops at the first `finding_resolution_clean` for the fingerprint. With no
producer for that event the streak is **monotonic**: it counts every reopen a
belief has ever had, across the entire life of the repository, and never
subtracts. A belief that broke and healed three times over three months was
therefore indistinguishable from one ping-ponging inside a single cycle — and a
decider wired on top of that counter would have escalated the first belief to
HUMAN_REQUIRED and refused it forever, with no path back.

That is why the fix is the reset FIRST. Wiring the decider onto a monotonic
counter would have turned a dormant control into a permanent block, which is
strictly worse than leaving it dormant.

WHY THE GATE NEVER REPORTED IT. `control_reachability.CONTROL_VERBS` is
`validate_ enforce_ assert_ require_ verify_ guard_ refuse_ check_`.
`guard_fix_dispatch` and `assert_fix_dispatch_allowed` match and were both
correctly waived as dormant. `record_resolution` does not match — it is spelled
as a recorder, not a checker — so the one dormant piece that breaks the contract
is invisible to the instrument by construction. A counter-based control has a
completeness requirement (increment, reset and decide are live together or not
at all) that a name-prefix reachability scan cannot express.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.memory import _record_belief
from aria_kernel.oscillation_guard import (
    DEFAULT_OSCILLATION_THRESHOLD,
    record_reopen,
    reopen_streak,
)
from aria_kernel.tool_registry import ensure_tools_binding

BELIEF_ID = "a-fact-that-breaks-and-heals"
FINGERPRINT = f"belief:{BELIEF_ID}"


def _hash(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


class OscillationResolutionWiringTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.workspace = Path(self._tmp.name) / "repo"
        (self.workspace / "docs").mkdir(parents=True)
        for name in ("fact.md", "unrelated.md"):
            (self.workspace / "docs" / name).write_text(f"{name}\n", encoding="utf-8")
        self.root = ensure_tools_binding(
            Path(self._tmp.name) / "aria-tools", workspace_root=self.workspace
        )

    def _observe(self, cycle_id: str, *, evidence_present: bool) -> dict:
        """Record the belief for one cycle.

        `_evidence_state` derives `missing_concrete_refs` by asking whether the
        ref appears in that cycle's FATES. Listing a different file is how a
        cycle says "this evidence is gone" without deleting a file that
        `validate_repo_evidence` still requires to exist.
        """
        listed = "docs/fact.md" if evidence_present else "docs/unrelated.md"
        body = (self.workspace / listed).read_text(encoding="utf-8")
        directory = self.root / "discovery" / cycle_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "FATES.json").write_text(
            json.dumps({"files": [{"path": listed, "content_hash": _hash(body)}]}),
            encoding="utf-8",
        )
        return _record_belief(
            self.root,
            cycle_id=cycle_id,
            belief_id=BELIEF_ID,
            claim="the fact holds",
            evidence_refs=["docs/fact.md"],
            confidence=0.60,
            workspace_root=self.workspace,
        )

    def test_a_belief_that_heals_resets_its_oscillation_streak(self) -> None:
        healthy = self._observe("cycle-1", evidence_present=True)
        self.assertEqual(healthy["needs_revalidation_cycles"], 0)

        broken = self._observe("cycle-2", evidence_present=False)
        self.assertEqual(broken["status"], "needs_revalidation")

        # What the diff-decay path does on a reopen, twice — one below the
        # threshold, so the guard is armed but has not yet fired.
        for cycle in ("cycle-2", "cycle-3"):
            record_reopen(fingerprint=FINGERPRINT, cycle_id=cycle, base_dir=self.root)
        self.assertEqual(
            reopen_streak(fingerprint=FINGERPRINT, base_dir=self.root),
            2,
            "the reopen half must still count — this fix resets the streak, it does not disarm it",
        )

        healed = self._observe("cycle-4", evidence_present=True)
        self.assertEqual(healed["needs_revalidation_cycles"], 0)
        self.assertEqual(healed["status"], "supported")

        self.assertEqual(
            reopen_streak(fingerprint=FINGERPRINT, base_dir=self.root),
            0,
            "a belief whose evidence holds again did not reset its streak; the "
            "counter is still monotonic and any decider on it is a permanent block",
        )

    def test_a_healed_belief_that_breaks_again_starts_a_fresh_streak(self) -> None:
        """The point of the reset: a slow break/heal history is not a loop.

        Without it, three unrelated breakages months apart reach the threshold
        exactly as fast as three inside one cycle, and the guard's own stated
        purpose — telling a ping-pong from a legitimate revision — is lost.
        """
        self._observe("cycle-1", evidence_present=True)
        for round_index in range(DEFAULT_OSCILLATION_THRESHOLD):
            self._observe(f"break-{round_index}", evidence_present=False)
            record_reopen(
                fingerprint=FINGERPRINT, cycle_id=f"break-{round_index}", base_dir=self.root
            )
            self._observe(f"heal-{round_index}", evidence_present=True)

        self.assertEqual(
            reopen_streak(fingerprint=FINGERPRINT, base_dir=self.root),
            0,
            f"{DEFAULT_OSCILLATION_THRESHOLD} separate break/heal rounds accumulated "
            "into a loop verdict; each heal must break the streak",
        )

    def test_a_belief_that_never_healed_keeps_its_streak(self) -> None:
        """The reset must be earned by a real transition, not by re-observation.

        A belief re-observed while still broken has not resolved anything, and
        emitting the clean event there would silently disarm the guard — which
        is the failure this whole finding is about, in the opposite direction.
        """
        self._observe("cycle-1", evidence_present=True)
        self._observe("cycle-2", evidence_present=False)
        for cycle in ("cycle-2", "cycle-3", "cycle-4"):
            record_reopen(fingerprint=FINGERPRINT, cycle_id=cycle, base_dir=self.root)
        self._observe("cycle-5", evidence_present=False)

        self.assertEqual(
            reopen_streak(fingerprint=FINGERPRINT, base_dir=self.root),
            3,
            "re-observing a still-broken belief reset its streak — the guard can "
            "now be disarmed by looking at the problem again",
        )


if __name__ == "__main__":
    unittest.main()
