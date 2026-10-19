"""ARIA-MEDIUM-563 — the one reader of a credential the kernel holds for a provider,
and of every kernel-held credential FILE (``read_secret_file``: the Jev
transport reads its key through it too).

A provider credential the kernel uses on a room's behalf (the Anthropic
gateway's token, the Z.ai transport's key) lives OUTSIDE every room: in a
regular file readable by its owner alone, named by the fleet row's
``credential_file_env`` (``model_fleet``), or — for CI-secret injection, where
the fleet row names one — in the value variable ``credential_env``. This
module is the boundary both consumers read through, so the rules are stated
once:

* one source: a file AND a value named at once is ambiguous, and refused —
  a stale one of the pair would otherwise decide silently;
* the file is opened without following a symlink and judged on the
  descriptor it is read from: a regular file owned by this euid whose mode
  grants nothing beyond its owner (``mode & 0o077 == 0``), at most
  ``MAX_CREDENTIAL_FILE_BYTES``, holding exactly one line of printable ASCII
  with no space (anything else would be header text the gateway writes);
* the file lies outside every tree a room is given — the kernel's own
  checkout (rooms bind its code, its worktrees are their workspaces), the
  host roots every room binds read-only (``implementation_safety
  .room_host_roots``: the system roots and the kernel's interpreter; rooms
  run as the kernel's uid, so a 0600 file there is readable inside every
  room) and any tree the caller names — so no room can read what the
  gateway injects.

The value is held in a :class:`ProviderCredential` whose repr, str and
dataclass fields never show it, used once per call to build a header, and
re-read per call: a rotated or re-minted token is picked up without a
restart. Refusals name a reason and never carry the value.

Usage (the workflows' presence check reads the same boundary)::

    python3 -m aria_kernel.provider_credentials check <provider>
"""
from __future__ import annotations

import os
import re
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Sequence

from .model_fleet import Provider, fleet_provider

# The kernel's checkout: the code every broker-served room binds read-only,
# and the parent of the worktrees rooms run in.
KERNEL_CHECKOUT_ROOT = Path(__file__).resolve().parents[2]
MAX_CREDENTIAL_FILE_BYTES = 4096
# One line of printable ASCII, no space: a token, never header text.
_SECRET_LINE = re.compile(r"[\x21-\x7e]+")


class CredentialFileRefused(Exception):
    """A named reason a credential file was not read. Never carries the value."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


class ProviderCredentialUnavailable(RuntimeError):
    """A named reason a provider's credential could not be established."""

    def __init__(self, reason: str, detail: str = "", *, provider: str = "") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail
        self.provider = provider


@dataclass(frozen=True)
class ProviderCredential:
    """The secret, held once, exposed only as a header value."""

    provider: str
    source: str
    """``file`` or ``env`` — which boundary supplied it. Never the value."""
    location: str
    """The file path or the env var NAME. Never the value."""
    _secret: str = field(repr=False, compare=False, default="")

    def header_value(self, scheme: str = "Bearer ") -> str:
        return scheme + self._secret

    def authorization_header(self) -> str:
        return self.header_value("Bearer ")

    def __str__(self) -> str:
        return f"ProviderCredential(provider={self.provider}, source={self.source})"

    def __repr__(self) -> str:
        return f"ProviderCredential(provider={self.provider!r}, source={self.source!r}, location={self.location!r})"


def _refuse(provider: Provider, reason: str, detail: str) -> ProviderCredentialUnavailable:
    return ProviderCredentialUnavailable(reason, detail, provider=provider.key)


def _inside(path: Path, trees: Sequence[Path]) -> Path | None:
    for tree in trees:
        try:
            root = Path(tree).resolve()
        except OSError:
            continue
        if path.is_relative_to(root):
            return root
    return None


def room_given_trees(room_trees: Sequence[Path] = ()) -> tuple[Path, ...]:
    """Every tree a room may be given: the kernel's checkout, the host roots
    the room builder binds into every room, and the caller's own."""
    from .implementation_safety import room_host_roots

    return (KERNEL_CHECKOUT_ROOT, *room_host_roots(), *room_trees)


def read_secret_file(file_path: str | Path, *, room_trees: Sequence[Path] = ()) -> str:
    """The one line a kernel-held credential file holds, or a refusal by name."""
    path = Path(file_path)
    tree = _inside(path.resolve(), room_given_trees(room_trees))
    if tree is not None:
        raise CredentialFileRefused("credential_file_in_room_tree",
                                    f"{path} lies inside {tree}, which a room is given; keep the file outside "
                                    "every checkout and system root (e.g. ~/.config/aria/)")
    # O_NONBLOCK: a FIFO opens at once and is refused below, never waited on.
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:  # absent, unreadable, or a symlink (ELOOP)
        raise CredentialFileRefused("credential_file_unreadable", type(exc).__name__) from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise CredentialFileRefused("credential_file_unreadable", "not a regular file")
        if info.st_uid != os.geteuid():
            raise CredentialFileRefused("credential_file_owner", f"{path} is not owned by uid {os.geteuid()}")
        if info.st_mode & 0o077:
            raise CredentialFileRefused(
                "credential_file_permissions",
                f"{path} mode {stat.S_IMODE(info.st_mode):04o} is readable beyond its owner; chmod 0600")
        data = os.read(descriptor, MAX_CREDENTIAL_FILE_BYTES + 1)
    except OSError as exc:
        raise CredentialFileRefused("credential_file_unreadable", type(exc).__name__) from exc
    finally:
        os.close(descriptor)
    if len(data) > MAX_CREDENTIAL_FILE_BYTES:
        raise CredentialFileRefused("credential_file_too_large", f"over {MAX_CREDENTIAL_FILE_BYTES} bytes")
    secret = data[:-1] if data.endswith(b"\n") else data
    if not secret:
        raise CredentialFileRefused("credential_file_empty", "expected exactly one non-empty line")
    if not _SECRET_LINE.fullmatch(secret.decode("latin-1")):
        raise CredentialFileRefused("credential_file_malformed", "expected one line of printable ASCII, no space")
    return secret.decode("ascii")


def _read_file(provider: Provider, file_path: str, room_trees: Sequence[Path]) -> ProviderCredential:
    try:
        secret = read_secret_file(file_path, room_trees=room_trees)
    except CredentialFileRefused as exc:
        raise _refuse(provider, exc.reason, exc.detail) from exc
    return ProviderCredential(provider=provider.key, source="file", location=str(file_path), _secret=secret)


def read_provider_credential(
    provider_key: str, environ: Mapping[str, str] | None = None, *, room_trees: Sequence[Path] = (),
) -> ProviderCredential:
    """Establish ``provider_key``'s credential from ONE boundary, refusing by name otherwise."""
    provider = fleet_provider(provider_key)
    env = os.environ if environ is None else environ
    file_env, value_env = provider.credential_file_env, provider.credential_env
    if file_env is None and value_env is None:
        raise _refuse(provider, "credential_boundary_undeclared", f"the fleet row {provider.key!r} names none")
    file_path = str(env.get(file_env, "") if file_env else "").strip()
    value = str(env.get(value_env, "") if value_env else "").strip()
    if file_path and value:
        raise _refuse(provider, "credential_sources_ambiguous", f"both {file_env} and {value_env} are set; keep one")
    if file_path:
        return _read_file(provider, file_path, room_trees)
    if value:
        return ProviderCredential(provider=provider.key, source="env", location=str(value_env), _secret=value)
    named = " or ".join(name for name in (f"{file_env} (a 0600 file)" if file_env else "", value_env or "") if name)
    raise _refuse(provider, "credential_not_configured", f"set {named}")


def main(argv: Sequence[str]) -> int:
    if len(argv) != 2 or argv[0] != "check":
        sys.stderr.write("usage: python3 -m aria_kernel.provider_credentials check <provider>\n")
        return 2
    try:
        credential = read_provider_credential(argv[1])
    except ProviderCredentialUnavailable as exc:
        sys.stdout.write(f"refused:{exc}\n")
        return 1
    sys.stdout.write(f"ok:{credential.source}:{credential.location}\n")
    return 0


__all__ = [
    "CredentialFileRefused", "KERNEL_CHECKOUT_ROOT", "MAX_CREDENTIAL_FILE_BYTES", "ProviderCredential",
    "ProviderCredentialUnavailable", "read_provider_credential", "read_secret_file", "room_given_trees",
]


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
