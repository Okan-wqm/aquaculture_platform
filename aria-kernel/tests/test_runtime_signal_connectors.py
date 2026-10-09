"""ARIA-MEDIUM-394 — runtime-signal source connectors + the registered
record schema.

Two properties are pinned:
  1. schema sync — docs/aria/schemas/runtime-signal.schema.json mirrors
     the bridge's module constants (sources, severities, trust grade,
     required fields); drift fails the suite, so the registered
     contract can never silently diverge from the writer.
  2. the importer — maps sentry/incident/log_anomaly rows onto
     ingest_runtime_signal, resolves external identifiers to
     repo-relative code_refs (existing relpath, abs-under-root, path-map
     rewrite), and REPORTS dropped refs, never silently.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import importlib.util

from aria_kernel.runtime_signal_bridge import (
    RUNTIME_SEVERITIES,
    RUNTIME_SIGNAL_SOURCES,
    RUNTIME_TRUST_GRADE,
    ingest_runtime_signal,
)
from aria_kernel.tool_registry import ensure_tools_dir

REPO_ROOT = Path(__file__).resolve().parents[2]

# The connector lives in a dashed tools/ directory (repo convention for
# script surfaces) and runs as a script; load it by path, not by package
# name — the same doctrine as tools/aria-acceptance.
_SPEC = importlib.util.spec_from_file_location(
    "import_signals", REPO_ROOT / "tools" / "runtime-signals" / "import_signals.py"
)
import_signals = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(import_signals)
import_main = import_signals.main
map_rows = import_signals.map_rows
resolve_code_ref = import_signals.resolve_code_ref


class RuntimeSignalSchemaSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.schema = json.loads(
            (REPO_ROOT / "docs/aria/schemas/runtime-signal.schema.json").read_text(encoding="utf-8")
        )

    def test_source_enum_mirrors_the_bridge(self) -> None:
        self.assertEqual(
            set(self.schema["properties"]["source"]["enum"]),
            RUNTIME_SIGNAL_SOURCES,
        )

    def test_severity_enum_mirrors_the_bridge(self) -> None:
        self.assertEqual(
            set(self.schema["properties"]["severity"]["enum"]),
            RUNTIME_SEVERITIES,
        )

    def test_trust_grade_is_pinned_unverified(self) -> None:
        self.assertEqual(
            self.schema["properties"]["trust_grade"]["const"], RUNTIME_TRUST_GRADE
        )
        self.assertEqual(self.schema["properties"]["trust_grade"]["const"], "runtime_unverified")

    def test_required_fields_match_the_written_record(self) -> None:
        record_keys = set(ingest_runtime_signal(
            source="operator", service="s", summary="m",
            code_refs=["src/a.ts"], base_dir=tempfile.mkdtemp(),
        ))
        self.assertEqual(
            set(self.schema["required"]),
            set(record_keys),
        )


class ResolveCodeRefTests(unittest.TestCase):
    def test_repo_relative_existing_path_is_kept(self) -> None:
        self.assertEqual(
            resolve_code_ref("aria-kernel/aria_kernel/memory.py", REPO_ROOT, {}),
            "aria-kernel/aria_kernel/memory.py",
        )

    def test_absolute_path_under_root_is_made_relative(self) -> None:
        absolute = (REPO_ROOT / "libs/backend-common/src/index.ts").resolve()
        self.assertEqual(
            resolve_code_ref(str(absolute), REPO_ROOT, {}),
            "libs/backend-common/src/index.ts",
        )

    def test_path_map_rewrites_external_prefix(self) -> None:
        resolved = resolve_code_ref(
            "srv/kernel/cli.py:12", REPO_ROOT,
            {"srv/kernel": "aria-kernel/aria_kernel"},
        )
        self.assertEqual(resolved, "aria-kernel/aria_kernel/cli.py:12")

    def test_path_map_rewrite_to_a_missing_file_is_dropped(self) -> None:
        # The rewrite is grounded like every other candidate: a target the
        # repo does not hold is dropped, not passed through as "plausible".
        self.assertIsNone(resolve_code_ref(
            "srv/kernel/no_such_module.py", REPO_ROOT,
            {"srv/kernel": "aria-kernel/aria_kernel"},
        ))

    def test_url_and_out_of_repo_absolute_are_dropped(self) -> None:
        self.assertIsNone(resolve_code_ref("https://sentry.io/x", REPO_ROOT, {}))
        self.assertIsNone(resolve_code_ref("/etc/passwd", REPO_ROOT, {}))


class ImportSignalsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.tools = self.root / "aria-tools"
        ensure_tools_dir(self.tools)
        self.repo = self.root / "repo"
        (self.repo / "apps/farm-service/src").mkdir(parents=True)
        (self.repo / "apps/farm-service/src/feed.ts").write_text("x", encoding="utf-8")

    def test_sentry_rows_map_and_ingest_idempotently(self) -> None:
        rows = [{
            "title": "NPE in feed allocation",
            "culprit": "apps/farm-service/src/feed.ts in allocate",
            "project": "farm-service",
            "level": "error",
        }]
        mapped, dropped = map_rows("sentry", rows, repo_root=self.repo, path_map={})
        self.assertEqual(dropped, [])
        self.assertEqual(mapped[0]["source"], "sentry")
        self.assertEqual(mapped[0]["severity"], "high")
        self.assertEqual(mapped[0]["code_refs"], ["apps/farm-service/src/feed.ts"])
        first = ingest_runtime_signal(base_dir=self.tools, **mapped[0])
        second = ingest_runtime_signal(base_dir=self.tools, **mapped[0])
        self.assertEqual(first["signal_id"], second["signal_id"])

    def test_unmapped_external_prefix_is_reported_not_passed_through(self) -> None:
        rows = [{
            "title": "stall",
            "culprit": "opaque-module/src/thing.rs",
            "project": "p",
        }]
        mapped, dropped = map_rows("sentry", rows, repo_root=self.repo, path_map={})
        # A path the repo cannot ground is DROPPED and reported: a
        # "plausible" path is exactly what an attacker writing Sentry
        # events through the public DSN would send.
        self.assertEqual(mapped, [])
        self.assertTrue(any("opaque-module/src/thing.rs" in d for d in dropped))

    def test_row_without_grounded_ref_is_dropped_and_reported(self) -> None:
        rows = [{"title": "only summary", "project": "p", "culprit": ""}]
        mapped, dropped = map_rows("sentry", rows, repo_root=self.repo, path_map={})
        self.assertEqual(mapped, [])
        self.assertTrue(dropped)

    def test_cli_end_to_end_ingests_and_reports(self) -> None:
        payload = [{
            "summary": "decode loop stalls",
            "service": "sensor-service",
            "path": "apps/farm-service/src/feed.ts",
            "severity": "critical",
        }]
        input_path = self.root / "anomalies.json"
        input_path.write_text(json.dumps(payload), encoding="utf-8")
        import io, contextlib
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = import_main([
                "--kind", "log_anomaly",
                "--input", str(input_path),
                "--repo-root", str(self.repo),
                "--tools-dir", str(self.tools),
            ])
        self.assertEqual(code, 0)
        result = json.loads(out.getvalue())
        self.assertEqual(result["ingested"], 1)
        self.assertEqual(len(result["signal_ids"]), 1)
        self.assertEqual(result["dropped"], [])
        record = json.loads(
            next((self.tools / "runtime-signals").glob("*.json")).read_text(encoding="utf-8")
        )
        self.assertEqual(record["source"], "prod_log")
        # prod_log content is outside-authored: its severity is capped and the
        # reported value kept beside the bounded one.
        self.assertEqual(record["severity"], "high")
        self.assertEqual(record["reported_severity"], "critical")

    def test_line_suffix_is_kept_and_sentry_frame_objects_are_read(self) -> None:
        rows = [{
            "title": "NPE",
            "project": "farm-service",
            "location": [
                {"filename": "apps/farm-service/src/feed.ts", "lineno": 42},
                {"abs_path": str(self.repo / "apps/farm-service/src/feed.ts"), "lineno": 7},
                "apps/farm-service/src/feed.ts:9",
            ],
        }]
        mapped, dropped = map_rows("sentry", rows, repo_root=self.repo, path_map={})
        self.assertEqual(dropped, [])
        self.assertEqual(mapped[0]["code_refs"], [
            "apps/farm-service/src/feed.ts:42",
            "apps/farm-service/src/feed.ts:7",
            "apps/farm-service/src/feed.ts:9",
        ])

    def test_hostile_refs_are_dropped_and_reported_per_row(self) -> None:
        # Two hostile refs that DO resolve to files under the root, so it is
        # the bridge's ref law — not groundedness — that refuses them.
        (self.repo / "apps/farm-service/src/x").mkdir()
        (self.repo / "apps/farm-service/src/[f]eed.ts").write_text("x", encoding="utf-8")
        hostile = [
            "../../../../etc/passwd",
            "apps/../../../root/.ssh/id_rsa",
            "apps/farm-service/src/x/../feed.ts",
            "*/*",
            "apps/farm-service/src/[f]eed.ts",
            "apps/farm-service/src/feed.ts\x00",
            "this is prose about feed.ts",
            "/etc/passwd",
        ]
        rows = [{"summary": "s", "service": "svc", "code_refs": hostile}]
        mapped, dropped = map_rows("incident", rows, repo_root=self.repo, path_map={})
        self.assertEqual(mapped, [])
        self.assertEqual(len([d for d in dropped if d.startswith("<row 0:")]), len(hostile) + 1)
        refused = [d for d in dropped if "ref refused" in d]
        self.assertTrue(any("runtime_signal_ref_glob" in d for d in refused))
        self.assertTrue(any("agent_evidence_path_escapes_workspace" in d for d in refused))

    def test_a_non_object_row_is_reported_and_the_rest_still_map(self) -> None:
        rows = ["not a row", {"summary": "s", "service": "svc", "code_refs": ["apps/farm-service/src/feed.ts"]}]
        mapped, dropped = map_rows("incident", rows, repo_root=self.repo, path_map={})
        self.assertEqual(len(mapped), 1)
        self.assertTrue(any(d.startswith("<row 0: not a JSON object") for d in dropped))

    def _run(self, *argv: str) -> tuple[int, str]:
        import io, contextlib
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = import_main(list(argv))
        return code, out.getvalue()

    def test_path_map_must_be_an_object_of_strings(self) -> None:
        input_path = self.root / "rows.json"
        input_path.write_text("[]", encoding="utf-8")
        bad_map = self.root / "map.json"
        bad_map.write_text(json.dumps({"ext/": 3}), encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            self._run("--kind", "incident", "--input", str(input_path), "--repo-root", str(self.repo),
                      "--tools-dir", str(self.tools), "--path-map", str(bad_map))
        self.assertIn("--path-map", str(caught.exception))

    def test_oversized_input_is_refused_before_parsing(self) -> None:
        input_path = self.root / "big.json"
        input_path.write_text(" " * (import_signals.MAX_INPUT_BYTES + 1), encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            self._run("--kind", "incident", "--input", str(input_path), "--repo-root", str(self.repo),
                      "--tools-dir", str(self.tools))
        self.assertIn("at most", str(caught.exception))

    def test_too_many_rows_are_refused(self) -> None:
        input_path = self.root / "many.json"
        input_path.write_text(json.dumps([{}] * (import_signals.MAX_ROWS + 1)), encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            self._run("--kind", "incident", "--input", str(input_path), "--repo-root", str(self.repo),
                      "--tools-dir", str(self.tools))
        self.assertIn("rows", str(caught.exception))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
