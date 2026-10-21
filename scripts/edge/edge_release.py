#!/usr/bin/env python3
"""Plan, package, state, sign and verify edge agent releases (ADR-048).

Every build row of the release workflow (.github/workflows/edge-agent-release.yml)
and of the profile CI (.github/workflows/ci-edge.yml) comes from `plan`, which
derives it from the cross-repo contract (contracts/suderra-edge/v1: boards.json,
artifact-naming.json, statements.json, schemas/) and the agent's release facts
(sens-api-gateway/release/edge-release.toml). No workflow names a board, target,
feature or artifact of its own.

Subcommands, in pipeline order:

  plan        build and test matrices for both channels (DEC-8.5, DEC-28)
  package     one deterministic tarball holding exactly the contract's member,
              after the ELF machine, interpreter, NEEDED and glibc symbol
              version check (DEC-8.5)
  provenance  the in-toto SLSA provenance statement of every planned artifact,
              from the artifact bytes, in the signing job (DEC-3.8, DEC-20)
  statements  the unsigned suderra.edge-release.v1 payload of every Suderra OS
              artifact, over the digests recomputed from the artifact bytes
  sign        the DSSE envelope of every payload with the edge-release key
              (DEC-3.9, DEC-20); the key comes from an environment variable
  verify      every planned envelope against its artifact, the public key and
              the contract, in the statements.json verification_order, with
              verify_strict semantics; the payload must be byte for byte the
              statement this release produces
  check-envelope  the key-free checks of one envelope (schema, profile)
  signature-vectors  the Ed25519 verifier over fixtures/dsse/signature-vectors.json
  notes       the GitHub release body: what each channel ships, which boards
              are not built and why
  manifest    the machine-readable index of every published file

The tool needs only the Python 3.11+ standard library and, for `sign` alone,
the OpenSSL 3 CLI (Ed25519 -rawin), so the signing job installs nothing.
Signatures are verified by this file's own Ed25519 verifier, which implements
the contract's verify_strict semantics (statements.json
dsse.signature_algorithm); OpenSSL's verifier is not conforming.

Its JSON Schema check is a fail-closed subset validator over the contract's
own schema files: a keyword it does not implement is an error, never a pass.
tests/invariants/edge-release-pipeline.spec.ts cross-checks its output with Ajv
and Node's Ed25519.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import gzip
import hashlib
import io
import json
import os
import re
import struct
import subprocess
import sys
import tarfile
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

if sys.version_info < (3, 11):  # noqa: UP036 - a clear refusal instead of an ImportError of tomllib
    sys.stderr.write("edge_release: Python 3.11 or newer is required\n")
    sys.exit(2)

import tomllib  # noqa: E402  (after the version gate)

REPO = Path(__file__).resolve().parents[2]
CONTRACT = REPO / "contracts" / "suderra-edge" / "v1"
DEFAULT_FACTS = REPO / "sens-api-gateway" / "release" / "edge-release.toml"
DEFAULT_CARGO_TOML = REPO / "sens-api-gateway" / "Cargo.toml"

# The one statement type this tool produces and verifies (statements.json:
# every call site pins exactly one statement type).
STATEMENT_TYPE = "suderra.edge-release.v1"
CHANNEL_OS = "suderra-os"
CHANNEL_GENERIC = "generic"

PAYLOAD_SUFFIX = ".release.payload.json"
PUBLIC_KEY_FILE = "edge-release.pub"

# RFC 8410 SubjectPublicKeyInfo prefix of a raw Ed25519 public key.
ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")
MAX_SAFE_INTEGER = 9007199254740991
# A release binary larger than this is not an agent build.
MAX_BINARY_BYTES = 512 * 1024 * 1024

ELF_MACHINE = {"x86_64": 62, "aarch64": 183, "armv7": 40}
ELF_CLASS = {"x86_64": 2, "aarch64": 2, "armv7": 1}
PT_LOAD, PT_DYNAMIC, PT_INTERP = 1, 2, 3
DT_NULL, DT_NEEDED, DT_STRTAB = 0, 1, 5
DT_VERNEED, DT_VERNEEDNUM = 0x6FFFFFFE, 0x6FFFFFFF
GLIBC_VERSION = re.compile(r"GLIBC_([0-9]+)\.([0-9]+)(?:\.([0-9]+))?")


class ReleaseError(Exception):
    """A release input breaks the contract; `reason` is a statements.json code."""

    def __init__(self, message: str, reason: str | None = None) -> None:
        super().__init__(message)
        self.reason = reason


def fail(message: str, reason: str | None = None) -> NoReturn:
    raise ReleaseError(message, reason)


# --------------------------------------------------------------------------
# Strict JSON (statements.json dsse.json)
# --------------------------------------------------------------------------


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ValueError(f"duplicate member {key!r}")
        out[key] = value
    return out


def _reject_float(text: str) -> NoReturn:
    raise ValueError(f"number {text} is not an integer")


def _reject_constant(text: str) -> NoReturn:
    raise ValueError(f"{text} is not JSON")


def _check_integers(value: Any) -> None:
    if isinstance(value, dict):
        for v in value.values():
            _check_integers(v)
    elif isinstance(value, list):
        for v in value:
            _check_integers(v)
    elif isinstance(value, int) and not isinstance(value, bool) and abs(value) > MAX_SAFE_INTEGER:
        raise ValueError(f"integer {value} exceeds 2^53-1")


_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")


def _check_surrogates(value: Any) -> None:
    if isinstance(value, dict):
        for k, v in value.items():
            _check_surrogates(k)
            _check_surrogates(v)
    elif isinstance(value, list):
        for v in value:
            _check_surrogates(v)
    elif isinstance(value, str) and _LONE_SURROGATE.search(value):
        raise ValueError("unpaired UTF-16 surrogate")


def strict_json(data: bytes, what: str, reason: str) -> Any:
    """Parse contract JSON: UTF-8 without BOM, no duplicates, integers only."""
    if data.startswith(b"\xef\xbb\xbf"):
        fail(f"{what}: byte order mark", reason)
    try:
        text = data.decode("utf-8")
        value = json.loads(
            text,
            object_pairs_hook=_no_duplicates,
            parse_float=_reject_float,
            parse_constant=_reject_constant,
        )
        _check_integers(value)
        _check_surrogates(value)
    except (UnicodeDecodeError, ValueError) as e:
        fail(f"{what}: {e}", reason)
    return value


def canonical(value: Any) -> bytes:
    """Deterministic payload bytes. Verifiers never depend on this form."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json(path: Path) -> Any:
    return strict_json(path.read_bytes(), str(path), "envelope-invalid")


# --------------------------------------------------------------------------
# JSON Schema 2020-12 subset over the contract's schema files
# --------------------------------------------------------------------------

_ANNOTATIONS = {
    "$schema",
    "$id",
    "$defs",
    "$comment",
    "title",
    "description",
    "examples",
    "default",
    "deprecated",
    "readOnly",
    "writeOnly",
    "format",
}


def _ecma_pattern(pattern: str) -> re.Pattern[str]:
    """ECMA-262 `$` (no multiline) matches only at the end of input: `\\Z`."""
    out: list[str] = []
    in_class = False
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "\\":
            out.append(pattern[i : i + 2])
            i += 2
            continue
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        elif c == "$" and not in_class:
            out.append(r"\Z")
            i += 1
            continue
        out.append(c)
        i += 1
    return re.compile("".join(out))


def _json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    fail(f"not a JSON value: {value!r}")


def _json_equal(a: Any, b: Any) -> bool:
    if _json_type(a) != _json_type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_json_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(_json_equal(x, y) for x, y in zip(a, b, strict=True))
    return bool(a == b)


class Schemas:
    def __init__(self, directory: Path) -> None:
        self.docs: dict[str, dict[str, Any]] = {}
        for path in sorted(directory.glob("*.schema.json")):
            doc = read_json(path)
            self.docs[doc["$id"]] = doc

    def schema(self, name: str) -> tuple[dict[str, Any], str]:
        sid = f"urn:suderra:edge-contract:v1:schema:{name}"
        if sid not in self.docs:
            fail(f"contract schema {sid} not found")
        return self.docs[sid], sid

    def _resolve(self, ref: str, base: str) -> tuple[dict[str, Any], str]:
        uri, _, pointer = ref.partition("#")
        doc_id = uri or base
        if doc_id not in self.docs:
            fail(f"schema reference {ref} names no contract schema")
        node: Any = self.docs[doc_id]
        for part in [p for p in pointer.split("/") if p]:
            node = node[part.replace("~1", "/").replace("~0", "~")]
        return node, doc_id

    def errors(self, value: Any, schema: dict[str, Any], base: str, at: str = "$") -> list[str]:
        errs: list[str] = []
        for key, rule in schema.items():
            if key in _ANNOTATIONS:
                continue
            if key == "$ref":
                target, target_base = self._resolve(rule, base)
                errs += self.errors(value, target, target_base, at)
            elif key == "type":
                kinds = rule if isinstance(rule, list) else [rule]
                actual = _json_type(value)
                if actual not in kinds and not (actual == "integer" and "number" in kinds):
                    errs.append(f"{at}: {actual} is not {rule}")
            elif key == "const":
                if not _json_equal(value, rule):
                    errs.append(f"{at}: is not {rule!r}")
            elif key == "enum":
                if not any(_json_equal(value, option) for option in rule):
                    errs.append(f"{at}: {value!r} is not one of {rule}")
            elif key == "pattern":
                if isinstance(value, str) and not _ecma_pattern(rule).search(value):
                    errs.append(f"{at}: {value!r} does not match {rule}")
            elif key in ("minLength", "maxLength"):
                if isinstance(value, str):
                    n = len(value)
                    if (key == "minLength" and n < rule) or (key == "maxLength" and n > rule):
                        errs.append(f"{at}: length {n} breaks {key} {rule}")
            elif key in ("minimum", "maximum"):
                if _json_type(value) == "integer" and (
                    (key == "minimum" and value < rule) or (key == "maximum" and value > rule)
                ):
                    errs.append(f"{at}: {value} breaks {key} {rule}")
            elif key in ("minItems", "maxItems"):
                if isinstance(value, list):
                    n = len(value)
                    if (key == "minItems" and n < rule) or (key == "maxItems" and n > rule):
                        errs.append(f"{at}: {n} items break {key} {rule}")
            elif key == "uniqueItems":
                if rule and isinstance(value, list):
                    for i, item in enumerate(value):
                        if any(_json_equal(item, other) for other in value[:i]):
                            errs.append(f"{at}: duplicate item {item!r}")
            elif key == "items":
                if isinstance(value, list):
                    for i, item in enumerate(value):
                        errs += self.errors(item, rule, base, f"{at}[{i}]")
            elif key == "required":
                if isinstance(value, dict):
                    errs += [f"{at}: missing {name}" for name in rule if name not in value]
            elif key == "properties":
                if isinstance(value, dict):
                    for name, sub in rule.items():
                        if name in value:
                            errs += self.errors(value[name], sub, base, f"{at}.{name}")
            elif key == "additionalProperties":
                if isinstance(value, dict):
                    known = set(schema.get("properties", {}))
                    for name in value:
                        if name in known:
                            continue
                        if rule is False:
                            errs.append(f"{at}: unknown member {name}")
                        elif isinstance(rule, dict):
                            errs += self.errors(value[name], rule, base, f"{at}.{name}")
            else:
                fail(f"schema keyword {key!r} at {at} is not implemented by this validator")
        return errs

    def validate(self, value: Any, name: str, reason: str) -> None:
        schema, base = self.schema(name)
        errs = self.errors(value, schema, base)
        if errs:
            fail(f"{name}: " + "; ".join(errs), reason)


# --------------------------------------------------------------------------
# Contract, release facts and Cargo features
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Row:
    """One release build: a Suderra OS (board_profile, arch) or a generic slug."""

    channel: str
    id: str
    arch: str
    rust_target: str
    features: tuple[str, ...]
    artifact: str
    binary_name: str
    archive_members: tuple[str, ...]
    statement: str
    cargo_bin: str

    @property
    def base(self) -> str:
        return self.artifact.removesuffix(".tar.gz")

    def matrix(self) -> dict[str, str]:
        return {
            "channel": self.channel,
            "id": self.id,
            "arch": self.arch,
            "rust_target": self.rust_target,
            "features": ",".join(self.features),
            "artifact": self.artifact,
            "base": self.base,
            "binary_name": self.binary_name,
            "statement": self.statement,
            "cargo_bin": self.cargo_bin,
        }


def _strict_table(table: dict[str, Any], allowed: set[str], where: str) -> None:
    unknown = sorted(set(table) - allowed)
    if unknown:
        fail(f"{where}: unknown keys {unknown}")


class Release:
    def __init__(self, facts_path: Path, cargo_toml: Path, contract: Path = CONTRACT) -> None:
        self.contract = contract
        self.boards = read_json(contract / "boards.json")
        # DEC-8.5, INFRA-MEDIUM-253: the runtime the Suderra OS images provide is
        # the contract's (boards.json os_runtime), not a second copy kept here.
        self.os_runtime: dict[str, Any] = self.boards["os_runtime"]
        self.naming = read_json(contract / "artifact-naming.json")
        self.statements = read_json(contract / "statements.json")
        self.keyring = read_json(contract / "test-keys" / "keyring.json")
        self.schemas = Schemas(contract / "schemas")
        entry = self.statements["statements"][STATEMENT_TYPE]
        self.payload_type: str = entry["payload_type"]
        self.signing_purpose: str = entry["signing_purpose"]
        self.schema_name = Path(entry["schema"]).name.removesuffix(".schema.json")
        self.release_schema, _ = self.schemas.schema(self.schema_name)
        common, _ = self.schemas.schema("common")
        self.semver = _ecma_pattern(common["$defs"]["semver"]["pattern"])

        with facts_path.open("rb") as fh:
            self.facts = tomllib.load(fh)
        with cargo_toml.open("rb") as fh:
            cargo = tomllib.load(fh)
        self.version: str = cargo["package"]["version"]
        self.cargo_features = set(cargo.get("features", {}))
        bins = [b["name"] for b in cargo.get("bin", [])]
        if len(bins) != 1:
            fail(f"{cargo_toml} must declare exactly one [[bin]], found {bins}")
        self.cargo_bin: str = bins[0]
        self._check_facts()

    # ------------------------------------------------------------------ facts
    def _check_facts(self) -> None:
        f = self.facts
        _strict_table(f, {"suderra_os", "generic_channel", "runtime"}, "release facts")
        os_facts = f["suderra_os"]
        _strict_table(
            os_facts,
            {
                "security_version",
                "agent_abi",
                "min_os_version",
                "crate_required_features",
                "crate_required_features_tracked_by",
                "required_kernel_config",
                "unbuildable",
            },
            "release facts [suderra_os]",
        )
        _strict_table(
            f["generic_channel"], {"cargo_features", "max_glibc"}, "release facts [generic_channel]"
        )
        for channel in (CHANNEL_OS, CHANNEL_GENERIC):
            self.max_glibc(channel)
        if self._crate_required() and not re.fullmatch(
            r"[A-Z]+-(CRITICAL|HIGH|MEDIUM|LOW)-[0-9]+",
            str(os_facts.get("crate_required_features_tracked_by", "")),
        ):
            fail(
                "release facts: crate_required_features puts features outside boards.json into a "
                "Suderra OS build; crate_required_features_tracked_by must name the finding that removes them"
            )
        for arch, rt in f["runtime"].items():
            _strict_table(rt, {"interpreter", "needed"}, f"release facts [runtime.{arch}]")
            if arch in self.os_runtime["shared_libraries"]:
                fail(
                    f"release facts [runtime.{arch}] repeats the {arch} runtime of boards.json os_runtime: "
                    "the contract is the one definition, delete the copy"
                )
        board_ids = {b["board_profile"] for b in self.boards["boards"]}
        kernel = set(os_facts["required_kernel_config"])
        if kernel != board_ids:
            fail(
                "release facts [suderra_os.required_kernel_config] must name exactly the boards of "
                f"boards.json {sorted(board_ids)}, got {sorted(kernel)}"
            )
        for board, entry in os_facts.get("unbuildable", {}).items():
            _strict_table(entry, {"blocked_by", "reason"}, f"release facts unbuildable.{board}")
            if board not in board_ids:
                fail(f"release facts: unbuildable board {board} is not in boards.json")
        if not self.semver.search(self.version):
            fail(f"Cargo package version {self.version!r} is not a path-safe semver (DEC-1.10)")
        for feature in self._crate_required() + list(f["generic_channel"]["cargo_features"]):
            if feature not in self.cargo_features:
                fail(f"release facts name cargo feature {feature!r} that sens-api-gateway does not define")

    def _crate_required(self) -> list[str]:
        return list(self.facts["suderra_os"]["crate_required_features"])

    def max_glibc(self, channel: str) -> tuple[int, int, int]:
        """DEC-8.5: the newest GLIBC_x.y symbol version a binary of the channel may need."""
        if channel == CHANNEL_OS:
            where = "boards.json os_runtime.glibc_version"
            text = self.os_runtime.get("glibc_version")
        else:
            where = "release facts generic_channel.max_glibc"
            text = self.facts["generic_channel"].get("max_glibc")
        m = re.fullmatch(r"([0-9]+)\.([0-9]+)(?:\.([0-9]+))?", str(text))
        if text is None or m is None:
            fail(f"{where} must be a glibc version x.y, got {text!r}")
        return (int(m[1]), int(m[2]), int(m[3] or 0))

    def runtime(self, arch: str) -> dict[str, Any]:
        """The interpreter and libraries of a planned build: the contract's for the architectures
        the Suderra OS images are built for, the release facts' for any other (armv7, generic only)."""
        rt = self.os_runtime["shared_libraries"].get(arch) or self.facts["runtime"].get(arch)
        if rt is None:
            fail(
                f"neither boards.json os_runtime nor the release facts [runtime.{arch}] "
                f"declare a runtime for a planned {arch} build"
            )
        return rt

    # ------------------------------------------------------------------- plan
    def rows(self) -> list[Row]:
        os_naming = self.naming["suderra_os_channel"]
        generic = self.naming["generic_channel"]
        unbuildable = self.facts["suderra_os"].get("unbuildable", {})
        rows: list[Row] = []
        for board in self.boards["boards"]:
            profile = board["board_profile"]
            missing = sorted(set(board["cargo_features"]) - self.cargo_features)
            if profile in unbuildable:
                if not missing:
                    fail(
                        f"release facts mark {profile} unbuildable ({unbuildable[profile]['blocked_by']}), "
                        "but sens-api-gateway now defines every feature it needs: remove the entry"
                    )
                continue
            if missing:
                fail(
                    f"boards.json {profile} needs cargo features {missing} that sens-api-gateway does "
                    "not define; add them, or record the board under [suderra_os.unbuildable] with the "
                    "finding that tracks them"
                )
            if board["rust_target"].split("-", 1)[0] != board["arch"]:
                fail(f"boards.json {profile}: rust_target {board['rust_target']} is not {board['arch']}")
            artifact = os_naming["artifact"].format(
                version=self.version, board_profile=profile, arch=board["arch"]
            )
            features = tuple(sorted(set(board["cargo_features"]) | set(self._crate_required())))
            rows.append(
                Row(
                    channel=CHANNEL_OS,
                    id=profile,
                    arch=board["arch"],
                    rust_target=board["rust_target"],
                    features=features,
                    artifact=artifact,
                    binary_name=os_naming["binary_name"],
                    archive_members=tuple(os_naming["archive_members"]),
                    statement=os_naming["statement"].format(artifact=artifact),
                    cargo_bin=self.cargo_bin,
                )
            )
        for slug in generic["slugs"]:
            arch = slug["rust_target"].split("-", 1)[0]
            artifact = generic["artifact"].format(version=self.version, slug=slug["slug"])
            rows.append(
                Row(
                    channel=CHANNEL_GENERIC,
                    id=slug["slug"],
                    arch=arch,
                    rust_target=slug["rust_target"],
                    features=tuple(sorted(self.facts["generic_channel"]["cargo_features"])),
                    artifact=artifact,
                    binary_name=generic["binary_name"],
                    archive_members=(generic["binary_name"],),
                    statement="",
                    cargo_bin=self.cargo_bin,
                )
            )
        ids = [(r.channel, r.id) for r in rows]
        if len(set(ids)) != len(ids) or len({r.artifact for r in rows}) != len(rows):
            fail("the plan names one build twice")
        for row in rows:
            self.runtime(row.arch)
        return rows

    def row(self, channel: str, ident: str) -> Row:
        for r in self.rows():
            if r.channel == channel and r.id == ident:
                return r
        fail(f"the plan has no {channel} build {ident}")

    def board(self, profile: str) -> dict[str, Any]:
        for b in self.boards["boards"]:
            if b["board_profile"] == profile:
                return b
        fail(f"board_profile {profile!r} is not in boards.json", "release-profile-mismatch")

    # ------------------------------------------------------------ statement
    def body(self, row: Row, artifact: dict[str, Any], provenance_digest: str) -> dict[str, Any]:
        props = self.release_schema["properties"]
        board = self.board(row.id)
        os_facts = self.facts["suderra_os"]
        return {
            "_type": props["_type"]["const"],
            "name": props["name"]["const"],
            "version": self.version,
            "security_version": os_facts["security_version"],
            "board_profile": row.id,
            "arch": board["arch"],
            "agent_profile": board["agent_profile"],
            "cargo_features": sorted(board["cargo_features"]),
            "artifact": artifact,
            "min_os_version": os_facts["min_os_version"],
            "agent_abi": os_facts["agent_abi"],
            "required_kernel_config": sorted(os_facts["required_kernel_config"][row.id]),
            "provenance": {
                "predicate_type": props["provenance"]["properties"]["predicate_type"]["const"],
                "digest": {"sha256": provenance_digest},
            },
        }

    def check_statement(self, body: Any) -> None:
        """schema-invalid, then release-profile-mismatch (statements.json checks)."""
        self.schemas.validate(body, self.schema_name, "schema-invalid")
        board = self.board(body["board_profile"])
        problems = []
        if body["arch"] != board["arch"]:
            problems.append(f"arch {body['arch']} is not {board['arch']}")
        if body["agent_profile"] != board["agent_profile"]:
            problems.append(f"agent_profile {body['agent_profile']} is not {board['agent_profile']}")
        if body["cargo_features"] != sorted(board["cargo_features"]):
            problems.append(
                f"cargo_features {body['cargo_features']} are not {sorted(board['cargo_features'])}"
            )
        naming = self.naming["suderra_os_channel"]
        expected = naming["artifact"].format(
            version=body["version"], board_profile=body["board_profile"], arch=board["arch"]
        )
        if body["artifact"]["name"] != expected:
            problems.append(f"artifact name {body['artifact']['name']} is not {expected}")
        if body["artifact"]["binary_name"] != naming["binary_name"]:
            problems.append(f"binary_name {body['artifact']['binary_name']} is not {naming['binary_name']}")
        if body["artifact"]["format"] != naming["format"]:
            problems.append(f"format {body['artifact']['format']} is not {naming['format']}")
        if problems:
            fail(f"{body['board_profile']}: " + "; ".join(problems), "release-profile-mismatch")

    def test_only_keyids(self) -> set[str]:
        ids = {k["keyid"] for k in self.keyring["keys"]}
        ids |= {k["keyid"] for k in self.keyring.get("unanchored_keys", [])}
        return ids


# --------------------------------------------------------------------------
# ELF and archive
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ElfFacts:
    elf_class: int
    machine: int
    interpreter: str | None
    needed: tuple[str, ...]
    # (library, version) of every ELF VERNEED requirement, e.g. ("libc.so.6", "GLIBC_2.17").
    version_needs: tuple[tuple[str, str], ...]


def elf_facts(data: bytes) -> ElfFacts:
    try:
        if data[:4] != b"\x7fELF":
            fail("not an ELF file", "archive-invalid")
        elf_class, encoding = data[4], data[5]
        if encoding != 1:
            fail("not a little-endian ELF file", "archive-invalid")
        if elf_class == 2:
            (e_type, machine, _v, _entry, phoff, _sh, _fl, _eh, phentsize, phnum) = struct.unpack_from(
                "<HHIQQQIHHH", data, 16
            )
            ph_fmt, dyn_fmt = "<IIQQQQQQ", "<qQ"
        elif elf_class == 1:
            (e_type, machine, _v, _entry, phoff, _sh, _fl, _eh, phentsize, phnum) = struct.unpack_from(
                "<HHIIIIIHHH", data, 16
            )
            ph_fmt, dyn_fmt = "<IIIIIIII", "<iI"
        else:
            fail(f"unknown ELF class {elf_class}", "archive-invalid")
        if e_type not in (2, 3):
            fail(f"ELF type {e_type} is not an executable", "archive-invalid")
        segments = []
        for i in range(phnum):
            fields = struct.unpack_from(ph_fmt, data, phoff + i * phentsize)
            if elf_class == 2:
                p_type, _flags, offset, vaddr, _paddr, filesz, _memsz, _align = fields
            else:
                p_type, offset, vaddr, _paddr, filesz, _memsz, _flags, _align = fields
            segments.append((p_type, offset, vaddr, filesz))

        def file_offset(addr: int) -> int:
            for p_type, offset, vaddr, filesz in segments:
                if p_type == PT_LOAD and vaddr <= addr < vaddr + filesz:
                    return offset + (addr - vaddr)
            fail(f"ELF address {addr:#x} lies in no loaded segment", "archive-invalid")

        def c_string(offset: int) -> str:
            end = data.index(b"\0", offset)
            return data[offset:end].decode("ascii")

        interpreter = None
        dynamic: list[tuple[int, int]] = []
        for p_type, offset, _vaddr, filesz in segments:
            if p_type == PT_INTERP:
                interpreter = c_string(offset)
            elif p_type == PT_DYNAMIC:
                size = struct.calcsize(dyn_fmt)
                for j in range(filesz // size):
                    tag, val = struct.unpack_from(dyn_fmt, data, offset + j * size)
                    if tag == DT_NULL:
                        break
                    dynamic.append((tag, val))
        strtab = [val for tag, val in dynamic if tag == DT_STRTAB]
        needed_offsets = [val for tag, val in dynamic if tag == DT_NEEDED]
        verneed = [val for tag, val in dynamic if tag == DT_VERNEED]
        verneednum = [val for tag, val in dynamic if tag == DT_VERNEEDNUM]
        needed: list[str] = []
        version_needs: list[tuple[str, str]] = []
        if needed_offsets or verneed or verneednum:
            if len(strtab) != 1:
                fail("ELF dynamic section has no single string table", "archive-invalid")
            base = file_offset(strtab[0])
            needed = [c_string(base + off) for off in needed_offsets]
            if len(verneed) != len(verneednum) or len(verneed) > 1:
                fail("ELF dynamic section has no single DT_VERNEED/DT_VERNEEDNUM pair", "archive-invalid")
            if verneed:
                # Elf32_Verneed and Elf64_Verneed share one layout, as do the
                # Vernaux entries: (u16 version, u16 cnt, u32 file, u32 aux,
                # u32 next) and (u32 hash, u16 flags, u16 other, u32 name, u32 next).
                at = file_offset(verneed[0])
                for _ in range(verneednum[0]):
                    vn_version, vn_cnt, vn_file, vn_aux, vn_next = struct.unpack_from("<HHIII", data, at)
                    if vn_version != 1:
                        fail(f"ELF Verneed version {vn_version} is not 1", "archive-invalid")
                    library = c_string(base + vn_file)
                    aux = at + vn_aux
                    for _ in range(vn_cnt):
                        _hash, _flags, _other, vna_name, vna_next = struct.unpack_from("<IHHII", data, aux)
                        version_needs.append((library, c_string(base + vna_name)))
                        aux += vna_next
                    at += vn_next
        return ElfFacts(elf_class, machine, interpreter, tuple(needed), tuple(version_needs))
    except (struct.error, IndexError, ValueError, UnicodeDecodeError) as e:
        fail(f"malformed ELF file: {e}", "archive-invalid")


def check_binary(release: Release, row: Row, data: bytes) -> ElfFacts:
    """DEC-8.5: the right machine, the OS's interpreter, only the OS's libraries."""
    facts = elf_facts(data)
    if facts.elf_class != ELF_CLASS[row.arch] or facts.machine != ELF_MACHINE[row.arch]:
        fail(
            f"{row.artifact}: ELF class {facts.elf_class} machine {facts.machine} is not {row.arch}",
            "archive-invalid",
        )
    rt = release.runtime(row.arch)
    if facts.interpreter != rt["interpreter"]:
        fail(
            f"{row.artifact}: program interpreter {facts.interpreter} is not {rt['interpreter']}",
            "archive-invalid",
        )
    foreign = sorted(set(facts.needed) - set(rt["needed"]))
    if foreign:
        fail(
            f"{row.artifact}: ELF NEEDED {foreign} is outside the {row.arch} runtime the OS provides "
            f"{sorted(rt['needed'])} (contracts/suderra-edge/v1/boards.json os_runtime; "
            f"sens-api-gateway/release/edge-release.toml [runtime.{row.arch}] for an architecture it names)",
            "archive-invalid",
        )
    # The loader refuses a binary that needs a newer glibc symbol version than
    # the device's glibc has, and nothing may link against glibc's private ABI.
    cap = release.max_glibc(row.channel)
    too_new: list[str] = []
    for library, version in facts.version_needs:
        if version == "GLIBC_PRIVATE":
            fail(f"{row.artifact}: needs GLIBC_PRIVATE of {library}", "archive-invalid")
        m = GLIBC_VERSION.fullmatch(version)
        if m and (int(m[1]), int(m[2]), int(m[3] or 0)) > cap:
            too_new.append(f"{version} ({library})")
    if too_new:
        fail(
            f"{row.artifact}: needs glibc symbol versions {sorted(too_new)} newer than the "
            f"{row.channel} channel's glibc {'.'.join(map(str, cap)).removesuffix('.0')} "
            "(boards.json os_runtime.glibc_version; edge-release.toml generic_channel.max_glibc)",
            "archive-invalid",
        )
    return facts


def pack(member: str, binary: bytes, mtime: int) -> bytes:
    """One regular 0755 member owned by root, gzip without name or time."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        info = tarfile.TarInfo(member)
        info.size = len(binary)
        info.mode = 0o755
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        info.mtime = mtime
        info.type = tarfile.REGTYPE
        tar.addfile(info, io.BytesIO(binary))
    out = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0, compresslevel=9) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def unpack(row: Row, archive: bytes) -> bytes:
    """The binary of an archive holding exactly the contract's members."""
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            members = tar.getmembers()
            names = [m.name for m in members]
            if names != list(row.archive_members):
                fail(
                    f"{row.artifact} holds {names}, the contract names {list(row.archive_members)}",
                    "archive-invalid",
                )
            member = members[0]
            if not member.isreg() or member.mode & 0o111 == 0:
                fail(f"{row.artifact}: {member.name} is not an executable regular file", "archive-invalid")
            if member.size > MAX_BINARY_BYTES:
                fail(f"{row.artifact}: {member.name} is {member.size} bytes", "archive-invalid")
            fh = tar.extractfile(member)
            if fh is None:
                fail(f"{row.artifact}: {member.name} has no content", "archive-invalid")
            return fh.read()
    except (tarfile.TarError, OSError, EOFError) as e:
        fail(f"{row.artifact}: not a tar.gz archive: {e}", "archive-invalid")


def artifact_facts(release: Release, row: Row, path: Path) -> dict[str, Any]:
    if path.name != row.artifact:
        fail(f"{path.name} is not the planned artifact {row.artifact}", "artifact-digest-mismatch")
    if not path.is_file():
        fail(f"the planned artifact {row.artifact} is missing from {path.parent}")
    data = path.read_bytes()
    binary = unpack(row, data)
    check_binary(release, row, binary)
    return {
        "name": row.artifact,
        "format": release.naming["suderra_os_channel"]["format"],
        "size_bytes": len(data),
        "digest": {"sha256": sha256_hex(data)},
        "binary_name": row.binary_name,
        "binary_digest": {"sha256": sha256_hex(binary)},
    }


# --------------------------------------------------------------------------
# Ed25519 verify_strict (statements.json dsse.signature_algorithm)
# --------------------------------------------------------------------------
#
# RFC 8032 arithmetic in extended coordinates, with the checks
# ed25519-dalek's verify_strict adds and the contract requires: S < L, A and R
# canonical encodings (y < p, and x = 0 never with the sign bit set) that are
# not small-order points, and the cofactorless equation [S]B = R + [k]A.
# Verification only: no secret ever enters this code, so its timing is not a
# concern.

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)
_Point = tuple[int, int, int, int]
_IDENTITY: _Point = (0, 1, 1, 0)


def _ed_add(p: _Point, q: _Point) -> _Point:
    a = (p[1] - p[0]) * (q[1] - q[0]) % _P
    b = (p[1] + p[0]) * (q[1] + q[0]) % _P
    c = 2 * p[3] * q[3] * _D % _P
    d = 2 * p[2] * q[2] % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _ed_mul(scalar: int, p: _Point) -> _Point:
    q = _IDENTITY
    while scalar > 0:
        if scalar & 1:
            q = _ed_add(q, p)
        p = _ed_add(p, p)
        scalar >>= 1
    return q


def _ed_equal(p: _Point, q: _Point) -> bool:
    return (p[0] * q[2] - q[0] * p[2]) % _P == 0 and (p[1] * q[2] - q[1] * p[2]) % _P == 0


def _ed_recover_x(y: int, sign: int) -> int | None:
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _SQRT_M1 % _P
    if (x * x - x2) % _P != 0:
        return None
    if x & 1 != sign:
        x = _P - x
    return x


def _ed_decode_strict(encoded: bytes) -> _Point | None:
    """A canonical encoding of a point that is not of small order, else None."""
    if len(encoded) != 32:
        return None
    y = int.from_bytes(encoded, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= _P:
        return None
    x = _ed_recover_x(y, sign)
    if x is None:
        return None
    point = (x, y, 1, x * y % _P)
    if _ed_equal(_ed_mul(8, point), _IDENTITY):
        return None
    return point


_BASE_Y = 4 * pow(5, _P - 2, _P) % _P


def _ed_base() -> _Point:
    x = _ed_recover_x(_BASE_Y, 0)
    if x is None:
        raise RuntimeError("the Ed25519 base point does not decode")
    return (x, _BASE_Y, 1, x * _BASE_Y % _P)


_BASE: _Point = _ed_base()


def ed25519_verify_strict(public_key: bytes, message: bytes, signature: bytes) -> bool:
    if len(public_key) != 32 or len(signature) != 64:
        return False
    a = _ed_decode_strict(public_key)
    r = _ed_decode_strict(signature[:32])
    s = int.from_bytes(signature[32:], "little")
    if a is None or r is None or s >= _L:
        return False
    k = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), "little") % _L
    return _ed_equal(_ed_mul(s, _BASE), _ed_add(r, _ed_mul(k, a)))


def spki_pem_public_key(text: str, what: str) -> bytes:
    """The raw key of an RFC 8410 Ed25519 SubjectPublicKeyInfo PEM."""
    lines = [line.strip() for line in text.strip().splitlines()]
    if len(lines) < 3 or lines[0] != "-----BEGIN PUBLIC KEY-----" or lines[-1] != "-----END PUBLIC KEY-----":
        fail(f"{what} is not one PEM public key")
    try:
        der = base64.b64decode("".join(lines[1:-1]), validate=True)
    except (ValueError, TypeError) as e:
        fail(f"{what}: not base64: {e}")
    if len(der) != 44 or not der.startswith(ED25519_SPKI_PREFIX):
        fail(f"{what} is not an Ed25519 public key")
    return der[len(ED25519_SPKI_PREFIX) :]


# --------------------------------------------------------------------------
# OpenSSL Ed25519 signing
# --------------------------------------------------------------------------


def openssl(*args: str) -> bytes:
    try:
        proc = subprocess.run(["openssl", *args], capture_output=True, check=False)
    except FileNotFoundError:
        fail("the openssl CLI (OpenSSL 3, Ed25519 -rawin) is required")
    if proc.returncode != 0:
        fail(f"openssl {args[0]} failed: {proc.stderr.decode(errors='replace').strip()}")
    return proc.stdout


def private_key_public_pem(pem_path: Path) -> str:
    """The SubjectPublicKeyInfo PEM of an Ed25519 PKCS#8 private key."""
    public = openssl("pkey", "-in", str(pem_path), "-pubout").decode("ascii")
    spki_pem_public_key(public, f"the public key of {pem_path.name}")
    return public


def pae(payload_type: str, body: bytes) -> bytes:
    kind = payload_type.encode()
    return b"DSSEv1 %d %s %d %s" % (len(kind), kind, len(body), body)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64_strict(text: str, what: str) -> bytes:
    try:
        data = base64.b64decode(text, validate=True)
    except (ValueError, TypeError) as e:
        fail(f"{what}: not base64: {e}", "envelope-invalid")
    if b64(data) != text:
        fail(f"{what}: not canonical base64", "envelope-invalid")
    return data


# --------------------------------------------------------------------------
# Subcommands
# --------------------------------------------------------------------------


def cmd_plan(release: Release, args: argparse.Namespace) -> None:
    if args.expect_version is not None and args.expect_version != release.version:
        fail(f"release version {args.expect_version} is not the Cargo version {release.version}")
    rows = release.rows()
    # Every Suderra OS row's statement fields must already pass the contract,
    # so bad release facts fail here and not after the builds.
    for row in rows:
        if row.channel == CHANNEL_OS:
            stand_in = {"sha256": "0" * 64}
            body = release.body(
                row,
                {
                    "name": row.artifact,
                    "format": release.naming["suderra_os_channel"]["format"],
                    "size_bytes": 1,
                    "digest": stand_in,
                    "binary_name": row.binary_name,
                    "binary_digest": stand_in,
                },
                "0" * 64,
            )
            release.check_statement(body)
    build = {"include": [r.matrix() for r in rows]}
    feature_sets: dict[str, list[str]] = {}
    for r in rows:
        feature_sets.setdefault(",".join(r.features), []).append(f"{r.channel}/{r.id}")
    test = {
        "include": [
            {"features": features, "used_by": " ".join(sorted(users))}
            for features, users in sorted(feature_sets.items())
        ]
    }
    plan = {"version": release.version, "build": build, "test": test}
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as out:
            out.write(f"version={release.version}\n")
            out.write(f"build_matrix={json.dumps(build, separators=(',', ':'))}\n")
            out.write(f"test_matrix={json.dumps(test, separators=(',', ':'))}\n")
    print(json.dumps(plan, indent=2))


def cmd_package(release: Release, args: argparse.Namespace) -> None:
    row = release.row(args.channel, args.id)
    epoch = args.source_date_epoch
    if epoch is None:
        env = os.environ.get("SOURCE_DATE_EPOCH")
        if env is None or not env.isdigit():
            fail("package needs --source-date-epoch or SOURCE_DATE_EPOCH (the commit time)")
        epoch = int(env)
    binary = Path(args.binary).read_bytes()
    if len(binary) > MAX_BINARY_BYTES:
        fail(f"{args.binary} is {len(binary)} bytes")
    facts = check_binary(release, row, binary)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    archive = pack(row.archive_members[0], binary, epoch)
    target = out_dir / row.artifact
    target.write_bytes(archive)
    (out_dir / f"{row.artifact}.sha256").write_text(f"{sha256_hex(archive)}  {row.artifact}\n")
    print(
        json.dumps(
            {
                "artifact": str(target),
                "sha256": sha256_hex(archive),
                "binary_sha256": sha256_hex(binary),
                "interpreter": facts.interpreter,
                "needed": list(facts.needed),
                "version_needs": [f"{v} ({lib})" for lib, v in facts.version_needs],
            },
            indent=2,
        )
    )


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        fail(f"this step needs the GitHub Actions environment variable {name}")
    return value


def _provenance_statement(release: Release, row: Row, digest: str, tag: str) -> dict[str, Any]:
    repo = _require_env("GITHUB_REPOSITORY")
    return {
        "_type": "https://in-toto.io/Statement/v1",
        "subject": [{"name": row.artifact, "digest": {"sha256": digest}}],
        "predicateType": release.release_schema["properties"]["provenance"]["properties"]["predicate_type"][
            "const"
        ],
        "predicate": {
            "buildDefinition": {
                "buildType": "https://github.com/Attestations/GitHubActionsWorkflow@v1",
                "externalParameters": {
                    "repository": repo,
                    "workflow": _require_env("GITHUB_WORKFLOW"),
                    "workflowRef": _require_env("GITHUB_WORKFLOW_REF"),
                    "releaseTag": tag,
                    "channel": row.channel,
                    "target": row.id,
                    "rustTarget": row.rust_target,
                    "features": ",".join(row.features),
                },
                "resolvedDependencies": [
                    {
                        "uri": f"git+https://github.com/{repo}",
                        "digest": {"gitCommit": _require_env("GITHUB_SHA")},
                    }
                ],
            },
            "runDetails": {
                "builder": {"id": "https://github.com/actions/runner/ubuntu-24.04"},
                "metadata": {
                    "invocationId": f"https://github.com/{repo}/actions/runs/{_require_env('GITHUB_RUN_ID')}"
                },
            },
        },
    }


def cmd_provenance(release: Release, args: argparse.Namespace) -> None:
    """DEC-20: the signing job states the provenance of every planned artifact.

    Its claims come from the plan of the tag's sources and the signing job's
    own GitHub context, and its subject digest from the downloaded artifact
    bytes, never from what a build job (which runs cross and every build
    script) reports.
    """
    artifacts = Path(args.artifacts)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = release.rows()
    present = {p.name for p in artifacts.glob("*.tar.gz")}
    planned = {r.artifact for r in rows}
    if present != planned:
        fail(f"artifacts {sorted(present)} are not the planned set {sorted(planned)}")
    for row in rows:
        digest = sha256_hex((artifacts / row.artifact).read_bytes())
        out = out_dir / f"{row.base}.intoto.jsonl"
        out.write_bytes(canonical(_provenance_statement(release, row, digest, args.tag)) + b"\n")
        print(str(out))


def _provenance_digest(row: Row, directory: Path, artifact_digest: str) -> str:
    path = directory / f"{row.base}.intoto.jsonl"
    if not path.is_file():
        fail(f"provenance {path.name} of {row.artifact} is missing")
    data = path.read_bytes()
    lines = data.splitlines()
    if len(lines) != 1:
        fail(f"{path.name} is not one in-toto statement line")
    statement = strict_json(lines[0], path.name, "schema-invalid")
    subjects = statement.get("subject") if isinstance(statement, dict) else None
    if subjects != [{"name": row.artifact, "digest": {"sha256": artifact_digest}}]:
        fail(f"{path.name} does not name exactly {row.artifact} at its digest")
    return sha256_hex(data)


def _os_rows(release: Release) -> list[Row]:
    return [r for r in release.rows() if r.channel == CHANNEL_OS]


def _expected_body(release: Release, row: Row, facts: dict[str, Any], provenance_digest: str) -> bytes:
    """The statement this release makes for the row, in canonical form: every
    field from the contract, the release facts and the artifact bytes."""
    body = release.body(row, facts, provenance_digest)
    release.check_statement(body)
    return canonical(body)


def cmd_statements(release: Release, args: argparse.Namespace) -> None:
    if args.expect_version is not None and args.expect_version != release.version:
        fail(f"release version {args.expect_version} is not the Cargo version {release.version}")
    artifacts = Path(args.artifacts)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for row in _os_rows(release):
        facts = artifact_facts(release, row, artifacts / row.artifact)
        payload = _expected_body(
            release, row, facts, _provenance_digest(row, artifacts, facts["digest"]["sha256"])
        )
        target = out_dir / f"{row.artifact}{PAYLOAD_SUFFIX}"
        target.write_bytes(payload)
        print(str(target))


def _statement_body(release: Release, payload: bytes, what: str) -> dict[str, Any]:
    body = strict_json(payload, f"{what} payload", "payload-json-invalid")
    if not isinstance(body, dict):
        fail(f"{what} payload is not an object", "payload-json-invalid")
    release.check_statement(body)
    return body


def _check_payload(release: Release, row: Row, payload: bytes, artifacts: Path) -> None:
    """The contract checks with their reasons, then: the payload is byte for
    byte the statement this release makes, so no field is left free."""
    body = _statement_body(release, payload, row.artifact)
    if body["board_profile"] != row.id or body["version"] != release.version:
        fail(
            f"{row.artifact}: the statement is for {body['board_profile']} {body['version']}",
            "release-profile-mismatch",
        )
    facts = artifact_facts(release, row, artifacts / row.artifact)
    if body["artifact"]["size_bytes"] != facts["size_bytes"] or body["artifact"]["digest"] != facts["digest"]:
        fail(f"{row.artifact}: the statement names other artifact bytes", "artifact-digest-mismatch")
    if body["artifact"]["binary_digest"] != facts["binary_digest"]:
        fail(f"{row.artifact}: the statement names another binary", "binary-digest-mismatch")
    provenance = _provenance_digest(row, artifacts, facts["digest"]["sha256"])
    if body["provenance"]["digest"]["sha256"] != provenance:
        fail(f"{row.artifact}: the statement names other provenance than {row.base}.intoto.jsonl")
    expected = _expected_body(release, row, facts, provenance)
    if payload != expected:
        expected_body = json.loads(expected)
        differing = sorted(
            k for k in expected_body.keys() | body.keys() if body.get(k) != expected_body.get(k)
        )
        what = f"fields {differing} differ" if differing else "its bytes are not the canonical form"
        fail(f"{row.artifact}: the payload is not the statement this release makes: {what}")


def cmd_sign(release: Release, args: argparse.Namespace) -> None:
    pem = os.environ.get(args.key_env)
    if not pem:
        fail(f"the signing key environment variable {args.key_env} is empty")
    expect = args.expect_keyid
    if not re.fullmatch(r"[0-9a-f]{64}", expect or ""):
        fail("--expect-keyid must be the lowercase hex SHA-256 of the raw edge-release public key")
    artifacts = Path(args.artifacts)
    payloads = Path(args.payloads)
    out_dir = Path(args.out_dir)
    rows = _os_rows(release)
    expected_payloads = {f"{r.artifact}{PAYLOAD_SUFFIX}" for r in rows}
    present = {p.name for p in payloads.glob(f"*{PAYLOAD_SUFFIX}")}
    if present != expected_payloads:
        fail(f"payloads {sorted(present)} are not the planned set {sorted(expected_payloads)}")
    # Every payload is this release's statement before the key signs any.
    payload_of: dict[str, bytes] = {}
    for row in rows:
        payload = (payloads / f"{row.artifact}{PAYLOAD_SUFFIX}").read_bytes()
        _check_payload(release, row, payload, artifacts)
        payload_of[row.artifact] = payload
    with tempfile.TemporaryDirectory(prefix="edge-release-sign-") as tmp:
        key = Path(tmp) / "key.pem"
        fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as fh:
            fh.write(pem if pem.endswith("\n") else pem + "\n")
        public = private_key_public_pem(key)
        keyid = sha256_hex(spki_pem_public_key(public, "the signing key"))
        if keyid in release.test_only_keyids():
            fail("the signing key is a TEST-ONLY contract key; no signer may hold one (DEC-3.9)")
        if keyid != expect:
            fail(
                f"the signing key's keyid {keyid} is not the expected "
                f"{release.signing_purpose} keyid {expect}"
            )
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / PUBLIC_KEY_FILE).write_text(public, encoding="ascii")
        for row in rows:
            payload = payload_of[row.artifact]
            message = Path(tmp) / "pae"
            message.write_bytes(pae(release.payload_type, payload))
            sig = openssl("pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-in", str(message))
            if len(sig) != 64:
                fail("the Ed25519 signature is not 64 bytes")
            envelope = {
                "payloadType": release.payload_type,
                "payload": b64(payload),
                "signatures": [{"keyid": keyid, "sig": b64(sig)}],
            }
            target = out_dir / row.statement
            target.write_text(json.dumps(envelope, indent=2) + "\n", encoding="utf-8")
            print(str(target))
    # Every envelope verifies, under verify_strict, before it leaves the job.
    _verify_all(release, artifacts, out_dir, out_dir / PUBLIC_KEY_FILE, expect)


def _envelope(release: Release, path: Path) -> dict[str, Any]:
    """envelope-invalid, then payload-type-mismatch (verification_order)."""
    if not path.is_file():
        fail(f"{path.name} is missing", "envelope-invalid")
    envelope = strict_json(path.read_bytes(), path.name, "envelope-invalid")
    release.schemas.validate(envelope, "dsse-envelope", "envelope-invalid")
    if envelope["payloadType"] != release.payload_type:
        fail(f"{path.name}: payloadType {envelope['payloadType']}", "payload-type-mismatch")
    return envelope


def cmd_check_envelope(release: Release, args: argparse.Namespace) -> None:
    """Every check that needs neither a key nor the artifact (operators, tests)."""
    path = Path(args.envelope)
    envelope = _envelope(release, path)
    payload = b64_strict(envelope["payload"], f"{path.name} payload")
    _statement_body(release, payload, path.name)
    print(f"ok {path.name}")


def _verify_envelope(
    release: Release, row: Row, path: Path, public_key: bytes, expect: str, artifacts: Path
) -> None:
    """statements.json verification_order, then the release checks."""
    envelope = _envelope(release, path)
    keyid = sha256_hex(public_key)
    signature = envelope["signatures"][0]
    if keyid != expect or signature["keyid"] != keyid:
        fail(
            f"{row.statement}: keyid {signature['keyid']} is not the {release.signing_purpose} key {expect}",
            "key-unknown",
        )
    payload = b64_strict(envelope["payload"], f"{row.statement} payload")
    sig = b64_strict(signature["sig"], f"{row.statement} sig")
    if not ed25519_verify_strict(public_key, pae(envelope["payloadType"], payload), sig):
        fail(f"{row.statement}: the signature does not verify", "signature-invalid")
    _check_payload(release, row, payload, artifacts)


def _verify_all(release: Release, artifacts: Path, statements: Path, public_key: Path, expect: str) -> None:
    rows = _os_rows(release)
    present = {p.name for p in statements.glob("*.release.dsse.json")}
    expected = {r.statement for r in rows}
    if present != expected:
        fail(f"statements {sorted(present)} are not the planned set {sorted(expected)}")
    raw = spki_pem_public_key(public_key.read_text(encoding="ascii"), public_key.name)
    for row in rows:
        _verify_envelope(release, row, statements / row.statement, raw, expect, artifacts)
        print(f"verified {row.statement}")


def cmd_verify(release: Release, args: argparse.Namespace) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", args.expect_keyid or ""):
        fail("--expect-keyid must be a lowercase hex SHA-256 keyid")
    _verify_all(
        release, Path(args.artifacts), Path(args.statements), Path(args.public_key), args.expect_keyid
    )


def cmd_signature_vectors(release: Release, args: argparse.Namespace) -> None:
    """The verifier against the contract's verify_strict vectors."""
    path = (
        Path(args.vectors)
        if args.vectors
        else release.contract / "fixtures" / "dsse" / "signature-vectors.json"
    )
    vectors = read_json(path)["vectors"]
    results = []
    for v in vectors:
        got = ed25519_verify_strict(
            bytes.fromhex(v["public_key_hex"]),
            bytes.fromhex(v["message_hex"]),
            bytes.fromhex(v["signature_hex"]),
        )
        results.append({"id": v["id"], "expected": v["verify_strict"], "verified": got})
    print(json.dumps(results, indent=2))
    wrong = [r["id"] for r in results if r["expected"] != r["verified"]]
    if wrong:
        fail(f"the verifier disagrees with the contract's verify_strict on {wrong}")


def cmd_notes(release: Release, args: argparse.Namespace) -> None:
    """The GitHub release body, from the plan: what ships and what does not."""
    repo = _require_env("GITHUB_REPOSITORY")
    rows = release.rows()
    unbuildable = release.facts["suderra_os"].get("unbuildable", {})
    os_lines = [
        f"- `{r.artifact}` and `{r.statement}` ({r.id}, {r.arch})" for r in rows if r.channel == CHANNEL_OS
    ]
    skipped = [
        f"- `{board}`: no release in this version ({entry['blocked_by']}). {entry['reason']}"
        for board, entry in sorted(unbuildable.items())
    ]
    generic_lines = [f"- `{r.artifact}` ({r.id})" for r in rows if r.channel == CHANNEL_GENERIC]
    identity = f"https://github.com/{repo}/.github/workflows/edge-agent-release.yml@refs/tags/{args.tag}"
    text = "\n".join(
        [
            f"## Suderra Edge Agent {args.tag}",
            "",
            "Tag-only release built from a commit reachable from `origin/main`, after the",
            "gateway CI and the profile CI passed on that commit.",
            "`edge-release-manifest.json` lists every file with its digest.",
            "",
            "### Suderra OS channel (ADR-048)",
            "",
            "Each archive holds exactly `suderra-agent` and carries its Ed25519 DSSE release",
            f"statement (`{STATEMENT_TYPE}`, {release.signing_purpose} key `{args.statement_keyid}`).",
            "Suderra OS installs it only through a signed provisioning manifest that names",
            "the statement; root verifies the statement and both digests.",
            "",
            *os_lines,
            "",
            "Boards of `contracts/suderra-edge/v1/boards.json` this version does not ship:",
            "",
            *(skipped or ["- none"]),
            "",
            "### Generic-Linux channel (ADR-048 DEC-28)",
            "",
            "Each archive holds `edge-agent`; the cloud's installer and update scripts fetch it.",
            "",
            *generic_lines,
            "",
            "### Provenance",
            "",
            "Every file carries `.sig`/`.pem` cosign keyless signature material, plus `.sha256`,",
            "`.cargo-metadata.sbom.json`, `.intoto.jsonl` and `.NOTICE.md` per artifact. Devices",
            "trust only the Ed25519 statement (DEC-3.8). Verify a signature:",
            "",
            "```bash",
            "cosign verify-blob \\",
            "  --certificate <file>.pem \\",
            "  --signature <file>.sig \\",
            f'  --certificate-identity "{identity}" \\',
            '  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \\',
            "  <file>",
            "```",
            "",
        ]
    )
    Path(args.out).write_text(text, encoding="utf-8")
    print(args.out)


def _file_entry(directory: Path, name: str) -> dict[str, Any]:
    path = directory / name
    if not path.is_file():
        fail(f"release manifest missing artifact: {name}")
    data = path.read_bytes()
    return {"name": name, "sha256": sha256_hex(data), "bytes": len(data)}


def _signed(directory: Path, name: str) -> dict[str, Any]:
    entry = _file_entry(directory, name)
    entry["signature"] = _file_entry(directory, f"{name}.sig")
    entry["certificate"] = _file_entry(directory, f"{name}.pem")
    return entry


def cmd_manifest(release: Release, args: argparse.Namespace) -> None:
    directory = Path(args.artifacts)
    entries = []
    for row in release.rows():
        archive = _signed(directory, row.artifact)
        archive["checksum"] = _file_entry(directory, f"{row.artifact}.sha256")
        entry: dict[str, Any] = {
            "channel": row.channel,
            "target": row.id,
            "arch": row.arch,
            "rust_target": row.rust_target,
            "cargo_features": list(row.features),
            "binary_name": row.binary_name,
            "archive": archive,
            "sbom": _signed(directory, f"{row.base}.cargo-metadata.sbom.json"),
            "provenance": _signed(directory, f"{row.base}.intoto.jsonl"),
            "notice": _signed(directory, f"{row.base}.NOTICE.md"),
        }
        if row.channel == CHANNEL_OS:
            entry["release_statement"] = _signed(directory, row.statement)
        entries.append(entry)
    repo = _require_env("GITHUB_REPOSITORY")
    manifest = {
        "schema_version": 2,
        "kind": "suderra.edge.release.manifest",
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "release": {
            "tag": args.tag,
            "version": release.version,
            "channel": args.channel,
            "prerelease": args.prerelease == "true",
            "repository": repo,
            "commit": _require_env("GITHUB_SHA"),
            "workflow": _require_env("GITHUB_WORKFLOW"),
            "workflow_ref": _require_env("GITHUB_WORKFLOW_REF"),
            "workflow_run_id": _require_env("GITHUB_RUN_ID"),
        },
        "signing": {
            "release_statements": {
                "statement_type": STATEMENT_TYPE,
                "purpose": release.signing_purpose,
                "keyid": args.statement_keyid,
            },
            "provenance": {
                "mode": "cosign-keyless",
                "oidc_issuer": "https://token.actions.githubusercontent.com",
                "certificate_identity": f"https://github.com/{repo}/.github/workflows/edge-agent-release.yml@refs/tags/{args.tag}",
            },
        },
        "artifacts": entries,
    }
    out = directory / "edge-release-manifest.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(str(out))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="edge_release.py", description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--facts", default=str(DEFAULT_FACTS), help="release facts TOML")
    parser.add_argument("--cargo-toml", default=str(DEFAULT_CARGO_TOML), help="agent Cargo.toml")
    parser.add_argument("--contract", default=str(CONTRACT), help="contracts/suderra-edge/v1 directory")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("plan", help="build and test matrices")
    p.add_argument("--expect-version")
    p.add_argument("--github-output")

    p = sub.add_parser("package", help="ELF check and deterministic tarball")
    p.add_argument("--channel", required=True, choices=[CHANNEL_OS, CHANNEL_GENERIC])
    p.add_argument("--id", required=True, help="board_profile or generic slug")
    p.add_argument("--binary", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--source-date-epoch", type=int)

    p = sub.add_parser("provenance", help="in-toto SLSA provenance of every planned artifact")
    p.add_argument("--artifacts", required=True)
    p.add_argument("--tag", required=True)
    p.add_argument("--out-dir", required=True)

    p = sub.add_parser("statements", help="unsigned release statement payloads")
    p.add_argument("--artifacts", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--expect-version")

    p = sub.add_parser("sign", help="DSSE envelopes with the edge-release key")
    p.add_argument("--artifacts", required=True)
    p.add_argument("--payloads", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--key-env", required=True, help="environment variable holding the PKCS#8 PEM key")
    p.add_argument("--expect-keyid", required=True)

    p = sub.add_parser("verify", help="verify every planned release statement")
    p.add_argument("--artifacts", required=True)
    p.add_argument("--statements", required=True)
    p.add_argument("--public-key", required=True)
    p.add_argument("--expect-keyid", required=True)

    p = sub.add_parser("check-envelope", help="key-free checks of one release statement")
    p.add_argument("--envelope", required=True)

    p = sub.add_parser("signature-vectors", help="the Ed25519 verifier against the contract vectors")
    p.add_argument("--vectors", help="default: the contract's fixtures/dsse/signature-vectors.json")

    p = sub.add_parser("notes", help="the GitHub release body")
    p.add_argument("--tag", required=True)
    p.add_argument("--statement-keyid", required=True)
    p.add_argument("--out", required=True)

    p = sub.add_parser("manifest", help="index of every published file")
    p.add_argument("--artifacts", required=True)
    p.add_argument("--tag", required=True)
    p.add_argument("--channel", required=True)
    p.add_argument("--prerelease", required=True, choices=["true", "false"])
    p.add_argument("--statement-keyid", required=True)

    args = parser.parse_args(argv)
    commands: dict[str, Callable[[Release, argparse.Namespace], None]] = {
        "plan": cmd_plan,
        "package": cmd_package,
        "provenance": cmd_provenance,
        "statements": cmd_statements,
        "sign": cmd_sign,
        "verify": cmd_verify,
        "check-envelope": cmd_check_envelope,
        "signature-vectors": cmd_signature_vectors,
        "notes": cmd_notes,
        "manifest": cmd_manifest,
    }
    try:
        release = Release(Path(args.facts), Path(args.cargo_toml), Path(args.contract))
        commands[args.command](release, args)
    except ReleaseError as e:
        reason = f" [{e.reason}]" if e.reason else ""
        sys.stderr.write(f"edge_release: error{reason}: {e}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
