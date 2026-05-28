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
