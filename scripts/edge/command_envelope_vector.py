#!/usr/bin/env python3
"""The cross-language CommandEnvelope v3 test vector (ADR-048 DEC-9.2).

The cloud signs every command it sends a Suderra OS agent
(apps/sensor-service/src/edge-device/command-envelope-signer.service.ts) and
the agent verifies it in Enforcing mode
(sens-api-gateway/src/command_envelope/{canonical,envelope}.rs). Each side
builds the signed transcript itself, so one byte of difference in key order,
number or string form, field framing or a domain tag refuses every command
while both test suites stay green on their own. This script writes the one
vector both consume:

  sens-api-gateway/tests/fixtures/command-envelope-v3/platform-command.json

It is a third, independent implementation of the Rust layout (read from
canonical.rs and envelope.rs, not from the TypeScript signer), so the
TypeScript spec and the Rust test each compare against bytes neither of them
produced. The key is TEST-ONLY (seed 00 01 .. 1f) and signs nothing real.

  python3 scripts/edge/command_envelope_vector.py          # rewrite the vector
  python3 scripts/edge/command_envelope_vector.py --check  # fail on drift

Parameter values are chosen where JavaScript, Python and serde_json write
the same text: safe integers, and non-integers at or above 1e-4 (Python's
repr switches to an exponent below 1e-4, serde_json below 1e-5).
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
import uuid
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "sens-api-gateway/tests/fixtures/command-envelope-v3/platform-command.json"

SEED = bytes(range(32))
CMD = "read_tag"
# Insertion order is not code-point order on purpose: canonical form sorts.
PARAMS = {
    "tag": "pump_1.state",
    "Zeta": True,
    "_under": None,
    "count": 42,
    "negative": -7,
    "max_safe": 9007199254740991,
    "setpoint": 7.25,
    "ratio": 0.1,
    "precise": 1234.5678,
    "neg_frac": -0.125,
    "text": 'quote" backslash\\ newline\n tab\t bell\x07 unit\x1f del\x7f ü \U0001f41f  ',
    "list": [3, "b", {"z": 1, "a": [True, None], "M": "x"}, []],
    "empty": "",
    "ü-key": "non-ASCII key",
}
ACTOR = "01234567-89ab-4def-8abc-0123456789ab"
TENANT = "fedcba98-7654-4210-bedc-ba9876543210"
IAT = 1792497600  # 2026-10-20T12:00:00Z
EXP = IAT + 300
POLICY_VERSION = 3
JTI = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f"
NONCE = "00112233445566778899aabbccddeeff"


def u32(n: int) -> bytes:
    return struct.pack(">I", n)


def canonical_params(cmd: str, params: dict) -> bytes:
    """canonical.rs canonical_params: be_u32(len) || cmd || serde_json(BTreeMap) || tag."""
    body = json.dumps(params, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    cmd_bytes = cmd.encode("utf-8")
    return (
        u32(len(cmd_bytes)) + cmd_bytes + body.encode("utf-8") + b"command-envelope-v1"
    )


def transcript(cmd: str, params_bytes: bytes, cmd_hash: bytes) -> bytes:
    """envelope.rs envelope_canonical_bytes, v3, no co-approver."""
    cmd_bytes = cmd.encode("utf-8")
    jti = JTI.encode("utf-8")
    nonce = NONCE.encode("utf-8")
    return b"".join(
        [
            u32(len(cmd_bytes)),
            cmd_bytes,
            u32(len(params_bytes)),
            params_bytes,
            uuid.UUID(ACTOR).bytes,
            uuid.UUID(TENANT).bytes,
            struct.pack(">q", IAT),
            struct.pack(">q", EXP),
            struct.pack(">Q", POLICY_VERSION),
            b"\x00",
            u32(len(jti)),
            jti,
            u32(len(nonce)),
            nonce,
            cmd_hash,
            b"command-envelope-sig-v3",
        ]
    )


def vector() -> str:
    key = Ed25519PrivateKey.from_private_bytes(SEED)
    public_key = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    params_bytes = canonical_params(CMD, PARAMS)
    cmd_hash = hashlib.sha256(params_bytes).digest()
    signed = transcript(CMD, params_bytes, cmd_hash)
    signature = key.sign(signed)
    # The wire JSON exactly as the cloud publishes it (SignedCommandEnvelope
    # member order; byte arrays as arrays of integers, the serde shape).
    wire = {
        "cmd": CMD,
        "params": PARAMS,
        "actor": list(uuid.UUID(ACTOR).bytes),
        "tenant_id": list(uuid.UUID(TENANT).bytes),
        "iat_unix_secs": IAT,
        "exp_unix_secs": EXP,
        "claimed_policy_version": POLICY_VERSION,
        "jti": JTI,
        "nonce": NONCE,
        "cmd_hash": list(cmd_hash),
        "signature": list(signature),
        "co_approver_actor": None,
        "co_approver_signature": None,
    }
    document = {
        "description": (
            "CommandEnvelope v3 signed by the cloud platform actor and verified by the agent in "
            "Enforcing mode (ADR-048 DEC-9.2). Written by scripts/edge/command_envelope_vector.py; "
            "consumed by apps/sensor-service/src/edge-device/__tests__/command-envelope-signer.spec.ts "
            "and sens-api-gateway/src/command_envelope/cloud_signer_vector.rs. TEST-ONLY key."
        ),
        "seed_hex": SEED.hex(),
        "public_key_hex": public_key.hex(),
        "inputs": {
            "cmd": CMD,
            "params": PARAMS,
            "actor": ACTOR,
            "tenant": TENANT,
            "iat_unix_secs": IAT,
            "exp_unix_secs": EXP,
            "claimed_policy_version": POLICY_VERSION,
            "jti": JTI,
            "nonce": NONCE,
        },
        "tenant_hex": uuid.UUID(TENANT).bytes.hex(),
        "now_unix_secs": IAT + 60,
        "canonical_params_hex": params_bytes.hex(),
        "cmd_hash_hex": cmd_hash.hex(),
        "envelope_canonical_bytes_hex": signed.hex(),
        "signature_hex": signature.hex(),
        "wire": json.dumps(wire, separators=(",", ":"), ensure_ascii=False),
    }
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    text = vector()
    if argv[1:] == ["--check"]:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print(
                f"{OUT.relative_to(ROOT)} is stale; rerun {Path(__file__).name}",
                file=sys.stderr,
            )
            return 1
        return 0
    if argv[1:]:
        print(__doc__, file=sys.stderr)
        return 2
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
