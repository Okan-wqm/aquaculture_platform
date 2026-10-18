"""ARIA-MEDIUM-400 — a fixture verdict is bound to the code it measured.

The ``fixture_calibration`` proof row (``fixture_runner.fixture_suite_row``)
is what SHADOW -> ACTIVE readiness reads (``latest_fixture_status``). Schema
version 1 named the tool version, the manifest hash and the fixture-set hash,
but neither the workspace commit the suite ran against nor the bytes of the
files the runner argv executed. ``latest_fixture_status`` judged currency on
those three alone, so an adapter whose script changed after its suite passed
kept a current verdict: the verdict outlived the code it measured.

Schema version 2 binds both inside ``evidence_hash``, and the reader re-hashes
the argv-named files before it calls a verdict current. A version-1 row stays
readable history and is never current.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel import fixture_runner, register_tool, run_fixture_suite
from aria_kernel.implementation_safety import KERNEL_CHECKOUT_ROOT
from aria_kernel.ledger import LedgerIntegrityError, append_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir, get_tool
from tests._helpers.git_fixtures import commit_files, make_local_git_repo

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"
RULES = "rules/findings.json"


def _tool_record() -> dict:
    return {
        "tool_id": "bound-adapter",
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["rules/**"],
        "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
        "fixture_set": "tools/aria-adapters/fixtures/bound-adapter",
        "health_thresholds": {"max_cost_units": 10},
        "allowed_read_globs": ["rules/**"],
        "forbidden_read_globs": [],
        "claim_types": ["drift"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            # The argv names a workspace file (the way a ts-node runner names
            # tools/gates/tsconfig.json and the adapter's .ts entry) and an
            # absolute kernel program (a trusted helper of this checkout).
            "argv": ["python3", FAKE_RUNNER.as_posix(), "--findings-file", RULES],
            "cwd": ".",
            "timeout_ms": 30_000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


class _Workspace:
    """A committed checkout with one fixture case and the registered tool."""

    def __init__(self, parent: Path, name: str) -> None:
        self.root = make_local_git_repo(parent, name=name, initial_commit=False)
        self.tools = self.root / ".aria-state-store" / "tools"
        ensure_tools_dir(self.tools)
        fixture_dir = self.root / "tools" / "aria-adapters" / "fixtures" / "bound-adapter"
        self.head = commit_files(self.root, {
            RULES: "[]\n",
            "tools/aria-adapters/fixtures/bound-adapter/cases/baseline.json": json.dumps(
                {"input": {}, "expected": {"status": "ok", "max_findings": 0}},
            ),
        })
        self.fixture_dir = fixture_dir
        register_tool(_tool_record(), base_dir=self.tools)


class FixtureProofRowBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = {key: os.environ.get(key) for key in ("ARIA_TOOLS_DIR", "ARIA_REPO_ROOT")}
        os.environ.pop("ARIA_REPO_ROOT", None)
        os.environ.pop("ARIA_TOOLS_DIR", None)
        self.parent = Path(tempfile.mkdtemp(prefix="aria-m400-"))
        self.ws = _Workspace(self.parent, "workspace")

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.parent, ignore_errors=True)

    def _run(self) -> dict:
        return run_fixture_suite(
            "bound-adapter", workspace_root=self.ws.root, cycle_id="cycle-m400", base_dir=self.ws.tools,
        )

    def _status(self) -> dict:
        return fixture_runner.latest_fixture_status(
            "bound-adapter", base_dir=self.ws.tools, workspace_root=self.ws.root,
        )

    def test_the_suite_row_binds_the_commit_and_the_argv_scripts(self) -> None:
        summary = self._run()

        self.assertEqual(summary["actual_status"], "pass", summary["failed_cases"])
        self.assertEqual(summary["schema_version"], 2)
        self.assertEqual(summary["workspace_commit_sha"], self.ws.head)
        tool = get_tool("bound-adapter", self.ws.tools)
        self.assertEqual(
            summary["argv_scripts_hash"],
            fixture_runner.suite_scripts_digest(
                tool, self.ws.fixture_dir, workspace_root=self.ws.root, store=self.ws.tools,
            ),
        )
        # Both facts are inside evidence_hash: a row that names another commit
        # or other script bytes is another row.
        for field, other in (("workspace_commit_sha", "f" * 40), ("argv_scripts_hash", "sha256:" + "0" * 64)):
            forged = {**summary, field: other}
            self.assertNotEqual(
                fixture_runner._compute_suite_evidence_hash(forged), summary["evidence_hash"], field,
            )
        # The strict reader admits what the producer wrote.
        stored = fixture_runner.load_fixture_runs("bound-adapter", base_dir=self.ws.tools)[-1]
        self.assertEqual({key: stored[key] for key in summary}, summary)

    def test_a_verdict_does_not_outlive_the_scripts_it_measured(self) -> None:
        self._run()
        self.assertTrue(self._status()["current_tool_passed"])

        # Same tool version, same manifest, same fixture set: only the bytes
        # the runner argv names changed after the verdict.
        rules = self.ws.root / RULES
        rules.write_text("[ ]\n", encoding="utf-8")
        status = self._status()
        self.assertTrue(status["version_matches"] and status["manifest_matches"] and status["fixture_matches"])
        self.assertFalse(status["current_tool_passed"])
        self.assertFalse(status["scripts_match"])

        rules.write_text("[]\n", encoding="utf-8")
        self.assertTrue(self._status()["current_tool_passed"])

    def test_a_row_that_binds_no_scripts_is_never_current(self) -> None:
        summary = self._run()
        legacy = {
            key: value for key, value in summary.items()
            if key not in {"workspace_commit_sha", "argv_scripts_hash", "evidence_hash", "ledger_hash", "previous_ledger_hash"}
        }
        legacy["schema_version"] = 1
        legacy["evidence_hash"] = fixture_runner._compute_suite_evidence_hash(legacy)
        append_declared_jsonl(
            fixture_runner.fixture_runs_path(self.ws.tools), legacy, expected_surface="agent_eval_fixture_runs",
        )

        latest = fixture_runner.load_fixture_runs("bound-adapter", base_dir=self.ws.tools)[-1]
        self.assertEqual(latest["schema_version"], 1)  # history stays readable
        status = self._status()
        self.assertTrue(status["passed"] and status["version_matches"] and status["fixture_matches"])
        self.assertFalse(status["current_tool_passed"])
        self.assertFalse(status["scripts_match"])

    def test_the_digest_names_no_host_path(self) -> None:
        twin = _Workspace(self.parent, "twin-checkout")
        tool = get_tool("bound-adapter", self.ws.tools)
        here = fixture_runner.suite_scripts_digest(
            tool, self.ws.fixture_dir, workspace_root=self.ws.root, store=self.ws.tools,
        )
        there = fixture_runner.suite_scripts_digest(
            tool, twin.fixture_dir, workspace_root=twin.root, store=twin.tools,
        )
        self.assertEqual(here, there)
        self.assertTrue(FAKE_RUNNER.is_relative_to(KERNEL_CHECKOUT_ROOT))
        (twin.root / RULES).write_text("[ ]\n", encoding="utf-8")
        self.assertNotEqual(
            here,
            fixture_runner.suite_scripts_digest(tool, twin.fixture_dir, workspace_root=twin.root, store=twin.tools),
        )

    def test_an_argv_element_no_file_can_be_named_by_is_text(self) -> None:
        # A base64 payload on the argv (tests/_helpers/fake_tool_runner.py
        # --output-b64) is longer than NAME_MAX: Python 3.12 stat raises
        # ENAMETOOLONG for it, which must not escape the digest.
        tool = {**get_tool("bound-adapter", self.ws.tools)}
        tool["runner"] = {**tool["runner"], "argv": [*tool["runner"]["argv"], "--output-b64", "e" * 400]}
        digest = fixture_runner.suite_scripts_digest(
            tool, self.ws.fixture_dir, workspace_root=self.ws.root, store=self.ws.tools,
        )
        self.assertTrue(digest.startswith("sha256:"))

    def test_the_capability_evidence_reads_only_rows_that_name_their_code(self) -> None:
        """The same reset on the capability side: fixture_calibration@2 admits
        version-2 rows only, so a version-1 pass stops at the schema gate."""
        from aria_kernel.autonomy_evidence import _evaluate_native_rows

        summary = {**self._run(), "ledger_hash": "sha256:" + "e" * 64, "previous_ledger_hash": None}
        legacy = {
            key: value for key, value in summary.items() if key not in {"workspace_commit_sha", "argv_scripts_hash"}
        }
        legacy["schema_version"] = 1
        _candidates, _counts, blockers = _evaluate_native_rows(
            "fixture_calibration", {"agent_eval_fixture_runs": (legacy,)},
        )
        self.assertEqual(blockers, ("proof_schema_unsupported:agent_eval_fixture_runs",))
        # ARIA-HIGH-004 — fixture_calibration@3: the version-2 row is a proof
        # bound to the commit it names.
        candidates, _counts, blockers = _evaluate_native_rows(
            "fixture_calibration", {"agent_eval_fixture_runs": (summary,)},
        )
        self.assertEqual(blockers, ())
        self.assertEqual([c.evidence_target_sha for c in candidates], [summary["workspace_commit_sha"]])

    def test_the_strict_reader_refuses_a_version_two_row_that_binds_nothing(self) -> None:
        summary = self._run()
        path = fixture_runner.fixture_runs_path(self.ws.tools)
        for field, value, reason in (
            ("argv_scripts_hash", None, "argv_scripts_hash_invalid"),
            ("workspace_commit_sha", "abc", "workspace_commit_sha_invalid"),
        ):
            with self.subTest(field=field):
                row = {
                    key: item for key, item in summary.items()
                    if key not in {"evidence_hash", "ledger_hash", "previous_ledger_hash"}
                }
                row[field] = value
                row["evidence_hash"] = fixture_runner._compute_suite_evidence_hash(row)
                with self.assertRaises(LedgerIntegrityError) as ctx:
                    fixture_runner._validate_fixture_run_row(
                        {**row, "ledger_hash": "sha256:" + "e" * 64, "previous_ledger_hash": None}, path=path, line=1,
                    )
                self.assertIn(reason, str(ctx.exception))
        missing = {
            **{key: item for key, item in summary.items() if key != "argv_scripts_hash"},
            "ledger_hash": "sha256:" + "e" * 64, "previous_ledger_hash": None,
        }
        with self.assertRaises(LedgerIntegrityError) as ctx:
            fixture_runner._validate_fixture_run_row(missing, path=path, line=1)
        self.assertIn("missing_top_level_fields=argv_scripts_hash", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
