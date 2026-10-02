"""ARIA-HIGH-292 — a tool's output size must not decide whether its findings exist.

The runner read an adapter's whole stdout, and past ``STDOUT_PARSE_MAX_BYTES``
(12 MiB) recorded ``budget_exceeded`` with EMPTY output: every finding of that
tool vanished for the cycle and nothing named what was lost. These tests pin
the replacement contract:

* the adapter protocol is consumed as a stream of records — parsing holds one
  incomplete record, never the whole stdout;
* the retained output is stored once, content-addressed (``sha256/<aa>/<hex>``),
  and the run row keeps the digest and the counts;
* past the per-run bound the run is ``truncated``: every record parsed before
  the bound is kept, the exact kept/dropped counts are recorded, and a
  governance event names the tool and what it dropped;
* readers resolve the same findings from a stored document as from a legacy
  inline artifact.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import tracemalloc
import unittest
from collections.abc import Iterator
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_enterprise_cycle import FAKE_RUNNER, register_tool, shadow_tool  # noqa: E402

from aria_kernel.ledger import load_jsonl  # noqa: E402
from aria_kernel.tool_runner import _parse_tool_output, run_tool  # noqa: E402

MIB = 1024 * 1024
OBSERVATION = {"id": "obs-1", "type": "fixture"}
TAIL = {
    "read_paths": ["src/app.ts"],
    "evidence_sources": ["src/app.ts"],
    "cost_units": 1,
    "metadata": {"fixture": True},
}


def _finding(index: int, pad: int) -> dict[str, Any]:
    return {
        "id": f"finding-{index:06d}",
        "rule": f"rule-{index % 7}",
        "message": "m" * pad,
        "evidence": [{"path": "src/app.ts", "line": 1}],
    }


def _encoded(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def _document_chunks(count: int, pad: int) -> Iterator[bytes]:
    """One adapter-protocol document, produced record by record — never
    materialized whole, so the parser test measures the parser alone."""
    yield b'{"observations":[' + _encoded(OBSERVATION) + b'],"findings":['
    for index in range(count):
        yield (b"," if index else b"") + _encoded(_finding(index, pad))
    yield b"]," + _encoded(TAIL)[1:] + b"\n"


# 690 findings of ~20 KB: 13.9 MB of stdout, over 13 MiB. (Few large records
# keep the per-row ledger cost of ingestion out of the test's runtime.)
LARGE_COUNT = 690
LARGE_PAD = 20000


def _legacy_parse(stdout: str, tool: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    """The whole-buffer parser this change retired, kept verbatim as the oracle
    the stream parser must agree with on every small output."""
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return None, "output_not_json"
    if not isinstance(payload, dict):
        return None, "output_not_dict"
    minimum = ("observations", "findings", "read_paths", "evidence_sources")
    required = set(minimum)
    required.update(tool.get("output_schema", {}).get("required", []))
    for field in sorted(required):
        if field not in payload:
            return None, f"missing_field:{field}"
    for field in minimum:
        if not isinstance(payload.get(field), list):
            return None, f"field_not_list:{field}"
    cost = payload.get("cost_units")
    if "cost_units" in payload and not (isinstance(cost, (int, float)) and cost >= 0):
        return None, "cost_units_invalid"
    if "metadata" in payload and not isinstance(payload["metadata"], dict):
        return None, "metadata_not_dict"
    if "belief_candidates" in payload and not isinstance(payload["belief_candidates"], list):
        return None, "belief_candidates_not_list"
    return payload, None


SMALL_OUTPUTS: tuple[str, ...] = (
    json.dumps({"observations": [OBSERVATION], "findings": [_finding(0, 3)], **TAIL}),
    json.dumps({"findings": [], "observations": [], "read_paths": [], "evidence_sources": []}, indent=2),
    '{"observations":[],"findings":[{"id":"f","n":12345,"x":-0.5e3,"t":true,"z":null}],'
    '"read_paths":["a"],"evidence_sources":[],"cost_units":12345}',
    '{"observations":[],"findings":[{"id":"\\u00e7\\u011f","m":"ğüşıöç ✓ 𝄞"}],"read_paths":[],"evidence_sources":[]}',
    '{"observations":[1,2.5,-3,"s",[1],{"a":[]}],"findings":[],"read_paths":[],"evidence_sources":[],"metadata":{}}',
    '{"findings":[{"id":"dup"}],"findings":[],"observations":[],"read_paths":[],"evidence_sources":[]}',
    "",
    "not json",
    "[]",
    '"x"',
    "12",
    "{}",
    '{"observations":[],"findings":{},"read_paths":[],"evidence_sources":[]}',
    '{"observations":[],"findings":[],"read_paths":[],"evidence_sources":[],"cost_units":-1}',
    '{"observations":[],"findings":[],"read_paths":[],"evidence_sources":[],"cost_units":null}',
    '{"observations":[],"findings":[],"read_paths":[],"evidence_sources":[],"metadata":[]}',
    '{"observations":[],"findings":[],"read_paths":[],"evidence_sources":[],"belief_candidates":{}}',
    '{"observations":[],"findings":[],"read_paths":[],"evidence_sources":[]} trailing',
    '{"observations":[],"findings":[1,],"read_paths":[],"evidence_sources":[]}',
    '{"observations":[],"findings":[],"read_paths":[],"evidence_sources":[],}',
    '{"observations":[],"findings":[',
    '{"observations" [],"findings":[]}',
)


class StreamParserAgreesWithLegacy(unittest.TestCase):
    """Readers see identical findings from the stream and the legacy parse."""

    def test_every_small_output_parses_identically(self) -> None:
        tool = shadow_tool()
        for stdout in SMALL_OUTPUTS:
            with self.subTest(stdout=stdout[:60]):
                self.assertEqual(_parse_tool_output(stdout, tool), _legacy_parse(stdout, tool))

    def test_any_chunking_of_a_document_yields_the_same_records(self) -> None:
        from aria_kernel.tool_runner import OutputStream

        tool = shadow_tool()
        for stdout in SMALL_OUTPUTS:
            data = stdout.encode("utf-8")
            expected = _legacy_parse(stdout, tool)
            for size in (1, 2, 3, 7, 64):
                with self.subTest(stdout=stdout[:40], chunk=size):
                    stream = OutputStream(retain_bytes=len(data) + 1)
                    for start in range(0, len(data), size):
                        stream.feed(data[start:start + size])
                    stream.close()
                    self.assertEqual(stream.result(tool), expected)
                    self.assertEqual(stream.sha256, "sha256:" + hashlib.sha256(data).hexdigest())


class StreamParserIsMemoryBounded(unittest.TestCase):
    def test_a_13_mib_stream_is_parsed_one_record_at_a_time(self) -> None:
        from aria_kernel.tool_runner import STREAM_CHUNK_BYTES, OutputStream

        tracemalloc.start()
        try:
            stream = OutputStream(retain_bytes=256 * 1024)
            for chunk in _document_chunks(LARGE_COUNT, LARGE_PAD):
                stream.feed(chunk)
            stream.close()
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertGreater(stream.consumed_bytes, 13 * MIB)
        # A whole-buffer read alone allocates the 13.8 MB stdout (twice, as
        # str and bytes). The stream holds one pending record plus a chunk.
        self.assertLess(peak, 4 * MIB, peak)
        self.assertLessEqual(stream.peak_pending, STREAM_CHUNK_BYTES + 4 * LARGE_PAD)
        output, error = stream.result(shadow_tool())
        self.assertIsNone(error)
        kept = stream.kept["findings"]
        self.assertEqual(kept + stream.dropped["findings"], LARGE_COUNT)
        self.assertEqual(len(output["findings"]), kept)
        self.assertEqual(output["findings"][-1], _finding(kept - 1, LARGE_PAD))
        self.assertTrue(stream.truncated)
        # Provenance is budgeted apart: dropping claims never drops the paths
        # that make the kept claims verifiable.
        self.assertEqual(output["read_paths"], TAIL["read_paths"])
        self.assertEqual(output["evidence_sources"], TAIL["evidence_sources"])


class ContentAddress(unittest.TestCase):
    def test_cas_layout_is_the_cold_store_layout(self) -> None:
        from aria_kernel.runtime_artifacts import cas_relative_path
        from aria_kernel.tool_registry import GovernanceError

        digest = "ab" + "cd" * 31
        self.assertEqual(cas_relative_path(f"sha256:{digest}"), f"sha256/ab/{digest}")
        self.assertEqual(cas_relative_path(digest), f"sha256/ab/{digest}")
        for bad in ("", "sha256:xyz", "sha256:" + "A" * 64, "../" + "a" * 61):
            with self.assertRaises(GovernanceError):
                cas_relative_path(bad)


class RunToolStreamsLargeOutput(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.workspace = self.root / "work"
        (self.workspace / "src").mkdir(parents=True)
        (self.workspace / "src" / "app.ts").write_text("x\n", encoding="utf-8")
        self.tools_dir = self.root / "tools"
        self.tools_dir.mkdir()
        self.output_file = self.root / "adapter-stdout.json"
        with self.output_file.open("wb") as handle:
            for chunk in _document_chunks(LARGE_COUNT, LARGE_PAD):
                handle.write(chunk)

    def _register(self, **runner: Any) -> None:
        tool = shadow_tool()
        tool["runner"]["argv"] = ["python3", FAKE_RUNNER.as_posix(), "--output-file", self.output_file.as_posix()]
        tool["runner"]["timeout_ms"] = 120_000
        tool["runner"].update(runner)
        register_tool(tool, base_dir=self.tools_dir)

    def _run(self) -> dict[str, Any]:
        return run_tool(
            "fixture-shadow-tool",
            {"repo_snapshot": {"allowed_paths": ["src/app.ts"], "snapshot_mode": "working-tree", "snapshot_hash": "sha256:test"}},
            "cyc-20261002T000000Z-stream",
            workspace_root=self.workspace,
            base_dir=self.tools_dir,
        )

    def _row(self) -> dict[str, Any]:
        return load_jsonl(self.tools_dir / "runs.jsonl")[-1]

    def _raw_rows(self) -> list[dict[str, Any]]:
        return load_jsonl(self.tools_dir / "raw-findings.jsonl")

    def _stored(self, row: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
        from aria_kernel.tool_runner import OutputStream

        ref = row["output_ref"]
        data = (self.tools_dir / ref["uri"]).read_bytes()
        stream = OutputStream(retain_bytes=len(data))
        stream.feed(data)
        stream.close()
        document, error = stream.result(shadow_tool())
        self.assertIsNone(error)
        return data, document

    def test_a_13_mib_output_yields_every_finding(self) -> None:
        self.assertGreater(self.output_file.stat().st_size, 13 * MIB)
        self._register()
        result = self._run()
        envelope = result["envelope"]
        self.assertEqual(envelope["status"], "ok", envelope["runner"].get("parse_error"))
        self.assertEqual(envelope["runner"]["raw_findings_count"], LARGE_COUNT)
        self.assertEqual(
            envelope["output_hash"], "sha256:" + hashlib.sha256(self.output_file.read_bytes()).hexdigest(),
        )
        row = self._row()
        self.assertEqual(row["status"], "ok", row["evidence_validation"])
        self.assertEqual(row["runner"]["output_stream"]["dropped"], {})
        self.assertFalse(row["runner"]["output_stream"]["truncated"])
        raw = self._raw_rows()
        self.assertEqual(len(raw), LARGE_COUNT)
        from aria_kernel.runtime_artifacts import cas_relative_path, resolve_finding_from_artifact

        # The stored digest round-trips: the bytes hash to the ref, the path is
        # the content address, and the document re-parses to every record.
        data, document = self._stored(row)
        ref = row["output_ref"]
        self.assertEqual(ref["sha256"], "sha256:" + hashlib.sha256(data).hexdigest())
        self.assertTrue(ref["uri"].endswith(cas_relative_path(ref["sha256"]) + ".json"), ref["uri"])
        self.assertEqual(len(document["findings"]), LARGE_COUNT)
        self.assertEqual(document["findings"][123], _finding(123, LARGE_PAD))
        # The run artifact keeps the digest and counts, not a second copy.
        artifact = json.loads((self.tools_dir / row["artifact_ref"]["uri"]).read_bytes())
        self.assertNotIn("stdout", artifact["payload"])
        self.assertNotIn("raw_findings", artifact["payload"])
        self.assertLess(len(json.dumps(artifact)), 1 * MIB)
        for index in (0, 432, LARGE_COUNT - 1):
            self.assertEqual(resolve_finding_from_artifact(raw[index], base_dir=self.tools_dir), _finding(index, LARGE_PAD))

    def test_past_the_bound_the_run_is_truncated_loudly_and_keeps_its_prefix(self) -> None:
        from aria_kernel.cycle_runtime_status import tool_run_degradation_class

        bound = 1 * MIB
        self._register(output_retain_bytes=bound)
        tracemalloc.start()
        try:
            result = self._run()
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        # The old runner held the 13.8 MB stdout as str AND bytes; the stream
        # never holds more than a chunk of it beside the retained prefix.
        self.assertLess(peak, 16 * MIB, peak)
        budget = bound - len(_encoded(OBSERVATION))
        expected_kept = 0
        while budget >= len(_encoded(_finding(expected_kept, LARGE_PAD))):
            budget -= len(_encoded(_finding(expected_kept, LARGE_PAD)))
            expected_kept += 1
        self.assertGreater(expected_kept, 0)
        envelope = result["envelope"]
        self.assertEqual(envelope["status"], "truncated")
        row = self._row()
        self.assertEqual(row["status"], "truncated", row["evidence_validation"])
        stream = row["runner"]["output_stream"]
        self.assertTrue(stream["truncated"])
        self.assertEqual(stream["kept"]["findings"], expected_kept)
        self.assertEqual(stream["dropped"], {"findings": LARGE_COUNT - expected_kept})
        self.assertEqual(stream["retain_bytes"], bound)
        self.assertEqual(stream["consumed_bytes"], self.output_file.stat().st_size)
        self.assertEqual(tool_run_degradation_class(row), "truncated")
        raw = self._raw_rows()
        self.assertEqual(len(raw), expected_kept)
        _data, document = self._stored(row)
        self.assertEqual(document["findings"], [_finding(i, LARGE_PAD) for i in range(expected_kept)])
        events = [
            event for event in load_jsonl(self.tools_dir / "governance.jsonl")
            if event.get("kind") == "tool_output_truncated"
        ]
        self.assertEqual(len(events), 1)
        details = events[0]["details"]
        self.assertEqual(details["tool_id"], "fixture-shadow-tool")
        self.assertEqual(details["run_id"], row["run_id"])
        self.assertEqual(details["cycle_id"], row["cycle_id"])
        self.assertEqual(details["dropped"], {"findings": LARGE_COUNT - expected_kept})
        self.assertEqual(details["kept"]["findings"], expected_kept)
        self.assertEqual(details["stored"]["sha256"], row["output_ref"]["sha256"])


class ReadersAgreeAcrossStorageForms(unittest.TestCase):
    def test_legacy_inline_and_stored_artifacts_resolve_identical_findings(self) -> None:
        from aria_kernel.feedback_store import record_raw_findings_for_run
        from aria_kernel.rule_health import _fingerprint_rules
        from aria_kernel.runtime_artifacts import (
            resolve_finding_from_artifact,
            write_run_artifact,
            write_tool_output,
        )

        findings = [_finding(index, 5) for index in range(12)]
        output = {"observations": [OBSERVATION], "findings": findings, **TAIL}
        resolved: dict[str, list[dict[str, Any]]] = {}
        rules: dict[str, dict[str, str]] = {}
        with tempfile.TemporaryDirectory() as tmp:
            for form in ("legacy", "stored"):
                tools = Path(tmp) / form
                tools.mkdir()
                register_tool(shadow_tool(), base_dir=tools)
                payload: dict[str, Any]
                if form == "legacy":
                    payload = {"raw_findings": findings}
                else:
                    stored = write_tool_output(
                        base_dir=tools, run_id="run-1", cycle_uid="cyc-20261002T000000Z-x",
                        tool_id="fixture-shadow-tool", output=output, run_status="ok",
                    )
                    payload = {"output_ref": stored["artifact_ref"]}
                artifact = write_run_artifact(
                    base_dir=tools, run_id="run-1", cycle_uid="cyc-20261002T000000Z-x",
                    tool_id="fixture-shadow-tool", kind="tool_run", payload=payload, run_status="ok",
                )
                run = {
                    "run_id": "run-1", "tool_id": "fixture-shadow-tool", "cycle_id": "cyc-20261002T000000Z-x",
                    "status": "ok", "artifact_ref": artifact["artifact_ref"], "artifact_hash": artifact["artifact_hash"],
                }
                record_raw_findings_for_run(run, findings, base_dir=tools)
                rows = load_jsonl(tools / "raw-findings.jsonl")
                resolved[form] = [resolve_finding_from_artifact(row, base_dir=tools) for row in rows]
                rules[form] = _fingerprint_rules(tools)
        self.assertEqual(resolved["legacy"], findings)
        self.assertEqual(resolved["stored"], resolved["legacy"])
        self.assertEqual(rules["stored"], rules["legacy"])
        self.assertEqual(set(rules["legacy"].values()), {finding["rule"] for finding in findings})


if __name__ == "__main__":
    unittest.main()
