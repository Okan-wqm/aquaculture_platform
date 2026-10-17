"""The sealed transcript of an accepted request, read from the store (ARIA-HIGH-448).

One reader for the per-lane proofs: the accepted result row names the transcript's hash; the
kernel sealed the bytes content-addressed under that hash; the proof is that those bytes carry
no secret shape and that their hash is the one the result row recorded (the executor hashed
the scrubbed bytes, nothing re-derives a hash from raw ones).
"""
from __future__ import annotations

import hashlib
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import accepted_result_for_request


def assert_sealed_transcript_scrubbed(
    case: unittest.TestCase, *, tools: Path, request_id: str, secrets: tuple[str, ...],
    expect_marker: bool = True,
) -> bytes:
    """Assert the request's sealed transcript holds none of ``secrets``; return its bytes."""
    result = accepted_result_for_request(request_id=request_id, base_dir=tools)
    case.assertIsNotNone(result, f"{request_id} has no accepted result")
    transcript_hash = str(result["transcript_hash"])
    sealed = (Path(tools) / "agent-invocations" / "outputs" / "content-addressed" / "transcripts"
              / f"{transcript_hash.removeprefix('sha256:')}.md")
    case.assertTrue(sealed.is_file(), f"no sealed transcript at {sealed}")
    data = sealed.read_bytes()
    case.assertEqual("sha256:" + hashlib.sha256(data).hexdigest(), transcript_hash,
                     "the recorded hash is the sealed (scrubbed) bytes' hash")
    for secret in secrets:
        case.assertNotIn(secret.encode("utf-8"), data, "a secret shape reached the sealed transcript")
    if expect_marker:
        case.assertIn(b"<secret-redacted>", data)
    return data
