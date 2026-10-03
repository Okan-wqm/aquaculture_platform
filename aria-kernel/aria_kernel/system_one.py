"""System One — registered typed questions to Jev, ARIA's learned-reflex layer (ARIA-LOW-252).

A literal question about a small typed state, answered with a probability, a
choice or a score — never text; it classifies, never finds, closes or merges.
Questions come only from ``aria-config/system-one-questions.json`` (READONLY to
ARIA); a model other than the registry's answers in shadow; ``enabled: false``
(the seed) means no call and no row. Each enabled call writes one row to the
observation surface ``system-one/calls.jsonl`` (state sha256, never the state;
nothing reads it back as a lesson or must_satisfy; unrecorded = unavailable).

EGRESS ALLOWLIST — the caller builds the state from typed inputs only: finding
text (title, rule), repository code (a diff, an excerpt, a path and its symbol
outline) and claim text (a commit or PR message), with exactly the question's
``state_keys`` and string (or one level of string-mapping) values. Never sent:
state-store runtime signals, tenant data, production logs, operator content,
credentials. Refused before egress: wrong shape, oversize, the kernel's secret
patterns plus private keys, ``apikey_…`` and ``*_PASSWORD=`` assignments, Turkish.
"""
from __future__ import annotations

import hashlib
import json
import random
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from .jev_runtime import JevReply, JevUnavailable, call_systemone
from .ledger import append_declared_jsonl
from .secret_scrub import scrub_text_with_count
from .tool_registry import bound_workspace_root, ensure_tools_dir, utc_now

REGISTRY_RELPATH = ("aria-config", "system-one-questions.json")
REGISTRY_SCHEMA = "aria/system-one-questions/v1"
CALLS_SURFACE = "system_one_calls"
CALLS_RELPATH = ("system-one", "calls.jsonl")
STATE_MAX_CHARS = 100_000  # ~25k tokens under the vendor's 32k state budget
_PII_NOT_SECRET = frozenset({"ipv4_octet", "email"})  # public repository code carries both
_EXTRA_SECRET = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY|apikey_[0-9a-f]{20,}|xox[abp]-[A-Za-z0-9-]{20,}"
    r"|(?m:^[+\- \t]*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_?KEY)\s*=\s*\S{6,})",
)
_TURKISH = re.compile(r"[ğĞüÜşŞıİöÖçÇ]")
_ENGLISH_WORD = re.compile(r"\b(?:the|a|an|is|are|this|of|to|in|does|do|how|which|what)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Question:
    id: str
    version: int
    type: str
    instructions: str
    criteria: Any
    decision_points: tuple[str, ...]
    mode: str
    thresholds: Mapping[str, float]
    state_keys: tuple[str, ...]
    tool_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class Registry:
    enabled: bool
    model: str
    questions: Mapping[str, Question] = field(default_factory=dict)
    invalid: Mapping[str, str] = field(default_factory=dict)  # id -> why that entry is refused


@dataclass(frozen=True)
class Answer:
    question_id: str
    version: int
    type: str
    value: float | str
    confidence: float | None
    probabilities: Mapping[str, float] | None
    model: str
    mode: str  # EFFECTIVE: the declared mode only when the registry's model answered
    decision_point: str


@dataclass(frozen=True)
class Unavailable:
    question_id: str
    outcome: str  # "unavailable" (no answer) | "refused" (asked wrongly; nothing left the host)
    reason: str


def _unit(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0.0 <= value <= 1.0


def _strings(value: Any) -> bool:
    return isinstance(value, list) and bool(value) and all(isinstance(item, str) for item in value)


def _question(raw: dict[str, Any]) -> Question | str:
    """One registry entry, or the reason it is refused."""
    kind, criteria, thresholds = raw.get("type"), raw.get("criteria"), raw.get("thresholds") or {}
    points = [raw["decision_point"]] if isinstance(raw.get("decision_point"), str) else raw.get("decision_point")
    if (type(raw.get("version")) is not int or raw.get("mode", "shadow") not in ("shadow", "order", "gate")
            or not _strings(points) or not _strings(raw.get("state_keys")) or not isinstance(thresholds, dict)
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in thresholds.values())):
        return "entry_shape"
    if kind == "choice" and isinstance(criteria, dict) and _strings(list(criteria.values())):
        texts = list(criteria.values())
    elif kind == "score" and _strings(criteria) and 2 <= len(criteria) <= 10:
        texts = list(criteria)
    elif kind == "noul" and criteria is None:
        texts = []
    else:
        return "entry_criteria"
    instructions = str(raw.get("instructions") or "")
    if not all(text.isascii() for text in [instructions, *texts]) or not _ENGLISH_WORD.search(instructions):
        return "question_not_english"
    return Question(
        id=str(raw["id"]), version=raw["version"], type=kind, instructions=instructions, criteria=criteria,
        decision_points=tuple(points), mode=raw.get("mode", "shadow"), thresholds=dict(thresholds),
        state_keys=tuple(raw["state_keys"]), tool_ids=tuple(str(t) for t in raw.get("tool_ids") or ()),
    )


def load_registry(workspace_root: str | Path) -> Registry | None:
    """The operator's registry; None when the file is absent; disabled when it is unreadable."""
    path = Path(workspace_root).joinpath(*REGISTRY_RELPATH)
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = None
    if not (isinstance(raw, dict) and raw.get("$schema") == REGISTRY_SCHEMA and isinstance(raw.get("questions"), list)):
        return Registry(enabled=False, model="")
    questions: dict[str, Question] = {}
    invalid: dict[str, str] = {}
    for entry in raw["questions"]:
        qid = str(entry.get("id") or "") if isinstance(entry, dict) else ""
        parsed = _question(entry) if qid else "entry_shape"
        if isinstance(parsed, str) or qid in questions or qid in invalid:
            invalid[qid] = parsed if isinstance(parsed, str) else "duplicate_id"
            questions.pop(qid, None)
        else:
            questions[qid] = parsed
    return Registry(raw.get("enabled") is True, str(raw.get("model") or ""), questions, invalid)


def _state_refusal(question: Question, state: Any) -> str | None:
    if not isinstance(state, dict) or sorted(state) != sorted(question.state_keys):
        return "state_shape:keys"
    strings = [item for value in state.values() for item in (value.values() if isinstance(value, dict) else [value])]
    if not all(isinstance(item, str) for item in strings):
        return "state_shape:values"
    if sum(map(len, strings)) > STATE_MAX_CHARS:
        return "state_too_large"
    leaked = sorted({kind for text in strings for kind in scrub_text_with_count(text)[1]} - _PII_NOT_SECRET)
    if leaked or any(_EXTRA_SECRET.search(text) for text in strings):
        return "state_secret_shaped:" + (",".join(leaked) or "credential_shape")
    if any(len(_TURKISH.findall(text)) >= 3 for text in strings):
        return "state_not_english"
    return None


def _spec(question: Question, state_sha: str) -> dict[str, Any]:
    spec: dict[str, Any] = {"type": question.type, "instructions": question.instructions}
    if question.type == "choice":
        # Jev leans to the first option: a (question, state)-seeded shuffle, reproducible from the row.
        items = list(question.criteria.items())
        random.Random(hashlib.sha256(f"{question.id}:{question.version}:{state_sha}".encode()).digest()).shuffle(items)
        spec["criteria"] = dict(items)
    elif question.type == "score":
        spec["criteria"] = list(question.criteria)
    return spec


def _value(question: Question, raw: Any) -> tuple[float | str, float | None, Mapping[str, float] | None] | None:
    if not isinstance(raw, dict) or raw.get("type") != question.type:
        return None
    if question.type == "noul":
        return (float(raw["noul"]), None, None) if _unit(raw.get("noul")) else None
    value, probabilities = raw.get(question.type), raw.get("probabilities")
    if question.type == "choice":
        valid = isinstance(value, str) and value in question.criteria
    else:
        valid = isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value < len(question.criteria)
    if not valid or not _unit(raw.get("confidence")) or not (
            probabilities is None or isinstance(probabilities, dict) and all(map(_unit, probabilities.values()))):
        return None
    return (value if question.type == "choice" else float(value)), float(raw["confidence"]), probabilities


def ask(
    question_id: str, state: Any, *, decision_point: str, base_dir: str | Path | None,
    subject: str | None = None, transport: Callable[[dict[str, Any]], JevReply | JevUnavailable] | None = None,
) -> Answer | Unavailable:
    """Ask one registered question about ``state``. Never raises (module docstring)."""
    registry = load_registry(bound_workspace_root(base_dir))
    if registry is None or not registry.enabled:
        return Unavailable(question_id, "unavailable", "registry_absent" if registry is None else "system_one_disabled")
    question = registry.questions.get(question_id)
    row: dict[str, Any] = {
        "schema_version": 1, "question_id": question_id, "question_version": question.version if question else None,
        "decision_point": decision_point, "subject": subject, "declared_mode": question.mode if question else None,
        "mode": "shadow", "model_requested": registry.model, "model": None, "state_sha256": None,
        "answer": None, "latency_ms": 0, "input_tokens": None,
    }
    result: Answer | Unavailable
    if question is None:
        result = Unavailable(question_id, "refused", registry.invalid.get(question_id, "question_not_registered"))
    elif decision_point not in question.decision_points:
        result = Unavailable(question_id, "refused", "decision_point_not_registered")
    elif (refusal := _state_refusal(question, state)) is not None:
        result = Unavailable(question_id, "refused", refusal)
    else:
        text = json.dumps(state, ensure_ascii=False)
        row["state_sha256"] = "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
        payload = {"model": registry.model, "state": text, "questions": {question.id: _spec(question, row["state_sha256"])}}
        started = time.monotonic()
        try:
            reply = (transport or call_systemone)(payload)
        except Exception as exc:  # noqa: BLE001 — the reflex never breaks the protocol; the class is recorded
            reply = JevUnavailable(f"transport_raised:{type(exc).__name__}")
        row["latency_ms"] = int((time.monotonic() - started) * 1000)
        if isinstance(reply, JevUnavailable):
            result = Unavailable(question_id, "unavailable", reply.reason)
        elif (fields := _value(question, reply.answers.get(question.id))) is None:
            row["model"], row["input_tokens"] = reply.model, reply.input_tokens
            result = Unavailable(question_id, "unavailable", "answer_malformed")
        else:
            mode = question.mode if reply.model == registry.model else "shadow"
            row.update(model=reply.model, input_tokens=reply.input_tokens, mode=mode, answer=reply.answers[question.id])
            result = Answer(question.id, question.version, question.type, *fields, reply.model, mode, decision_point)
    answered = isinstance(result, Answer)
    row.update(recorded_at=utc_now(), outcome="answered" if answered else result.outcome,
               reason=None if answered else result.reason)
    try:
        path = ensure_tools_dir(base_dir).joinpath(*CALLS_RELPATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl(path, row, expected_surface=CALLS_SURFACE)
    except Exception as exc:  # noqa: BLE001 — an unrecorded answer steers nothing
        return Unavailable(question_id, "unavailable", f"ledger_unwritable:{type(exc).__name__}")
    return result
