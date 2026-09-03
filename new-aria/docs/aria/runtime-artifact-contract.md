# ARIA Runtime Artifact Contract

Codex runtime output is summary-first and artifact-backed. The operator may see a small stdout payload, but audit evidence must remain complete and hash-verifiable.

## Contract

- `ARIA_RUN_LEDGER_FORMAT=v1|v2-shadow|v2` controls rollout.
- Default `v2-shadow` preserves legacy run fields while writing v2 artifact refs.
- `v2` run rows are thin and must resolve to a full artifact.
- `runs_reader` is the only supported consumer surface for `runs.jsonl`.
- Missing artifact, hash mismatch, path escape, write failure, or failed restore is `integrity_failed`.

## No Silent Loss

Any output that is summarized, truncated, deduplicated, redacted, migrated, archived, or omitted must record:

- artifact ref
- content hash
- count
- reason code
- verification status

If those fields cannot be produced, the run must not remain `ok`.

Summary fields that claim bounded output must also preserve audit cardinality:

- `source_count`: number of source records before bounding.
- `emitted_count`: number of records represented in stdout or thin ledger rows.
- `suppressed_count`: number intentionally omitted from bounded output.
- `truncated_count`: number shortened for size.
- `reason_code`: stable machine-readable reason for each omission/truncation class.
- `artifact_ref`, `sha256`, and `verification_status`: pointer back to complete evidence.

These fields must be derived from produced evidence, not defaulted for a green status. A zero value is valid only when the runtime can prove no record was suppressed or truncated.

## Ledgers

- `runs.jsonl`: run summary row.
- `runs/by-cycle/<cycle_uid>.jsonl`: bounded per-cycle run index.
- `raw-findings.jsonl`: finding pointers and fingerprints.
- `run-artifacts/artifact-index.jsonl`: current artifact location and hash.
- `run-artifacts/manifest.jsonl`: artifact lifecycle events.
- `retention/events.jsonl`: archive/restore events.
- `observability/alerts.jsonl`: SLO and silence alerts.
- `observability/artifact-inventory.jsonl`: artifact byte inventory.

## Verification

Use:

```bash
aria-kernel runtime verify-artifacts
aria-kernel integrity verify
```

Both must pass before autonomous follow-on phases are trusted.

## Promotion Boundary

`--output full --artifact <path>` is an operator export, not a replacement for indexed audit evidence. A full export may help review, but `ok` status still depends on the hash-indexed runtime artifact graph under `run-artifacts/`.
