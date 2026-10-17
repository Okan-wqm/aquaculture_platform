"""ARIA-HIGH-448 — a run's transcript is scrubbed at its one writer, before it is hashed and sealed.

Every executor lane wrote the run's stdout to its transcript raw (Claude CLI, native Z.ai, Codex,
mock, the fallback record, the judge batch), and the kernel seals those bytes content-addressed
and publishes them on aria/state: 40 stored transcripts sampled on origin/aria/state carried 0
redaction markers. The lanes now share ONE write, ``artifact_safety.write_sanitized_transcript``
(the executor's ``_write_sanitized_transcript``), and this pins both the scrub and the single
writer. The end-to-end proofs per lane live with each lane's own test (native Claude, native
Z.ai, Codex, judge batch).
"""
from __future__ import annotations

import ast
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.artifact_safety import scrub_transcript, write_sanitized_transcript

_REPO_ROOT = Path(__file__).resolve().parents[2]
GITHUB_PAT = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
ANTHROPIC_KEY = "sk-ant-api03-" + "x" * 48
SECRETS = (GITHUB_PAT, ANTHROPIC_KEY)

# A Claude stream-json run as the CLI writes it: one JSON event per line,
# compact, non-ASCII as is. The tool reads a file holding a key and echoes a
# token assignment; the usage counters are integers under token-named keys.
_STREAM = "\n".join(json.dumps(event, ensure_ascii=False, separators=(",", ":")) for event in (
    {"type": "system", "subtype": "init", "session_id": "s-1", "tools": ["Bash", "Read"], "model": "opus"},
    {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": f"GH_TOKEN={GITHUB_PAT} gh pr list"}}]}},
    {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": f"ANTHROPIC_API_KEY={ANTHROPIC_KEY}\nçalışıyor"}]}},
    {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Değişiklik hazır."}]}},
    {"type": "result", "subtype": "success", "is_error": False, "result": "done",
     "usage": {"input_tokens": 900, "output_tokens": 120, "cache_read_input_tokens": 0}},
)) + "\n"


class AStreamJsonTranscriptIsScrubbedEventForEvent(unittest.TestCase):
    def test_no_secret_survives_and_every_event_still_parses(self) -> None:
        scrubbed = scrub_transcript(_STREAM)
        for secret in SECRETS:
            self.assertNotIn(secret, scrubbed)
        self.assertIn("<secret-redacted>", scrubbed)
        before = [json.loads(line) for line in _STREAM.splitlines()]
        after = [json.loads(line) for line in scrubbed.splitlines()]
        self.assertEqual([(e["type"], e.get("subtype")) for e in after], [(e["type"], e.get("subtype")) for e in before])
        self.assertEqual(after[-1]["usage"], before[-1]["usage"], "integer counters under token-named keys stay")
        self.assertEqual(after[1]["message"]["content"][0]["input"]["command"], "GH_TOKEN=<secret-redacted> gh pr list")

    def test_a_line_with_nothing_to_redact_keeps_its_exact_bytes(self) -> None:
        scrubbed = scrub_transcript(_STREAM).split("\n")
        original = _STREAM.split("\n")
        self.assertEqual([index for index, (a, b) in enumerate(zip(original, scrubbed)) if a != b], [1, 2])
        self.assertTrue(scrubbed[-1] == "" and original[-1] == "", "the trailing newline stays")
        self.assertIn("çalışıyor", scrubbed[2], "non-ASCII stays as written")

    def test_a_line_that_is_not_json_is_scrubbed_as_text(self) -> None:
        text = f"plain vendor prose with {GITHUB_PAT}\r\n" + '{"key": "value"}\r\n'
        scrubbed = scrub_transcript(text)
        self.assertEqual(scrubbed, "plain vendor prose with <secret-redacted>\r\n" + '{"key": "value"}\r\n')

    def test_the_writer_writes_the_scrubbed_bytes_so_the_hash_is_theirs(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "out" / "run.transcript.jsonl"
            write_sanitized_transcript(path, _STREAM)
            data = path.read_bytes()
        self.assertEqual(data, scrub_transcript(_STREAM).encode("utf-8"))
        self.assertNotEqual(hashlib.sha256(data).hexdigest(), hashlib.sha256(_STREAM.encode("utf-8")).hexdigest())


def _raw_transcript_writes(relative: str, source: str | None = None) -> list[str]:
    """Each `<…transcript…>.write_text/.write_bytes(...)` or `open(<…transcript…>, …)` in a module."""
    tree = ast.parse(source if source is not None else (_REPO_ROOT / relative).read_text(encoding="utf-8"))
    offenders = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in ("write_text", "write_bytes"):
            target = func.value
        elif isinstance(func, ast.Name) and func.id == "open" and node.args:
            target = node.args[0]
        else:
            continue
        names = " ".join(n.id if isinstance(n, ast.Name) else n.attr for n in ast.walk(target)
                         if isinstance(n, (ast.Name, ast.Attribute)))
        if "transcript" in names.lower():
            offenders.append(f"{relative}:{node.lineno}")
    return offenders


class EveryLaneWritesThroughTheOneWriter(unittest.TestCase):
    """The single write is what makes a sixth lane scrubbed too: no executor module writes a
    transcript path itself (on 0ffd209dd: ci_executor.py:2069/2537/3429/3576/5924 and
    ci_executor_judge_batch.py:505)."""

    MODULES = ("tools/aria-poc/ci_executor.py", "tools/aria-poc/ci_executor_judge_batch.py",
               "tools/aria-poc/ci_executor_drain.py", "tools/aria-poc/worker_executor.py",
               "tools/aria-poc/zai_tool_loop.py", "tools/aria-poc/claude_runtime.py",
               "tools/aria-poc/codex_runtime.py", "tools/aria-poc/zai_runtime.py")

    def test_no_executor_module_writes_a_transcript_raw(self) -> None:
        self.assertEqual([hit for module in self.MODULES for hit in _raw_transcript_writes(module)], [])

    def test_the_pin_sees_the_shapes_it_exists_for(self) -> None:
        source = ("def f(transcript_path, resolved_transcript_path, out, envelope_path):\n"
                  "    transcript_path.write_text(out)\n"
                  "    resolved_transcript_path.write_bytes(out)\n"
                  "    open(transcript_path, 'w')\n"
                  "    envelope_path.write_text(out)\n")
        self.assertEqual(_raw_transcript_writes("m.py", source), ["m.py:2", "m.py:3", "m.py:4"])


if __name__ == "__main__":
    unittest.main()
