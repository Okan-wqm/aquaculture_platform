from __future__ import annotations

import hashlib
from pathlib import Path


def sha256_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def submit_binding_kwargs(
    request: dict,
    *,
    transcript_dir: Path,
    transcript_name: str = "transcript.jsonl",
    transcript_text: str = "fixture transcript\n",
) -> dict[str, str]:
    _ = (transcript_dir, transcript_name)
    transcript = Path(request["expected_output_path"]).with_suffix(".transcript.jsonl")
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text(transcript_text, encoding="utf-8")
    return {
        "context_hash": str(request["context_hash"]),
        "prompt_hash": str(request["prompt_hash"]),
        "transcript_hash": sha256_file(transcript),
        "transcript_artifact_ref": transcript.resolve().as_posix(),
    }
