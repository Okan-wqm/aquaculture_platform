"""The one table of credential shapes: how each family is detected, and how it is redacted.

WHY (ARIA-HIGH-519). Six modules each kept a copy of "what a credential
looks like", and the two that matter most drifted apart. The executor's
publication boundary (``artifact_safety``) redacted with this module's
patterns while the kernel refused with ``implementation_safety``'s, so five
families the refusal fires on passed the boundary untouched: private-key
headers AND bodies, the value assigned to ``aws_secret_access_key``,
``gho_``/``ghr_`` tokens and ``DATABASE_PASSWORD=``-style values. An executor
exit that released without submitting left those bytes on the published
surface, and no kernel check read them. Copying the refusal's regexes into the
scrubber would not have fixed it: its private-key and ``aws_secret_access_key``
rows match a header, so applied as redactors they leave the secret and silence
the refusal.

WHAT. ``CREDENTIAL_SHAPES`` holds one row per (family, detection shape). Each
row states both halves: ``detect`` is what a consumer that flags or refuses
matches; ``redact`` is the span that removes the secret material itself, not
a header. ``views`` names the consumers that read the row; each reads only its
view, through the accessors below:

* ``redact``: every scrubber. ``artifact_safety`` (executor envelopes,
  ``published_text`` for issue and state text) and ``scrub_text`` here
  (cross-review files, hooks' argv journal, progress previews) apply each
  row's ``redact`` in table order;
* ``refuse``: the kernel's refusal set, ``implementation_safety.SECRET_SCAN_PATTERNS``;
* ``dlp``: the readiness DLP scanner, ``readiness_proofs.DLP_PATTERNS``;
* ``harness``: rule 1 of ``tools/aria-poc/agent_harness_security_adapter.py``;
* ``system_one``: the Jev egress backstop, ``system_one._EXTRA_SECRET``;
* ``habitat``: the T2 probe's personal-token check, ``habitat._PERSONAL_TOKEN_RE``;
* ``vault``: the evidence vault's value redactor, ``security.vault._REDACT_VALUES``.

A family carries one row per distinct detection shape (the DLP scanner's AKIA
has word boundaries, the refusal set's has none), so each consumer keeps the
exact regexes it had; names are unique within a view.

HOW IT STAYS RIGHT. A wrong table cannot load. Each row is checked when it
is built: its ``detect`` matches its synthetic ``fixture``, and one match of
its ``redact`` spans the whole ``fixture_secret`` (a redaction that keeps even
one character of the value is refused, not just one that keeps all of it).
``validate_credential_table`` runs at import: the redact view, applied in
order by ``_redact_counted`` (the one loop every scrubber runs, with either
marker), leaves no refusal hit and no four-character run of the secret on the
fixture of any redact or refuse row. So for raw text, the publication
boundary covers the refusal set by construction.
``artifact_safety.write_sanitized_json`` still scans the bytes it writes:
JSON escaping can form a refusal hit the raw text did not hold (an escape such
as ``\\u00ea`` ends in ``a``), and a mapping key is never rewritten. Both are
refused, not written.

Order inside the redact view is load-bearing: the key block runs first so no
shorter row splits a PEM body, and specific families (``sk-ant-``, ``ghp_``)
precede their generic supersets (``generic_sk_key``, ``github_token_family``)
so a match is named by its most specific type.

Fixtures are assembled from parts, so the text of this file matches no
detection shape: the harness adapter scans ``aria_kernel/**``, and the DLP
proof and the kernel's diff scan read diffs that carry it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, Literal, get_args

CredentialView = Literal["redact", "refuse", "dlp", "harness", "system_one", "habitat", "vault"]
ShapeKind = Literal["credential", "pii"]
CREDENTIAL_VIEWS: Final[frozenset[str]] = frozenset(get_args(CredentialView))
SHAPE_KINDS: Final[frozenset[str]] = frozenset(get_args(ShapeKind))
# Views a consumer reads as ONE alternation of the rows' detect sources: the
# rows must carry no compile flags (scoped inline flags only), or the joined
# pattern would not mean what each row means.
_ALTERNATION_VIEWS: Final[frozenset[str]] = frozenset({"system_one", "habitat", "vault"})


class CredentialTableError(ValueError):
    """The credential table, or a request for one of its views, is malformed."""


@dataclass(frozen=True)
class CredentialShape:
    """One detection shape of one credential family; every field is required.

    ``fixture`` is a synthetic sample ``detect`` matches; ``fixture_secret`` is
    the part of it that must not survive ``redact``.
    """

    name: str
    kind: ShapeKind
    detect: re.Pattern[str]
    redact: re.Pattern[str]
    views: frozenset[str]
    fixture: str
    fixture_secret: str

    def __post_init__(self) -> None:
        problem = _row_problem(self)
        if problem is not None:
            raise CredentialTableError(f"credential_shape_invalid:{self.name}:{problem}")


def _row_problem(row: CredentialShape) -> str | None:
    if not re.fullmatch(r"[a-z][a-z0-9_]*", row.name):
        return "name"
    if row.kind not in SHAPE_KINDS:
        return "kind"
    if not row.views or not row.views <= CREDENTIAL_VIEWS:
        return "views"
    if row.views & _ALTERNATION_VIEWS and row.detect.flags & ~re.UNICODE:
        return "alternation_row_has_compile_flags"
    if not row.fixture_secret or row.fixture_secret not in row.fixture:
        return "fixture_secret_not_in_fixture"
    if row.detect.search(row.fixture) is None:
        return "detect_misses_fixture"
    if not _redact_spans_secret(row.redact, row.fixture, row.fixture_secret):
        return "redact_leaves_part_of_fixture_secret"
    return None


def _redact_spans_secret(redact: re.Pattern[str], text: str, secret: str) -> bool:
    """Whether every occurrence of ``secret`` in ``text`` lies inside ONE match of ``redact``.

    ``sub`` replaces exactly these matches, so this is the property "the
    redaction removes the whole value": a pattern that stops one character
    short, or that matches only a header, fails it.
    """
    spans = [match.span() for match in redact.finditer(text)]
    start = text.find(secret)
    while start != -1:
        end = start + len(secret)
        if not any(left <= start and end <= right for left, right in spans):
            return False
        start = text.find(secret, start + 1)
    return True


# The longest run of a secret that may survive the whole redact view. A run
# this short identifies nothing; one character longer is evidence a row
# stopped inside the value.
_SURVIVING_RUN: Final = 3


def _secret_run_survives(text: str, secret: str) -> bool:
    """Whether ``text`` still holds any run of ``secret`` longer than ``_SURVIVING_RUN`` characters."""
    width = min(len(secret), _SURVIVING_RUN + 1)
    return any(secret[index:index + width] in text for index in range(len(secret) - width + 1))


# ``redact=_DETECT`` says, per row, that the detect pattern already spans the
# whole secret, so the same pattern redacts it.
_DETECT: Final = object()


def _shape(
    name: str,
    kind: ShapeKind,
    views: frozenset[str],
    *,
    detect: str,
    redact: str | object,
    fixture: str,
    secret: str,
    redact_flags: int = 0,
) -> CredentialShape:
    detect_pattern = re.compile(detect)
    redact_pattern = detect_pattern if redact is _DETECT else re.compile(str(redact), redact_flags)
    return CredentialShape(
        name=name, kind=kind, detect=detect_pattern, redact=redact_pattern,
        views=views, fixture=fixture, fixture_secret=secret,
    )


# A whole PEM block, headers included, through its END line or, when the END
# line is missing, the end of the string (inside ``scrub_json`` that is the
# end of one string value, so the JSON stays valid). No backreference: Python
# fails a reference to a group that did not take part.
_PRIVATE_KEY_BLOCK: Final = (
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----.*?"
    r"(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\Z)"
)
_PEM_BODY: Final = "MIIE" + "U3ludGhldGljS2V5Qm9keQ" * 3


def _pem(label: str, *, newline: str = "\n") -> str:
    """A synthetic armoured block: header, body, footer."""
    return newline.join((f"-----BEGIN {label}-----", _PEM_BODY, f"-----END {label}-----"))


_REDACT_REFUSE: Final = frozenset({"redact", "refuse"})
_REDACT: Final = frozenset({"redact"})
_REFUSE: Final = frozenset({"refuse"})
_DLP: Final = frozenset({"dlp"})
_HARNESS: Final = frozenset({"harness"})
_SYSTEM_ONE: Final = frozenset({"system_one"})

CREDENTIAL_SHAPES: Final[tuple[CredentialShape, ...]] = (
    # --- the redact view, in application order; refuse rows ride with it ---
    _shape("private_key_block", "credential", _REDACT_REFUSE,
           detect=r"-----BEGIN (RSA|EC|OPENSSH|DSA) PRIVATE KEY-----",
           redact=_PRIVATE_KEY_BLOCK, redact_flags=re.DOTALL,
           fixture=_pem("RSA PRIVATE KEY"), secret=_PEM_BODY),
    # The literal is split so this file's text carries no key header.
    _shape("pgp_private_key_block", "credential", _REFUSE,
           detect="-----BEGIN PGP" r" PRIVATE KEY BLOCK-----",
           redact=_PRIVATE_KEY_BLOCK, redact_flags=re.DOTALL,
           fixture=_pem("PGP PRIVATE KEY BLOCK", newline="\\n"), secret=_PEM_BODY),
    _shape("aws_access_key", "credential", _REDACT_REFUSE,
           detect=r"AKIA[0-9A-Z]{16}", redact=_DETECT,
           fixture="id AKIA" + "Q7" * 8 + " end", secret="Q7" * 8),
    _shape("aws_secret_access_key", "credential", _REDACT_REFUSE,
           detect=r"aws_secret_access_key\s*[:=]",
           redact=r"aws_secret_access_key\s*[:=]\s*\S*",
           fixture="aws_secret_access_key" + " = " + "W9" * 20, secret="W9" * 20),
    _shape("github_pat", "credential", _REDACT,
           detect=r"ghp_[A-Za-z0-9]{36,}", redact=_DETECT,
           fixture="ghp" + "_" + "d4" * 18, secret="d4" * 18),
    _shape("github_pat_long", "credential", _REDACT_REFUSE,
           detect=r"github_pat_[A-Za-z0-9_]{50,}",
           redact=r"github_pat_[A-Za-z0-9_]{40,}",
           fixture="github_pat" + "_" + "e5" * 26, secret="e5" * 26),
    _shape("github_token_family", "credential", _REDACT_REFUSE,
           detect=r"gh[pousr]_[A-Za-z0-9]{36,}",
           redact=r"gh[pousr]_[A-Za-z0-9_]{20,}",
           fixture="gho" + "_" + "f6" * 18, secret="f6" * 18),
    _shape("github_app_installation_token", "credential", _REFUSE,
           detect=r"ghs_[A-Za-z0-9]{36,}",
           redact=r"ghs_[A-Za-z0-9_]{20,}",
           fixture="ghs" + "_" + "g7" * 18, secret="g7" * 18),
    _shape("anthropic_api_key", "credential", _REDACT_REFUSE,
           detect=r"sk-ant-[A-Za-z0-9-]{32,}",
           redact=r"sk-ant-[A-Za-z0-9_\-]{32,}",
           fixture="sk-ant" + "-api03-" + "h8" * 15, secret="h8" * 15),
    _shape("openai_api_key", "credential", _REDACT_REFUSE,
           detect=r"sk-[A-Za-z0-9]{32,}", redact=_DETECT,
           fixture="sk" + "-" + "i9" * 20, secret="i9" * 20),
    _shape("generic_sk_key", "credential", _REDACT,
           detect=r"sk-[A-Za-z0-9_-]{20,}", redact=_DETECT,
           fixture="sk" + "-proj_" + "j1" * 10, secret="j1" * 10),
    _shape("named_env_assignment", "credential", _REDACT,
           detect=(
               r"(?:OPENAI_API_KEY|CODEX_API_KEY|CLAUDE_CODE_OAUTH_TOKEN"
               r"|ANTHROPIC_API_KEY|ARIA_LEASE_TOKEN)=\S+"
           ),
           redact=_DETECT,
           fixture="ARIA_LEASE_TOKEN" + "=" + "k2" * 6, secret="k2" * 6),
    # The refusal pattern stops after 16 value characters; the redaction runs
    # to the end of the value token, so no tail of the secret survives.
    _shape("named_secret_assignment", "credential", _REDACT_REFUSE,
           detect=r"(JWT_SECRET|API_SECRET|DATABASE_PASSWORD)\s*[:=]\s*['\"]?[A-Za-z0-9+/=_-]{16,}",
           redact=r"(?:JWT_SECRET|API_SECRET|DATABASE_PASSWORD)\s*[:=]\s*['\"]?[A-Za-z0-9+/=_-]{16,}[^\s'\"]*",
           fixture="DATABASE_PASSWORD" + "=" + "Zq7" * 6 + "!x9", secret="Zq7" * 6 + "!x9"),
    _shape("bearer_token", "credential", _REDACT_REFUSE,
           detect=r"Bearer\s+[A-Za-z0-9_.-]{32,}",
           redact=r"Bearer\s+[A-Za-z0-9._\-]{20,}",
           fixture="Authorization: Bearer" + " " + "m3" * 20, secret="m3" * 20),
    _shape("basic_auth_password", "credential", _REDACT,
           detect=r"password\s*=\s*['\"][^'\"]{4,}['\"]", redact=_DETECT,
           fixture="password" + "='" + "n4" * 4 + "'", secret="n4" * 4),
    _shape("token_assignment", "credential", _REDACT,
           detect=r"token\s*=\s*['\"][^'\"]{8,}['\"]", redact=_DETECT,
           fixture="token" + '="' + "p5" * 5 + '"', secret="p5" * 5),
    _shape("ipv4_octet", "pii", _REDACT,
           detect=r"\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b",
           redact=_DETECT,
           fixture="host " + ".".join(("198", "51", "100", "23")), secret=".".join(("198", "51", "100", "23"))),
    _shape("email", "pii", _REDACT,
           detect=r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", redact=_DETECT,
           fixture="mail " + "ops" + "@" + "example.org", secret="ops" + "@" + "example.org"),
    # --- the readiness DLP scanner (names and order are its proof's) ---
    _shape("private_key_block", "credential", _DLP,
           detect=r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
           redact=_PRIVATE_KEY_BLOCK, redact_flags=re.DOTALL,
           fixture=_pem("EC PRIVATE KEY"), secret=_PEM_BODY),
    _shape("github_token", "credential", _DLP,
           detect=r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}", redact=_DETECT,
           fixture="ghu" + "_" + "q6" * 12, secret="q6" * 12),
    _shape("github_pat", "credential", _DLP,
           detect=r"\bgithub_pat_[A-Za-z0-9_]{20,}", redact=_DETECT,
           fixture="github_pat" + "_" + "r7" * 12, secret="r7" * 12),
    _shape("aws_access_key", "credential", frozenset({"dlp", "harness"}),
           detect=r"\bAKIA[0-9A-Z]{16}\b", redact=_DETECT,
           fixture="key AKIA" + "S8" * 8 + " end", secret="S8" * 8),
    _shape("stripe_live_key", "credential", _DLP,
           detect=r"\bsk_live_[A-Za-z0-9]{16,}", redact=_DETECT,
           fixture="sk_live" + "_" + "t9" * 10, secret="t9" * 10),
    _shape("slack_token", "credential", _DLP,
           detect=r"\bxox[baprs]-[A-Za-z0-9-]{10,}", redact=_DETECT,
           fixture="xoxb" + "-" + "u1" * 8, secret="u1" * 8),
    _shape("npm_auth_token", "credential", _DLP,
           detect=r"_authToken\s*=\s*\S+", redact=_DETECT,
           fixture="//registry.npmjs.org/:_authToken" + "=" + "v2" * 10, secret="v2" * 10),
    _shape("jwt_like", "credential", _DLP,
           detect=r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.",
           redact=r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*",
           fixture="eyJ" + "w3" * 6 + ".eyJ" + "x4" * 6 + "." + "y5" * 8, secret="y5" * 8),
    _shape("credential_assignment", "credential", _DLP,
           detect=r"(?i)\b(?:api[_-]?key|secret|password|token)\b\s*[:=]\s*['\"][^'\"\s]{16,}['\"]",
           redact=_DETECT,
           fixture="api_key" + ": '" + "z6" * 9 + "'", secret="z6" * 9),
    # --- rule 1 of the agent-harness security adapter (aws_access_key above) ---
    _shape("github_pat", "credential", _HARNESS,
           detect=r"\bghp_[A-Za-z0-9]{36,}\b", redact=_DETECT,
           fixture="ghp" + "_" + "a7" * 18, secret="a7" * 18),
    _shape("anthropic_api_key", "credential", _HARNESS,
           detect=r"\bsk-ant-(?:api|admin)?-?[A-Za-z0-9_\-]{20,}\b", redact=_DETECT,
           fixture="sk-ant" + "-admin-" + "b8" * 12, secret="b8" * 12),
    _shape("hardcoded_password", "credential", _HARNESS,
           detect=r"(?i)\bpassword\s*=\s*['\"][^'\"]{4,}", redact=_DETECT,
           fixture="PASSWORD" + ' = "' + "c9" * 4 + '"', secret="c9" * 4),
    _shape("hardcoded_token", "credential", _HARNESS,
           detect=r"(?i)\btoken\s*=\s*['\"][^'\"<{][^'\"]{4,}", redact=_DETECT,
           fixture="token" + " = '" + "d1" * 4 + "'", secret="d1" * 4),
    # --- the Jev egress backstop, read as one alternation in this order ---
    _shape("private_key_header", "credential", _SYSTEM_ONE,
           detect=r"-----BEGIN [A-Z ]*PRIVATE KEY",
           redact=_PRIVATE_KEY_BLOCK, redact_flags=re.DOTALL,
           fixture=_pem("DSA PRIVATE KEY"), secret=_PEM_BODY),
    _shape("jwt", "credential", _SYSTEM_ONE,
           detect=r"eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", redact=_DETECT,
           fixture="eyJ" + "e2" * 5 + ".eyJ" + "f3" * 5 + "." + "g4" * 5, secret="g4" * 5),
    _shape("stripe_key", "credential", _SYSTEM_ONE,
           detect=r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}", redact=_DETECT,
           fixture="rk_test" + "_" + "h5" * 9, secret="h5" * 9),
    _shape("stripe_webhook_secret", "credential", _SYSTEM_ONE,
           detect=r"\bwhsec_[A-Za-z0-9]{16,}", redact=_DETECT,
           fixture="whsec" + "_" + "i6" * 9, secret="i6" * 9),
    _shape("url_userinfo", "credential", _SYSTEM_ONE,
           detect=r"\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@", redact=_DETECT,
           fixture="https://" + "deploy:" + "j7" * 5 + "@" + "example.invalid/x", secret="j7" * 5),
    _shape("digitalocean_token", "credential", _SYSTEM_ONE,
           detect=r"\bdop_v1_[a-f0-9]{64}", redact=_DETECT,
           fixture="dop_v1" + "_" + "ab" * 32, secret="ab" * 32),
    _shape("sendgrid_key", "credential", _SYSTEM_ONE,
           detect=r"\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}", redact=_DETECT,
           fixture="SG" + "." + "k8" * 9 + "." + "l9" * 9, secret="l9" * 9),
    _shape("npm_token", "credential", _SYSTEM_ONE,
           detect=r"\bnpm_[A-Za-z0-9]{36}", redact=_DETECT,
           fixture="npm" + "_" + "m1" * 18, secret="m1" * 18),
    _shape("gitlab_pat", "credential", _SYSTEM_ONE,
           detect=r"\bglpat-[A-Za-z0-9_-]{20,}", redact=_DETECT,
           fixture="glpat" + "-" + "n2" * 11, secret="n2" * 11),
    _shape("google_api_key", "credential", _SYSTEM_ONE,
           detect=r"\bAIza[0-9A-Za-z_-]{35}", redact=_DETECT,
           fixture="AIza" + "o3" * 17 + "p", secret="o3" * 17 + "p"),
    _shape("slack_token", "credential", _SYSTEM_ONE,
           detect=r"\bxox[abposr]-[A-Za-z0-9-]{10,}", redact=_DETECT,
           fixture="xoxp" + "-" + "q4" * 7, secret="q4" * 7),
    _shape("slack_webhook", "credential", _SYSTEM_ONE,
           detect=r"hooks\.slack\.com/services/",
           redact=r"hooks\.slack\.com/services/[^\s'\"]*",
           fixture="https://hooks.slack.com/" + "services/" + "T0/B0/" + "r5" * 12, secret="r5" * 12),
    _shape("apikey_hex", "credential", _SYSTEM_ONE,
           detect=r"\bapikey_[0-9a-f]{20,}", redact=_DETECT,
           fixture="apikey" + "_" + "0f" * 11, secret="0f" * 11),
    _shape("aws_secret_in_context", "credential", _SYSTEM_ONE,
           detect=r"(?i:aws.{0,20}?(?:secret|access).{0,20}?[\"'=:\s][A-Za-z0-9/+=]{40}\b)", redact=_DETECT,
           fixture="AWS_SECRET_ACCESS_KEY" + "=" + "s6" * 20, secret="s6" * 20),
    _shape("password_quoted", "credential", _SYSTEM_ONE,
           detect=r"(?i:\bpass(?:word|wd)?\s*[:=]\s*[\"'][^\"'\s]{4,}[\"'])", redact=_DETECT,
           fixture="passwd" + ': "' + "t7" * 3 + '"', secret="t7" * 3),
    _shape("secret_env_line", "credential", _SYSTEM_ONE,
           detect=r"(?m:^[+\- \t]*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_?KEY)\s*[=:]\s*\S{6,})",
           redact=_DETECT,
           fixture="export STRIPE_API_KEY" + "=" + "u8" * 4, secret="u8" * 4),
    _shape("password_yaml_line", "credential", _SYSTEM_ONE,
           detect=(
               r"(?im:^[+\- \t]*[A-Za-z_]*pass(?:word|wd)?\s*:\s*"
               r"(?!string\b|number\b|boolean\b|undefined\b|null\b|any\b)[^\s'\"{(<|][^\s]{3,}\s*$)"
           ),
           redact=_DETECT,
           fixture="db_password" + ": " + "v9" * 4, secret="v9" * 4),
    # --- the T2 probe: a token that acts as a user account (ghs_ is T2's own) ---
    _shape("github_personal_token", "credential", frozenset({"habitat"}),
           detect=r"\b(?:ghp_|github_pat_|gho_|ghu_)[A-Za-z0-9_]{20,}", redact=_DETECT,
           fixture="gho" + "_" + "w1" * 11, secret="w1" * 11),
    # --- the evidence vault's value redactor, read as one alternation; each
    # row scopes the case-insensitive flag the vault applied to both ---
    _shape("bearer_value", "credential", frozenset({"vault"}),
           detect=r"(?i:\bbearer\s+\S+)", redact=_DETECT,
           fixture="authorization: " + "BEARER" + " " + "x2" * 6, secret="x2" * 6),
    _shape("jwt_value", "credential", frozenset({"vault"}),
           detect=r"(?i:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+)", redact=_DETECT,
           fixture="eyJ" + "y3" * 4 + "." + "z4" * 4 + "." + "a5" * 4, secret="a5" * 4),
)


# The uniform marker of the publication boundary; typed scrubbers write
# ``<REDACTED:{name}>`` instead.
UNIFORM_MARKER: Final = "<secret-redacted>"


def _redact_counted(rows: tuple[CredentialShape, ...], text: str, *, typed: bool) -> tuple[str, dict[str, int]]:
    """The one redaction loop: each row's ``redact`` in order; match counts per row name.

    The import-time proof and every scrubber (``redact_secrets``,
    ``scrub_text``, ``scrub_text_with_count``) run this function, so the
    proof covers the exact code the boundary runs.
    """
    counts: dict[str, int] = {}
    for row in rows:
        text, matched = row.redact.subn(f"<REDACTED:{row.name}>" if typed else UNIFORM_MARKER, text)
        if matched:
            counts[row.name] = matched
    return text, counts


def validate_credential_table(rows: tuple[CredentialShape, ...]) -> None:
    """Raise ``CredentialTableError`` unless ``rows`` form a usable table.

    Each view is non-empty with unique names, and the redact view, applied in
    order with either marker, leaves on the fixture of every redact or refuse
    row no refusal hit and no run of its secret longer than
    ``_SURVIVING_RUN`` characters (an earlier row that cuts into a later
    row's value is caught here, where each row alone looked whole).
    """
    for view in sorted(CREDENTIAL_VIEWS):
        names = [row.name for row in rows if view in row.views]
        if not names:
            raise CredentialTableError(f"credential_view_empty:{view}")
        duplicates = sorted({name for name in names if names.count(name) > 1})
        if duplicates:
            raise CredentialTableError(f"credential_view_duplicate_names:{view}:{','.join(duplicates)}")
    redact_rows = tuple(row for row in rows if "redact" in row.views)
    refuse_rows = tuple(row for row in rows if "refuse" in row.views)
    for row in tuple(row for row in rows if row.views & {"redact", "refuse"}):
        for typed in (False, True):
            out = _redact_counted(redact_rows, row.fixture, typed=typed)[0]
            if _secret_run_survives(out, row.fixture_secret):
                raise CredentialTableError(f"redact_view_leaves_secret:{row.name}")
            fired = sorted(other.name for other in refuse_rows if other.detect.search(out))
            if fired:
                raise CredentialTableError(f"redact_view_leaves_refusal_hit:{row.name}:{','.join(fired)}")


validate_credential_table(CREDENTIAL_SHAPES)


def shapes_in(view: str) -> tuple[CredentialShape, ...]:
    """The rows one consumer reads, in table order."""
    if view not in CREDENTIAL_VIEWS:
        raise CredentialTableError(f"credential_view_unknown:{view}")
    return tuple(row for row in CREDENTIAL_SHAPES if view in row.views)


def named_detectors(view: str) -> tuple[tuple[str, re.Pattern[str]], ...]:
    """``(name, detect)`` per row of ``view``: the shape a scanner reports by name."""
    return tuple((row.name, row.detect) for row in shapes_in(view))


def view_alternation(view: str) -> re.Pattern[str]:
    """The detect patterns of ``view`` as one alternation, in table order."""
    if view not in _ALTERNATION_VIEWS:
        raise CredentialTableError(f"credential_view_not_an_alternation:{view}")
    return re.compile("|".join(row.detect.pattern for row in shapes_in(view)))


def refusal_patterns() -> tuple[re.Pattern[str], ...]:
    """The kernel's refusal set: the refuse view's detect patterns."""
    return tuple(row.detect for row in shapes_in("refuse"))


def redact_secrets(text: str) -> str:
    """The publication boundary's redaction: the redact view in order, one uniform marker.

    ``artifact_safety.scrub_text`` runs this function; consumers that need the
    type names use ``scrub_text`` / ``scrub_text_with_count``.
    """
    return _redact_counted(shapes_in("redact"), text, typed=False)[0]


def credential_shapes_in(text: str) -> tuple[str, ...]:
    """Names of the redact view's credential rows (not its PII rows) that match ``text``.

    For text a writer never rewrites, such as a mapping key: the writer
    refuses it instead of publishing a credential the redaction would have
    removed from a value.
    """
    return tuple(row.name for row in shapes_in("redact") if row.kind == "credential" and row.redact.search(text))


def secret_pattern_types() -> tuple[str, ...]:
    """The redact view's type names, in application order."""
    return tuple(row.name for row in shapes_in("redact"))


def pii_shape_names() -> frozenset[str]:
    """Redact-view types that are personal data, not credentials."""
    return frozenset(row.name for row in shapes_in("redact") if row.kind == "pii")


def scrub_text(text: str) -> tuple[str, list[str]]:
    """Redact secrets in ``text``; return ``(scrubbed, redaction_types)``.

    redaction_types preserves match order and is suitable for emitting
    as a governance event payload. The raw matched strings are NEVER
    in the returned types list — only the type name.
    """
    if not isinstance(text, str) or not text:
        return text, []
    scrubbed, counts = _redact_counted(shapes_in("redact"), text, typed=True)
    return scrubbed, list(counts)


def scrub_text_with_count(text: str) -> tuple[str, dict[str, int]]:
    """Variant: returns ``{pattern_type: match_count}`` instead of list.

    Useful for governance event payloads that prefer histogram shape.
    """
    if not isinstance(text, str) or not text:
        return text, {}
    return _redact_counted(shapes_in("redact"), text, typed=True)
