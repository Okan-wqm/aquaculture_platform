"""D5 / PLAN-v2 F3.2 — the one red-first prover, pinned before it exists.

WHY. ARIA has no function that proves "this test is red at one commit and
green at another, for the reason it claims". The closest live computation,
``validation._regression_status``, lets the apply gate accept ``improved`` and
``no_regression`` alike, so red-first is never required; the red→green fact
per finding (``finding.record_finding_reproduction`` /
``record_finding_fix_verification``) has no prover that classifies WHY a run
was red. A test that is red because its import broke "proves" any claim.

The design (DESIGN-discovery.md step 9, row D5) gives the prover one home and
one signature, ``validation.prove_red_first(red_at, green_at, pin)``:

* the pin is ``{files, command, failure_signature, expectation_ref}``; its
  files must be test files and its command must pass
  ``validation.parse_allowed_command`` — anything else is refused before a
  single worktree exists;
* the pin runs in two fresh worktrees (``green_at`` and ``red_at``) under the
  validation sandbox, and both runs land on the one ``validation_runs``
  ledger with a closed failure-reason class
  (``assertion``/``collection``/``import``/``timeout``/``infra_required``);
* the verdict is closed: ``proven`` (green at ``green_at``, red at ``red_at``
  for ``assertion`` with the pin's signature), ``exposed`` (red at both for
  ``assertion``), ``wrong_reason``, ``refuted`` (green at ``red_at``),
  ``unrunnable``.

The SAME call serves discovery (``red_at`` = head) and a fix (``red_at`` =
the fix's base): fixture (g) swaps the SHAs of one change and gets the other
answer.

Fixture repository (one tree, three commits):
  A  ``add`` correct, ``sub`` present, ``mul`` wrong (a bug older than A)
  B  ``add`` broken (the regression), ``sub`` removed, ``mul`` still wrong
  C  ``add`` fixed again (the fix of B)

Every test here pins NEW API (``validation.prove_red_first``,
``validation.PROOF_VERDICTS``,
``validation_runs_ledger.VALIDATION_FAILURE_REASONS``); at the branch base each
is red by assertion through ``_prover`` / the vocabulary checks, not by an
import or collection error.
"""
from __future__ import annotations

import ast
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable

from aria_kernel import validation, validation_runs_ledger
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.validation_runs_ledger import list_validation_runs
from tests._helpers.git_fixtures import _git, commit_files, make_repo_with_initial_commit
from tests._helpers.sandbox_pins import require_sandbox_backend

_CALC_A = "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a + b\n"
_CALC_B = "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a + b\n"
_CALC_C = "def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a + b\n"

_PIN_PATH = "tests/test_probe.py"
_PIN_COMMAND = "python3 -m unittest tests.test_probe"


def _probe(body: str) -> str:
    return (
        "import unittest\n\nimport calc\n\n\n"
        "class Probe(unittest.TestCase):\n"
        "    def test_claim(self):\n"
        f"        {body}\n"
    )


_ADD_PROBE = _probe("self.assertEqual(calc.add(2, 3), 5)")
_MUL_PROBE = _probe("self.assertEqual(calc.mul(2, 3), 6)")
_SUB_PROBE = "import unittest\n\nfrom calc import sub\n\n\nclass Probe(unittest.TestCase):\n    def test_claim(self):\n        self.assertEqual(sub(5, 3), 2)\n"
_UNCOLLECTABLE_PROBE = "import unittest\n\n\nclass Probe(unittest.TestCase:\n    pass\n"


def _pin(source: str, signature: str, **overrides: Any) -> dict[str, Any]:
    pin = {
        "files": {_PIN_PATH: source},
        "command": _PIN_COMMAND,
        "failure_signature": signature,
        "expectation_ref": "calc.py:1",
    }
    pin.update(overrides)
    return pin


class ProveRedFirstTests(unittest.TestCase):
    def setUp(self) -> None:
        require_sandbox_backend()
        tmp = tempfile.TemporaryDirectory(prefix="aria-d5-prover-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name).resolve()
        self.repo = make_repo_with_initial_commit(
            root, {"calc.py": _CALC_A, "tests/__init__.py": ""}, name="subject",
        )
        self.sha_a = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        self.sha_b = commit_files(self.repo, {"calc.py": _CALC_B}, message="fixture: regress add, drop sub")
        self.sha_c = commit_files(self.repo, {"calc.py": _CALC_C}, message="fixture: fix add")
        self.store = ensure_tools_dir(root / "aria-tools")
        set_profile("standard", operator_approval_ref="t", base_dir=self.store)

    def _prover(self) -> Callable[..., dict[str, Any]]:
        prove = getattr(validation, "prove_red_first", None)
        self.assertIsNotNone(prove, "validation.prove_red_first does not exist: D5 / F3.2 has no prover")
        return prove

    def _prove(self, *, red_at: str, green_at: str, pin: dict[str, Any]) -> dict[str, Any]:
        return self._prover()(
            red_at=red_at, green_at=green_at, pin=pin,
            workspace_root=self.repo, base_dir=self.store, runner_identity="d5-prover-test",
        )

    def _runs_at(self, sha: str) -> list[dict[str, Any]]:
        return [row for row in list_validation_runs(base_dir=self.store) if row.get("commit_sha") == sha]

    def _assert_one_run_each(self, red_at: str, green_at: str) -> tuple[dict[str, Any], dict[str, Any]]:
        rows = list_validation_runs(base_dir=self.store)
        self.assertEqual(sorted(row["commit_sha"] for row in rows), sorted([red_at, green_at]),
                         "one pin run per side, each recorded on the one ledger at the SHA it ran at")
        (red,) = self._runs_at(red_at)
        (green,) = self._runs_at(green_at)
        return red, green

    def _assert_hermetic(self) -> None:
        """Two fresh worktrees, gone afterwards; the subject checkout untouched."""
        self.assertEqual(_git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip(), self.sha_c)
        self.assertEqual(_git(["status", "--porcelain", "--untracked-files=all"], cwd=self.repo).stdout, "")
        worktrees = [line for line in _git(["worktree", "list", "--porcelain"], cwd=self.repo).stdout.splitlines()
                     if line.startswith("worktree ")]
        self.assertEqual(worktrees, [f"worktree {self.repo}"], "the prover's worktrees must not outlive the proof")

    def _assert_contained(self, row: dict[str, Any]) -> None:
        """The run's hash-bound log records the argv that executed: bwrap first."""
        line = next(line for line in Path(row["log_path"]).read_text(encoding="utf-8").splitlines()
                    if line.startswith("argv: "))
        argv = ast.literal_eval(line[len("argv: "):])
        self.assertEqual(os.path.basename(argv[0]), "bwrap",
                         "every pin run executes under implementation_safety.wrap_validation_in_sandbox")

    def _assert_nothing_ran(self) -> None:
        self.assertEqual(list_validation_runs(base_dir=self.store), [])
        self._assert_hermetic()

    # (a) green at base / red at head with an assertion → proven
    def test_a_green_at_base_red_at_head_for_the_claimed_assertion_is_proven(self) -> None:
        result = self._prove(red_at=self.sha_b, green_at=self.sha_a, pin=_pin(_ADD_PROBE, "-1 != 5"))
        self.assertEqual(result["verdict"], "proven")
        red, green = self._assert_one_run_each(self.sha_b, self.sha_a)
        self.assertEqual((green["status"], green.get("failure_reason")), ("ok", None))
        self.assertEqual((red["status"], red["failure_reason"]), ("failed", "assertion"))
        self._assert_contained(red)
        self._assert_contained(green)
        self._assert_hermetic()

    def test_a_red_for_an_assertion_other_than_the_pinned_signature_is_wrong_reason(self) -> None:
        result = self._prove(red_at=self.sha_b, green_at=self.sha_a, pin=_pin(_ADD_PROBE, "999 != 5"))
        self.assertEqual(result["verdict"], "wrong_reason",
                         "red for an assertion the pin did not claim proves nothing about the claim")

    # (b) red at both → exposed
    def test_b_red_at_both_for_the_claimed_assertion_is_exposed(self) -> None:
        result = self._prove(red_at=self.sha_b, green_at=self.sha_a, pin=_pin(_MUL_PROBE, "5 != 6"))
        self.assertEqual(result["verdict"], "exposed")
        red, green = self._assert_one_run_each(self.sha_b, self.sha_a)
        self.assertEqual([red["failure_reason"], green["failure_reason"]], ["assertion", "assertion"])

    # (c) red from an import or collection error → wrong_reason
    def test_c_red_from_an_import_error_is_wrong_reason(self) -> None:
        result = self._prove(red_at=self.sha_b, green_at=self.sha_a, pin=_pin(_SUB_PROBE, "cannot import name"))
        self.assertEqual(result["verdict"], "wrong_reason")
        red, green = self._assert_one_run_each(self.sha_b, self.sha_a)
        self.assertEqual(red["failure_reason"], "import")
        self.assertEqual(green["status"], "ok")

    def test_c_red_from_a_collection_error_at_both_is_wrong_reason_not_exposed(self) -> None:
        result = self._prove(red_at=self.sha_b, green_at=self.sha_a, pin=_pin(_UNCOLLECTABLE_PROBE, "SyntaxError"))
        self.assertEqual(result["verdict"], "wrong_reason")
        red, green = self._assert_one_run_each(self.sha_b, self.sha_a)
        self.assertEqual([red["failure_reason"], green["failure_reason"]], ["collection", "collection"])

    # (d) green at head → refuted
    def test_d_green_at_red_at_is_refuted(self) -> None:
        result = self._prove(red_at=self.sha_c, green_at=self.sha_b, pin=_pin(_ADD_PROBE, "-1 != 5"))
        self.assertEqual(result["verdict"], "refuted")
        red, _green = self._assert_one_run_each(self.sha_c, self.sha_b)
        self.assertEqual((red["status"], red.get("failure_reason")), ("ok", None))

    # (e) command off the allowlist → refused
    def test_e_a_pin_command_parse_allowed_command_refuses_is_refused_before_any_run(self) -> None:
        for command in ("bash -c 'exit 1'",
                        "python3 -c 'import calc'",
                        f"{_PIN_COMMAND}; rm -rf calc.py"):
            with self.subTest(command=command):
                with self.assertRaises(GovernanceError):
                    self._prove(red_at=self.sha_b, green_at=self.sha_a,
                                pin=_pin(_ADD_PROBE, "-1 != 5", command=command))
                self._assert_nothing_ran()

    # (f) pin writing a non-test path → refused
    def test_f_a_pin_writing_outside_the_test_globs_is_refused_before_any_run(self) -> None:
        for files in ({"calc.py": _CALC_A},
                      {_PIN_PATH: _ADD_PROBE, "calc.py": _CALC_A},
                      {"tests/../calc.py": _CALC_A},
                      {"tests/conftest.py": "x = 1\n"}):
            with self.subTest(files=sorted(files)):
                with self.assertRaises(GovernanceError):
                    self._prove(red_at=self.sha_b, green_at=self.sha_a,
                                pin=_pin(_ADD_PROBE, "-1 != 5", files=files))
                self._assert_nothing_ran()

    # (g) the same call with swapped SHAs proves a fix
    def test_g_the_fix_of_b_is_proven_by_the_same_call_with_its_shas_swapped(self) -> None:
        pin = _pin(_ADD_PROBE, "-1 != 5")
        discovery = self._prove(red_at=self.sha_c, green_at=self.sha_b, pin=pin)
        self.assertEqual(discovery["verdict"], "refuted", "C is no regression: the pin is green at its head")
        fix = self._prove(red_at=self.sha_b, green_at=self.sha_c, pin=pin)
        self.assertEqual(fix["verdict"], "proven", "red at the fix's base, green at its head: the fix is proven")
        self._assert_hermetic()

    # D5-R1-SSOT-B1: an assertion whose message names an infra token is
    # still an assertion red, so the pair is proven, not unrunnable.
    def test_an_assertion_naming_an_infra_token_is_proven_not_unrunnable(self) -> None:
        good = commit_files(self.repo, {"errmap.py": "def code_for(n):\n    return {111: 'ECONNREFUSED'}.get(n)\n"},
                            message="fixture: errno map")
        bad = commit_files(self.repo, {"errmap.py": "def code_for(n):\n    return {111: 'ETIMEDOUT'}.get(n)\n"},
                           message="fixture: regress errno map")
        probe = ("import unittest\n\nimport errmap\n\n\nclass Probe(unittest.TestCase):\n"
                 "    def test_claim(self):\n        self.assertEqual(errmap.code_for(111), 'ECONNREFUSED')\n")
        result = self._prove(red_at=bad, green_at=good, pin=_pin(probe, "'ETIMEDOUT' != 'ECONNREFUSED'"))
        self.assertEqual(result["verdict"], "proven")
        red, _green = self._assert_one_run_each(bad, good)
        self.assertEqual(red["failure_reason"], "assertion")

    # SEC-B1: the commit under proof is untrusted; a symlink it holds must
    # not carry the pin's write out of the worktree.
    def test_a_pin_path_through_a_symlink_the_commit_holds_is_refused_and_writes_nothing_outside(self) -> None:
        outside = Path(tempfile.mkdtemp(prefix="aria-d5-outside-")).resolve()
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        victim, victim_dir = outside / "victim.txt", outside / "victim-dir"
        victim.write_bytes(b"ORIGINAL\n")
        victim_dir.mkdir()
        (self.repo / "tests" / "test_evil.py").symlink_to(victim)
        (self.repo / "evil").symlink_to(victim_dir)
        _git(["add", "-A"], cwd=self.repo)
        _git(["commit", "-q", "-m", "fixture: symlinks out of the tree"], cwd=self.repo)
        hostile = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        for path in ("tests/test_evil.py", "evil/made_here/test_x.py"):
            with self.subTest(path=path):
                with self.assertRaisesRegex(GovernanceError, "red_first_pin_path_escapes_worktree"):
                    self._prove(red_at=hostile, green_at=self.sha_a,
                                pin=_pin(_ADD_PROBE, "-1 != 5", files={path: _ADD_PROBE}))
                self.assertEqual(victim.read_bytes(), b"ORIGINAL\n")
                self.assertEqual(list(victim_dir.iterdir()), [])
                worktrees = [line for line in _git(["worktree", "list", "--porcelain"], cwd=self.repo).stdout.splitlines()
                             if line.startswith("worktree ")]
                self.assertEqual(worktrees, [f"worktree {self.repo}"])


class ProofVocabularyTests(unittest.TestCase):
    """The two closed vocabularies the design names, owned once each."""

    def test_failure_reason_classes_live_on_the_validation_runs_ledger(self) -> None:
        self.assertEqual(
            getattr(validation_runs_ledger, "VALIDATION_FAILURE_REASONS", None),
            ("assertion", "collection", "import", "timeout", "infra_required"),
        )

    def test_proof_verdicts_live_beside_the_prover(self) -> None:
        self.assertEqual(
            getattr(validation, "PROOF_VERDICTS", None),
            ("proven", "exposed", "wrong_reason", "refuted", "unrunnable"),
        )


if __name__ == "__main__":
    unittest.main()
