"""CB-5 / program ruling 15 — subject pins are committed policy data, never kernel literals.

ADR-0021 left the subject-pin hook as ``plan_origin.SUBJECT_PIN_POLICY``, a
Python tuple: the only way to pin a path into a plan's admission bound was a
literal in kernel source, and any caller of ``compute_admission_scope`` could
hand in its own pins (``pin_policy=``). The bound now reads
``docs/aria/policy/subject-pins.json`` as committed at the workspace's
main-proven commit (``main_anchor.resolve_main_anchor`` +
``main_anchor.committed_blob``), records which blob it read on the admission
record, and fails closed by name: a missing, malformed or unanchored policy
pins nothing, says why on the record and discloses it once in governance.

A fix's journey pin (``<project>/src/__journeys__/…pin.json``) needs no pin at
all: it lies under its own project's closure root, which the bound admits
(``test_a_fixs_journey_pin_lies_inside_the_bound_of_its_own_project``).

The fixture is the four-project graph of ``test_revision_scope_bound`` as a
git checkout whose commits are published to ``refs/remotes/origin/main``.
"""
from __future__ import annotations

import inspect
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.main_anchor import ANCHOR_HEAD_UNRESOLVED, ANCHOR_NOT_ON_MAIN
from aria_kernel.plan_convergence import _append_event, content_hash, fold_plan_state, start_plan
from aria_kernel.plan_origin import (
    SUBJECT_PIN_POLICY_ANCHOR_UNAVAILABLE,
    SUBJECT_PIN_POLICY_MALFORMED,
    SUBJECT_PIN_POLICY_MISSING,
    SUBJECT_PIN_POLICY_PATH,
    SUBJECT_PIN_POLICY_REFUSED,
    compute_admission_scope,
    paths_outside_admission_scope,
    validate_admission_scope,
)
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.git_fixtures import make_local_git_repo
from tests.test_revision_scope_bound import FARM, _seed, _seed_workspace, _write_workspace

RUNBOOK_PIN = {"subject": "F-007", "paths": ["docs/runbooks/farm.md"]}


def _policy(pins: list[dict]) -> str:
    return json.dumps({"$schema": "aria/subject-pins/v1", "schema_version": 1,
                       "policy_id": "aria-subject-pins", "subject_pins": pins}, indent=2) + "\n"


class SubjectPinPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-subject-pins-")
        self.addCleanup(self.tmp.cleanup)
        # ORPHAN-HIGH-519 — _seed_workspace creates and commits the four-project
        # workspace, because the converter grounds the seed's refs at HEAD.
        self.repo = Path(self.tmp.name) / "workspace"
        _seed_workspace(self.repo)
        self._git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.tools = Path(self.tmp.name) / "aria-tools"
        self.seed = _seed(self.repo, "f_finding", "F-007", [FARM])

    def _git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True, text=True).stdout

    def _commit(self, files: dict[str, str], *, on_main: bool = True) -> str:
        for relative, text in files.items():
            (self.repo / relative).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / relative).write_text(text, encoding="utf-8")
            self._git("add", "--", relative)
        self._git("commit", "-q", "-m", "chore(test): policy")
        head = self._git("rev-parse", "HEAD").strip()
        if on_main:
            self._git("update-ref", "refs/remotes/origin/main", head)
        return head

    def _scope(self) -> dict:
        return compute_admission_scope(self.seed, workspace_root=self.repo, base_dir=self.tools)

    def _disclosures(self) -> list[dict]:
        path = self.tools / "governance.jsonl"
        rows = load_declared_jsonl(path, expected_surface="tools_governance") if path.exists() else []
        return [row["details"] for row in rows if row["kind"] == SUBJECT_PIN_POLICY_REFUSED]

    def test_a_committed_pin_on_main_joins_the_bound_of_the_subjects_it_names(self) -> None:
        head = self._commit({SUBJECT_PIN_POLICY_PATH: _policy([
            RUNBOOK_PIN,
            {"subject": "gateway", "paths": ["e2e/tests/gateway-consumer.spec.ts"]},  # a closure project
            {"subject": "auth-service", "paths": ["docs/auth.md"]},  # a project outside this closure
            {"subject": "F-999", "paths": ["docs/other.md"]},
        ])})
        scope = self._scope()
        self.assertEqual(scope["policy_pins"], ["docs/runbooks/farm.md", "e2e/tests/gateway-consumer.spec.ts"])
        blob = self._git("rev-parse", f"HEAD:{SUBJECT_PIN_POLICY_PATH}").strip()
        self.assertEqual(scope["pin_policy"], {"path": SUBJECT_PIN_POLICY_PATH, "commit": head,
                                               "blob_oid": blob, "refused": None})
        self.assertEqual(paths_outside_admission_scope(scope, ["docs/runbooks/farm.md", "docs/auth.md",
                                                               "docs/other.md"]), ["docs/auth.md", "docs/other.md"])
        self.assertEqual(self._disclosures(), [])

    def test_a_fixs_journey_pin_lies_inside_the_bound_of_its_own_project(self) -> None:
        # CB-5. A pin is a new file and never a grounding ref; it is admitted
        # because it lies under its project's closure root (ADR-0021 D2), so
        # the policy holds no derivation rule for it.
        self._commit({SUBJECT_PIN_POLICY_PATH: _policy([])})
        scope = self._scope()
        self.assertEqual(scope["policy_pins"], [])
        self.assertEqual(paths_outside_admission_scope(scope, [
            "apps/farm-service/src/__journeys__/feed/feed-type-enum.pin.json",
            "apps/gateway/src/__journeys__/farm/farm-query.pin.json",
            "apps/auth-service/src/__journeys__/login/role.pin.json",
            "apps/auth-service/src/new-helper.ts",
        ]), ["apps/auth-service/src/__journeys__/login/role.pin.json", "apps/auth-service/src/new-helper.ts"])

    def test_a_malformed_policy_admits_no_pin_and_says_why(self) -> None:
        def raw(**overrides: object) -> str:
            body = {"$schema": "aria/subject-pins/v1", "schema_version": 1, "policy_id": "aria-subject-pins",
                    "subject_pins": [RUNBOOK_PIN]}
            return json.dumps({**body, **overrides})

        cases = {
            "not_json": "{\"subject_pins\": [",
            "schema_version": raw(schema_version=2),
            "policy_id": raw(policy_id="aria-other"),
            "unknown_top_level_key": raw(subject_pin=[]),
            "entry_unknown_key": _policy([RUNBOOK_PIN, {"subject": "F-007", "path": ["docs/x.md"]}]),
            "traversal": _policy([RUNBOOK_PIN, {"subject": "F-007", "paths": ["docs/../../etc"]}]),
            "non_canonical": _policy([RUNBOOK_PIN, {"subject": "F-007", "paths": ["docs//runbooks/farm.md"]}]),
            "absolute": _policy([RUNBOOK_PIN, {"subject": "F-007", "paths": ["/etc/passwd"]}]),
            "empty_paths": _policy([RUNBOOK_PIN, {"subject": "F-007", "paths": []}]),
            "blank_subject": _policy([RUNBOOK_PIN, {"subject": " ", "paths": ["docs/x.md"]}]),
        }
        for name, text in cases.items():
            with self.subTest(name):
                self._commit({SUBJECT_PIN_POLICY_PATH: text})
                scope = self._scope()
                # The valid sibling entry is not admitted either: no partial policy.
                self.assertEqual(scope["policy_pins"], [])
                self.assertTrue(scope["pin_policy"]["refused"].startswith(SUBJECT_PIN_POLICY_MALFORMED + ":"))
                self.assertEqual(paths_outside_admission_scope(scope, ["docs/runbooks/farm.md"]),
                                 ["docs/runbooks/farm.md"])
        disclosed = self._disclosures()
        self.assertEqual(len(disclosed), len(cases))
        self.assertEqual({row["origin_finding_id"] for row in disclosed}, {"F-007"})
        # The same refused blob is a standing fact: disclosed once, not per plan.
        self._scope()
        self.assertEqual(len(self._disclosures()), len(cases))

    def test_a_missing_policy_or_an_unproven_anchor_admits_no_pin(self) -> None:
        scope = self._scope()
        self.assertEqual((scope["policy_pins"], scope["pin_policy"]["refused"]), ([], SUBJECT_PIN_POLICY_MISSING))
        self._commit({SUBJECT_PIN_POLICY_PATH: _policy([RUNBOOK_PIN])}, on_main=False)
        scope = self._scope()
        self.assertEqual((scope["policy_pins"], scope["pin_policy"]["refused"]),
                         ([], f"{SUBJECT_PIN_POLICY_ANCHOR_UNAVAILABLE}: {ANCHOR_NOT_ON_MAIN}"))
        # A workspace that is not a git checkout has no HEAD to anchor on.
        plain = Path(self.tmp.name) / "plain"
        _write_workspace(plain)
        scope = compute_admission_scope(self.seed, workspace_root=plain, base_dir=self.tools)
        self.assertEqual((scope["policy_pins"], scope["pin_policy"]["refused"]),
                         ([], f"{SUBJECT_PIN_POLICY_ANCHOR_UNAVAILABLE}: {ANCHOR_HEAD_UNRESOLVED}"))
        self.assertEqual([row["refused"] for row in self._disclosures()], [
            SUBJECT_PIN_POLICY_MISSING, f"{SUBJECT_PIN_POLICY_ANCHOR_UNAVAILABLE}: {ANCHOR_NOT_ON_MAIN}",
            f"{SUBJECT_PIN_POLICY_ANCHOR_UNAVAILABLE}: {ANCHOR_HEAD_UNRESOLVED}"])

    def test_a_plan_cannot_supply_or_rewrite_the_policy(self) -> None:
        # No caller hands the bound a policy; it reads the committed one.
        self.assertNotIn("pin_policy", inspect.signature(compute_admission_scope).parameters)
        on_main = self._commit({SUBJECT_PIN_POLICY_PATH: _policy([RUNBOOK_PIN])})
        # A working-tree edit, which is what an implementer's write makes, is not the committed blob.
        widened = _policy([RUNBOOK_PIN, {"subject": "F-007", "paths": ["apps/auth-service"]}])
        (self.repo / SUBJECT_PIN_POLICY_PATH).write_text(widened, encoding="utf-8")
        # A plan body naming pins or a bound is not read either.
        claims = dict(self.seed, subject_pins=[{"subject": "F-007", "paths": ["apps/auth-service"]}],
                      admission_scope={"policy_pins": ["apps/auth-service"]})
        start_plan(plan_id="plan-claims", plan_content=claims, initial_revision_id="plan-claims-r0",
                   base_dir=self.tools, workspace_root=self.repo)
        recorded = fold_plan_state(plan_id="plan-claims", base_dir=self.tools)["plan_started"]["admission_scope"]
        self.assertEqual((recorded["policy_pins"], recorded["pin_policy"]["commit"]),
                         (["docs/runbooks/farm.md"], on_main))
        # Committing the edit on an implementation branch proves nothing: the
        # commit is not on main, so no pin is admitted at all.
        self._git("commit", "-q", "-am", "chore(test): widen the policy off main")
        scope = self._scope()
        self.assertEqual((scope["policy_pins"], scope["pin_policy"]["refused"]),
                         ([], f"{SUBJECT_PIN_POLICY_ANCHOR_UNAVAILABLE}: {ANCHOR_NOT_ON_MAIN}"))
        # A record whose refused policy still carries pins is refused on the ledger.
        with self.assertRaisesRegex(GovernanceError, "pin_policy"):
            _append_event(root=self.tools, plan_id="plan-tampered", event_type="plan_started",
                          idempotency_key=content_hash({"tampered": 1}), payload={
                              "plan_content": self.seed, "content_hash": content_hash(self.seed),
                              "initial_revision_id": "plan-tampered-r0",
                              "admission_scope": dict(scope, policy_pins=["apps/auth-service"]),
                          })

    def test_a_record_from_before_the_committed_policy_still_folds_and_pins_nothing(self) -> None:
        scope = self._scope()
        legacy = {key: value for key, value in scope.items() if key != "pin_policy"}
        validate_admission_scope(dict(legacy, schema_version=1), self.seed)
        with self.assertRaisesRegex(GovernanceError, "policy_pins"):
            validate_admission_scope(dict(legacy, schema_version=1, policy_pins=["apps/auth-service"]), self.seed)
        with self.assertRaisesRegex(GovernanceError, "pin_policy"):
            validate_admission_scope(legacy, self.seed)


if __name__ == "__main__":
    unittest.main()
