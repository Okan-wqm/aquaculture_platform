"""ARIA-HIGH-434 — the file tools of the Z.ai write runtime, executed INSIDE the room.

WHY A CHILD. The kernel's tool loop (``zai_tool_loop``) runs outside every
sandbox: it holds the Z.ai credential and the kernel's store. What a tool
call DOES must happen where the Claude implementer's tools happen — inside
the bwrap room the write containment builds (READONLY_PATHS read-only at the
syscall level, the profile's write scope, the git containment) — so a Write
the gate admitted still meets EROFS on a path the room does not open. The
loop therefore never touches the workspace itself: it runs this file, by
path, under ``python -I`` inside the room, one call per room.

WHAT. Read, Write, Edit, Glob and Grep with the Claude Code tools' input
shapes and output conventions (``cat -n`` numbered reads of 2000 lines,
2000-character lines, an Edit that needs a unique ``old_string`` unless
``replace_all``). Bash is not here: the room runs the command line itself
under ``bash -c``, the shell the CLI's own Bash tool uses.

Standard library only, imported nothing from the kernel or the workspace:
``-I`` keeps the agent-writable tree off ``sys.path``, the same reason the
hook client and the MCP relay run isolated (ARIA-HIGH-124 round 2).

Protocol: one JSON object on stdin ``{"tool", "input", "workspace"}``, one on
stdout ``{"ok", "content", "meta"}``; exit 0 whenever an answer was written.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import sys
from pathlib import Path

READ_DEFAULT_LINES = 2000
READ_MAX_LINE_CHARS = 2000
OUTPUT_MAX_CHARS = 30000
GLOB_MAX_RESULTS = 100
GREP_MAX_FILE_BYTES = 4 << 20
BINARY_SNIFF_BYTES = 8192
# Directory names no search descends into: the repository's own git dir and
# the installed dependency tree. A search over `node_modules` is never what
# an implementer asked, and ripgrep — what the CLI's search tools run —
# skips both by default (`.git` as hidden, `node_modules` by .gitignore).
SKIPPED_DIRS = frozenset({".git", "node_modules"})


class ToolError(Exception):
    """A refusal or failure the model reads as the tool's error result."""


def _target(raw: object, workspace: Path, *, key: str = "file_path") -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise ToolError(f"{key} is required")
    path = Path(raw)
    return path if path.is_absolute() else workspace / path


def _hidden(relative: Path) -> bool:
    return any(part.startswith(".") for part in relative.parts)


def _read(arguments: dict, workspace: Path) -> tuple[str, dict]:
    path = _target(arguments.get("file_path"), workspace)
    if path.is_dir():
        raise ToolError(f"EISDIR: {path} is a directory")
    data = path.read_bytes()
    if b"\0" in data[:BINARY_SNIFF_BYTES]:
        raise ToolError(f"{path} is a binary file")
    lines = data.decode("utf-8", errors="replace").splitlines()
    offset = arguments.get("offset")
    limit = arguments.get("limit")
    start = max(1, int(offset)) if isinstance(offset, int) else 1
    count = max(1, int(limit)) if isinstance(limit, int) else READ_DEFAULT_LINES
    shown = lines[start - 1:start - 1 + count]
    if not lines:
        return "(the file is empty)", {"lines": 0}
    body = "\n".join(
        f"{number:6}\t{line[:READ_MAX_LINE_CHARS]}" for number, line in enumerate(shown, start=start)
    )
    return body, {"lines": len(lines), "shown": len(shown)}


def _write(arguments: dict, workspace: Path) -> tuple[str, dict]:
    path = _target(arguments.get("file_path"), workspace)
    content = arguments.get("content")
    if not isinstance(content, str):
        raise ToolError("content is required")
    existed = path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    verb = "updated" if existed else "created"
    return f"File {verb} successfully at: {path}", {"filePath": str(path), "type": "update" if existed else "create"}


def _edit(arguments: dict, workspace: Path) -> tuple[str, dict]:
    path = _target(arguments.get("file_path"), workspace)
    old = arguments.get("old_string")
    new = arguments.get("new_string")
    if not isinstance(old, str) or not isinstance(new, str):
        raise ToolError("old_string and new_string are required")
    if old == new:
        raise ToolError("old_string and new_string are identical; nothing to change")
    text = path.read_text(encoding="utf-8")
    found = text.count(old) if old else 0
    if found == 0:
        raise ToolError("old_string was not found in the file")
    if found > 1 and arguments.get("replace_all") is not True:
        raise ToolError(f"old_string occurs {found} times; give more context to make it unique, or set replace_all")
    path.write_text(text.replace(old, new) if arguments.get("replace_all") is True else text.replace(old, new, 1),
                    encoding="utf-8")
    return f"The file {path} has been updated.", {"filePath": str(path), "replacements": found if arguments.get("replace_all") is True else 1}


def _walk(root: Path):
    if root.is_file():
        yield root
        return
    for directory, names, files in os.walk(root):
        names[:] = sorted(name for name in names if name not in SKIPPED_DIRS and not name.startswith("."))
        for name in sorted(files):
            if not name.startswith("."):
                yield Path(directory) / name


def _glob(arguments: dict, workspace: Path) -> tuple[str, dict]:
    pattern = arguments.get("pattern")
    if not isinstance(pattern, str) or not pattern.strip():
        raise ToolError("pattern is required")
    root = _target(arguments.get("path") or str(workspace), workspace, key="path")
    if not root.is_dir():
        raise ToolError(f"{root} is not a directory")
    matches = []
    for path in root.glob(pattern):
        relative = path.relative_to(root)
        if not path.is_file() or _hidden(relative) or SKIPPED_DIRS & set(relative.parts):
            continue
        matches.append(path)
    matches.sort(key=lambda p: (-p.stat().st_mtime, str(p)))
    shown = matches[:GLOB_MAX_RESULTS]
    body = "\n".join(str(p) for p in shown) or "No files found"
    if len(matches) > GLOB_MAX_RESULTS:
        body += f"\n(Results are truncated: {len(matches) - GLOB_MAX_RESULTS} more files)"
    return body, {"numFiles": len(matches)}


def _grep(arguments: dict, workspace: Path) -> tuple[str, dict]:
    pattern = arguments.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        raise ToolError("pattern is required")
    try:
        regex = re.compile(pattern, re.IGNORECASE if arguments.get("-i") is True else 0)
    except re.error as exc:
        raise ToolError(f"invalid regex: {exc}") from exc
    root = _target(arguments.get("path") or str(workspace), workspace, key="path")
    file_glob = arguments.get("glob") if isinstance(arguments.get("glob"), str) else None
    mode = arguments.get("output_mode") or "files_with_matches"
    if mode not in ("files_with_matches", "content", "count"):
        raise ToolError(f"unknown output_mode {mode!r}")
    head_limit = arguments.get("head_limit") if isinstance(arguments.get("head_limit"), int) else None
    out: list[str] = []
    files = 0
    for path in _walk(root):
        if file_glob and not (fnmatch.fnmatch(path.name, file_glob) or fnmatch.fnmatch(str(path), file_glob)):
            continue
        try:
            if path.stat().st_size > GREP_MAX_FILE_BYTES:
                continue
            data = path.read_bytes()
        except OSError:
            continue
        if b"\0" in data[:BINARY_SNIFF_BYTES]:
            continue
        hits = [(n, line) for n, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), start=1)
                if regex.search(line)]
        if not hits:
            continue
        files += 1
        if mode == "files_with_matches":
            out.append(str(path))
        elif mode == "count":
            out.append(f"{path}:{len(hits)}")
        else:
            out.extend(f"{path}:{n}:{line[:READ_MAX_LINE_CHARS]}" for n, line in hits)
    if head_limit is not None:
        out = out[:max(0, head_limit)]
    body = "\n".join(out) or "No matches found"
    return body, {"numFiles": files}


TOOLS = {"Read": _read, "Write": _write, "Edit": _edit, "Glob": _glob, "Grep": _grep}


def main() -> int:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        tool = request.get("tool")
        handler = TOOLS.get(tool) if isinstance(tool, str) else None
        if handler is None:
            raise ToolError(f"unknown room tool {tool!r}")
        arguments = request.get("input") if isinstance(request.get("input"), dict) else {}
        content, meta = handler(arguments, Path(str(request.get("workspace") or os.getcwd())))
        answer = {"ok": True, "content": content[:OUTPUT_MAX_CHARS], "meta": meta}
    except ToolError as exc:
        answer = {"ok": False, "content": str(exc)[:OUTPUT_MAX_CHARS], "meta": {}}
    except (OSError, UnicodeError, ValueError) as exc:
        answer = {"ok": False, "content": f"{type(exc).__name__}: {exc}"[:OUTPUT_MAX_CHARS], "meta": {}}
    sys.stdout.write(json.dumps(answer))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
