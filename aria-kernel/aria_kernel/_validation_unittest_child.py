"""Private, opt-in unittest observation in the actual validation child.

Only explicitly named, already loaded modules and a closed public environment
subset are observed. Post-run files do not identify imported/executed bytes.
This script deliberately avoids importing aria_kernel's aggregate package.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import time


class _ObservationWork:
    def __init__(self, byte_limit: int, path_limit: int, time_budget: float = 0.250) -> None:
        self.byte_limit = byte_limit
        self.path_limit = path_limit
        self.bytes_read = 0
        self.paths: dict[str, dict] = {}
        self.deadline = time.monotonic() + time_budget

    def expired(self) -> bool:
        return time.monotonic() >= self.deadline

    def file(self, raw_path: str) -> dict:
        if raw_path in self.paths:
            return self.paths[raw_path]
        result = {"status": "unknown", "phase": "post_run", "reason": "input_unreadable"}
        if self.expired():
            return {**result, "reason": "observation_deadline"}
        if len(self.paths) >= self.path_limit:
            return {**result, "reason": "content_path_limit"}
        self.paths[raw_path] = result
        try:
            with Path(raw_path).open("rb", buffering=0) as stream:
                before = os.fstat(stream.fileno())
                if self.expired():
                    result["reason"] = "observation_deadline"
                elif not stat.S_ISREG(before.st_mode):
                    result["reason"] = "not_regular_file"
                elif before.st_size > 2 * 1024 * 1024:
                    result["reason"] = "input_file_byte_limit"
                elif before.st_size > self.byte_limit - self.bytes_read:
                    result["reason"] = "input_total_byte_limit"
                else:
                    data = stream.read(before.st_size)
                    self.bytes_read += len(data)
                    after = os.fstat(stream.fileno())
                    if len(data) != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        result["reason"] = "changed_during_read"
                    else:
                        result = {"status": "available", "phase": "post_run", "size_bytes": len(data),
                                  "content_hash": "sha256:" + hashlib.sha256(data).hexdigest()}
        except FileNotFoundError:
            result["reason"] = "input_missing"
        except (OSError, ValueError, RuntimeError):
            pass
        if self.expired():
            result = {"status": "unknown", "phase": "post_run", "reason": "observation_deadline"}
        self.paths[raw_path] = result
        return result


def _public_environment() -> dict:
    values = {}
    for name in ("PYTHONHASHSEED", "PYTHONUTF8", "PYTHONDONTWRITEBYTECODE", "LC_ALL", "TZ"):
        value = os.environ.get(name)
        if value is None:
            values[name] = {"status": "unknown", "reason": "not_set"}
            continue
        valid = isinstance(value, str) and len(value) <= 64 and value.isascii()
        if valid and name == "PYTHONHASHSEED":
            valid = value == "random" or (value.isdecimal() and len(value) <= 10 and int(value) <= 4294967295)
        elif valid and name in ("PYTHONUTF8", "PYTHONDONTWRITEBYTECODE"):
            valid = value in ("0", "1")
        elif valid and name == "LC_ALL":
            valid = re.fullmatch(r"(?:C|POSIX|[A-Za-z]{2,3}(?:_[A-Za-z]{2})?)(?:\.[A-Za-z0-9-]{1,16})?(?:@[A-Za-z0-9_-]{1,16})?", value) is not None
        elif valid and name == "TZ":
            valid = re.fullmatch(r"(?:UTC|GMT|[A-Za-z][A-Za-z0-9_+-]{0,31}(?:/[A-Za-z][A-Za-z0-9_+-]{0,31}){1,2})", value) is not None
        values[name] = {"status": "available", "value": value} if valid else {"status": "unknown", "reason": "public_value_not_supported"}
    return values


def _module_observations(names: list[str], work: _ObservationWork) -> dict:
    result = {}
    for name in names:
        module = sys.modules.get(name)
        entry = {"presence": "unknown", "reason": "module_not_present_post_run",
                 "executed_content_binding": {"status": "unknown", "reason": "loaded_bytes_not_observed"}}
        result[name] = entry
        if work.expired():
            entry["reason"] = "observation_deadline"
            continue
        if module is None:
            continue
        entry.pop("reason")
        entry["presence"] = "observed_post_run"
        spec = getattr(module, "__spec__", None)
        origin = getattr(spec, "origin", None)
        if origin in ("built-in", "frozen"):
            entry["origin_kind"] = origin
        elif origin is None:
            entry["origin_kind"] = "namespace_or_unknown"
        elif type(origin) is str and 0 < len(origin) <= 2048:
            entry["origin_kind"] = "source" if origin.endswith(".py") else "file_backed"
            entry["origin_file_observation"] = work.file(origin)
            cached = getattr(module, "__cached__", None)
            if type(cached) is str and 0 < len(cached) <= 2048 and not work.expired():
                cache = work.file(cached)
                if cache.get("reason") != "input_missing":
                    entry["cache_file_observation"] = cache
        else:
            entry["origin_kind"] = "unknown"
    return result


def _send_receipt(fd: int, limit: int, byte_limit: int, path_limit: int, modules: list[str], time_budget: float = 0.250) -> None:
    observation_started = time.monotonic()
    work = _ObservationWork(byte_limit, path_limit, time_budget)
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        stable = {
            "interpreter": {"implementation": sys.implementation.name, "version": list(sys.version_info[:3]),
                            "cache_tag": sys.implementation.cache_tag, "byte_order": sys.byteorder,
                            "pointer_bits": struct.calcsize("P") * 8,
                            "flags": {name: getattr(sys.flags, name) for name in ("utf8_mode", "dont_write_bytecode", "hash_randomization")}},
            "public_environment": _public_environment(), "modules": _module_observations(modules, work),
        }
        receipt = {"schema_version": 1, "status": "available", "stable": stable,
                   "observation": {"child_pid": os.getpid(), "phase": "post_run", "started_at": started_at,
                                   "completed_at": datetime.datetime.now(datetime.timezone.utc).isoformat()},
                   "work": {"bytes_read": work.bytes_read, "content_paths": len(work.paths)}}
        # Include bounded receipt preparation in measured active work. A final
        # scalar cannot measure its own later write/close tail.
        json.dumps(receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        receipt["work"]["observation_elapsed_seconds"] = max(0.0, time.monotonic() - observation_started)
        encoded = json.dumps(receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
        reason = "observation_deadline" if work.expired() else "receipt_byte_limit"
        if work.expired() or len(encoded) > limit:
            receipt = {"schema_version": 1, "status": "unknown", "reason": reason, "work": receipt["work"]}
            encoded = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
        if len(encoded) <= limit:
            os.write(fd, encoded)
    except Exception:
        # Observation failure must not replace unittest's original exception or exit.
        pass
    finally:
        try:
            os.close(fd)
        except OSError:
            # Outcome ownership remains unittest's; do not retry an ambiguous close.
            pass


def _main() -> None:
    fd, byte_limit, path_limit, receipt_limit = (int(value) for value in sys.argv[1:5])
    modules = json.loads(sys.argv[5])
    time_budget = float(sys.argv[6])
    if sys.argv[7] != "--":
        raise ValueError("invalid private observation wire")
    arguments = sys.argv[8:]
    sys.path[0] = os.getcwd()
    sys.argv = [os.path.basename(sys.executable) + " -m unittest", *arguments]
    try:
        import unittest
        unittest.main(module=None, argv=sys.argv)
    finally:
        _send_receipt(fd, receipt_limit, byte_limit, path_limit, modules, time_budget)


if __name__ == "__main__":
    _main()
