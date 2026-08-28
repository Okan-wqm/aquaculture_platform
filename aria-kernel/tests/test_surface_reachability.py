"""A vocabulary member nothing writes is dormant, and dormancy must be declared.

THE DEFECT. `test_control_reachability` catches a control nobody calls. This
suite catches its twin, which cost this programme roughly nineteen closures in
one session: a member of a closed string vocabulary that the kernel declares,
validates, tests — and no production path can ever produce.

    writer with no reader      a surface written that nothing loads
    reader with no writer      a field read that nothing populates
    unsatisfiable predicate    a refusal no production input can reach
    unread tunable             a policy key nothing consults

Measured when this file was written: **55 members across four closed
vocabularies, 17 with no production producer** — 31%. Among them
`REQUEST_ROLES.consensus_arbitration`, which sits in JUDGE_ROLES and therefore
obliges the bridge to handle a verdict nothing ever asks for; and
`EVENT_TYPES.lock_reaped`, which has a payload validator and no emitter inside
a set its own module documents as a one-way door.

WHY THE WAIVER SHAPE IS COPIED, NOT INVENTED. `invariant-reachability.spec.ts`
and `test_control_reachability` already solved the manifest problem, and the
TypeScript spec learned one lesson expensively: it validated the SHAPE of
`expires_on` with a regex and never compared it to the clock, so twenty-five
waivers sailed a month past a shared deadline in silence. This suite compares
against the clock, and a stale waiver — for a member that became writable, or
that no longer exists, or for a surface that was renamed — fails too, so the
manifest cannot rot in either direction.

THE KEYING DECISION. The manifest is keyed by SURFACE and then by member, not
by member alone. `ACTIVE` is a genesis state and a tool status and they are
unrelated; a flat manifest would let a waiver written for one silence a real
gap in the other, which is the precise failure this whole file exists to
prevent.
"""

from __future__ import annotations

import json
import unittest
from datetime import date
from pathlib import Path

from aria_kernel.literal_provenance import ProductionIndex
from aria_kernel.surface_reachability import (
    declared_surfaces,
    undeclared_written_members,
    unwritten_members,
    written_members,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPO_ROOT / "aria-kernel" / "surface-reachability.unwritten.json"
REQUIRED_WAIVER_FIELDS = ("owner", "reason", "expires_on", "finding_id")


def _manifest() -> dict[str, dict[str, dict[str, str]]]:
    if not MANIFEST_PATH.exists():
        return {}
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


class SurfaceReachabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.index = ProductionIndex(REPO_ROOT)
        cls.surfaces = declared_surfaces()
        cls.unwritten = {
            surface.surface_id: unwritten_members(surface, cls.index) for surface in cls.surfaces
        }
        cls.manifest = _manifest()

    def test_the_surfaces_still_describe_real_closed_vocabularies(self) -> None:
        # If a refactor emptied one of the imported sets, every later
        # assertion would pass over nothing and prove nothing. The floors are
        # deliberately far below the measured sizes so they fail on collapse
        # rather than on ordinary growth.
        for surface in self.surfaces:
            with self.subTest(surface=surface.surface_id):
                self.assertGreater(
                    len(surface.members),
                    3,
                    f"{surface.surface_id} no longer selects a vocabulary "
                    f"({surface.declared_in})",
                )

    def test_every_declared_writer_is_a_real_production_function(self) -> None:
        # A writer name that no longer resolves would make its whole surface
        # read as 100% dormant, and a gate that fails everything gets muted
        # exactly as fast as one that fails nothing.
        for surface in self.surfaces:
            for writer in surface.writers:
                with self.subTest(surface=surface.surface_id, writer=writer.function):
                    self.assertTrue(
                        self.index.calls_to(writer.function),
                        f"{surface.surface_id} names writer {writer.function!r}, "
                        "which has no production callsite — the binding is stale",
                    )

    def test_every_unwritten_member_is_declared(self) -> None:
        undeclared: list[str] = []
        for surface_id, members in self.unwritten.items():
            waived = self.manifest.get(surface_id, {})
            undeclared.extend(f"{surface_id}.{m}" for m in members if m not in waived)
        self.assertEqual(
            undeclared,
            [],
            "vocabulary member(s) with no production writer and no waiver: "
            + ", ".join(undeclared),
        )

    def test_no_writer_emits_a_member_the_vocabulary_does_not_declare(self) -> None:
        """ORPHAN-HIGH-758 — the direction every defence here was missing.

        Every check above asks "is a DECLARED member reachable?".
        ORPHAN-CRITICAL-733 came from the OPPOSITE direction: a producer
        emitting a value no registry knew, which killed a cycle. The
        defences built afterwards — a boundary raise, a parity test between
        the two pressure tables, this gate — all faced the wrong way, and
        `written_members` was resolving the answer and discarding it one
        line before it could be reported.

        Turning it on found two live instances at once: `post_merge_ci`
        (emitted by the post-merge red scan, in neither pressure table, and
        a `GovernanceError` the first night a red merge outcome is
        recorded) and `specialist_domain_review` (a surface bound to
        REQUEST_ROLES whose writer is governed by INVOCATION_ROLES). There
        is no waiver ledger for this direction on purpose: an unwritten
        member is a plan that has not happened yet, which can reasonably
        carry an owner and a date, while an undeclared written
        value is a raise waiting for its input.
        """
        undeclared: list[str] = []
        for surface in self.surfaces:
            for member, locations in undeclared_written_members(surface, self.index).items():
                undeclared.append(
                    f"{surface.surface_id}.{member} emitted at {locations[0]}"
                )
        self.assertEqual(
            undeclared,
            [],
            "production writer(s) emit a value their vocabulary does not "
            "declare — register it in the closed table(s) or stop emitting "
            "it: " + "; ".join(undeclared),
        )

    def test_every_waiver_names_an_owner_a_reason_a_deadline_and_a_finding(self) -> None:
        for surface_id, entries in sorted(self.manifest.items()):
            for member, entry in sorted(entries.items()):
                with self.subTest(surface=surface_id, member=member):
                    for field in REQUIRED_WAIVER_FIELDS:
                        self.assertTrue(
                            str(entry.get(field, "")).strip(),
                            f"waiver for {surface_id}.{member} is missing {field}",
                        )
                    # Without an ID nothing gets worked — which is how
                    # twenty-five TypeScript waivers reached one shared expiry.
                    self.assertRegex(
                        entry["finding_id"], r"^[A-Z]+-(CRITICAL|HIGH|MEDIUM|LOW)-\d{3}$"
                    )

    def test_a_waiver_expires_against_the_clock_not_against_a_regex(self) -> None:
        # THE LESSON. `invariant-reachability.spec.ts` checked this field's
        # shape and not its value; every waiver was a month stale and green.
        today = date.today()
        expired = [
            f"{surface_id}.{member} (expired {entry['expires_on']}, {entry['finding_id']})"
            for surface_id, entries in sorted(self.manifest.items())
            for member, entry in sorted(entries.items())
            if date.fromisoformat(entry["expires_on"]) < today
        ]
        self.assertEqual(expired, [], "waiver(s) past their deadline: " + ", ".join(expired))

    def test_a_waiver_for_a_member_that_is_now_written_must_be_removed(self) -> None:
        # The manifest must not outlive the problem. A waiver left behind
        # after the member was wired is a standing licence to un-wire it.
        revived: list[str] = []
        for surface_id, entries in sorted(self.manifest.items()):
            dormant = set(self.unwritten.get(surface_id, ()))
            revived.extend(f"{surface_id}.{m}" for m in sorted(entries) if m not in dormant)
        self.assertEqual(
            revived,
            [],
            "member(s) now written but still waived — delete the waiver: " + ", ".join(revived),
        )

    def test_a_waiver_for_a_member_or_surface_that_no_longer_exists_must_be_removed(self) -> None:
        declared = {surface.surface_id: set(surface.members) for surface in self.surfaces}
        ghosts: list[str] = []
        for surface_id, entries in sorted(self.manifest.items()):
            if surface_id not in declared:
                ghosts.append(f"{surface_id} (whole surface)")
                continue
            ghosts.extend(f"{surface_id}.{m}" for m in sorted(entries) if m not in declared[surface_id])
        self.assertEqual(
            ghosts, [], "waiver(s) naming something that no longer exists: " + ", ".join(ghosts)
        )

    def test_the_generic_cli_passthrough_never_vouches_for_a_role(self) -> None:
        # THE PRECISION PIN, and the reason this gate can see anything at all.
        # `aria-kernel agent request --role X` mints whatever the operator
        # typed (cli.py, role=args.role). If that callsite counted, every role
        # in REQUEST_ROLES would be certified live by one argparse attribute
        # and this entire file would be theatre. `gap_finding` is the canary:
        # the CLI can mint it, and it must still read as unwritten.
        #
        # The canary used to be `verification` — until the same change that
        # added this file gave that role a real minter (decision_questioning),
        # at which point the assertion started failing for the RIGHT reason.
        # A canary must be a member nothing writes; when one gets wired, the
        # canary moves rather than the gate loosening.
        surface = next(s for s in self.surfaces if s.surface_id == "agent_surface_request_role")
        self.assertIn("gap_finding", surface.members)
        self.assertIn(
            "gap_finding",
            self.unwritten["agent_surface_request_role"],
            "an opaque argument started counting as a writer — the walk has "
            "lost the distinction between minting a role and forwarding one",
        )

    def test_a_wired_member_reports_the_callsite_that_wires_it(self) -> None:
        # Evidence, not just a verdict. An earlier draft of the walk leaked
        # across sibling functions in a module and cited the wrong line for
        # three of the four bridge roles; a verdict nobody can check is a
        # verdict nobody will act on.
        surface = next(s for s in self.surfaces if s.surface_id == "agent_surface_request_role")
        written = written_members(surface, self.index)
        self.assertIn("cross_review", written)
        self.assertTrue(
            any("cross_review_bridge.py" in location for location in written["cross_review"]),
            f"cross_review evidence no longer points at its bridge: {written['cross_review']}",
        )


if __name__ == "__main__":
    unittest.main()
