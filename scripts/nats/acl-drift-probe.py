#!/usr/bin/env python3
"""Nightly NATS ACL drift probe (FARM-AI Sprint 0.2.4).

Detects hand-edits to the LIVE nats.conf that were never promoted to the
services.yaml SSoT — the exact drift class that cost us
`request.auth.user.resolveCallerCapabilities` (manual overlay, lost on the
next source deploy) and `$JS.ACK.>` (29/32 services).

How it works:
  1. Resolve the live conf through docker inspect of the running aqua-nats
     container (robust against tag/dir changes — the bind mount is the truth).
  2. Parse both files into {user: {publish: set, subscribe: set}}.
  3. Report grants present in live but missing from the reference (= the SSoT
     regen pinned at deploy time). Live-only grants are DRIFT (someone patched
     live); reference-only grants mean the reference was never deployed.

Reference policy: the reference file is a copy of the deployed SSoT regen.
Update it only through a deliberate deploy (`--update-reference`), never to
"make the alarm go away".

Exit codes: 0 = clean, 2 = drift detected, 3 = operational error.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_REFERENCE = Path("/var/lib/aqua/local-runtime/nats-conf.reference.conf")
DEFAULT_LOG = Path("/var/lib/aqua/local-runtime/acl-drift-probe.log")


def live_conf_path() -> Path:
    out = subprocess.run(
        ["docker", "inspect", "aqua-nats", "--format", "{{json .Mounts}}"],
        capture_output=True, text=True, check=True,
    ).stdout
    for m in json.loads(out):
        if m.get("Destination") == "/etc/nats/nats.conf":
            return Path(m["Source"])
    raise RuntimeError("aqua-nats has no /etc/nats/nats.conf bind mount")


def parse(path: Path) -> dict[str, dict[str, set[str]]]:
    conf: dict[str, dict[str, set[str]]] = {}
    cur_user: str | None = None
    section: str | None = None
    for raw in path.read_text().splitlines():
        line = raw.strip()
        m = re.match(r'user: "CN=([\w-]+)"', line)
        if m:
            cur_user = m.group(1)
            conf[cur_user] = {"publish": set(), "subscribe": set()}
            continue
        if not cur_user:
            continue
        if line == "publish:":
            section = "publish"
        elif line == "subscribe:":
            section = "subscribe"
        elif line.startswith("}"):
            section = None
        else:
            m2 = re.match(r'"([^"]+)",?$', line)
            if m2 and section:
                conf[cur_user][section].add(m2.group(1))
    return conf


def diff(live: dict, ref: dict) -> list[str]:
    findings: list[str] = []
    for user in sorted(set(live) | set(ref)):
        for sec in ("publish", "subscribe"):
            lset = live.get(user, {}).get(sec, set())
            rset = ref.get(user, {}).get(sec, set())
            live_only = lset - rset
            ref_only = rset - lset
            if live_only:
                findings.append(
                    f"DRIFT  [{user}] {sec}: live-only (hand-patch never promoted to SSoT?): {sorted(live_only)}"
                )
            if ref_only:
                findings.append(
                    f"STALE  [{user}] {sec}: reference-only (SSoT grant not live — deploy missed?): {sorted(ref_only)}"
                )
    return findings


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, default=DEFAULT_REFERENCE)
    ap.add_argument("--log", type=Path, default=DEFAULT_LOG)
    ap.add_argument("--update-reference", action="store_true",
                    help="Copy the CURRENT live conf over the reference. Only after a deliberate SSoT deploy.")
    args = ap.parse_args()

    try:
        live_path = live_conf_path()
    except Exception as exc:  # operational failure — probe must not silently pass
        args.log.parent.mkdir(parents=True, exist_ok=True)
        args.log.write_text(f"OPERATIONAL-ERROR resolving live conf: {exc}\n")
        return 3

    if args.update_reference:
        args.reference.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(live_path, args.reference)
        print(f"reference updated from {live_path} -> {args.reference}")
        return 0

    if not args.reference.exists():
        args.log.parent.mkdir(parents=True, exist_ok=True)
        args.log.write_text(f"OPERATIONAL-ERROR reference missing: {args.reference}\n")
        return 3

    findings = diff(parse(live_path), parse(args.reference))
    stamp = subprocess.run(["date", "-Is"], capture_output=True, text=True).stdout.strip()
    with args.log.open("a") as fh:
        if findings:
            fh.write(f"[{stamp}] DRIFT DETECTED (live={live_path})\n")
            for f in findings:
                fh.write(f"  {f}\n")
        else:
            fh.write(f"[{stamp}] clean\n")
    if findings:
        for f in findings:
            print(f)
        return 2
    print("clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
