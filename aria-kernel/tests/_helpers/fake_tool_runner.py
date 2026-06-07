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
    args = parser.parse_args(argv)

    if args.sleep_seconds:
        time.sleep(args.sleep_seconds)
    if args.mutate:
        target = Path(args.mutate)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("changed", encoding="utf-8")
    if args.invalid_json:
        print("not json")
    elif args.echo_input:
        payload = json.load(sys.stdin)
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
