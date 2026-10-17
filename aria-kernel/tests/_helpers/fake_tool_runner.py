from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path


def _decode_json(value: str) -> object:
    raw = base64.b64decode(value.encode("ascii")).decode("utf-8")
    return json.loads(raw)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-b64")
    parser.add_argument("--invalid-json", action="store_true")
    parser.add_argument("--echo-input", action="store_true")
    parser.add_argument("--exit-code", type=int, default=0)
    parser.add_argument("--sleep-seconds", type=float, default=0)
    parser.add_argument("--mutate")
    # Exit 1 when the stdin payload lacks a key, the way an adapter that
    # requires its declared input does (adapter-fs.ts requireScanRoots).
    parser.add_argument("--require-input-key", action="append", default=[])
    # A workspace-relative JSON list of findings the run reports, read at run
    # time so a test changes what the adapter finds by editing the workspace
    # (tests/_helpers/spine_fixture.py). Every path a finding cites is read.
    parser.add_argument("--findings-file")
    # A workspace-relative directory whose every file the run reports as read,
    # sorted, citing nothing: the read set of a tree-walking adapter (test-gap
    # read 7,818 files on 2026-10-15), too large for --output-b64's argv.
    parser.add_argument("--read-tree")
    # Text the run writes to stderr before it answers (base64 UTF-8): what a
    # crashing adapter leaves behind (ARIA-LOW-542).
    parser.add_argument("--stderr-b64")
    args = parser.parse_args(argv)

    if args.stderr_b64:
        sys.stderr.write(base64.b64decode(args.stderr_b64.encode("ascii")).decode("utf-8"))
        sys.stderr.flush()

    if args.sleep_seconds:
        time.sleep(args.sleep_seconds)
    if args.mutate:
        target = Path(args.mutate)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("changed", encoding="utf-8")
    if args.invalid_json:
        print("not json")
    elif args.findings_file:
        findings = json.loads(Path(args.findings_file).read_text(encoding="utf-8"))
        cited = sorted({
            ref["path"] for finding in findings for ref in finding.get("evidence", []) if "path" in ref
        })
        read = sorted({args.findings_file, *cited})
        print(json.dumps({
            "observations": [],
            "findings": findings,
            "read_paths": read,
            "evidence_sources": read,
            "cost_units": 0,
            "metadata": {"fixture": True},
        }))
    elif args.read_tree:
        read = sorted(path.as_posix() for path in Path(args.read_tree).rglob("*") if path.is_file())
        print(json.dumps({
            "observations": [{"id": "obs-1", "type": "fixture"}],
            "findings": [],
            "read_paths": read,
            "evidence_sources": [],
            "cost_units": 1,
            "metadata": {"fixture": True},
        }))
    elif args.echo_input or args.require_input_key:
        payload = json.load(sys.stdin)
        missing = [key for key in args.require_input_key if key not in payload]
        if missing:
            print(f"missing required input: {', '.join(missing)}", file=sys.stderr)
            return 1
        print(json.dumps({
            "observations": [{"id": "obs-1", "type": "fixture", "details": payload}],
            "findings": [],
            "read_paths": ["src/app.ts"],
            "evidence_sources": [],
            "cost_units": 1,
            "metadata": {"fixture": True},
        }))
    elif args.output_b64:
        print(json.dumps(_decode_json(args.output_b64)))
    else:
        print("{}")
    return args.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
