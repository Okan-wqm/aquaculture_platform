"""ARIA-HIGH-125 — the gold corpus and the judges' answers on it, exported signed.

WHY. The goldset (operator verdicts and three-judge anchors a named curator
promoted) and the judges' replay verdicts on it are the one labelled corpus
ARIA owns that nobody in its loop wrote the answers to. A judge trained or
re-weighted on it later must be able to tell that corpus from a hand-edited
copy: the export says which gold corpus it holds (``goldset_hash``), what
every judge answered on each item, and carries the kernel's signature over
all of it.

WHAT. :func:`export_training_set` builds one row per tool with an active
goldset — each gold item with its verdict and provenance, and every judge's
replay verdict on it (``judge_replay``'s ``replay:<tool>:<run>:<finding>``
groups) — signs it under the kernel's training-set key (``hmac_keyring``,
``secrets/training-set-hmac.key``, a key of its own with its own signing
domain) and appends it to the declared ``training_set_exports`` surface. A
corpus whose content has not changed since the tool's last export is not
exported again. :func:`verify_training_set_row` recomputes the signature.
The nightly fitness phase exports after the report that measured the corpus.
"""
from __future__ import annotations

import hmac
import json
from pathlib import Path
from typing import Any

from .hmac_keyring import HmacKeyring, hmac_sign
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

TRAINING_SET_SURFACE = "training_set_exports"
TRAINING_SET_RELPATH = ("fitness", "training-sets.jsonl")
_KEY_FILE_RELATIVE = ("secrets", "training-set-hmac.key")
SIGNING_DOMAIN = b"aria-training-set/v1\n"
_SIGNING_EXCLUDED_FIELDS: frozenset[str] = frozenset({"signature", "ledger_hash", "previous_ledger_hash"})


def training_set_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*TRAINING_SET_RELPATH)


def _keyring(root: Path) -> HmacKeyring:
    return HmacKeyring(path=root.joinpath(*_KEY_FILE_RELATIVE), purpose="training_set")


def _signing_bytes(row: dict[str, Any]) -> bytes:
    subject = {key: value for key, value in row.items() if key not in _SIGNING_EXCLUDED_FIELDS}
    return SIGNING_DOMAIN + json.dumps(subject, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def _examples(tool_id: str, goldset: dict[str, Any], root: Path) -> list[dict[str, Any]]:
    from .feedback_store import load_feedback
    from .judge_replay import REPLAY_GROUP_PREFIX

    answers: dict[str, list[dict[str, Any]]] = {}
    for row in load_feedback(tool_id=tool_id, base_dir=root):
        group = str(row.get("judgment_group_id") or "")
        if row.get("source_type") == "ai_judge" and group.startswith(f"{REPLAY_GROUP_PREFIX}{tool_id}:"):
            answers.setdefault(group, []).append({
                "judge_id": row.get("judge_id"), "model": row.get("model"),
                "verdict": row.get("verdict"), "confidence": row.get("confidence"),
            })
    examples = []
    for item in [*(goldset.get("true_positive_items") or []), *(goldset.get("known_false_positive_items") or [])]:
        if not isinstance(item, dict):
            continue
        group = f"{REPLAY_GROUP_PREFIX}{tool_id}:{item.get('run_id')}:{item.get('finding_id')}"
        examples.append({**item, "judge_verdicts": answers.get(group, [])})
    return examples


def export_training_set(
    *,
    tool_id: str,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Sign and append ``tool_id``'s gold corpus with its replay verdicts.

    None when the tool has no active goldset, or when the corpus and its
    verdicts are byte-for-byte what the tool's last export already holds.
    """
    from .goldset import load_active_goldset
    from .ledger import append_declared_jsonl, sha256_digest_of_canonical_json
    from .role_fitness import goldset_hash

    root = ensure_tools_dir(base_dir)
    goldset = load_active_goldset(tool_id=tool_id, base_dir=root)
    if not goldset:
        return None
    examples = _examples(tool_id, goldset, root)
    content_hash = sha256_digest_of_canonical_json(examples)
    previous = [row for row in list_training_sets(base_dir=root) if row.get("tool_id") == tool_id]
    if previous and previous[-1].get("content_hash") == content_hash:
        return None
    key = _keyring(root).ensure_head()
    row: dict[str, Any] = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "tool_id": tool_id,
        "goldset_hash": goldset_hash(goldset),
        "curator": goldset.get("curator"),
        "example_count": len(examples),
        "judged_examples": sum(1 for example in examples if example["judge_verdicts"]),
        "content_hash": content_hash,
        "examples": examples,
        "signer_kid": str(key["key_id"]),
    }
    row["signature"] = hmac_sign(str(key["secret"]), _signing_bytes(row))
    return append_declared_jsonl(training_set_path(root), row, expected_surface=TRAINING_SET_SURFACE)


def export_training_sets(*, cycle_id: str | None = None, base_dir: str | Path | None = None) -> dict[str, Any]:
    """:func:`export_training_set` for every adapter, one result per tool."""
    from .tool_registry import list_tools

    root = ensure_tools_dir(base_dir)
    exported: list[str] = []
    for tool in list_tools(base_dir=root):
        tool_id = str(tool.get("tool_id") or "")
        if tool_id and tool.get("kind") == "adapter" and export_training_set(
            tool_id=tool_id, cycle_id=cycle_id, base_dir=root,
        ) is not None:
            exported.append(tool_id)
    return {"schema_version": 1, "exported": exported}


def list_training_sets(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    from .ledger import load_declared_jsonl

    path = training_set_path(base_dir)
    return load_declared_jsonl(path, expected_surface=TRAINING_SET_SURFACE) if path.exists() else []


def verify_training_set_row(row: Any, *, base_dir: str | Path) -> bool:
    """The kernel signed this row, under the key it names, as it now reads."""
    if not isinstance(row, dict) or not isinstance(row.get("signature"), str):
        return False
    try:
        key = _keyring(ensure_tools_dir(base_dir)).resolve(key_id=str(row.get("signer_kid") or ""))
    except (GovernanceError, OSError, ValueError):
        return False
    return hmac.compare_digest(hmac_sign(str(key["secret"]), _signing_bytes(row)), row["signature"])


__all__ = [
    "TRAINING_SET_SURFACE",
    "export_training_set",
    "export_training_sets",
    "list_training_sets",
    "training_set_path",
    "verify_training_set_row",
]
