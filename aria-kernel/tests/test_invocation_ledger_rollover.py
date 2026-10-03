"""ARIA-HIGH-275 — the agent-invocation request and prompt ledgers roll over
into chained monthly segments instead of growing one file into the 64 MiB
per-surface publish cap (`state_snapshot.SNAPSHOT_MAX_SURFACE_BLOB_BYTES`).

`agent-invocations/{requests,prompts}.jsonl` stay in place as frozen segment
0; new rows land in `agent-invocations/{requests,prompts}/<YYYY-MM>[-k].jsonl`,
each opened by a `segment_opened` row that names the previous segment, its
row count and its tail ledger hash. `ledger.load_segments` is the one reader.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import agent_invocations as invocations
from aria_kernel import convergence_drainer, delivery_closure, doctor, judge_fanout, ledger
from aria_kernel.contention_replay import replay_append_only_suffixes
from aria_kernel.ledger import LedgerIntegrityError, append_declared_jsonl, load_declared_jsonl
from aria_kernel.ledger_refs import find_row_by_source_ledger_ref, ledger_ref_for_row
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture

REQUESTS = "agent_invocation_requests"
PROMPTS = "agent_invocation_prompts"
OCT = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)
NOV = datetime(2026, 11, 2, 9, tzinfo=timezone.utc)
DEC = datetime(2026, 12, 1, 0, 5, tzinfo=timezone.utc)
CONTEXT_HASH = "sha256:" + "c" * 64


def _request(request_id: str, **extra: Any) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "row_type": "request",
        "row_id": f"request:{request_id}",
        "request_id": request_id,
        "role": "judge",
        "target_agent": "aria-evidence-judge",
        "convergence_id": "plan-1",
        "round_number": 1,
        "judgment_group_id": f"group-{request_id}",
        "evidence_refs": [f"ref:{request_id}"],
        **extra,
    }


def _prompt(request_id: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "row_type": "prompt",
        "row_id": f"prompt:{request_id}",
        "request_id": request_id,
        "context_hash": CONTEXT_HASH,
        "prompt_hash": "sha256:" + request_id.encode().hex().ljust(64, "0")[:64],
        "prompt_text": f"prompt for {request_id}",
    }


class InvocationLedgerRolloverTests(unittest.TestCase):
    maxDiff = None

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-high-275-"))
        self.root = ensure_tools_dir(self.tmp / "aria-tools")
        self.inv = self.root / "agent-invocations"
        self.segment0 = self.inv / "requests.jsonl"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_segment_zero(self, *request_ids: str) -> list[dict[str, Any]]:
        for request_id in request_ids:
            append_declared_fixture(self.segment0, _request(request_id), expected_surface=REQUESTS)
        return load_declared_jsonl(self.segment0, expected_surface=REQUESTS)

    def _append(self, now: datetime, *request_ids: str, **extra: Any) -> list[dict[str, Any]]:
        return ledger.append_segment_rows(
            self.root, [_request(request_id, **extra) for request_id in request_ids],
            expected_surface=REQUESTS, now=now, bypass_profile_gate=True,
        )

    def _segment(self, name: str) -> list[dict[str, Any]]:
        return load_declared_jsonl(self.inv / "requests" / name, expected_surface=REQUESTS)

    def _ids(self) -> list[str]:
        return [row["request_id"] for row in ledger.load_segments(self.root, REQUESTS)]

    def test_write_in_new_month_opens_segment_chained_to_previous_tail(self) -> None:
        segment0 = self._seed_segment_zero("r0", "r1")
        frozen_bytes = self.segment0.read_bytes()

        self._append(OCT, "r2")
        self._append(OCT, "r3")
        october = self._segment("2026-10.jsonl")
        self.assertEqual(october[0], {**october[0], **{
            "row_type": "segment_opened",
            "segment": "agent-invocations/requests/2026-10.jsonl",
            "prev_segment": "agent-invocations/requests.jsonl",
            "prev_row_count": 2,
            "prev_tail_ledger_hash": segment0[-1]["ledger_hash"],
        }})
        self.assertEqual([row["request_id"] for row in october[1:]], ["r2", "r3"])
        self.assertEqual(self.segment0.read_bytes(), frozen_bytes, "segment 0 is frozen")

        self._append(NOV, "r4")
        november = self._segment("2026-11.jsonl")
        self.assertEqual(november[0]["prev_segment"], "agent-invocations/requests/2026-10.jsonl")
        self.assertEqual(november[0]["prev_row_count"], 3)
        self.assertEqual(november[0]["prev_tail_ledger_hash"], october[-1]["ledger_hash"])
        self.assertEqual(self._ids(), ["r0", "r1", "r2", "r3", "r4"])

    def test_production_writer_never_grows_segment_zero(self) -> None:
        prompts0 = self.inv / "prompts.jsonl"
        append_declared_fixture(prompts0, _prompt("AIR-0"), expected_surface=PROMPTS)
        frozen_bytes = prompts0.read_bytes()

        stored = invocations.record_invocation_prompt(
            request_id="AIR-1", context_hash=CONTEXT_HASH, prompt_text="exact prompt",
            base_dir=self.root,
        )

        self.assertEqual(prompts0.read_bytes(), frozen_bytes)
        month = datetime.now(timezone.utc).strftime("%Y-%m")
        segment = load_declared_jsonl(self.inv / "prompts" / f"{month}.jsonl", expected_surface=PROMPTS)
        self.assertEqual(segment[0]["prev_segment"], "agent-invocations/prompts.jsonl")
        self.assertEqual(segment[-1]["ledger_hash"], stored["ledger_hash"])
        self.assertEqual(
            [row["request_id"] for row in ledger.load_segments(self.root, PROMPTS)], ["AIR-0", "AIR-1"],
        )

    def test_sixteen_mib_opens_the_next_k_segment(self) -> None:
        self.assertEqual(ledger.SEGMENT_ROLLOVER_BYTES, 16 * 1024 * 1024)
        blob = "x" * 900_000
        self._append(OCT, *(f"big-{i}" for i in range(18)), blob=blob)
        october = self.inv / "requests" / "2026-10.jsonl"
        self.assertLess(october.stat().st_size, ledger.SEGMENT_ROLLOVER_BYTES)

        self._append(OCT, "big-18", blob=blob)  # still below the line when chosen
        self.assertGreaterEqual(october.stat().st_size, ledger.SEGMENT_ROLLOVER_BYTES)
        self.assertFalse((self.inv / "requests" / "2026-10-1.jsonl").exists())

        self._append(OCT, "after-the-line")
        opened = self._segment("2026-10-1.jsonl")
        self.assertEqual(opened[0]["prev_segment"], "agent-invocations/requests/2026-10.jsonl")
        self.assertEqual(opened[0]["prev_row_count"], 20)  # marker + 19 rows
        self.assertEqual([row["request_id"] for row in opened[1:]], ["after-the-line"])

    def test_load_segments_yields_rows_in_order_across_segment_zero_and_k_segments(self) -> None:
        self._seed_segment_zero("a", "b")
        with mock.patch.object(ledger, "SEGMENT_ROLLOVER_BYTES", 1):
            self._append(OCT, "c")
            self._append(OCT, "d", "e")
            for index in range(10):
                self._append(OCT, f"k{index + 2}")
        names = [path.name for path in ledger.segment_paths(self.root, REQUESTS)]
        self.assertEqual(
            names,
            ["requests.jsonl", "2026-10.jsonl", *(f"2026-10-{k}.jsonl" for k in range(1, 12))],
            "-k orders numerically: -2 before -10",
        )
        self.assertEqual(self._ids(), ["a", "b", "c", "d", "e", *(f"k{k}" for k in range(2, 12))])
        self.assertNotIn(
            "segment_opened",
            {row.get("row_type") for row in ledger.load_segments(self.root, REQUESTS)},
        )

    def test_append_to_a_sealed_segment_is_refused(self) -> None:
        self._seed_segment_zero("a")
        self._append(OCT, "b")
        self._append(NOV, "c")
        for sealed in (
            self.segment0,
            self.inv / "requests" / "2026-10.jsonl",
            self.inv / "requests" / "2026-09.jsonl",  # behind the newest: never opens
        ):
            with self.subTest(sealed=sealed.name), self.assertRaisesRegex(
                LedgerIntegrityError, "segment_sealed",
            ):
                append_declared_jsonl(sealed, _request("x"), expected_surface=REQUESTS,
                                      bypass_profile_gate=True)
        with self.assertRaisesRegex(LedgerIntegrityError, "segment_opened_row_misplaced"):
            append_declared_jsonl(self.inv / "requests" / "2026-12.jsonl", _request("y"),
                                  expected_surface=REQUESTS, bypass_profile_gate=True)
        self._append(OCT, "d")  # a clock behind the newest segment keeps writing there
        self.assertEqual([row["request_id"] for row in self._segment("2026-11.jsonl")[1:]], ["c", "d"])
        self.assertEqual(self._ids(), ["a", "b", "c", "d"])

    def test_chain_verifies_and_refuses_a_broken_link(self) -> None:
        self._seed_segment_zero("a", "b")
        self._append(OCT, "c")
        self._append(NOV, "d")
        self.assertEqual(self._ids(), ["a", "b", "c", "d"])

        october = self.inv / "requests" / "2026-10.jsonl"
        aside = self.tmp / "october.jsonl"
        october.rename(aside)
        with self.assertRaisesRegex(LedgerIntegrityError, "segment_chain_broken"):
            ledger.load_segments(self.root, REQUESTS)
        aside.rename(october)

        frozen = self.segment0.read_bytes()
        self.segment0.write_bytes(frozen[: frozen.rstrip(b"\n").rfind(b"\n") + 1])
        with self.assertRaisesRegex(LedgerIntegrityError, "segment_chain_broken"):
            ledger.load_segments(self.root, REQUESTS)
        self.segment0.write_bytes(frozen)

        # A writer that died before its marker was whole leaves an empty
        # newest segment: it holds nothing yet, and the next append opens it.
        (self.inv / "requests" / "2026-12.jsonl").write_bytes(b"")
        self.assertEqual(self._ids(), ["a", "b", "c", "d"])
        self._append(DEC, "e")
        self.assertEqual(self._segment("2026-12.jsonl")[0]["prev_segment"],
                         "agent-invocations/requests/2026-11.jsonl")
        self.assertEqual(self._ids(), ["a", "b", "c", "d", "e"])

    def _replayed(self, name: str, winner_ops: list[tuple[datetime, str]],
                  loser_ops: list[tuple[datetime, str]]) -> list[str]:
        """Two lanes extend one published base; the loser's suffix replays onto the winner."""
        base = ensure_tools_dir(self.tmp / name / "base")
        append_declared_fixture(base / "agent-invocations" / "requests.jsonl", _request("b0"),
                                expected_surface=REQUESTS)
        ledger.append_segment_rows(base, [_request("b1")], expected_surface=REQUESTS, now=OCT,
                                   bypass_profile_gate=True)
        published = {path.relative_to(base).as_posix(): ledger.verify_jsonl(path)
                     for path in ledger.segment_paths(base, REQUESTS)}
        winner, loser = self.tmp / name / "winner", self.tmp / name / "loser"
        shutil.copytree(base, winner)
        shutil.copytree(base, loser)
        for lane, ops in ((winner, winner_ops), (loser, loser_ops)):
            for when, request_id in ops:
                ledger.append_segment_rows(lane, [_request(request_id)], expected_surface=REQUESTS,
                                           now=when, bypass_profile_gate=True)
        surfaces = {}
        for path in ledger.segment_paths(loser, REQUESTS):
            relative = path.relative_to(loser).as_posix()
            claim = published.get(relative, {"row_count": 0, "last_hash": None})
            key = REQUESTS if path.name == "requests.jsonl" else f"agent_invocation_request_segments:{relative}"
            surfaces[key] = {"winner_path": winner / relative, "loser_path": path,
                             "base_row_count": claim["row_count"], "base_tail_hash": claim["last_hash"]}
        replay_append_only_suffixes(surfaces=surfaces, replay_transaction_id=f"replay-{name}")
        ledger.append_segment_rows(winner, [_request("after")], expected_surface=REQUESTS, now=DEC,
                                   bypass_profile_gate=True)
        return [row["request_id"] for row in ledger.load_segments(winner, REQUESTS)]

    def test_contention_replay_keeps_the_chain_readable(self) -> None:
        # A losing lane's rows replay into the files that lane wrote: a sealed
        # segment grows behind its link, both lanes' markers share a segment,
        # or two rollovers fork from one segment. None of it may wedge a read.
        cases = {
            "loser-opens-a-segment": ([], [(NOV, "l1")], ["l1"]),
            "loser-appends-to-a-segment-the-winner-sealed": ([(NOV, "w1")], [(OCT, "l1")], ["l1", "w1"]),
            "loser-opens-a-segment-the-winner-did-not": ([(OCT, "w1")], [(NOV, "l1")], ["w1", "l1"]),
            "both-open-from-one-view": ([(NOV, "w1")], [(NOV, "l1")], ["w1", "l1"]),
            "both-open-from-different-views": (
                [(OCT, "w1"), (NOV, "w2")], [(OCT, "l1"), (NOV, "l2")], ["w1", "l1", "w2", "l2"]),
        }
        for name, (winner_ops, loser_ops, merged) in cases.items():
            with self.subTest(name):
                self.assertEqual(self._replayed(name, winner_ops, loser_ops), ["b0", "b1", *merged, "after"])
        with self.subTest("rollovers-fork"), mock.patch.object(ledger, "SEGMENT_ROLLOVER_BYTES", 400):
            # The loser's last October row crossed the line (October-1); the
            # winner's first November row opened November after October.
            self.assertEqual(self._replayed("fork", [(NOV, "w1")], [(OCT, "l1")]),
                             ["b0", "b1", "l1", "w1", "after"])
            self.assertEqual(
                [path.name for path in ledger.segment_paths(self.tmp / "fork" / "winner", REQUESTS)],
                ["requests.jsonl", "2026-10.jsonl", "2026-10-1.jsonl", "2026-11.jsonl", "2026-12.jsonl"],
            )

    def _reader_views(self, request_ids: list[str]) -> dict[str, Any]:
        """What every request/prompt reader returns for this store."""
        return {
            "list": [row["ledger_hash"] for row in invocations.list_agent_invocation_requests(base_dir=self.root)],
            "pending": [row["request_id"] for row in invocations.list_agent_invocation_requests(
                base_dir=self.root, state="pending")],
            "find": [invocations._find_request_by_id(self.root, rid)["ledger_hash"] for rid in request_ids],
            "minted": invocations.minted_subject_refs(
                role="judge", target_agent="aria-evidence-judge", base_dir=self.root),
            "judges": judge_fanout._existing_judge_dispatches(self.root),
            "step": [row["request_id"] for row in convergence_drainer._requests_for_step(
                self.root, convergence_id="plan-1", role="judge", round_number=1)],
            "delivery": [record.request_id for record in
                         delivery_closure.compute_delivery_closure(base_dir=self.root).records],
            "live": doctor._requests_are_live(self.root),
            "prompt": invocations.verify_invocation_context_binding(
                request_id=request_ids[-1], context_hash=CONTEXT_HASH,
                prompt_hash=_prompt(request_ids[-1])["prompt_hash"], base_dir=self.root,
            )["prompt"]["ledger_hash"],
        }

    def _expected_views(self, requests: list[dict[str, Any]], prompts: list[dict[str, Any]]) -> dict[str, Any]:
        ids = [row["request_id"] for row in requests]
        return {
            "list": [row["ledger_hash"] for row in requests],
            "pending": ids,
            "find": [row["ledger_hash"] for row in requests],
            "minted": {f"ref:{rid}" for rid in ids if not rid.startswith("impl")},
            "judges": {(f"group-{rid}", "aria-evidence-judge") for rid in ids},
            "step": [rid for rid in ids if not rid.startswith("impl")],
            "delivery": [rid for rid in ids if rid.startswith("impl")],
            "live": True,
            "prompt": prompts[-1]["ledger_hash"],
        }

    def _seed_context(self, request_id: str) -> None:
        append_declared_fixture(
            self.inv / "contexts.jsonl",
            {"schema_version": 1, "row_type": "context", "row_id": f"context:{request_id}",
             "request_id": request_id, "context_hash": CONTEXT_HASH},
            expected_surface="agent_invocation_contexts",
        )

    def test_every_reader_returns_segment_zero_rows_unchanged(self) -> None:
        # A store holding only segment 0 — every store before this change.
        append_declared_fixture(self.segment0, _request("r0"), expected_surface=REQUESTS)
        append_declared_fixture(self.segment0, _request("impl-1", role="implementation"),
                                expected_surface=REQUESTS)
        append_declared_fixture(self.segment0, _request("r2"), expected_surface=REQUESTS)
        append_declared_fixture(self.inv / "prompts.jsonl", _prompt("r2"), expected_surface=PROMPTS)
        self._seed_context("r2")
        requests = load_declared_jsonl(self.segment0, expected_surface=REQUESTS)
        prompts = load_declared_jsonl(self.inv / "prompts.jsonl", expected_surface=PROMPTS)

        self.assertEqual(self._reader_views(["r0", "impl-1", "r2"]), self._expected_views(requests, prompts))

    def test_every_reader_sees_rows_in_every_segment(self) -> None:
        self._seed_segment_zero("r0")
        self._append(OCT, "impl-1", role="implementation")
        self._append(NOV, "r2")
        ledger.append_segment_rows(self.root, [_prompt("r2")], expected_surface=PROMPTS,
                                   now=NOV, bypass_profile_gate=True)
        self._seed_context("r2")
        located = ledger.segment_rows(self.root, REQUESTS)
        requests = [row for _path, row in located]
        prompts = ledger.load_segments(self.root, PROMPTS)

        self.assertEqual(self._reader_views(["r0", "impl-1", "r2"]), self._expected_views(requests, prompts))
        # A source ref names the segment file its row lives in and resolves.
        for path, row in located:
            ref = ledger_ref_for_row(surface=REQUESTS, ledger_path=path, row_id=row["row_id"],
                                     row_type="request", row=row)
            self.assertEqual(find_row_by_source_ledger_ref(self.root, ref, expected_surface=REQUESTS), row)


if __name__ == "__main__":
    unittest.main()
