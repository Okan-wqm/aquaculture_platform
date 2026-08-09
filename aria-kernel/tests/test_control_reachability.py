"""A control nothing calls is dormant, and dormancy must be declared.

THE DEFECT THIS EXISTS TO CATCH. Four findings this programme closed are one
defect wearing four names — a control that is correct, tested, exported, and
called by nobody:

    ORPHAN-CRITICAL-498  a perimeter with no production caller
    ORPHAN-HIGH-569      a discovery list the repository outgrew
    ORPHAN-MEDIUM-571    a repository map nothing refreshed and nothing read
    ORPHAN-MEDIUM-572    a request vocabulary nothing consults

Every one was found by a human reading code, never by a gate. A green suite
is no evidence against them, because the tests call the control directly:
that is exactly how a control stays green while governing nothing.

Measured when this file was written: **85 public control-verb callables in
`aria_kernel`, 18 of them referenced by no production module** — 21%. Among
them `verify_no_secret_in_envelope`, whose own docstring calls it a hard-fail
check for the leak path its wired sibling `verify_no_secret_in_diff` does not
cover.

WHY THE WAIVER SHAPE IS COPIED, NOT INVENTED. `invariant-reachability.spec.ts`
solved this for TypeScript specs and learned one lesson expensively: it
validated the SHAPE of `expires_on` with a regex and never compared it to the
clock, so twenty-five waivers sailed a month past a shared deadline in
silence. Checking the syntax of a date instead of the date is checking the
syntax of a thing instead of the thing. This suite therefore compares against
the clock, and a stale waiver — one whose control became reachable, or no
longer exists — fails too, so the manifest cannot rot in either direction.
"""

from __future__ import annotations

import json
import unittest
from datetime import date
from pathlib import Path

from aria_kernel.control_reachability import (
    PRODUCTION_SOURCE_ROOTS,
    declared_controls,
    first_production_reference,
    unreachable_controls,
    unrostered_production_dirs,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPO_ROOT / "aria-kernel" / "control-reachability.dormant.json"
REQUIRED_WAIVER_FIELDS = ("owner", "reason", "expires_on", "finding_id")


def _manifest() -> dict[str, dict[str, str]]:
    if not MANIFEST_PATH.exists():
        return {}
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


class ControlReachabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.controls = declared_controls(REPO_ROOT)
        cls.unreachable = unreachable_controls(REPO_ROOT)
        cls.manifest = _manifest()

    def test_the_convention_still_selects_a_real_control_surface(self) -> None:
        # If a rename swept the control verbs away, every later assertion in
        # this file would pass over an empty set and prove nothing. The floor
        # is deliberately far below the 85 measured, so it fails on collapse
        # rather than on ordinary drift.
        self.assertGreater(len(self.controls), 40, "control-verb convention no longer selects the kernel's controls")

    def test_the_production_roster_still_covers_the_repository(self) -> None:
        # PRODUCTION_SOURCE_ROOTS narrows the scan so this gate cannot be
        # raced by the trees the rest of the suite creates. A narrowed scan
        # is exactly the shape of ORPHAN-HIGH-569 — a list that was true when
        # written and quietly stopped describing the repo — so the list is
        # not allowed to stand unchecked. Production Python appearing outside
        # the roster means the roster is stale, and a stale roster would make
        # a live caller invisible and its control look dormant.
        stray = unrostered_production_dirs(REPO_ROOT)
        self.assertEqual(
            stray,
            {},
            "production Python outside PRODUCTION_SOURCE_ROOTS "
            f"{PRODUCTION_SOURCE_ROOTS}: {stray} — extend the roster",
        )

    def test_every_dormant_control_is_declared(self) -> None:
        undeclared = sorted(set(self.unreachable) - set(self.manifest))
        self.assertEqual(
            undeclared,
            [],
            "control(s) with no production caller and no dormancy waiver: "
            + ", ".join(f"{n} ({self.unreachable[n]['module']})" for n in undeclared),
        )

    def test_every_waiver_names_an_owner_a_reason_a_deadline_and_a_finding(self) -> None:
        for name, entry in sorted(self.manifest.items()):
            with self.subTest(control=name):
                for field in REQUIRED_WAIVER_FIELDS:
                    self.assertTrue(
                        str(entry.get(field, "")).strip(),
                        f"waiver for {name} is missing {field}",
                    )
                # Without an ID nothing gets worked — which is how twenty-five
                # TypeScript waivers reached one shared expiry together.
                self.assertRegex(entry["finding_id"], r"^[A-Z]+-(CRITICAL|HIGH|MEDIUM|LOW)-\d{3}$")

    def test_a_waiver_expires_against_the_clock_not_against_a_regex(self) -> None:
        # THE LESSON. `invariant-reachability.spec.ts` checked this field's
        # shape and not its value; every waiver was a month stale and green.
        today = date.today()
        expired = [
            f"{name} (expired {entry['expires_on']}, {entry['finding_id']})"
            for name, entry in sorted(self.manifest.items())
            if date.fromisoformat(entry["expires_on"]) < today
        ]
        self.assertEqual(expired, [], "dormancy waiver(s) past their deadline: " + ", ".join(expired))

    def test_a_waiver_for_a_control_that_is_now_wired_must_be_removed(self) -> None:
        # The manifest must not outlive the problem. A waiver left behind
        # after the control was wired is a standing licence to un-wire it.
        revived = sorted(set(self.manifest) & (set(self.controls) - set(self.unreachable)))
        self.assertEqual(
            revived,
            [],
            "control(s) now reachable but still waived — delete the waiver: " + ", ".join(revived),
        )

    def test_a_waiver_for_a_control_that_no_longer_exists_must_be_removed(self) -> None:
        ghosts = sorted(set(self.manifest) - set(self.controls))
        self.assertEqual(ghosts, [], "waiver(s) naming a control that no longer exists: " + ", ".join(ghosts))

    def test_the_secret_scanner_this_gate_found_is_wired(self) -> None:
        # The gate's first catch, pinned by name so it cannot silently
        # regress into the dormant set it came from: an agent response
        # envelope carries stdout, stderr and validation_results, and its
        # sibling verify_no_secret_in_diff never sees any of them.
        control = self.controls.get("verify_no_secret_in_envelope")
        self.assertIsNotNone(control, "verify_no_secret_in_envelope disappeared")
        reference = first_production_reference(
            "verify_no_secret_in_envelope", control, repo_root=REPO_ROOT
        )
        self.assertIsNotNone(reference, "the envelope secret scan lost its production caller again")
        self.assertNotIn("verify_no_secret_in_envelope", self.manifest)


if __name__ == "__main__":
    unittest.main()
