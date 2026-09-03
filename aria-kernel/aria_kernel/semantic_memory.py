"""Z7 — embedding-backed semantic memory substrate (model-agnostic).

WHY: every matcher ARIA owns today is literal — finding fingerprints are
sha256 over normalized text, convention matches are path prefixes, FP
suppression is exact fingerprint equality. "The same root cause in a
different guise" is structurally invisible. A FIXED embedding model is
deterministic (same text → same vector), so similarity search fits the
replay/audit constitution where trained-in-place models cannot.

MODEL SUPPLY IS AN OPERATOR ITEM (ORPHAN-MEDIUM-639): the kernel ships no
model. This module defines the seam: an `Embedder` is any callable
`(text: str) -> list[float]`; `configured_embedder()` resolves one from
the environment (`ARIA_EMBEDDER_CMD` — a command that reads text on stdin
and prints a JSON float array) and returns None when absent. EVERY public
entry point is a structured no-op without a model — callers never branch
on availability, they just get empty results (the breaker-evidence
`readable` pattern).

Ledger: `knowledge-graph/embeddings.jsonl`, hash-chained via the
knowledge-graph `_append_row` writer. Rows store {kind, ref_id, model_id,
vector} — vectors are recomputable from their source text given the same
model_id, so the ledger is an index, not a truth source.

Small on purpose — operator preference 2026-08-11: files stay short.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
from pathlib import Path
from typing import Any, Callable

from .ledger import load_jsonl
from .tool_registry import ensure_tools_dir

Embedder = Callable[[str], "list[float]"]

EMBEDDER_CMD_ENV = "ARIA_EMBEDDER_CMD"
EMBEDDER_MODEL_ID_ENV = "ARIA_EMBEDDER_MODEL_ID"
_EMBED_TIMEOUT_SECONDS = 60
# Plan 032 Faz 032i (D4) — decisions with a stated reason are embeddable too.
_KNOWN_KINDS = frozenset({"finding", "belief", "convention", "decision"})


def _embeddings_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "knowledge-graph" / "embeddings.jsonl"


def configured_embedder() -> tuple[Embedder, str] | None:
    """Resolve the operator-supplied embedder, or None (no-op mode).

    The command contract is deliberately narrow: text in on stdin, one
    JSON float array out on stdout. Narrow enough that a local
    sentence-transformer wrapper, an AI-service bridge, and a test fake
    are all four-line scripts.
    """
    cmd = os.environ.get(EMBEDDER_CMD_ENV, "").strip()
    if not cmd:
        return None
    model_id = os.environ.get(EMBEDDER_MODEL_ID_ENV, "").strip() or "operator-default"

    def _run(text: str) -> list[float]:
        proc = subprocess.run(
            ["/bin/sh", "-c", cmd],
            input=text,
            capture_output=True,
            text=True,
            timeout=_EMBED_TIMEOUT_SECONDS,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"embedder_cmd_failed: {proc.stderr[-300:]}")
        vector = json.loads(proc.stdout)
        if not isinstance(vector, list) or not all(
            isinstance(item, (int, float)) for item in vector
        ):
            raise RuntimeError("embedder_cmd_output_not_float_array")
        return [float(item) for item in vector]

    return _run, model_id


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Plain-python cosine; 0.0 for mismatched or zero-norm vectors."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def record_embedding(
    *,
    kind: str,
    ref_id: str,
    text: str,
    base_dir: str | Path | None = None,
    embedder: tuple[Embedder, str] | None = None,
) -> dict[str, Any] | None:
    """Embed and append one row; None (structured no-op) without a model."""
    if kind not in _KNOWN_KINDS:
        raise ValueError(f"semantic_memory_unknown_kind: {kind!r}")
    resolved = embedder if embedder is not None else configured_embedder()
    if resolved is None:
        return None
    embed, model_id = resolved
    from .knowledge_graph import _append_row

    row = {
        "schema_version": 1,
        "kind": kind,
        "ref_id": ref_id,
        "model_id": model_id,
        "vector": embed(text),
    }
    _append_row(_embeddings_path(base_dir), row)
    return row


def nearest(
    *,
    text: str,
    k: int = 5,
    kind: str | None = None,
    base_dir: str | Path | None = None,
    embedder: tuple[Embedder, str] | None = None,
) -> list[dict[str, Any]]:
    """The k most similar recorded rows; [] without a model or ledger.

    Only rows embedded by the SAME model_id are comparable — vectors from
    different models share no space, and a similarity across them would
    be a confident number that measures nothing.
    """
    resolved = embedder if embedder is not None else configured_embedder()
    if resolved is None:
        return []
    embed, model_id = resolved
    path = _embeddings_path(base_dir)
    if not path.exists():
        return []
    query = embed(text)
    scored: list[dict[str, Any]] = []
    for row in load_jsonl(path):
        if row.get("model_id") != model_id:
            continue
        if kind is not None and row.get("kind") != kind:
            continue
        scored.append({
            "kind": row.get("kind"),
            "ref_id": row.get("ref_id"),
            "similarity": cosine_similarity(query, row.get("vector") or []),
        })
    scored.sort(key=lambda item: (-item["similarity"], str(item["ref_id"])))
    return scored[: max(0, k)]
