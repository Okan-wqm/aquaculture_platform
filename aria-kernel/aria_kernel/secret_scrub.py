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
fixture of EVERY credential row, whichever view detects it, and on a token of
every prefix in ``GITHUB_TOKEN_CLASSES``. So for raw text, the publication
boundary removes every credential any consumer detects by construction
(ARIA-MEDIUM-546: the proof had covered only the redact and refuse rows, and
24 rows that the dlp, harness, ``system_one`` and vault views detect, Stripe,
SendGrid, DigitalOcean, Google, Slack, npm and GitLab tokens, JWTs and
password lines among them, left the boundary unredacted). A detect-view row
joins the redact view when its ``redact`` is the family's redactor; a row whose
family another redact row already removes stays out of it. The negative half
of the proof is ``REFERENCE_SHAPES``: what a finding or a record cites (a
path:line, a digest, a fingerprint, a commit, a diagnostic) comes out of the
redact view unchanged, so no row redacts by over-reach.
``artifact_safety.write_sanitized_json`` still scans the bytes it writes:
JSON escaping can form a refusal hit the raw text did not hold (an escape such
as ``\\u00ea`` ends in ``a``), and a mapping key is never rewritten. Both are
refused, not written.

Order inside the redact view is load-bearing: the key block runs first so no
shorter row splits a PEM body, specific families (``sk-ant-``, ``ghp_``)
precede their generic supersets (``generic_sk_key``, ``github_token_family``)
so a match is named by its most specific type, and the personal-data rows run
last so a credential that holds an ``@`` (a URL's password) is named as one.

Fixtures are assembled from parts, so the text of this file matches no
detection shape: the harness adapter scans ``aria_kernel/**``, and the DLP
proof and the kernel's diff scan read diffs that carry it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Final, Literal, get_args

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


# GitHub's token format (2021): the prefix names the credential's class. Every
# class but the installation token's (``ghs_``) acts as a user account; a
# refresh token (``ghr_``) is exchanged for a user-to-server token. The one
# list: ``github_writes`` classifies a write's credential by it, the habitat
# view flags its user-acting prefixes, and the table proves the redact view
# removes a token of each.
GITHUB_INSTALLATION_TOKEN_CLASS: Final = "installation"
GITHUB_TOKEN_CLASSES: Final[tuple[tuple[str, str], ...]] = (
    ("ghs_", GITHUB_INSTALLATION_TOKEN_CLASS),
    ("ghp_", "personal_access_token"),
    ("github_pat_", "fine_grained_personal_access_token"),
    ("gho_", "oauth_user_token"),
    ("ghu_", "user_to_server_token"),
    ("ghr_", "refresh_token"),
)
_GITHUB_USER_TOKEN: Final = (
    r"\b(?:"
    + "|".join(re.escape(prefix) for prefix, token_class in GITHUB_TOKEN_CLASSES
               if token_class != GITHUB_INSTALLATION_TOKEN_CLASS)
    + r")[A-Za-z0-9_]{20,}"
)
_GITHUB_TOKEN_BODY: Final = "Gt5" * 12

# A vendor key prefix starts a token: ``sk-`` inside a word (``task-``,
# ``risk-``, ``disk-`` followed by a long id) is not a key. Without this
# boundary the sk- rows redacted 304 task and risk ids on aria/state.
_KEY_START: Final = r"(?<![A-Za-z0-9])"

_REDACT_REFUSE: Final = frozenset({"redact", "refuse"})
_REDACT: Final = frozenset({"redact"})
_REFUSE: Final = frozenset({"refuse"})
_DLP: Final = frozenset({"dlp"})
_DLP_REDACT: Final = frozenset({"dlp", "redact"})
_HARNESS: Final = frozenset({"harness"})
_HARNESS_REDACT: Final = frozenset({"harness", "redact"})
_SYSTEM_ONE: Final = frozenset({"system_one"})
_SYSTEM_ONE_REDACT: Final = frozenset({"system_one", "redact"})
# The value of a secret assignment: quoted (spaces included), or one bare
# token. A value that starts with ``$`` or ``<`` is a variable reference, a
# placeholder or an earlier redaction marker, not a secret, and stays.
# The value is a named group, so the one redaction loop replaces the value
# alone and keeps the name, its quotes and the delimiter: a quoted JSON or
# compose value stays parseable after redaction. A bare JSON literal (true,
# false, null) is no secret: an env-presence probe prints
# ``"GH_TOKEN": false``. A bare number still is (a PIN), and a bare value
# still runs to the next space or quote, because a secret may contain ``,``
# or ``}``, and stopping there would publish its tail.
_ASSIGNED_VALUE: Final = (
    r"""(?:"(?![$<])(?P<value>[^"\n]+)"|'(?![$<])(?P<value_sq>[^'\n]+)'"""
    r"""|(?![$<"'])(?!(?:true|false|null)(?:[\s,}\]]|$))(?P<value_bare>[^\s"']+))"""
)
# The group names a row's ``redact`` may use to confine its replacement.
_VALUE_GROUPS: Final[tuple[str, ...]] = ("value", "value_sq", "value_bare")
# An environment-style name that ends in a secret word: the words the
# system_one view knows, and the key and pass-phrase names an env file, a
# compose file or a CI secret carries (``JWT_PRIVATE_KEY``,
# ``STRIPE_SECRET_KEY``, ``SMTP_PASS``; ARIA-HIGH-448). A name merely holding
# the word (``MAX_TOKENS``, ``TOKEN_BUDGET``, ``BYPASS``) is no secret.
_SECRET_NAME: Final = (
    r"(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|(?:SECRET|PRIVATE|ACCESS)_?KEY)"
    r"|[A-Z0-9_]*_PASS)"
)
# Mapping keys whose string value is a credential (``artifact_safety.scrub_json``
# masks it whatever its shape): a key naming a token, a secret, an API key, a
# password or a private key. A number under such a key is a counter and stays.
CREDENTIAL_KEY_WORDS: Final[tuple[str, ...]] = (
    "token", "secret", "api_key", "apikey", "password", "passwd", "passphrase", "private_key",
)

CREDENTIAL_SHAPES: Final[tuple[CredentialShape, ...]] = (
    # --- the redact view, in application order (table order across every
    # section below); refuse rows ride with it ---
    # The refusal matches any armour label the boundary's own block redactor
    # removes ([A-Z ]*: ENCRYPTED and plain pkcs8 included), not four named
    # ones — what the boundary redacts, the kernel refuses.
    _shape("private_key_block", "credential", _REDACT_REFUSE,
           detect=r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
           redact=_PRIVATE_KEY_BLOCK, redact_flags=re.DOTALL,
           fixture=_pem("ENCRYPTED PRIVATE KEY"), secret=_PEM_BODY),
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
    # The refusal fires on 50+ characters; the redaction removes the 20+ the
    # dlp and habitat views detect.
    _shape("github_pat_long", "credential", _REDACT_REFUSE,
           detect=r"github_pat_[A-Za-z0-9_]{50,}",
           redact=r"github_pat_[A-Za-z0-9_]{20,}",
           fixture="github_pat" + "_" + "e5" * 26, secret="e5" * 26),
    _shape("github_token_family", "credential", _REDACT_REFUSE,
           detect=r"gh[pousr]_[A-Za-z0-9]{36,}",
           redact=r"gh[pousr]_[A-Za-z0-9_]{20,}",
           fixture="gho" + "_" + "f6" * 18, secret="f6" * 18),
    _shape("github_app_installation_token", "credential", _REFUSE,
           detect=r"ghs_[A-Za-z0-9]{36,}",
           redact=r"ghs_[A-Za-z0-9_]{20,}",
           fixture="ghs" + "_" + "g7" * 18, secret="g7" * 18),
    # ARIA-MEDIUM-620 — the body is base64url (every `claude setup-token` /
    # OAuth token), so '_' sits inside the first 32 characters as often as
    # not: the refusal admits it, exactly as the redaction always has.
    _shape("anthropic_api_key", "credential", _REDACT_REFUSE,
           detect=_KEY_START + r"sk-ant-[A-Za-z0-9_\-]{32,}",
           redact=_KEY_START + r"sk-ant-[A-Za-z0-9_\-]{32,}",
           fixture="sk-ant" + "-oat01-" + "h8" * 4 + "_" + "h8" * 10, secret="h8" * 4 + "_" + "h8" * 10),
    _shape("openai_api_key", "credential", _REDACT_REFUSE,
           detect=_KEY_START + r"sk-[A-Za-z0-9]{32,}", redact=_DETECT,
           fixture="sk" + "-" + "i9" * 20, secret="i9" * 20),
    _shape("generic_sk_key", "credential", _REDACT,
           detect=_KEY_START + r"sk-[A-Za-z0-9_-]{20,}", redact=_DETECT,
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
    # The redaction reads the scheme in any case, as the vault does, and takes
    # a token of 20+ characters or one of 8+ that holds a digit: a credential,
    # never the word after "bearer" in prose.
    # The refusal reads the scheme in any case and the standard-base64
    # alphabet exactly as the redaction does; its 32+ floor stays the refuse
    # side's own — a credential, never the word after "bearer" in prose.
    _shape("bearer_token", "credential", _REDACT_REFUSE,
           detect=r"(?i:bearer)\s+[A-Za-z0-9._~+/\-]{32,}=*",
           redact=(
               r"(?i:bearer)\s+(?:[A-Za-z0-9._~+/\-]{20,}"
               r"|(?=[A-Za-z._~+/\-]*[0-9])[A-Za-z0-9._~+/\-]{8,})=*"
           ),
           fixture="authorization: bearer" + " " + "m3+" * 12 + "/Q", secret="m3+" * 12 + "/Q"),
    _shape("basic_auth_password", "credential", _REDACT,
           detect=r"password\s*=\s*['\"][^'\"]{4,}['\"]", redact=_DETECT,
           fixture="password" + "='" + "n4" * 4 + "'", secret="n4" * 4),
    _shape("token_assignment", "credential", _REDACT,
           detect=r"token\s*=\s*['\"][^'\"]{8,}['\"]", redact=_DETECT,
           fixture="token" + '="' + "p5" * 5 + '"', secret="p5" * 5),
    # --- the readiness DLP scanner (names and order are its proof's); a row
    # whose family no redact row above removes joins the redact view ---
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
    _shape("npm_auth_token", "credential", _DLP_REDACT,
           detect=r"_authToken\s*=\s*\S+", redact=_DETECT,
           fixture="//registry.npmjs.org/:_authToken" + "=" + "v2" * 10, secret="v2" * 10),
    _shape("jwt_like", "credential", _DLP,
           detect=r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.",
           redact=r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*",
           fixture="eyJ" + "w3" * 6 + ".eyJ" + "x4" * 6 + "." + "y5" * 8, secret="y5" * 8),
    _shape("credential_assignment", "credential", _DLP_REDACT,
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
    _shape("hardcoded_password", "credential", _HARNESS_REDACT,
           detect=r"(?i)\bpassword\s*=\s*['\"][^'\"]{4,}",
           redact=r"(?i)\bpassword\s*=\s*['\"][^'\"]{4,}['\"]?",
           fixture="PASSWORD" + ' = "' + "c9" * 4 + '"', secret="c9" * 4),
    _shape("hardcoded_token", "credential", _HARNESS,
           detect=r"(?i)\btoken\s*=\s*['\"][^'\"<{][^'\"]{4,}", redact=_DETECT,
           fixture="token" + " = '" + "d1" * 4 + "'", secret="d1" * 4),
    # --- the Jev egress backstop, read as one alternation in this order; a
    # row whose family no redact row above removes joins the redact view ---
    _shape("private_key_header", "credential", _SYSTEM_ONE,
           detect=r"-----BEGIN [A-Z ]*PRIVATE KEY",
           redact=_PRIVATE_KEY_BLOCK, redact_flags=re.DOTALL,
           fixture=_pem("DSA PRIVATE KEY"), secret=_PEM_BODY),
    _shape("jwt", "credential", _SYSTEM_ONE,
           detect=r"eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", redact=_DETECT,
           fixture="eyJ" + "e2" * 5 + ".eyJ" + "f3" * 5 + "." + "g4" * 5, secret="g4" * 5),
    _shape("stripe_key", "credential", _SYSTEM_ONE_REDACT,
           detect=r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}", redact=_DETECT,
           fixture="rk_test" + "_" + "h5" * 9, secret="h5" * 9),
    _shape("stripe_webhook_secret", "credential", _SYSTEM_ONE_REDACT,
           detect=r"\bwhsec_[A-Za-z0-9]{16,}", redact=_DETECT,
           fixture="whsec" + "_" + "i6" * 9, secret="i6" * 9),
    # The redaction also takes an empty user name (``redis://:password@``,
    # ARIA-HIGH-448), which the detection does not.
    _shape("url_userinfo", "credential", _SYSTEM_ONE_REDACT,
           detect=r"\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@",
           redact=r"\b[a-z][a-z0-9+.-]*://[^\s/:@]*:[^\s/@]+@",
           fixture="https://" + "deploy:" + "j7" * 5 + "@" + "example.invalid/x", secret="j7" * 5),
    _shape("digitalocean_token", "credential", _SYSTEM_ONE_REDACT,
           detect=r"\bdop_v1_[a-f0-9]{64}", redact=_DETECT,
           fixture="dop_v1" + "_" + "ab" * 32, secret="ab" * 32),
    _shape("sendgrid_key", "credential", _SYSTEM_ONE_REDACT,
           detect=r"\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}", redact=_DETECT,
           fixture="SG" + "." + "k8" * 9 + "." + "l9" * 9, secret="l9" * 9),
    _shape("npm_token", "credential", _SYSTEM_ONE_REDACT,
           detect=r"\bnpm_[A-Za-z0-9]{36}", redact=_DETECT,
           fixture="npm" + "_" + "m1" * 18, secret="m1" * 18),
    _shape("gitlab_pat", "credential", _SYSTEM_ONE_REDACT,
           detect=r"\bglpat-[A-Za-z0-9_-]{20,}", redact=_DETECT,
           fixture="glpat" + "-" + "n2" * 11, secret="n2" * 11),
    _shape("google_api_key", "credential", _SYSTEM_ONE_REDACT,
           detect=r"\bAIza[0-9A-Za-z_-]{35}", redact=_DETECT,
           fixture="AIza" + "o3" * 17 + "p", secret="o3" * 17 + "p"),
    _shape("slack_token", "credential", _SYSTEM_ONE_REDACT,
           detect=r"\bxox[abposr]-[A-Za-z0-9-]{10,}", redact=_DETECT,
           fixture="xoxp" + "-" + "q4" * 7, secret="q4" * 7),
    _shape("slack_webhook", "credential", _SYSTEM_ONE_REDACT,
           detect=r"hooks\.slack\.com/services/",
           redact=r"hooks\.slack\.com/services/[^\s'\"]*",
           fixture="https://hooks.slack.com/" + "services/" + "T0/B0/" + "r5" * 12, secret="r5" * 12),
    _shape("apikey_hex", "credential", _SYSTEM_ONE_REDACT,
           detect=r"\bapikey_[0-9a-f]{20,}", redact=_DETECT,
           fixture="apikey" + "_" + "0f" * 11, secret="0f" * 11),
    _shape("aws_secret_in_context", "credential", _SYSTEM_ONE_REDACT,
           detect=r"(?i:aws.{0,20}?(?:secret|access).{0,20}?[\"'=:\s][A-Za-z0-9/+=]{40}\b)", redact=_DETECT,
           fixture="AWS_SECRET_ACCESS_KEY" + "=" + "s6" * 20, secret="s6" * 20),
    _shape("password_quoted", "credential", _SYSTEM_ONE_REDACT,
           detect=r"(?i:\bpass(?:word|wd)?\s*[:=]\s*[\"'][^\"'\s]{4,}[\"'])", redact=_DETECT,
           fixture="passwd" + ': "' + "t7" * 3 + '"', secret="t7" * 3),
    _shape("secret_env_line", "credential", _SYSTEM_ONE,
           detect=r"(?m:^[+\- \t]*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_?KEY)\s*[=:]\s*\S{6,})",
           redact=_DETECT,
           fixture="export STRIPE_API_KEY" + "=" + "u8" * 4, secret="u8" * 4),
    _shape("password_yaml_line", "credential", _SYSTEM_ONE_REDACT,
           detect=(
               r"(?im:^[+\- \t]*[A-Za-z_]*pass(?:word|wd)?\s*:\s*"
               r"(?!string\b|number\b|boolean\b|undefined\b|null\b|any\b)[^\s'\"{(<|][^\s]{3,}\s*$)"
           ),
           redact=_DETECT,
           fixture="db_password" + ": " + "v9" * 4, secret="v9" * 4),
    # --- the T2 probe: a token that acts as a user account (ghs_ is T2's own),
    # every user-acting prefix of GITHUB_TOKEN_CLASSES ---
    _shape("github_personal_token", "credential", frozenset({"habitat"}),
           detect=_GITHUB_USER_TOKEN, redact=_DETECT,
           fixture="gho" + "_" + "w1" * 11, secret="w1" * 11),
    # --- the evidence vault's value redactor, read as one alternation; each
    # row scopes the case-insensitive flag the vault applied to both ---
    _shape("bearer_value", "credential", frozenset({"vault"}),
           detect=r"(?i:\bbearer\s+\S+)", redact=_DETECT,
           fixture="authorization: " + "BEARER" + " " + "x2" * 6, secret="x2" * 6),
    # The redact view's JWT row: one dot after the header is enough, so it
    # removes the dlp, system_one and vault shapes alike.
    _shape("jwt_value", "credential", frozenset({"vault", "redact"}),
           detect=r"(?i:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+)", redact=_DETECT,
           fixture="eyJ" + "y3" * 4 + "." + "z4" * 4 + "." + "a5" * 4, secret="a5" * 4),
    # --- the redact view's catch-all, after every specific family: a secret
    # assigned to an environment-style name, wherever it sits (an env file, a
    # ``cat -n`` listing, ``docker run -e``, a compose or JSON key). It removes
    # the system_one view's line-anchored secret_env_line and its quoted
    # values whole. No consumer reads its detect, which needs only to anchor
    # the fixture (and so leaves source text such as ``NAME=" + x`` alone). ---
    _shape("secret_assignment", "credential", _REDACT,
           detect=_SECRET_NAME + r"[ \t]*[=:][ \t]*[A-Za-z0-9]{6,}",
           redact=_SECRET_NAME + r"[\"']?[ \t]*[=:][ \t]*" + _ASSIGNED_VALUE,
           fixture="env " + "DB_PASSWORD" + "=" + "Qm4" * 4, secret="Qm4" * 4),
    # A lower-case parameter: a libpq DSN, a CLI flag, a URL query
    # (``password=``, ``--password=``, ``?access_token=``; ARIA-HIGH-448).
    # ``=`` with no space, so ``password = hashPassword(x)`` in code stays; a
    # token-like name needs a value of 8+ so a diagnostic code stays.
    _shape("password_parameter", "credential", _REDACT,
           detect=r"(?i:\b[a-z0-9_.-]*pass(?:word|wd)=[A-Za-z0-9]{6,})",
           redact=r"(?i:\b[a-z0-9_.-]*pass(?:word|wd))=" + _ASSIGNED_VALUE,
           fixture="host=db " + "pass" + "word=" + "Rt5" * 4 + " dbname=x", secret="Rt5" * 4),
    _shape("credential_parameter", "credential", _REDACT,
           detect=r"(?i:\b[a-z0-9_.-]*(?:secret|token|api_?key|access_?key)=[A-Za-z0-9]{8,})",
           redact=r"(?i:\b[a-z0-9_.-]*(?:secret|token|api_?key|access_?key))=(?![$<])[^\s&'\"]{8,}",
           fixture="GET /cb?state=1&access_" + "token=" + "Wp6" * 4 + "&x=2", secret="Wp6" * 4),
    # --- personal data, redacted last so a credential holding an "@" is named as one ---
    _shape("ipv4_octet", "pii", _REDACT,
           detect=r"\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b",
           redact=_DETECT,
           fixture="host " + ".".join(("198", "51", "100", "23")), secret=".".join(("198", "51", "100", "23"))),
    _shape("email", "pii", _REDACT,
           detect=r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", redact=_DETECT,
           fixture="mail " + "ops" + "@" + "example.org", secret="ops" + "@" + "example.org"),
)


# The uniform marker of the publication boundary; typed scrubbers write
# ``<REDACTED:{name}>`` instead.
UNIFORM_MARKER: Final = "<secret-redacted>"


def _value_only(marker: str, groups: list[str]) -> Callable[[re.Match[str]], str]:
    """A replacement that swaps only the matched value group for ``marker``."""
    def replace(match: re.Match[str]) -> str:
        for name in groups:
            if match.group(name) is not None:
                start, end = match.span(name)
                whole, base = match.group(0), match.start()
                return whole[:start - base] + marker + whole[end - base:]
        return marker
    return replace


def _redact_counted(rows: tuple[CredentialShape, ...], text: str, *, typed: bool) -> tuple[str, dict[str, int]]:
    """The one redaction loop: each row's ``redact`` in order; match counts per row name.

    The import-time proof and every scrubber (``redact_secrets``,
    ``scrub_text``, ``scrub_text_with_count``) run this function, so the
    proof covers the exact code the boundary runs.
    """
    counts: dict[str, int] = {}
    for row in rows:
        marker = f"<REDACTED:{row.name}>" if typed else UNIFORM_MARKER
        groups = [name for name in _VALUE_GROUPS if name in row.redact.groupindex]
        text, matched = row.redact.subn(_value_only(marker, groups) if groups else marker, text)
        if matched:
            counts[row.name] = matched
    return text, counts


# What a finding, an envelope or a record cites, which the redact view must
# leave exactly as written: the negative fixtures of the proof. A row that
# reaches past a credential into one of these cannot load. Phrases a detect
# view would flag are assembled from parts, like the fixtures.
REFERENCE_SHAPES: Final[tuple[str, ...]] = (
    "apps/x.ts:12",
    "aria-kernel/aria_kernel/cost_budget" + ".py:263-267",
    "0123456789abcdef" * 4,
    # A cited digest, written out whole: this module is a standard-library
    # leaf the harness adapter loads alone (no package, so no `.digest`), and
    # a whole literal composes no label (the digest owner's pin, ARIA-LOW-517).
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "SHA256:" + "U3ludGhldGljRmluZ2VycHJpbnRGb3JBVGVzdE9ubHkx"[:43],
    "commit 99689e46b8f1d3c1e4a5b6c7d8e9f0a1b2c3d4e5",
    "integrity sha512-" + "U3ludGhldGljSW50ZWdyaXR5" * 3 + "==",
    "run 123e4567-e89b-12d3-a456-426614174000 at 2026-10-16T09:45:00Z",
    "ARIA-MEDIUM-546 PR#1756",
    "github_write_requires_installation_token:absent",
    "usage input_tokens=48213 output_tokens=1921 CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000",
    "ARIA_TOKEN_BUDGET=1000 token_budget=1000",
    "the gateway accepts a " + "bear" + "er token without a scope check",
    "Authorization: " + "Bear" + "er <token>",
    "GH_TOKEN: " + "${{ github.token }}",
    "GH_TOKEN=" + UNIFORM_MARKER + " gh pr list",
    "token <REDACTED:github_pat> end",
    "PASSWORD=$DB_PASSWORD SECRET=${JWT_SECRET} TOKEN=<value>",
    "psql --password-file=/run/secrets/db -h db",
    "https://example.org:8443/path?q=1",
    "password = hashPassword(input)",
    "resolve_token=absent",
    # A JSON record naming secret-shaped environment variables with values
    # that cannot be secrets (booleans, null): the env-presence probe of a
    # validation log. ARIA-MEDIUM-546's assignment rows once replaced each
    # name with its value here, and the record no longer parsed.
    '{"GH_TOKEN": false, "PROBE_SECRET_TOKEN": null, "DB_PASSWORD": true}',
    # Hyphenated ids whose word ends in "sk": a task, risk or disk slug
    # followed by a long id. A key prefix starts a token; 304 such ids on
    # aria/state were redacted as keys before the sk- rows got their left
    # boundary.
    "follow-up for task-" + "0123456789abcdefghij0123456789ab" + " done",
    "risk-" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7",
)


def validate_credential_table(rows: tuple[CredentialShape, ...]) -> None:
    """Raise ``CredentialTableError`` unless ``rows`` form a usable table.

    Each view is non-empty with unique names. The redact view, applied in
    order with either marker, leaves on the fixture of every credential row,
    whichever view detects it, and of every redact or refuse row, no refusal
    hit and no run of its secret longer than ``_SURVIVING_RUN`` characters (an
    earlier row that cuts into a later row's value is caught here, where each
    row alone looked whole); it leaves no such run of a token of any
    ``GITHUB_TOKEN_CLASSES`` prefix; and it leaves every ``REFERENCE_SHAPES``
    text unchanged.
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
    for row in tuple(row for row in rows if row.kind == "credential" or row.views & {"redact", "refuse"}):
        for typed in (False, True):
            out = _redact_counted(redact_rows, row.fixture, typed=typed)[0]
            if _secret_run_survives(out, row.fixture_secret):
                raise CredentialTableError(f"redact_view_leaves_secret:{row.name}")
            fired = sorted(other.name for other in refuse_rows if other.detect.search(out))
            if fired:
                raise CredentialTableError(f"redact_view_leaves_refusal_hit:{row.name}:{','.join(fired)}")
    for prefix, _token_class in GITHUB_TOKEN_CLASSES:
        for typed in (False, True):
            out = _redact_counted(redact_rows, f"token {prefix}{_GITHUB_TOKEN_BODY} end", typed=typed)[0]
            if _secret_run_survives(out, _GITHUB_TOKEN_BODY):
                raise CredentialTableError(f"redact_view_leaves_github_token:{prefix}")
    for index, text in enumerate(REFERENCE_SHAPES):
        for typed in (False, True):
            out, counts = _redact_counted(redact_rows, text, typed=typed)
            if out != text:
                raise CredentialTableError(f"redact_view_rewrites_reference:{index}:{','.join(counts)}")


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


def is_armoured_private_key(text: str) -> bool:
    """True when ``text`` is one armoured private key: BEGIN line, body, matching END line.

    The App-key token broker's input check. The BEGIN line is the refuse
    view's ``private_key_block`` row, read here rather than restated by the
    caller (ARIA-HIGH-519: one credential table); the END line must close the
    label the BEGIN line opened.
    """
    lines = text.strip().splitlines()
    if len(lines) < 3:
        return False
    begin, end = lines[0].strip(), lines[-1].strip()
    row = next(row for row in shapes_in("refuse") if row.name == "private_key_block")
    opener = "-----BEGIN "
    return (
        row.detect.fullmatch(begin) is not None
        and end == "-----END " + begin[len(opener):]
    )


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
