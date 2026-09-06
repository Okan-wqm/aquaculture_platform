#!/usr/bin/env python3
"""Declared stream capacity shared by broker generation and deploy admission.

This enforces allocation parity, not measured throughput or outage retention.
SENSOR-CRITICAL-108 retains ownership of those measurements and sizing decisions.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

STORAGE_POLICY = (
    Path(__file__).resolve().parents[2]
    / "platform/libs/event-bus/src/nats/jetstream-storage-policy.json"
)
MAX_SAFE_INTEGER = 9007199254740991


def positive_safe_integer(value: Any) -> bool:
    return type(value) is int and 0 < value <= MAX_SAFE_INTEGER


def load_storage_policy() -> dict[str, Any]:
    policy = json.loads(STORAGE_POLICY.read_text())
    if (
        not isinstance(policy, dict)
        or set(policy) != {"schema_version", "reserve", "streams"}
        or type(policy["schema_version"]) is not int
        or policy["schema_version"] != 1
        or not isinstance(policy["reserve"], dict)
        or set(policy["reserve"]) != {"numerator", "denominator"}
        or not isinstance(policy["streams"], dict)
        or set(policy["streams"]) != {"events", "telemetry", "dlq"}
    ):
        raise ValueError("invalid canonical JetStream storage policy shape")
    reserve = policy["reserve"]
    if (
        not positive_safe_integer(reserve["numerator"])
        or not positive_safe_integer(reserve["denominator"])
        or reserve["numerator"] < reserve["denominator"]
    ):
        raise ValueError("invalid canonical JetStream storage reserve")
    for stream in policy["streams"].values():
        if (
            not isinstance(stream, dict)
            or set(stream) != {"max_bytes"}
            or not positive_safe_integer(stream["max_bytes"])
        ):
            raise ValueError("invalid canonical JetStream stream allocation")
    return policy


def required_file_store_bytes(policy: dict[str, Any], override: str = "") -> int:
    reserved = sum(stream["max_bytes"] for stream in policy["streams"].values())
    reserved *= policy["reserve"]["numerator"]
    if not positive_safe_integer(reserved):
        raise ValueError("canonical JetStream reservation exceeds safe integer arithmetic")
    denominator = policy["reserve"]["denominator"]
    required = (reserved + denominator - 1) // denominator
    if override:
        if not re.fullmatch(r"[0-9]+", override) or not positive_safe_integer(int(override)):
            raise ValueError("NATS_REQUIRED_FILE_STORE_BYTES must be a positive safe integer")
        # Operator policy may require more capacity, never less than runtime.
        required = max(required, int(override))
    return required


def main() -> int:
    if len(sys.argv) not in (2, 3) or sys.argv[1] != "--required-file-store":
        sys.stderr.write("usage: jetstream_storage_policy.py --required-file-store [operator-floor]\n")
        return 64
    try:
        policy = load_storage_policy()
        override = sys.argv[2] if len(sys.argv) == 3 else ""
        print(required_file_store_bytes(policy, override))
    except (OSError, ValueError) as error:
        sys.stderr.write(f"error: JetStream capacity policy: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
