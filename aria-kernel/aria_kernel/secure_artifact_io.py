"""Descriptor-relative, non-following I/O for security proof artifacts."""
from __future__ import annotations

import hashlib
import json
import os
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterator

from .tool_registry import GovernanceError


@dataclass(frozen=True, slots=True)
class RegularFileSnapshot:
    data: bytes
    sha256: str
    size_bytes: int


@dataclass(frozen=True, slots=True)
class _DirectoryBinding:
    parent_fd: int
    name: str
    classified: os.stat_result
    child_fd: int


def load_json_object_bytes(data: bytes) -> dict[str, Any]:
    """Decode a closed JSON object while rejecting duplicate keys at any depth."""
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        for key, value in pairs:
            if key in payload:
                raise GovernanceError("secure_artifact_json_duplicate_key")
            payload[key] = value
        return payload

    try:
        payload = json.loads(
            data.decode("utf-8"),
            object_pairs_hook=reject_duplicates,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GovernanceError("secure_artifact_json_invalid") from exc
    if not isinstance(payload, dict):
        raise GovernanceError("secure_artifact_json_not_object")
    return payload


def normalized_relative_posix(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or "\x00" in value
        or value == "."
    ):
        raise GovernanceError("secure_artifact_relative_path_invalid")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise GovernanceError("secure_artifact_relative_path_invalid")
    normalized = path.as_posix()
    if normalized != value:
        raise GovernanceError("secure_artifact_relative_path_invalid")
    return normalized


def _directory_flags() -> int:
    nofollow = getattr(os, "O_NOFOLLOW", None)
    directory = getattr(os, "O_DIRECTORY", None)
    if nofollow is None or directory is None:
        raise GovernanceError("secure_artifact_nofollow_unavailable")
    return os.O_RDONLY | nofollow | directory | getattr(os, "O_CLOEXEC", 0)


def _directory_identity_fields(value: os.stat_result) -> tuple[int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        stat.S_IFMT(value.st_mode),
    )


def _require_same_directory_identity(
    classified: os.stat_result,
    observed: os.stat_result,
) -> None:
    if (
        not stat.S_ISDIR(classified.st_mode)
        or not stat.S_ISDIR(observed.st_mode)
        or _directory_identity_fields(classified)
        != _directory_identity_fields(observed)
    ):
        raise GovernanceError("secure_artifact_directory_changed")


def _open_bound_root_directory_at(
    parent_fd: int,
    name: str,
    classified: os.stat_result,
) -> int:
    if not stat.S_ISDIR(classified.st_mode):
        raise GovernanceError("secure_artifact_root_not_directory")
    try:
        child_fd = os.open(name, _directory_flags(), dir_fd=parent_fd)
    except OSError as exc:
        raise GovernanceError("secure_artifact_root_not_directory") from exc
    try:
        _require_same_directory_identity(classified, os.fstat(child_fd))
    except Exception:
        os.close(child_fd)
        raise
    return child_fd


def _verify_root_directory_bindings(
    bindings: list[_DirectoryBinding],
) -> None:
    for binding in reversed(bindings):
        try:
            live = os.lstat(binding.name, dir_fd=binding.parent_fd)
        except OSError as exc:
            raise GovernanceError("secure_artifact_directory_changed") from exc
        _require_same_directory_identity(binding.classified, live)
        _require_same_directory_identity(
            binding.classified,
            os.fstat(binding.child_fd),
        )


@contextmanager
def secure_directory_fd(path: str | Path, *, create: bool = False) -> Iterator[int]:
    raw = os.fspath(path)
    if not isinstance(raw, str) or any(
        component in {".", ".."} for component in raw.split(os.sep)
    ):
        raise GovernanceError("secure_artifact_root_path_invalid")
    absolute = Path(path).absolute()
    parts = absolute.parts
    if not parts or parts[0] != os.sep:
        raise GovernanceError("secure_artifact_root_not_absolute")
    current = os.open(os.sep, _directory_flags())
    owned_fds = [current]
    bindings: list[_DirectoryBinding] = []
    try:
        for component in parts[1:]:
            try:
                classified = os.lstat(component, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise GovernanceError("secure_artifact_root_missing")
                try:
                    os.mkdir(component, mode=0o755, dir_fd=current)
                except FileExistsError:
                    pass
                try:
                    classified = os.lstat(component, dir_fd=current)
                except OSError as exc:
                    raise GovernanceError(
                        "secure_artifact_root_not_directory"
                    ) from exc
            except OSError as exc:
                raise GovernanceError("secure_artifact_root_not_directory") from exc
            child = _open_bound_root_directory_at(
                current,
                component,
                classified,
            )
            bindings.append(
                _DirectoryBinding(
                    parent_fd=current,
                    name=component,
                    classified=classified,
                    child_fd=child,
                )
            )
            owned_fds.append(child)
            current = child
        root_stat = os.fstat(current)
        if not stat.S_ISDIR(root_stat.st_mode):
            raise GovernanceError("secure_artifact_root_not_directory")
        yield current
        _verify_root_directory_bindings(bindings)
    finally:
        for fd in reversed(owned_fds):
            os.close(fd)


def _open_parent_fd(root_fd: int, relative: str, *, create: bool = False) -> tuple[int, str]:
    parts = normalized_relative_posix(relative).split("/")
    current = os.dup(root_fd)
    try:
        for component in parts[:-1]:
            try:
                child = os.open(component, _directory_flags(), dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise GovernanceError("secure_artifact_parent_missing")
                try:
                    os.mkdir(component, mode=0o755, dir_fd=current)
                except FileExistsError:
                    pass
                child = os.open(component, _directory_flags(), dir_fd=current)
            except OSError as exc:
                raise GovernanceError("secure_artifact_parent_not_directory") from exc
            os.close(current)
            current = child
        return current, parts[-1]
    except Exception:
        os.close(current)
        raise


def _stable_stat_fields(value: os.stat_result) -> tuple[int, ...]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_nlink,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _require_same_entry(
    classified: os.stat_result,
    observed: os.stat_result,
    *,
    error: str,
) -> None:
    if _stable_stat_fields(classified) != _stable_stat_fields(observed):
        raise GovernanceError(error)


def _open_classified_directory_at(
    parent_fd: int,
    name: str,
    classified: os.stat_result,
) -> int:
    if not stat.S_ISDIR(classified.st_mode):
        raise GovernanceError("secure_artifact_directory_not_regular")
    try:
        child_fd = os.open(name, _directory_flags(), dir_fd=parent_fd)
    except OSError as exc:
        raise GovernanceError("secure_artifact_directory_unreadable") from exc
    try:
        opened = os.fstat(child_fd)
        if not stat.S_ISDIR(opened.st_mode):
            raise GovernanceError("secure_artifact_directory_not_regular")
        _require_same_entry(
            classified,
            opened,
            error="secure_artifact_directory_changed",
        )
    except Exception:
        os.close(child_fd)
        raise
    return child_fd


def _open_directory_chain_at(
    root_fd: int,
    components: tuple[str, ...],
) -> tuple[int, list[_DirectoryBinding], list[int]] | None:
    current = os.dup(root_fd)
    owned_fds = [current]
    bindings: list[_DirectoryBinding] = []
    try:
        for component in components:
            try:
                classified = os.lstat(component, dir_fd=current)
            except FileNotFoundError:
                _verify_directory_bindings(bindings)
                for fd in reversed(owned_fds):
                    os.close(fd)
                return None
            except OSError as exc:
                raise GovernanceError(
                    "secure_artifact_directory_unreadable"
                ) from exc
            child_fd = _open_classified_directory_at(
                current,
                component,
                classified,
            )
            bindings.append(
                _DirectoryBinding(
                    parent_fd=current,
                    name=component,
                    classified=classified,
                    child_fd=child_fd,
                )
            )
            owned_fds.append(child_fd)
            current = child_fd
        return current, bindings, owned_fds
    except Exception:
        for fd in reversed(owned_fds):
            os.close(fd)
        raise


def _verify_directory_bindings(bindings: list[_DirectoryBinding]) -> None:
    for binding in reversed(bindings):
        try:
            live = os.lstat(binding.name, dir_fd=binding.parent_fd)
        except OSError as exc:
            raise GovernanceError("secure_artifact_directory_changed") from exc
        _require_same_entry(
            binding.classified,
            live,
            error="secure_artifact_directory_changed",
        )
        _require_same_entry(
            binding.classified,
            os.fstat(binding.child_fd),
            error="secure_artifact_directory_changed",
        )


def _read_open_regular_fd(
    fd: int,
    before: os.stat_result,
) -> RegularFileSnapshot:
    chunks: list[bytes] = []
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        chunks.append(chunk)
    after = os.fstat(fd)
    data = b"".join(chunks)
    if _stable_stat_fields(before) != _stable_stat_fields(after) or len(data) != after.st_size:
        raise GovernanceError("secure_artifact_file_changed_during_read")
    return RegularFileSnapshot(
        data=data,
        sha256="sha256:" + hashlib.sha256(data).hexdigest(),
        size_bytes=len(data),
    )


def _read_classified_regular_at(
    parent_fd: int,
    name: str,
    classified: os.stat_result,
) -> RegularFileSnapshot:
    if not stat.S_ISREG(classified.st_mode) or classified.st_nlink != 1:
        raise GovernanceError("secure_artifact_file_not_regular")
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        raise GovernanceError("secure_artifact_nofollow_unavailable")
    flags = os.O_RDONLY | nofollow | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(name, flags, dir_fd=parent_fd)
    except OSError as exc:
        raise GovernanceError("secure_artifact_file_unreadable") from exc
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise GovernanceError("secure_artifact_file_not_regular")
        _require_same_entry(
            classified,
            opened,
            error="secure_artifact_file_changed",
        )
        snapshot = _read_open_regular_fd(fd, opened)
        try:
            live = os.lstat(name, dir_fd=parent_fd)
        except OSError as exc:
            raise GovernanceError("secure_artifact_file_changed") from exc
        _require_same_entry(
            classified,
            live,
            error="secure_artifact_file_changed",
        )
        return snapshot
    finally:
        os.close(fd)


def open_regular_fd_at(root_fd: int, relative: str) -> tuple[int, os.stat_result]:
    parent_fd, name = _open_parent_fd(root_fd, relative)
    try:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        nofollow = getattr(os, "O_NOFOLLOW", None)
        if nofollow is None:
            raise GovernanceError("secure_artifact_nofollow_unavailable")
        try:
            fd = os.open(name, flags | nofollow, dir_fd=parent_fd)
        except OSError as exc:
            raise GovernanceError("secure_artifact_file_unreadable") from exc
    finally:
        os.close(parent_fd)
    opened = os.fstat(fd)
    if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
        os.close(fd)
        raise GovernanceError("secure_artifact_file_not_regular")
    return fd, opened


def read_regular_file_at(root_fd: int, relative: str) -> RegularFileSnapshot:
    fd, before = open_regular_fd_at(root_fd, relative)
    try:
        return _read_open_regular_fd(fd, before)
    finally:
        os.close(fd)


def read_optional_regular_file_at(
    root_fd: int,
    relative: str,
) -> RegularFileSnapshot | None:
    parts = tuple(normalized_relative_posix(relative).split("/"))
    opened_chain = _open_directory_chain_at(root_fd, parts[:-1])
    if opened_chain is None:
        return None
    parent_fd, bindings, owned_fds = opened_chain
    try:
        try:
            entry = os.lstat(parts[-1], dir_fd=parent_fd)
        except FileNotFoundError:
            _verify_directory_bindings(bindings)
            return None
        snapshot = _read_classified_regular_at(parent_fd, parts[-1], entry)
        _verify_directory_bindings(bindings)
        return snapshot
    finally:
        for fd in reversed(owned_fds):
            os.close(fd)


def read_regular_path(path: str | Path) -> RegularFileSnapshot:
    target = Path(path).absolute()
    with secure_directory_fd(target.parent) as parent_fd:
        return read_regular_file_at(parent_fd, target.name)


def enumerate_regular_snapshots_beneath_at(
    root_fd: int,
    relative_directory: str,
) -> tuple[tuple[str, RegularFileSnapshot], ...]:
    """Snapshot one subtree without following or accepting aliased entries."""
    normalized = normalized_relative_posix(relative_directory)
    opened_chain = _open_directory_chain_at(
        root_fd,
        tuple(normalized.split("/")),
    )
    if opened_chain is None:
        return ()
    current, prefix_bindings, owned_fds = opened_chain
    try:
        snapshots: list[tuple[str, RegularFileSnapshot]] = []

        def visit(directory_fd: int, prefix: str) -> None:
            for name in sorted(os.listdir(directory_fd)):
                relative = f"{prefix}/{name}" if prefix else name
                try:
                    entry = os.lstat(name, dir_fd=directory_fd)
                except OSError as exc:
                    raise GovernanceError("secure_artifact_path_unreadable") from exc
                if stat.S_ISDIR(entry.st_mode):
                    child_fd = _open_classified_directory_at(
                        directory_fd,
                        name,
                        entry,
                    )
                    try:
                        visit(child_fd, relative)
                        try:
                            live = os.lstat(name, dir_fd=directory_fd)
                        except OSError as exc:
                            raise GovernanceError(
                                "secure_artifact_directory_changed"
                            ) from exc
                        _require_same_entry(
                            entry,
                            live,
                            error="secure_artifact_directory_changed",
                        )
                        _require_same_entry(
                            entry,
                            os.fstat(child_fd),
                            error="secure_artifact_directory_changed",
                        )
                    finally:
                        os.close(child_fd)
                    continue
                if not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1:
                    raise GovernanceError("secure_artifact_file_not_regular")
                full_relative = f"{normalized}/{relative}"
                snapshots.append(
                    (
                        full_relative,
                        _read_classified_regular_at(directory_fd, name, entry),
                    )
                )

        visit(current, "")
        _verify_directory_bindings(prefix_bindings)
        return tuple(snapshots)
    finally:
        for fd in reversed(owned_fds):
            os.close(fd)


def enumerate_regular_files_at(
    root_fd: int,
    *,
    allowed_directories: tuple[str, ...] = ("failures",),
) -> tuple[str, ...]:
    files: list[str] = []

    def visit(directory_fd: int, prefix: str) -> None:
        for name in sorted(os.listdir(directory_fd)):
            relative = f"{prefix}/{name}" if prefix else name
            try:
                entry = os.lstat(name, dir_fd=directory_fd)
            except OSError as exc:
                raise GovernanceError("secure_artifact_path_unreadable") from exc
            if stat.S_ISDIR(entry.st_mode):
                if relative not in allowed_directories:
                    raise GovernanceError("secure_artifact_directory_unexpected")
                try:
                    child_fd = os.open(name, _directory_flags(), dir_fd=directory_fd)
                except OSError as exc:
                    raise GovernanceError("secure_artifact_directory_unreadable") from exc
                try:
                    visit(child_fd, relative)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(entry.st_mode):
                files.append(normalized_relative_posix(relative))
            else:
                raise GovernanceError("secure_artifact_path_not_regular")

    visit(root_fd, "")
    return tuple(files)


def atomic_write_json_at(root_fd: int, relative: str, payload: dict[str, Any]) -> None:
    parent_fd, name = _open_parent_fd(root_fd, relative, create=True)
    temporary = f".{name}.tmp.{os.getpid()}.{id(payload)}"
    fd: int | None = None
    try:
        try:
            existing = os.lstat(name, dir_fd=parent_fd)
        except FileNotFoundError:
            existing = None
        if existing is not None and (
            not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1
        ):
            raise GovernanceError("secure_artifact_output_not_regular")
        flags = (
            os.O_WRONLY | os.O_CREAT | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        )
        fd = os.open(temporary, flags, 0o644, dir_fd=parent_fd)
        encoded = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
        view = memoryview(encoded)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temporary, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        os.close(parent_fd)


def atomic_write_json_path(path: str | Path, payload: dict[str, Any]) -> None:
    target = Path(path).absolute()
    with secure_directory_fd(target.parent, create=True) as parent_fd:
        atomic_write_json_at(parent_fd, target.name, payload)


@contextmanager
def stable_scan_paths_at(root_fd: int, relatives: tuple[str, ...]) -> Iterator[list[Path]]:
    opened: list[tuple[int, os.stat_result]] = []
    try:
        for relative in relatives:
            opened.append(open_regular_fd_at(root_fd, relative))
        yield [Path(f"/proc/self/fd/{fd}") for fd, _ in opened]
        for fd, before in opened:
            if _stable_stat_fields(before) != _stable_stat_fields(os.fstat(fd)):
                raise GovernanceError("secure_artifact_file_changed_during_scan")
    finally:
        for fd, _ in opened:
            os.close(fd)


__all__ = [
    "RegularFileSnapshot",
    "atomic_write_json_at",
    "atomic_write_json_path",
    "enumerate_regular_files_at",
    "load_json_object_bytes",
    "normalized_relative_posix",
    "read_regular_file_at",
    "read_regular_path",
    "secure_directory_fd",
    "stable_scan_paths_at",
]
