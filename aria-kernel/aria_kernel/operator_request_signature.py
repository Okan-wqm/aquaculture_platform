"""ADR-0020 / ADR-0023 — operator acts are signed by the operator, never by the runner.

WHY. The request rows the plan synthesizer ranks at priority 0 used to carry
a keyed HMAC the kernel minted on first use under
``aria-tools/secrets/operator-feedback-hmac.key``. That key lived on the
runner, so the signature attested "a process with the runner uid wrote this
row" — exactly the population the signature was meant to exclude. It was
also never published with the state store and the self-hosted lanes'
``git clean -ffdx`` swept it at job start (``aria-auto-cycle.yml``), so no
later job could verify a row, and the pre-merge perimeter (check 12) runs on
GitHub-hosted runners that never held it: an operator-sourced plan could not
merge by construction.

WHAT. The operator signs with an ed25519 key held off-runner through
``ssh-keygen -Y sign``; the verifier needs only the allowed-signers file
committed at :data:`ALLOWED_SIGNERS_PATH` and the namespace registry
committed at :data:`NAMESPACE_REGISTRY_PATH`, both read as git OBJECTS at a
commit proven on ``main`` through the hardened reader of :mod:`main_anchor`
(scrubbed git environment, replace objects off, blob re-hashed) — never the
working tree, never a commit the checkout merely points at. ``.github/`` is
in ``implementation_safety.READONLY_PATHS``, so ARIA cannot enrol a key for
itself. No signing material exists anywhere a runner uid can read.

ADR-0023 — every act has its own ``ssh-keygen -n`` namespace, and the
committed registry is the only list of them: its entry names the subject's
domain tag, the fields every subject carries, the principal classes that may
sign (T0 the operator, T1 a root session acting for the operator; never T2,
the runner) and the expiry bound. :func:`verify_operator_signature` is the
ONE verification every operator act goes through — the request rows, the
MCP write approvals, and the label, journey and enrolment acts that follow —
parameterised by namespace and fed by the registry entry.

The kernel-written row kinds of the same ledger (verdict rows, calibration
fixtures) keep their HMAC in ``operator_feedback_signature``; they are never
plan candidates, and nothing here verifies them.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, TextIO

from .main_anchor import committed_blob, resolve_main_anchor, tracked_files_at
from .operator_request_terms import parse_utc
from .tool_registry import GovernanceError

# ADR-0023 — the operator namespaces. Each is an entry of the committed
# registry; a namespace the registry does not list verifies nothing.
SIGNATURE_NAMESPACE = "aria-operator-request"
LABEL_NAMESPACE = "aria-operator-label"
JOURNEY_NAMESPACE = "aria-operator-journey"
ENROL_NAMESPACE = "aria-operator-enrol"
OPERATOR_NAMESPACES: tuple[str, ...] = (
    SIGNATURE_NAMESPACE, LABEL_NAMESPACE, JOURNEY_NAMESPACE, ENROL_NAMESPACE,
)
ALLOWED_SIGNERS_PATH = ".github/manifests/aria-operator-signers"
NAMESPACE_REGISTRY_PATH = ".github/manifests/aria-signature-namespaces.json"
NAMESPACE_REGISTRY_SCHEMA = "aria/signature-namespaces/v1"
# ADR-0023 enrolment chain. The two files above change only together with a
# row appended here, signed in ``aria-operator-enrol`` by a key the PARENT
# version enrols; each row carries its child files' bytes, so the chain
# verifies from one commit's tree without walking history or local refs.
ENROLMENTS_PATH = ".github/manifests/aria-operator-enrolments.jsonl"
ENROLMENT_SCHEMA = "aria/operator-enrolment/v1"
# The pair S1 committed — (allowed-signers, registry) digests — that every
# anchor read walks from. A one-way door: changing it rewrites trust history
# and is an amendment of ADR-0023. ``aria_kernel/`` is READONLY to ARIA.
ENROLMENT_GENESIS: tuple[str, str] = (
    "sha256:7dbcd3cae6f4ecec34299d35e67b73ef31a4b48a6d52d15a93c15e1259f07d4b",
    "sha256:56bb49bc7014c172b7bdeb6a26988f4018aa24fb33253fa9a7c8d12ad3fb43ee",
)
# T0 the operator at a terminal, T1 a root session acting for the operator
# (indistinguishable from T0 cryptographically: ARIA-MEDIUM-273), T2 ARIA's
# runner. An operator namespace admits T0/T1 only.
OPERATOR_ACTOR_CLASSES: frozenset[str] = frozenset({"T0", "T1"})
RUNNER_ACTOR_CLASS = "T2"
_ACTOR_CLASSES: frozenset[str] = OPERATOR_ACTOR_CLASSES | {RUNNER_ACTOR_CLASS}
NAMESPACE_ACTIVE = "active"
_NAMESPACE_RE = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
_VERIFIER_RE = re.compile(r"^aria_kernel(?:\.[a-z_][a-z0-9_]*)+$")
# Every operator subject carries these besides its own fields (ADR-0023):
# who signs, as which class, for which repository, until when.
OPERATOR_SUBJECT_FIELDS: frozenset[str] = frozenset({"actor_class", "audience", "expires_at", "signer_principal"})
# Domain separation inside the signed bytes, distinct from the HMAC rows'
# ``aria-operator-feedback/v1``: a signature over one subject verifies as
# no other. The registry's request entry carries the same tag (pinned by
# test), so a request's identity digest and its verified bytes agree.
REQUEST_DOMAIN_TAG = "aria-operator-request/v1"
SIGNING_DOMAIN = REQUEST_DOMAIN_TAG.encode("ascii") + b"\n"
# Chain metadata is stamped by the ledger after signing; ``signature`` is
# the field being computed. Everything else — the principal included — is
# signed, so a row cannot be re-attributed without breaking it.
_SIGNING_EXCLUDED_FIELDS: frozenset[str] = frozenset({
    "signature", "ledger_hash", "previous_ledger_hash",
})
# The operator-signed request row format (ADR-0018/0020). Fixed in the
# subject BEFORE signing: the ledger stamps a missing ``schema_version`` on
# append, and a subject that changes between signing and storage never
# verifies.
REQUEST_ROW_SCHEMA_VERSION = 2
# The principal reaches ssh-keygen's argv as ``-I``: a closed charset with
# no leading dash keeps a row from smuggling an option.
_PRINCIPAL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$")
_ARMOR_RE = re.compile(
    r"\A-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]+-----END SSH SIGNATURE-----\n?\Z"
)
MAX_SIGNATURE_CHARS = 4096
_VERIFY_TIMEOUT_SECONDS = 15
# Signing is an operator act at a terminal: an encrypted key prompts for its
# passphrase on the tty, which takes longer than a verifier ever should.
_SIGN_TIMEOUT_SECONDS = 300

# Closed vocabulary of verification failures, spoken by the ingestion
# governance event and by the pre-merge evidence alike.
SIGNATURE_MISSING = "signature_missing"
SIGNATURE_MALFORMED = "signature_malformed"
SIGNER_PRINCIPAL_MISSING = "signer_principal_missing"
SIGNER_PRINCIPAL_INVALID = "signer_principal_invalid"
ALLOWED_SIGNERS_UNAVAILABLE = "allowed_signers_unavailable"
SIGNER_NOT_ENROLLED = "signer_not_enrolled"
VERIFIER_UNAVAILABLE = "signature_verifier_unavailable"
VERIFICATION_TIMEOUT = "signature_verification_timeout"
SIGNATURE_INVALID = "signature_invalid"
NAMESPACE_UNREGISTERED = "signature_namespace_unregistered"
ACTOR_CLASS_REFUSED = "actor_class_refused"
VERIFICATION_REASONS: tuple[str, ...] = (
    SIGNATURE_MISSING, SIGNATURE_MALFORMED, SIGNER_PRINCIPAL_MISSING,
    SIGNER_PRINCIPAL_INVALID, ALLOWED_SIGNERS_UNAVAILABLE, SIGNER_NOT_ENROLLED,
    VERIFIER_UNAVAILABLE, VERIFICATION_TIMEOUT, SIGNATURE_INVALID,
    NAMESPACE_UNREGISTERED, ACTOR_CLASS_REFUSED,
)
# The runner could not judge the row (no anchor, no verifier, a verifier
# that hung). Never evidence against the request, so never a reason to
# spend it (ADR-0018, arbiter ruling iii).
VERIFICATION_RUNNER_FAULTS: frozenset[str] = frozenset({
    ALLOWED_SIGNERS_UNAVAILABLE, VERIFIER_UNAVAILABLE, VERIFICATION_TIMEOUT,
})
# An anchor reason, so a runner fault: the committed registry is not one.
NAMESPACE_REGISTRY_INVALID = "signature_namespace_registry_invalid"
# Anchor reasons of the enrolment walk: never a pass, always a runner fault.
ENROL_GENESIS_MISMATCH = "enrol_genesis_mismatch"
ENROL_CHAIN_BROKEN = "enrol_chain_broken"
ENROL_SIGNATURE_INVALID = "enrol_signature_invalid"
ENROL_TIP_MISMATCH = "enrol_tip_mismatch"
OPERATORS_POLICY_UNAVAILABLE = "operators_policy_unavailable"
# What a registry entry demands of a FRESH act's terms (an MCP write approval).
NAMESPACE_RETIRED = "signature_namespace_retired"
SUBJECT_FIELD_MISSING = "signed_subject_field_missing"
SUBJECT_AUDIENCE_MISMATCH = "signed_subject_audience_mismatch"
SUBJECT_EXPIRY_INVALID = "signed_subject_expiry_invalid"
SUBJECT_EXPIRED = "signed_subject_expired"


@dataclass(frozen=True)
class OperatorRequestVerdict:
    """One subject's verification: valid with the principal that signed it, or a reason."""

    valid: bool
    signer: str | None
    reason: str | None


@dataclass(frozen=True)
class NamespaceEntry:
    """One registry entry (ADR-0023): how a namespace's subjects are formed, signed and bounded."""

    namespace: str
    domain_tag: str | None
    signed_fields: tuple[str, ...]
    signer_classes: frozenset[str]
    expiry_hours: int | None
    verifier: str
    status: str

    @property
    def operator(self) -> bool:
        return RUNNER_ACTOR_CLASS not in self.signer_classes


def _strings(value: Any) -> list[str] | None:
    return value if isinstance(value, list) and all(isinstance(v, str) and v for v in value) else None


def _namespace_entry(item: Any) -> NamespaceEntry | None:
    if not isinstance(item, dict):
        return None
    name, tag, hours, verifier = (item.get(key) for key in ("namespace", "domain_tag", "expiry_hours", "verifier"))
    fields, classes, status = _strings(item.get("signed_fields")), _strings(item.get("signer_classes")), item.get("status")
    if not isinstance(name, str) or _NAMESPACE_RE.fullmatch(name) is None or not classes or fields is None:
        return None
    if not set(classes) <= _ACTOR_CLASSES or status not in ("active", "retired"):
        return None
    if not isinstance(verifier, str) or _VERIFIER_RE.fullmatch(verifier) is None:
        return None
    if RUNNER_ACTOR_CLASS in classes:
        # ARIA's own namespace: T2 alone, so no operator namespace admits
        # the runner — an entry listing T2 beside T0/T1 is no entry.
        if set(classes) != {RUNNER_ACTOR_CLASS}:
            return None
        tag, hours = None, None
    elif (not isinstance(tag, str) or re.fullmatch(re.escape(name) + r"/v[1-9][0-9]*", tag) is None
          or type(hours) is not int or hours <= 0 or not OPERATOR_SUBJECT_FIELDS <= set(fields)):
        return None
    return NamespaceEntry(namespace=name, domain_tag=tag, signed_fields=tuple(fields),
                          signer_classes=frozenset(classes), expiry_hours=hours, verifier=verifier, status=status)


def parse_namespace_registry(content: bytes) -> dict[str, NamespaceEntry] | None:
    """The committed registry by namespace, or None for anything that is not one.

    Every operator namespace this kernel speaks must be an operator entry
    (retired or not): a registry that drops one is no registry.
    """
    try:
        payload = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("$schema") != NAMESPACE_REGISTRY_SCHEMA:
        return None
    raw = payload.get("namespaces")
    if not isinstance(raw, list):
        return None
    entries: dict[str, NamespaceEntry] = {}
    for item in raw:
        entry = _namespace_entry(item)
        if entry is None or entry.namespace in entries:
            return None
        entries[entry.namespace] = entry
    if not all(name in entries and entries[name].operator for name in OPERATOR_NAMESPACES):
        return None
    return entries


def subject_signing_bytes(subject: dict[str, Any], domain_tag: str) -> bytes:
    """Domain tag, newline, canonical JSON of the subject minus chain fields and the signature.

    Same canonicalisation as ``operator_feedback_signature.canonical_signing_bytes``
    (sorted keys, no whitespace, ASCII) so a row that round-trips through the
    ledger verifies byte-for-byte.
    """
    body = {key: value for key, value in subject.items() if key not in _SIGNING_EXCLUDED_FIELDS}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return domain_tag.encode("ascii") + b"\n" + encoded.encode("utf-8")


def request_signing_bytes(row: dict[str, Any]) -> bytes:
    """The request subject's bytes (``aria-operator-request/v1``), unchanged by ADR-0023."""
    return subject_signing_bytes(row, REQUEST_DOMAIN_TAG)


def valid_principal(value: Any) -> bool:
    return isinstance(value, str) and _PRINCIPAL_RE.fullmatch(value) is not None


@dataclass(frozen=True)
class AllowedSigners:
    """The trust anchor's bytes, its namespace registry, and where they came from."""

    content: bytes
    commit: str
    blob_oid: str
    namespaces: Mapping[str, NamespaceEntry]
    # ARIA-LOW-267 — ``repository`` of the operators policy at the same commit.
    audience: str


def _digest(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


def _pair(allowed_signers: bytes, registry: bytes) -> dict[str, str]:
    return {"allowed_signers": _digest(allowed_signers), "registry": _digest(registry)}


def enrolment_genesis_row(allowed_signers: bytes, registry: bytes) -> dict[str, Any]:
    """Row 0 of the enrolment file: the genesis pair's bytes, which must hash to the pin."""
    return {"schema": ENROLMENT_SCHEMA, "kind": "genesis", "child": _pair(allowed_signers, registry),
            "child_allowed_signers": allowed_signers.decode("utf-8"), "child_registry": registry.decode("utf-8")}


def genesis_pinned(child: Any) -> bool:
    return child == dict(zip(("allowed_signers", "registry"), ENROLMENT_GENESIS))


def _child(row: Any) -> tuple[bytes, bytes] | None:
    """A row's child pair, when its bytes hash to its digests and the registry is one."""
    texts = (row.get("child_allowed_signers"), row.get("child_registry")) if isinstance(row, dict) else (None,)
    if not all(isinstance(text, str) for text in texts) or row.get("schema") != ENROLMENT_SCHEMA:
        return None
    signers, registry = (text.encode("utf-8") for text in texts)
    if row.get("child") != _pair(signers, registry) or parse_namespace_registry(registry) is None:
        return None
    return signers, registry


def verify_enrolment_chain(enrolments: bytes | None, *, allowed_signers: bytes, registry: bytes) -> str | None:
    """Why the committed pair is not reached from the pinned genesis by enrolments, or None.

    Row 0 is the genesis (its pair must be the pin); every later row names
    the current pair as its parent and is signed in ``aria-operator-enrol``
    by a key the CURRENT (parent) allowed-signers file enrols for it, as an
    actor class the parent registry admits; the last child must be the pair
    committed beside the file. A merged row is history: its expiry was
    checked before merge and is not re-checked here.
    """
    try:
        rows = [json.loads(line) for line in (enrolments or b"").decode("utf-8").splitlines() if line.strip()]
    except (UnicodeDecodeError, ValueError):
        return ENROL_CHAIN_BROKEN
    state = _child(rows[0]) if rows and isinstance(rows[0], dict) and rows[0].get("kind") == "genesis" else None
    if state is None or not genesis_pinned(rows[0]["child"]):
        return ENROL_GENESIS_MISMATCH
    for row in rows[1:]:
        child = _child(row)
        if child is None or row.get("kind") != "enrolment" or row.get("parent") != _pair(*state):
            return ENROL_CHAIN_BROKEN
        namespaces = parse_namespace_registry(state[1])
        entry = namespaces.get(ENROL_NAMESPACE) if namespaces else None
        if entry is None or any(field not in row for field in entry.signed_fields):
            return ENROL_SIGNATURE_INVALID
        verdict = verify_operator_signature(row, namespace=ENROL_NAMESPACE, allowed_signers=state[0], namespaces=namespaces)
        if not verdict.valid:
            return verdict.reason if verdict.reason in VERIFICATION_RUNNER_FAULTS else ENROL_SIGNATURE_INVALID
        state = child
    return None if _pair(*state) == _pair(allowed_signers, registry) else ENROL_TIP_MISMATCH


def appended_enrolments_reason(base: bytes | None, head: bytes | None, *, now: datetime) -> str | None:
    """Before merge (ADR-0023): a change only appends enrolment rows, and none it appends has expired."""
    base, head = base or b"", head or b""
    if not head.startswith(base):
        return ENROL_CHAIN_BROKEN
    for line in filter(str.strip, head[len(base):].decode("utf-8", errors="replace").splitlines()):
        try:
            row = json.loads(line)
        except ValueError:
            return ENROL_CHAIN_BROKEN
        if not isinstance(row, dict):
            return ENROL_CHAIN_BROKEN
        expires = parse_utc(row.get("expires_at"))
        # The genesis carries no expiry: the pin in this module is what admits it.
        if row.get("kind") != "genesis" and (expires is None or now >= expires):
            return SUBJECT_EXPIRED
    return None


def pre_merge_enrolment_reason(repo_root: str | Path, *, base: str, head: str, now: datetime) -> str | None:
    """ARIA-MEDIUM-282 — the enrolment rows ``head`` appends to ``base``, judged at ``now``, or None.

    ``now`` is the clock of the decision that lands the change: the merge
    authority's pre-merge perimeter passes its own, read immediately before
    it merges; the required check passes the clock of its run. Both commits
    are read through the hardened reader; a commit that cannot be listed, or
    a listed file that cannot be read, refuses (``enrol_chain_broken``) and
    never reads as "nothing appended".
    """
    contents: list[bytes] = []
    for commit in (base, head):
        listed = tracked_files_at(repo_root, commit=commit, paths=[ENROLMENTS_PATH])
        blob = committed_blob(repo_root, commit=commit, path=ENROLMENTS_PATH) if listed else None
        if listed is None or (listed and blob is None):
            return ENROL_CHAIN_BROKEN
        contents.append(blob.content if blob is not None else b"")
    return appended_enrolments_reason(contents[0], contents[1], now=now)


def _committed_audience(repo_root: str | Path, *, commit: str) -> str | None:
    """ARIA-LOW-267 — the request audience from the operators policy committed at the anchor."""
    from .operator_approval import OPERATORS_POLICY_RELPATH, load_operators_policy

    blob = committed_blob(repo_root, commit=commit, path=OPERATORS_POLICY_RELPATH)
    try:
        return str(load_operators_policy(json.loads(blob.content.decode("utf-8")))["repository"]) if blob else None
    except (GovernanceError, UnicodeDecodeError, ValueError, TypeError):
        return None


def _anchor_at(repo_root: str | Path, *, commit: str) -> tuple[AllowedSigners | None, str | None]:
    blob = committed_blob(repo_root, commit=commit, path=ALLOWED_SIGNERS_PATH)
    registry = committed_blob(repo_root, commit=commit, path=NAMESPACE_REGISTRY_PATH)
    if blob is None or registry is None or not blob.content.strip():
        return None, ALLOWED_SIGNERS_UNAVAILABLE
    namespaces = parse_namespace_registry(registry.content)
    if namespaces is None:
        return None, NAMESPACE_REGISTRY_INVALID
    enrolments = committed_blob(repo_root, commit=commit, path=ENROLMENTS_PATH)
    chain = verify_enrolment_chain(enrolments.content if enrolments else None, allowed_signers=blob.content,
                                   registry=registry.content)
    if chain is not None:
        return None, chain
    audience = _committed_audience(repo_root, commit=commit)
    if audience is None:
        return None, OPERATORS_POLICY_UNAVAILABLE
    return AllowedSigners(content=blob.content, commit=blob.commit, blob_oid=blob.blob_oid,
                          namespaces=namespaces, audience=audience), None


def allowed_signers_at(repo_root: str | Path, *, commit: str) -> AllowedSigners | None:
    """The allowed-signers file and the registry as committed at ``commit``, read through the hardened git.

    ``main_anchor.committed_blob``: a scrubbed environment, replace objects
    off, each blob re-hashed against its object id. None is not a pass —
    every caller turns it into :data:`ALLOWED_SIGNERS_UNAVAILABLE`.
    """
    return _anchor_at(repo_root, commit=commit)[0]


def allowed_signers_for_checkout(repo_root: str | Path) -> tuple[AllowedSigners | None, str | None]:
    """The anchor a cycle (or the recorder) may trust: its checkout's commit, proven on main.

    Returns ``(anchor, None)`` or ``(None, reason)`` with a
    ``main_anchor.ANCHOR_*`` reason, :data:`ALLOWED_SIGNERS_UNAVAILABLE`
    when the proven commit carries no allowed-signers file or registry,
    :data:`NAMESPACE_REGISTRY_INVALID`, an ``ENROL_*`` reason of the walk, or
    :data:`OPERATORS_POLICY_UNAVAILABLE`.
    """
    anchor = resolve_main_anchor(repo_root)
    if anchor.commit is None:
        return None, anchor.reason
    return _anchor_at(repo_root, commit=anchor.commit)


def request_subject_digest(row: dict[str, Any]) -> str:
    """``sha256:`` of the signed subject — the request's identity beyond its id."""
    return "sha256:" + hashlib.sha256(request_signing_bytes(row)).hexdigest()


def enrolled_principals(allowed_signers: bytes) -> frozenset[str]:
    """Principals the allowed-signers file names (first field, comma-separated).

    Used only to name ``signer_not_enrolled`` before ssh-keygen runs; the
    binding of key, principal and namespace is ssh-keygen's to judge.
    """
    principals: set[str] = set()
    for raw in allowed_signers.decode("utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        principals.update(part for part in line.split()[0].split(",") if part)
    return frozenset(principals)


def sign_operator_subject(
    subject: dict[str, Any], *, namespace: str, domain_tag: str, signing_key: str | Path,
    signer_principal: str, subject_stream: TextIO | None = None,
) -> dict[str, Any]:
    """Return ``subject`` plus ``signer_principal`` and the armored ``signature``.

    ``signing_key`` is the operator's private key, or its public half when
    the private key sits in ssh-agent; the kernel passes the path through to
    ssh-keygen and never reads, copies or stores it. The subject travels by
    file so stdin stays the operator's terminal for a passphrase prompt, and
    the file lives in a fresh private directory so ssh-keygen never meets an
    existing ``.sig`` it would ask to overwrite.

    ``subject_stream`` (the recorders pass stderr) receives the exact bytes
    about to be signed BEFORE ssh-keygen runs, so the operator signs what
    they read, not what a process between them and the key assembled
    (security-reviewer GSEC-MEDIUM-005).
    """
    act = namespace.removeprefix("aria-").replace("-", "_")
    if not isinstance(subject, dict):
        raise GovernanceError(f"{act}_row_must_be_object")
    if not valid_principal(signer_principal):
        raise GovernanceError(f"{act}_signer_principal_invalid: {signer_principal!r}")
    key_path = Path(signing_key).expanduser()
    if not key_path.is_file():
        raise GovernanceError(f"{act}_signing_key_missing: {key_path.as_posix()}")
    keygen = shutil.which("ssh-keygen")
    if keygen is None:
        raise GovernanceError(f"{act}_signing_unavailable: ssh-keygen not on PATH")
    body = {key: value for key, value in subject.items() if key not in _SIGNING_EXCLUDED_FIELDS}
    body["signer_principal"] = signer_principal
    subject_bytes = subject_signing_bytes(body, domain_tag)
    if subject_stream is not None:
        subject_stream.write(f"aria-kernel: signing this subject (namespace {namespace}):\n"
                             f"{subject_bytes.decode('ascii')}\n")
        subject_stream.flush()
    with tempfile.TemporaryDirectory(prefix=f"{namespace}-") as scratch:
        data_path = Path(scratch) / "subject"
        data_path.write_bytes(subject_bytes)
        try:
            proc = subprocess.run(
                [keygen, "-Y", "sign", "-f", str(key_path), "-n", namespace, str(data_path)],
                capture_output=True, text=True, check=False, timeout=_SIGN_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise GovernanceError(f"{act}_signing_timeout: ssh-keygen did not return") from exc
        signature_path = data_path.with_name(data_path.name + ".sig")
        if proc.returncode != 0 or not signature_path.is_file():
            raise GovernanceError(f"{act}_signing_failed: {proc.stderr.strip()[:200]}")
        signed = dict(body)
        signed["signature"] = signature_path.read_text(encoding="ascii")
    return signed


def sign_operator_request(
    row: dict[str, Any], *, signing_key: str | Path, signer_principal: str,
    subject_stream: TextIO | None = None,
) -> dict[str, Any]:
    """A request row signed in :data:`SIGNATURE_NAMESPACE` (ADR-0020's subject, unchanged)."""
    if not isinstance(row, dict):
        raise GovernanceError("operator_request_row_must_be_object")
    subject = dict(row)
    subject.setdefault("schema_version", REQUEST_ROW_SCHEMA_VERSION)
    return sign_operator_subject(
        subject, namespace=SIGNATURE_NAMESPACE, domain_tag=REQUEST_DOMAIN_TAG, signing_key=signing_key,
        signer_principal=signer_principal, subject_stream=subject_stream,
    )


def _admits(entry: NamespaceEntry, actor_class: Any) -> bool:
    return isinstance(actor_class, str) and actor_class in entry.signer_classes


def verify_operator_signature(
    subject: Any, *, namespace: str, allowed_signers: bytes | None,
    namespaces: Mapping[str, NamespaceEntry] | None,
) -> OperatorRequestVerdict:
    """The one ``ssh-keygen -Y verify`` of an operator act, in a registered operator ``namespace``.

    The entry's domain tag forms the verified bytes; a declared ``actor_class``
    the entry does not admit is refused (a request signed before ADR-0023
    declares none and verifies with unchanged bytes). Fail-closed: no
    verifier, no anchor or a hung verifier is a named reason, never a pass.
    """
    if not isinstance(subject, dict):
        return OperatorRequestVerdict(False, None, SIGNATURE_MISSING)
    signature = subject.get("signature")
    if not isinstance(signature, str) or not signature:
        return OperatorRequestVerdict(False, None, SIGNATURE_MISSING)
    if len(signature) > MAX_SIGNATURE_CHARS or _ARMOR_RE.fullmatch(signature) is None:
        return OperatorRequestVerdict(False, None, SIGNATURE_MALFORMED)
    principal = subject.get("signer_principal")
    if not isinstance(principal, str) or not principal:
        return OperatorRequestVerdict(False, None, SIGNER_PRINCIPAL_MISSING)
    if not valid_principal(principal):
        return OperatorRequestVerdict(False, None, SIGNER_PRINCIPAL_INVALID)
    if not allowed_signers or namespaces is None:
        return OperatorRequestVerdict(False, principal, ALLOWED_SIGNERS_UNAVAILABLE)
    entry = namespaces.get(namespace)
    if entry is None or not entry.operator or entry.domain_tag is None:
        return OperatorRequestVerdict(False, principal, NAMESPACE_UNREGISTERED)
    if "actor_class" in subject and not _admits(entry, subject["actor_class"]):
        return OperatorRequestVerdict(False, principal, ACTOR_CLASS_REFUSED)
    if principal not in enrolled_principals(allowed_signers):
        return OperatorRequestVerdict(False, principal, SIGNER_NOT_ENROLLED)
    # Resolved once and executed by absolute path: the binary that was
    # checked is the binary that runs (security-reviewer GSEC-LOW-006).
    keygen = shutil.which("ssh-keygen")
    if keygen is None:
        return OperatorRequestVerdict(False, principal, VERIFIER_UNAVAILABLE)
    with tempfile.TemporaryDirectory(prefix="aria-operator-verify-") as scratch:
        allowed_path = Path(scratch) / "allowed_signers"
        allowed_path.write_bytes(allowed_signers)
        signature_path = Path(scratch) / "subject.sig"
        signature_path.write_text(signature, encoding="ascii")
        try:
            proc = subprocess.run(
                [keygen, "-Y", "verify", "-f", str(allowed_path), "-I", principal,
                 "-n", entry.namespace, "-s", str(signature_path)],
                input=subject_signing_bytes(subject, entry.domain_tag), capture_output=True,
                check=False, timeout=_VERIFY_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            return OperatorRequestVerdict(False, principal, VERIFICATION_TIMEOUT)
        except OSError:
            return OperatorRequestVerdict(False, principal, VERIFIER_UNAVAILABLE)
    if proc.returncode != 0:
        return OperatorRequestVerdict(False, principal, SIGNATURE_INVALID)
    return OperatorRequestVerdict(True, principal, None)


def verify_operator_request(row: Any, *, allowed_signers: AllowedSigners | None) -> OperatorRequestVerdict:
    """A request row's signature, in :data:`SIGNATURE_NAMESPACE`, against the committed anchor."""
    return verify_operator_signature(
        row, namespace=SIGNATURE_NAMESPACE,
        allowed_signers=allowed_signers.content if allowed_signers is not None else None,
        namespaces=allowed_signers.namespaces if allowed_signers is not None else None,
    )


def operator_act_terms_reason(
    subject: dict[str, Any], *, entry: NamespaceEntry | None, audience: str, now: datetime,
) -> str | None:
    """Why a FRESH act is refused at ``now`` by its registry entry, or None (the signature is judged apart).

    Every signed field present, an admitted ``actor_class``, this repository's
    audience, and an ``expires_at`` ahead of ``now`` by no more than the bound.
    """
    if entry is None or not entry.operator or entry.expiry_hours is None:
        return NAMESPACE_UNREGISTERED
    if entry.status != NAMESPACE_ACTIVE:
        return NAMESPACE_RETIRED
    if any(field not in subject for field in entry.signed_fields):
        return SUBJECT_FIELD_MISSING
    if not _admits(entry, subject.get("actor_class")):
        return ACTOR_CLASS_REFUSED
    if subject.get("audience") != audience:
        return SUBJECT_AUDIENCE_MISMATCH
    expires = parse_utc(subject.get("expires_at"))
    if expires is None or expires > now + timedelta(hours=entry.expiry_hours):
        return SUBJECT_EXPIRY_INVALID
    if now >= expires:
        return SUBJECT_EXPIRED
    return None


def record_enrolment(
    *, repo_root: str | Path, signing_key: str | Path, signer_principal: str, actor_class: str,
    expires_in_hours: int, subject_stream: TextIO | None = None,
) -> dict[str, Any]:
    """Sign the checkout's edited allowed-signers file and registry as the child of the anchor's pair.

    The parent is the pair committed at the checkout's commit proven on
    main; the row is appended to the working tree's enrolment file, which
    must still be the committed one (one enrolment per change). Refused
    unless it verifies as the walk will verify it, with fresh terms.
    """
    from .operator_request_terms import utc_iso

    anchor, reason = allowed_signers_for_checkout(repo_root)
    if anchor is None:
        raise GovernanceError(f"operator_enrol_anchor_unavailable: {reason}")
    root = Path(repo_root)
    committed = {path: committed_blob(root, commit=anchor.commit, path=path)
                 for path in (NAMESPACE_REGISTRY_PATH, ENROLMENTS_PATH)}
    ledger = root / ENROLMENTS_PATH
    if (any(blob is None for blob in committed.values()) or not ledger.is_file()
            or ledger.read_bytes() != committed[ENROLMENTS_PATH].content):
        raise GovernanceError("operator_enrol_ledger_not_at_anchor")
    parent = (anchor.content, committed[NAMESPACE_REGISTRY_PATH].content)
    child = ((root / ALLOWED_SIGNERS_PATH).read_bytes(), (root / NAMESPACE_REGISTRY_PATH).read_bytes())
    if child == parent:
        raise GovernanceError("operator_enrol_unchanged")
    row = dict(enrolment_genesis_row(*child), kind="enrolment", parent=_pair(*parent), actor_class=actor_class,
               audience=anchor.audience)
    if _child(row) is None:
        raise GovernanceError("operator_enrol_child_registry_invalid")
    entry = anchor.namespaces[ENROL_NAMESPACE]
    now = datetime.now(timezone.utc).replace(microsecond=0)
    row["expires_at"] = utc_iso(now + timedelta(hours=expires_in_hours))
    signed = sign_operator_subject(row, namespace=ENROL_NAMESPACE, domain_tag=str(entry.domain_tag),
                                   signing_key=signing_key, signer_principal=signer_principal,
                                   subject_stream=subject_stream)
    refused = operator_act_terms_reason(signed, entry=entry, audience=anchor.audience, now=now) or \
        verify_operator_signature(signed, namespace=ENROL_NAMESPACE, allowed_signers=anchor.content,
                                  namespaces=anchor.namespaces).reason
    if refused is not None:
        raise GovernanceError(f"operator_enrol_refused: {refused}")
    line = json.dumps(signed, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    ledger.write_bytes(committed[ENROLMENTS_PATH].content + line.encode("ascii") + b"\n")
    return signed


__all__ = [
    "ACTOR_CLASS_REFUSED",
    "ALLOWED_SIGNERS_PATH",
    "ALLOWED_SIGNERS_UNAVAILABLE",
    "ENROLMENTS_PATH",
    "ENROLMENT_GENESIS",
    "ENROL_CHAIN_BROKEN",
    "ENROL_GENESIS_MISMATCH",
    "ENROL_SIGNATURE_INVALID",
    "ENROL_TIP_MISMATCH",
    "ENROL_NAMESPACE",
    "JOURNEY_NAMESPACE",
    "LABEL_NAMESPACE",
    "MAX_SIGNATURE_CHARS",
    "NAMESPACE_REGISTRY_INVALID",
    "NAMESPACE_REGISTRY_PATH",
    "NAMESPACE_RETIRED",
    "NAMESPACE_UNREGISTERED",
    "OPERATOR_ACTOR_CLASSES",
    "OPERATOR_NAMESPACES",
    "OPERATORS_POLICY_UNAVAILABLE",
    "REQUEST_DOMAIN_TAG",
    "REQUEST_ROW_SCHEMA_VERSION",
    "SIGNATURE_INVALID",
    "SIGNATURE_MALFORMED",
    "SIGNATURE_MISSING",
    "SIGNATURE_NAMESPACE",
    "SIGNER_NOT_ENROLLED",
    "SIGNER_PRINCIPAL_INVALID",
    "SIGNER_PRINCIPAL_MISSING",
    "SIGNING_DOMAIN",
    "SUBJECT_AUDIENCE_MISMATCH",
    "SUBJECT_EXPIRED",
    "SUBJECT_EXPIRY_INVALID",
    "SUBJECT_FIELD_MISSING",
    "VERIFICATION_REASONS",
    "VERIFICATION_TIMEOUT",
    "VERIFIER_UNAVAILABLE",
    "VERIFICATION_RUNNER_FAULTS",
    "AllowedSigners",
    "NamespaceEntry",
    "OperatorRequestVerdict",
    "allowed_signers_at",
    "appended_enrolments_reason",
    "allowed_signers_for_checkout",
    "enrolled_principals",
    "enrolment_genesis_row",
    "genesis_pinned",
    "record_enrolment",
    "operator_act_terms_reason",
    "parse_namespace_registry",
    "pre_merge_enrolment_reason",
    "request_signing_bytes",
    "request_subject_digest",
    "sign_operator_request",
    "sign_operator_subject",
    "subject_signing_bytes",
    "valid_principal",
    "verify_operator_request",
    "verify_enrolment_chain",
    "verify_operator_signature",
]
