# ARIA Runtime Retention Runbook

Runtime retention is archive-first. Delete is disabled by default.

## Dry Run

```bash
aria-kernel runtime retention dry-run --retain-hot-cycles 20
```

Review candidates before applying. Failed, degraded, or evidence-error cycles require operator review before archival.

## Apply

```bash
aria-kernel runtime verify-artifacts
aria-kernel runtime retention apply --retain-hot-cycles 20 --acknowledge
aria-kernel runtime verify-artifacts
aria-kernel integrity verify
```

The command writes `retention/events.jsonl` with original path, archive path, hash, size, cycle id, reason, and reviewed status.

If a retention source is missing before archive copy, treat it as an incident. Do not silently skip it in promotion evidence; restore or quarantine the affected artifact before continuing.

## Restore

```bash
aria-kernel runtime restore-artifact --artifact-ref <artifact-id-or-uri>
```

Restore verifies the artifact hash before reporting success. Promotion evidence must remove or move the hot artifact first, then restore from archive, so the test proves archive recovery rather than a no-op hot-path read.

## Rollback

```bash
aria-kernel runtime rollback-retention --manifest-id <manifest-id>
```

Rollback copies archived artifacts back to their original paths and re-verifies hashes. Promotion evidence must remove or move the hot artifact before rollback and then run `runtime verify-artifacts`; rollback must not delete archived evidence.

## Incident Checks

- `artifact_missing`: run `runtime verify-artifacts`, restore by artifact id, then rerun `integrity verify`.
- `hash_mismatch`: preserve both files, quarantine the run, and do not promote findings.
- `chain_broken`: stop autonomous phases and inspect the affected ledger.
- `archive_restore_failed`: keep the archive directory immutable and escalate to operator review.
- `stdout_truncated_without_artifact`: contract error; rerun only after artifact writer is fixed.
- `ledger_write_failed`: stop cycles; do not continue planner or worker drains.
- `finding_count_regression`: compare v1/v2-shadow raw counts before enabling v2 source of truth.
