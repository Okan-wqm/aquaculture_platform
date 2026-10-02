# Tool output size decided whether a detector's findings existed (2026-10-03)

Context: ARIA evolution-wall audit (2026-10-02), wall #15. `aria_kernel/tool_runner.py` read an
adapter's whole stdout and refused it past `STDOUT_PARSE_MAX_BYTES`.

Owner: claude (implementation), okan (review). Deadline 2026-10-06.

## ARIA-HIGH-292 — Tool output past 12 MiB became `budget_exceeded` with empty output

Measured on `main @ d3adb0f89`:

1. **Size decided existence.** `subprocess.run(capture_output=True)` held the whole stdout; past
   12 MiB (`tool_runner.py:35`, checked at `:152`) the run was `budget_exceeded` with
   `parse_error=output_too_large` and `output = {}`. Every finding of that tool vanished for the
   cycle, the runner kept no count of what it held, and no governance event named the tool.
2. **Whole-buffer parse.** Below the cap the output was parsed by one `json.loads` of the full
   text: the decoded string, its UTF-8 copy and the parse tree were alive at once. On a 13.8 MB
   synthetic output the runner's traced peak was 45.3 MB.
3. **Stored three times.** The `tool_run` artifact carried the output as the `stdout` string, as
   `parsed_output` and again as `raw_findings`.

The audit's figure ("11.36 MB, 90% of the cap") is the `lint-rules-adapter` run artifact, not its
stdout. On the `aria/state` tip (`cyc-20261001T220619Z-auto`) that adapter wrote 3,829,079 bytes of
stdout (30% of the cap) and a 11,355,365-byte artifact. The six adapters with artifacts over 1 MB
wrote 12.1 MB of stdout and 36.9 MB of run artifacts per cycle. The wall is a class: the cap had
already been crossed once (tenant-scoping, 5.84 MB over a 5 MB cap, 2026-08-13), and the remedy
then was a larger number.

### Fix (fix/aria-tool-output-content-addressed)

- `tool_runner.OutputStream` parses stdout as it arrives (64 KiB reads, stderr spooled, stdin
  written from a thread). The adapter protocol is unchanged: one JSON object whose list elements are
  records. The parser holds at most one incomplete record (`STREAM_RECORD_MAX_BYTES`, 8 MiB).
- Claims and provenance (`read_paths`, `evidence_sources`) are each retained up to
  `TOOL_OUTPUT_RETAIN_BYTES` (a quarter of the per-surface publish cap); a manifest may lower it
  (`runner.output_retain_bytes`). Past it the run is `truncated`: the records before the bound are
  kept and evidence-checked, the rest are parsed and counted, `runner.output_stream` carries the
  per-field kept/dropped counts, and governance gets `tool_output_truncated` naming the tool, the
  dropped counts and the stored digest. The cycle reads a truncated run as degraded.
- The retained output is stored once, content-addressed: `runtime_artifacts.write_tool_output`
  streams the canonical, scrubbed document to `hot/<cycle>/<run>/sha256/<aa>/<hex>.json` and indexes
  it like every runtime artifact. `cas_relative_path` is the layout the cold-eviction branch names
  evicted files by. The run row and the `tool_run` artifact carry `output_ref`.
- Readers: `resolve_finding_from_artifact` (raw-findings sampling, rule health, the integrity
  verifier) resolves through `output_ref` and still reads artifacts written before the change.
