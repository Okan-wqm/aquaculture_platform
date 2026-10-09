"""System One — registered typed questions to Jev, ARIA's learned-reflex layer (ARIA-LOW-252).

A literal question about a small typed state, answered with a probability, a
choice or a score — never text; it classifies, never finds, closes or merges.
Questions come only from ``aria-config/system-one-questions.json`` (READONLY to
ARIA); a model other than the registry's answers in shadow; ``enabled: false``
(the seed) means no call and no row. Each enabled call writes one row to the
observation surface ``system-one/calls.jsonl`` (state sha256, never the state;
an id-shaped subject, the validated answer fields only; nothing reads it back
as a lesson or must_satisfy; unrecorded = unavailable).

EGRESS IS BUILT, NOT FILTERED. The operator rule is that only public
repository code and finding/PR text may leave the host — never tenant data,
logs, secrets or operator content. A caller therefore never passes TEXT: it
passes REFERENCES (``StateRef``), and this module builds every state value
itself from the bound repository — a commit's diff, message, file excerpt or
symbol outline read with ``git`` at a 40-hex commit a PUBLIC branch already
holds (fetched per ask from the pinned public URL into ``refs/aria-public/``,
never via the checkout's own remote configuration), and a finding's title
and rule read by id from the registry as the public ``main`` holds it. A commit only in
this checkout — unpushed work, a stash commit carrying ignored files — is
refused: a question about an implementation branch is admissible once that
branch is pushed, never before. A path is
held to the agent evidence law (no absolute path, no ``..`` escape, no
control character, never ARIA's own output) and refused when it names a
credential-shaped file. The deny scan stays as a BACKSTOP over every string
of the final payload — keys included — with the kernel's secret patterns,
further vendor token and credential shapes, e-mail addresses and IPv4
addresses outside the documentation/loopback ranges, a size cap on the exact
wire bytes, and Turkish text.

The transport (``jev_runtime``) is private to this module.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import random
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

# Bound under a private name: system_one is the only egress path, so the
# transport is never re-exported from it (tests/test_jev_runtime.py pins that
# nothing else names it).
from .jev_runtime import JevReply, JevUnavailable
from .jev_runtime import post_systemone as _transport
from .ledger import append_declared_jsonl
from .secret_scrub import scrub_text_with_count
from .tool_registry import bound_workspace_root, ensure_tools_dir, utc_now

REGISTRY_RELPATH = ("aria-config", "system-one-questions.json")
REGISTRY_SCHEMA = "aria/system-one-questions/v1"
FINDING_REGISTRY_RELPATH = ("docs", "reviews", "_registry", "findings.jsonl")
#: What "public" means here: the branches the PUBLIC repository publishes,
#: fetched from this pinned URL — never from `remote.origin.url` or its
#: refspec, which the checkout's own config controls — into a namespace only
#: this module writes, pruned on every fetch.
PUBLIC_REPOSITORY_URL = "https://github.com/Okan-wqm/aquaculture_platform.git"
PUBLIC_REFS = "refs/aria-public/"
PUBLIC_REFSPEC = "+refs/heads/*:refs/aria-public/heads/*"
PUBLIC_REGISTRY_REF = "refs/aria-public/heads/main"
FINDING_REGISTRY_MAX_CHARS = 64 * 1024 * 1024
CALLS_SURFACE = "system_one_calls"
CALLS_RELPATH = ("system-one", "calls.jsonl")
PAYLOAD_MAX_BYTES = 110_000  # ~25k tokens of state under the vendor's 32k budget, plus the question
VALUE_MAX_CHARS = 60_000
EXCERPT_RADIUS = 6
OUTLINE_MAX_LINES = 200
_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
_FINDING_ID_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-[0-9]{1,6}$")
# The ledger's subject names WHAT was asked about, never what was said about it.
_SUBJECT_RE = re.compile(r"^(?:[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-[0-9]{1,6}|PR#[0-9]{1,7}|[0-9a-f]{40})$")
_SENSITIVE_PATH = re.compile(
    r"(?:^|/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|_netrc|kubeconfig(?:\..*)?|id_[a-z0-9]+"
    r"|[^/]*credentials?[^/]*\.json|service[-_]?account[^/]*\.json"
    r"|[^/]*\.(?:pem|key|p12|p8|pfx|jks|kdbx|asc|tfvars|tfstate))$"
    r"|(?:^|/)(?:secrets?|credentials?|\.ssh|\.gnupg|\.kube|\.aws|\.docker)/",
    re.IGNORECASE,
)
_OUTLINE_LINE = re.compile(
    r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:pub(?:\([^)]*\))?\s+)?"
    r"(?:def|class|function|interface|type|enum|struct|trait|impl|fn|mod)\b"
)
# Credential shapes beyond the kernel's secret patterns (secret_scrub): the
# backstop the reference-built state should never need.
_EXTRA_SECRET = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY"
    r"|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    r"|\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}"
    r"|\bwhsec_[A-Za-z0-9]{16,}"
    r"|\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@"
    r"|\bdop_v1_[a-f0-9]{64}"
    r"|\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"
    r"|\bnpm_[A-Za-z0-9]{36}"
    r"|\bglpat-[A-Za-z0-9_-]{20,}"
    r"|\bAIza[0-9A-Za-z_-]{35}"
    r"|\bxox[abposr]-[A-Za-z0-9-]{10,}"
    r"|hooks\.slack\.com/services/"
    r"|\bapikey_[0-9a-f]{20,}"
    r"|(?i:aws.{0,20}?(?:secret|access).{0,20}?[\"'=:\s][A-Za-z0-9/+=]{40}\b)"
    r"|(?i:\bpass(?:word|wd)?\s*[:=]\s*[\"'][^\"'\s]{4,}[\"'])"
    r"|(?m:^[+\- \t]*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_?KEY)\s*[=:]\s*\S{6,})"
    r"|(?im:^[+\- \t]*[A-Za-z_]*pass(?:word|wd)?\s*:\s*(?!string\b|number\b|boolean\b|undefined\b|null\b|any\b)[^\s'\"{(<|][^\s]{3,}\s*$)",
)
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")
_EMAIL_DOMAINS_ALLOWED = re.compile(
    r"(?:^|\.)(?:example\.(?:com|org|net)|example|invalid|test|localhost|users\.noreply\.github\.com|noreply\.github\.com)$",
    re.IGNORECASE,
)
_IPV4 = re.compile(r"(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])")
_IPV4_ALLOWED = tuple(ipaddress.ip_network(net) for net in (
    "127.0.0.0/8", "0.0.0.0/32", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24",
))
_TURKISH = re.compile(r"[ğĞüÜşŞıİöÖçÇ]")
_ENGLISH_WORD = re.compile(r"\b(?:the|a|an|is|are|this|of|to|in|does|do|how|which|what)\b", re.IGNORECASE)


@dataclass(frozen=True)
class StateRef:
    """What a caller may hand ``ask`` for one state key: a reference, never text.

    ``finding_id`` for ``finding`` / ``rule`` / ``problem``; ``commit`` for
    ``message``; ``commit`` + ``path`` for ``diff`` / ``outline``; ``commit`` +
    ``path`` + ``line`` for ``excerpt``; ``path`` for ``file``.
    """

    finding_id: str | None = None
    commit: str | None = None
    path: str | None = None
    line: int | None = None


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
    if not set(raw["state_keys"]) <= set(_BUILDERS):
        return "state_key_unbuildable"
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


class _Refusal(Exception):
    """A reference or payload this module will not send; ``reason`` is the ledger's."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _git(workspace: Path, *args: str, max_chars: int = VALUE_MAX_CHARS) -> str:
    """git in the bound workspace, with no caller GIT_* environment; bounded output; a refusal on failure."""
    hermetic = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    try:
        completed = subprocess.run(
            ["git", "-c", "core.fsmonitor=false", "-C", str(workspace), *args],
            capture_output=True, timeout=30, check=False, env=hermetic,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise _Refusal(f"repository_unreadable:{type(exc).__name__}") from exc
    if completed.returncode != 0:
        raise _Refusal("reference_not_in_repository")
    try:
        text = completed.stdout.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _Refusal("reference_not_text") from exc
    if len(text) > max_chars:
        raise _Refusal("reference_too_large")
    return text


def _fetch_public(workspace: Path) -> None:
    """Refresh ``refs/aria-public/`` from the pinned public URL; a refusal when that is not what git would reach.

    A ``url.<x>.insteadOf`` rule can rewrite any URL, so the URL git WOULD
    contact is read back first (``ls-remote --get-url``) and must be the
    pinned one. The explicit refspec and ``--prune`` replace the namespace
    with exactly the public branches: a ref planted there locally is removed.
    """
    resolved = _git(workspace, "ls-remote", "--get-url", PUBLIC_REPOSITORY_URL).strip()
    if resolved != PUBLIC_REPOSITORY_URL:
        raise _Refusal("public_remote_url_rewritten")
    try:
        _git(workspace, "fetch", "--quiet", "--prune", "--no-tags", "--no-recurse-submodules",
             PUBLIC_REPOSITORY_URL, PUBLIC_REFSPEC)
    except _Refusal as refusal:
        raise _Refusal("public_remote_unavailable") from refusal


def _commit(workspace: Path, ref: StateRef) -> str:
    """``ref.commit`` when a public branch already holds it; a refusal otherwise.

    "Public repository code" is code the public repository publishes: a
    commit only in this checkout (unpushed work, a stash commit, which can
    carry ignored files) never leaves. ``_build_state`` refreshes
    ``refs/aria-public/`` from the pinned URL first, so a pushed branch — an
    ARIA implementation branch ``aria-impl-*`` included — is admissible as
    soon as it is pushed, and a local ref, however named, never is.
    """
    if not isinstance(ref.commit, str) or not _COMMIT_RE.match(ref.commit):
        raise _Refusal("commit_not_a_sha")
    _git(workspace, "cat-file", "-e", f"{ref.commit}^{{commit}}")
    holders = _git(workspace, "for-each-ref", "--contains", ref.commit, "--format=%(refname)", PUBLIC_REFS)
    if not holders.strip():
        raise _Refusal("commit_not_on_public_remote")
    return ref.commit


def _path(ref: StateRef) -> str:
    from .evidence_trust import parse_evidence_ref
    from .evidence_validator import agent_ref_shape_refusal

    path = ref.path
    if not isinstance(path, str) or agent_ref_shape_refusal(path) is not None:
        raise _Refusal("path_refused")
    parsed = parse_evidence_ref(path)
    if parsed is None or parsed[1] is not None or any(char in path for char in "*?["):
        raise _Refusal("path_refused")
    if _SENSITIVE_PATH.search(path):
        raise _Refusal("path_credential_shaped")
    return path


def _finding(workspace: Path, ref: StateRef) -> dict[str, str]:
    """``{finding: title, rule: rule_violated}`` of the registry row ``ref.finding_id`` names."""
    if not isinstance(ref.finding_id, str) or not _FINDING_ID_RE.match(ref.finding_id):
        raise _Refusal("finding_id_malformed")
    # The registry as the public remote holds it — never the working-tree file.
    ledger = _git(workspace, "show", f"{PUBLIC_REGISTRY_REF}:{'/'.join(FINDING_REGISTRY_RELPATH)}",
                  max_chars=FINDING_REGISTRY_MAX_CHARS)
    row: dict[str, Any] | None = None
    for line in ledger.splitlines():
        if ref.finding_id in line:
            try:
                candidate = json.loads(line)
            except ValueError as exc:
                raise _Refusal("finding_registry_unreadable") from exc
            if isinstance(candidate, dict) and candidate.get("id") == ref.finding_id:
                row = candidate
    if row is None:
        raise _Refusal("finding_not_registered")
    title, rule = row.get("title"), row.get("rule_violated")
    if not (isinstance(title, str) and title and isinstance(rule, str) and rule):
        raise _Refusal("finding_row_incomplete")
    return {"finding": title, "rule": rule}


def _excerpt(workspace: Path, ref: StateRef) -> str:
    commit, path = _commit(workspace, ref), _path(ref)
    if type(ref.line) is not int or ref.line < 1:
        raise _Refusal("excerpt_line_invalid")
    lines = _git(workspace, "show", f"{commit}:{path}").splitlines()
    if ref.line > len(lines):
        raise _Refusal("excerpt_line_invalid")
    first = max(1, ref.line - EXCERPT_RADIUS)
    last = min(len(lines), ref.line + EXCERPT_RADIUS)
    return "\n".join(f"{number}: {lines[number - 1]}" for number in range(first, last + 1))


def _outline(workspace: Path, ref: StateRef) -> str:
    commit, path = _commit(workspace, ref), _path(ref)
    lines = _git(workspace, "show", f"{commit}:{path}").splitlines()
    symbols = [f"{number}: {text.strip()}" for number, text in enumerate(lines, 1) if _OUTLINE_LINE.match(text)]
    return "\n".join(symbols[:OUTLINE_MAX_LINES])


#: The one place a state value can come from: one builder per state key, each
#: reading the bound repository by reference. A registry entry naming any
#: other key is refused (``state_key_unbuildable``).
_BUILDERS: dict[str, Callable[[Path, StateRef], Any]] = {
    "finding": _finding,
    "rule": lambda workspace, ref: _finding(workspace, ref)["rule"],
    "problem": lambda workspace, ref: _finding(workspace, ref)["finding"],
    "diff": lambda workspace, ref: _git(
        workspace, "show", "--format=", "--no-color", "--no-ext-diff", "--no-textconv",
        _commit(workspace, ref), "--", _path(ref),
    ),
    "message": lambda workspace, ref: _git(workspace, "log", "-1", "--format=%B", _commit(workspace, ref)),
    "file": lambda _workspace, ref: _path(ref),
    "excerpt": _excerpt,
    "outline": _outline,
}


def _build_state(question: Question, refs: Any, workspace: Path) -> dict[str, Any]:
    if not isinstance(refs, Mapping) or sorted(refs) != sorted(question.state_keys):
        raise _Refusal("state_shape:keys")
    if not all(isinstance(ref, StateRef) for ref in refs.values()):
        raise _Refusal("state_shape:not_a_reference")
    # One fetch per ask: admissibility is decided against what the remote
    # publishes NOW (a just-pushed branch counts; a deleted one does not).
    _fetch_public(workspace)
    state = {key: _BUILDERS[key](workspace, refs[key]) for key in question.state_keys}
    if any(not value for value in state.values()):
        raise _Refusal("state_value_empty")
    return state


def _strings_of(value: Any) -> list[str]:
    """Every string in ``value`` — mapping KEYS included."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, Mapping):
        return [text for key, item in value.items() for text in (*_strings_of(key), *_strings_of(item))]
    if isinstance(value, (list, tuple)):
        return [text for item in value for text in _strings_of(item)]
    return []


def _egress_refusal(payload: Mapping[str, Any], state: Mapping[str, Any]) -> str | None:
    """The backstop over the FINAL payload: its wire size, and every string in it, keys included."""
    try:
        wire = json.dumps(payload).encode("utf-8")
    except (TypeError, ValueError, RecursionError, UnicodeError):
        return "payload_unserialisable"
    if len(wire) > PAYLOAD_MAX_BYTES:
        return "payload_too_large"
    # The state travels as one JSON string; it is scanned as the strings it
    # was built from, so a multi-line credential is still seen line by line.
    strings = _strings_of(state) + _strings_of({key: value for key, value in payload.items() if key != "state"})
    leaked = sorted({kind for text in strings for kind in scrub_text_with_count(text)[1]} - {"email", "ipv4_octet"})
    if leaked or any(_EXTRA_SECRET.search(text) for text in strings):
        return "state_secret_shaped:" + (",".join(leaked) or "credential_shape")
    for text in strings:
        if any(not _EMAIL_DOMAINS_ALLOWED.search(domain) for domain in _EMAIL.findall(text)):
            return "state_personal_data:email"
        for candidate in _IPV4.findall(text):
            try:
                address = ipaddress.ip_address(candidate)
            except ValueError:
                continue
            if not any(address in network for network in _IPV4_ALLOWED):
                return "state_personal_data:ipv4"
    if any(len(_TURKISH.findall(text)) >= 3 for text in strings):
        return "state_not_english"
    return None


def _ledger_answer(question: Question, fields: tuple[float | str, float | None, Mapping[str, float] | None]) -> dict[str, Any]:
    """The validated answer only — never the vendor's raw object."""
    value, confidence, probabilities = fields
    keys = list(question.criteria or ())
    if question.type == "score":
        keys += [str(index) for index in range(len(keys))]
    bounded = None
    if isinstance(probabilities, Mapping):
        bounded = {key: round(float(probabilities[key]), 6) for key in keys if key in probabilities}
    return {"value": value, "confidence": confidence, "probabilities": bounded}


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
    question_id: str, refs: Mapping[str, StateRef], *, decision_point: str, base_dir: str | Path | None,
    subject: str | None = None, transport: Callable[[dict[str, Any]], JevReply | JevUnavailable] | None = None,
) -> Answer | Unavailable:
    """Ask one registered question about the state built from ``refs``. Never raises (module docstring)."""
    workspace = bound_workspace_root(base_dir)
    registry = load_registry(workspace)
    if registry is None or not registry.enabled:
        return Unavailable(question_id, "unavailable", "registry_absent" if registry is None else "system_one_disabled")
    question = registry.questions.get(question_id)
    row: dict[str, Any] = {
        "schema_version": 1, "question_id": question_id, "question_version": question.version if question else None,
        "decision_point": decision_point,
        "subject": subject if isinstance(subject, str) and _SUBJECT_RE.match(subject) else None,
        "declared_mode": question.mode if question else None,
        "mode": "shadow", "model_requested": registry.model, "model": None, "state_sha256": None,
        "answer": None, "latency_ms": 0, "input_tokens": None,
    }
    result: Answer | Unavailable
    if question is None:
        result = Unavailable(question_id, "refused", registry.invalid.get(question_id, "question_not_registered"))
    elif decision_point not in question.decision_points:
        result = Unavailable(question_id, "refused", "decision_point_not_registered")
    elif subject is not None and row["subject"] is None:
        result = Unavailable(question_id, "refused", "subject_not_an_id")
    else:
        result = _ask_built(question, refs, registry, workspace, row, transport)
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


def _ask_built(
    question: Question, refs: Mapping[str, StateRef], registry: Registry, workspace: Path,
    row: dict[str, Any], transport: Callable[[dict[str, Any]], JevReply | JevUnavailable] | None,
) -> Answer | Unavailable:
    """Build the state from references, check the final payload, call, and fill ``row``."""
    try:
        state = _build_state(question, refs, workspace)
    except _Refusal as refusal:
        return Unavailable(question.id, "refused", refusal.reason)
    except Exception as exc:  # noqa: BLE001 — a reference that breaks the builder is refused, by class
        return Unavailable(question.id, "refused", f"reference_unbuildable:{type(exc).__name__}")
    text = json.dumps(state, ensure_ascii=False)
    row["state_sha256"] = "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
    payload = {"model": registry.model, "state": text, "questions": {question.id: _spec(question, row["state_sha256"])}}
    if (refusal := _egress_refusal(payload, state)) is not None:
        return Unavailable(question.id, "refused", refusal)
    started = time.monotonic()
    try:
        reply = (transport or _transport)(payload)
    except Exception as exc:  # noqa: BLE001 — the reflex never breaks the protocol; the class is recorded
        reply = JevUnavailable(f"transport_raised:{type(exc).__name__}")
    row["latency_ms"] = int((time.monotonic() - started) * 1000)
    if isinstance(reply, JevUnavailable):
        return Unavailable(question.id, "unavailable", reply.reason)
    if not (isinstance(reply.model, str) and _MODEL_RE.match(reply.model)):
        return Unavailable(question.id, "unavailable", "answer_malformed")
    tokens = reply.input_tokens if type(reply.input_tokens) is int and 0 <= reply.input_tokens <= 10_000_000 else None
    row["model"], row["input_tokens"] = reply.model, tokens
    fields = _value(question, reply.answers.get(question.id))
    if fields is None:
        return Unavailable(question.id, "unavailable", "answer_malformed")
    mode = question.mode if reply.model == registry.model else "shadow"
    row.update(mode=mode, answer=_ledger_answer(question, fields))
    return Answer(question.id, question.version, question.type, *fields, reply.model, mode, row["decision_point"])
