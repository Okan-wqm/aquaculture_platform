"""Central artifact safety boundary for ARIA executor outputs."""
from __future__ import annotations

import json
import os
import re
import stat
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"(OPENAI_API_KEY|CODEX_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=\S+"),
    re.compile(r"(ARIA_LEASE_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|RUNNER_TOKEN)=\S+"),
    re.compile(r"(gh[psu]_[A-Za-z0-9_]{20,})"),
)

FORBIDDEN_REAL_MODE_ENV: frozenset[str] = frozenset({
    "CODEX_OSS_DEBUG",
})


class ArtifactSafetyError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class SafeArtifact:
    path: Path
    digest: str
    content: bytes
    device: int
    inode: int
    size: int


@dataclass(frozen=True, slots=True)
class DeclaredArtifactRef:
    """Declared write destination for a finalized runtime artifact."""

    path: str | Path
    root: Path
    purpose: str
    max_bytes: int = 5 * 1024 * 1024


def _path_parts_under_root(
    raw_path: str | Path,
    *,
    root: Path,
    purpose: str,
) -> tuple[Path, tuple[str, ...]]:
    if not str(raw_path or "").strip():
        raise ArtifactSafetyError(f"{purpose}_artifact_path_required")
    root_resolved = root.expanduser().resolve(strict=True)
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = root_resolved / candidate
    if ".." in candidate.parts:
        raise ArtifactSafetyError(f"{purpose}_artifact_path_traversal")
    try:
        relative = candidate.relative_to(root_resolved)
    except ValueError as exc:
        raise ArtifactSafetyError(f"{purpose}_artifact_outside_tools_root") from exc
    parts = tuple(part for part in relative.parts if part not in ("", "."))
    if not parts:
        raise ArtifactSafetyError(f"{purpose}_artifact_path_required")
    if any(part == ".." for part in parts):
        raise ArtifactSafetyError(f"{purpose}_artifact_path_traversal")
    return root_resolved, parts


def _nofollow_flag(*, purpose: str) -> int:
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        raise ArtifactSafetyError(f"{purpose}_artifact_nofollow_unavailable")
    return int(nofollow)


def _open_parent_dir(
    *,
    root: Path,
    parts: tuple[str, ...],
    purpose: str,
    create: bool,
) -> int:
    nofollow = _nofollow_flag(purpose=purpose)
    current_fd = os.open(str(root), os.O_RDONLY | os.O_DIRECTORY | nofollow)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, 0o755, dir_fd=current_fd)
                except FileExistsError:
                    pass
            try:
                next_fd = os.open(
                    part,
                    os.O_RDONLY | os.O_DIRECTORY | nofollow,
                    dir_fd=current_fd,
                )
            except OSError as exc:
                raise ArtifactSafetyError(
                    f"{purpose}_artifact_symlink_or_missing_parent"
                ) from exc
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except BaseException:
        os.close(current_fd)
        raise


def read_safe_artifact(
    raw_path: str | Path,
    *,
    root: Path,
    purpose: str,
    missing_error: str | None = None,
    max_bytes: int = 5 * 1024 * 1024,
) -> SafeArtifact:
    root_resolved, parts = _path_parts_under_root(raw_path, root=root, purpose=purpose)
    parent_fd = _open_parent_dir(root=root_resolved, parts=parts, purpose=purpose, create=False)
    file_fd: int | None = None
    try:
        nofollow = _nofollow_flag(purpose=purpose)
        nonblock = getattr(os, "O_NONBLOCK", 0)
        try:
            file_fd = os.open(parts[-1], os.O_RDONLY | nofollow | nonblock, dir_fd=parent_fd)
        except FileNotFoundError as exc:
            raise ArtifactSafetyError(missing_error or f"{purpose}_artifact_not_found") from exc
        except OSError as exc:
            raise ArtifactSafetyError(f"{purpose}_artifact_symlink_or_unopenable") from exc
        st = os.fstat(file_fd)
        if not stat.S_ISREG(st.st_mode):
            raise ArtifactSafetyError(f"{purpose}_artifact_not_regular_file")
        if st.st_nlink > 1:
            raise ArtifactSafetyError(f"{purpose}_artifact_hardlink_forbidden")
        if st.st_size > max_bytes:
            raise ArtifactSafetyError(f"{purpose}_artifact_too_large")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(file_fd, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > max_bytes:
                raise ArtifactSafetyError(f"{purpose}_artifact_too_large")
        content = b"".join(chunks)
        digest = "sha256:" + hashlib.sha256(content).hexdigest()
        return SafeArtifact(
            path=root_resolved.joinpath(*parts),
            digest=digest,
            content=content,
            device=st.st_dev,
            inode=st.st_ino,
            size=st.st_size,
        )
    finally:
        if file_fd is not None:
            os.close(file_fd)
        os.close(parent_fd)


def write_safe_text(
    raw_path: str | Path,
    text: str,
    *,
    root: Path,
    purpose: str,
    max_bytes: int = 5 * 1024 * 1024,
) -> SafeArtifact:
    raw = text.encode("utf-8")
    return safe_finalize_artifact(
        raw,
        DeclaredArtifactRef(
            path=raw_path,
            root=root,
            purpose=purpose,
            max_bytes=max_bytes,
        ),
    )


def safe_finalize_artifact(raw: bytes, ref: DeclaredArtifactRef) -> SafeArtifact:
    """Atomically finalize bytes to a declared no-follow artifact path."""
    if len(raw) > ref.max_bytes:
        raise ArtifactSafetyError(f"{ref.purpose}_artifact_too_large")
    root_resolved, parts = _path_parts_under_root(
        ref.path, root=ref.root, purpose=ref.purpose,
    )
    parent_fd = _open_parent_dir(
        root=root_resolved, parts=parts, purpose=ref.purpose, create=True,
    )
    tmp_name = f".{parts[-1]}.tmp.{os.getpid()}.{hashlib.sha256(raw).hexdigest()[:16]}"
    tmp_fd: int | None = None
    existing_fd: int | None = None
    try:
        nofollow = _nofollow_flag(purpose=ref.purpose)
        nonblock = getattr(os, "O_NONBLOCK", 0)
        try:
            existing_fd = os.open(
                parts[-1],
                os.O_RDONLY | nofollow | nonblock,
                dir_fd=parent_fd,
            )
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise ArtifactSafetyError(
                f"{ref.purpose}_artifact_symlink_or_unopenable"
            ) from exc
        if existing_fd is not None:
            st_existing = os.fstat(existing_fd)
            if not stat.S_ISREG(st_existing.st_mode):
                raise ArtifactSafetyError(f"{ref.purpose}_artifact_not_regular_file")
            if st_existing.st_nlink > 1:
                raise ArtifactSafetyError(f"{ref.purpose}_artifact_hardlink_forbidden")
        try:
            tmp_fd = os.open(
                tmp_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow | nonblock,
                0o644,
                dir_fd=parent_fd,
            )
        except OSError as exc:
            raise ArtifactSafetyError(f"{ref.purpose}_artifact_temp_unopenable") from exc
        os.write(tmp_fd, raw)
        os.fsync(tmp_fd)
        os.close(tmp_fd)
        tmp_fd = None
        os.replace(tmp_name, parts[-1], src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        if tmp_fd is not None:
            os.close(tmp_fd)
        if existing_fd is not None:
            os.close(existing_fd)
        try:
            os.unlink(tmp_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        os.close(parent_fd)
    return read_safe_artifact(
        root_resolved.joinpath(*parts),
        root=root_resolved,
        purpose=ref.purpose,
        max_bytes=ref.max_bytes,
    )


def scrub_text(value: str) -> str:
    out = value
    for pattern in SECRET_PATTERNS:
        out = pattern.sub("<secret-redacted>", out)
    return out


def scrub_json(value: Any) -> Any:
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, list):
        return [scrub_json(item) for item in value]
    if isinstance(value, dict):
        scrubbed: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if any(token in key_text.lower() for token in ("token", "secret", "api_key", "apikey")):
                scrubbed[key_text] = "<secret-redacted>"
            else:
                scrubbed[key_text] = scrub_json(item)
        return scrubbed
    return value


def assert_real_mode_env_safe(env: dict[str, str]) -> None:
    for name in FORBIDDEN_REAL_MODE_ENV:
        if env.get(name) == "1":
            raise ArtifactSafetyError(f"{name}=1 is forbidden in ARIA real mode")


def write_sanitized_json(path: str | Path, payload: Any, *, max_bytes: int = 1_000_000) -> None:
    scrubbed = scrub_json(payload)
    raw = json.dumps(scrubbed, indent=2, sort_keys=True)
    target = Path(path)
    root = target.parent if target.parent != Path("") else Path(".")
    root.mkdir(parents=True, exist_ok=True)
    safe_finalize_artifact(
        (raw + "\n").encode("utf-8"),
        DeclaredArtifactRef(
            path=target.name,
            root=root,
            purpose="json",
            max_bytes=max_bytes,
        ),
    )


__all__ = [
    "ArtifactSafetyError",
    "DeclaredArtifactRef",
    "SafeArtifact",
    "assert_real_mode_env_safe",
    "read_safe_artifact",
    "safe_finalize_artifact",
    "scrub_json",
    "scrub_text",
    "write_safe_text",
    "write_sanitized_json",
]
