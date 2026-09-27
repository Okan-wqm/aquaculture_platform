# ARIA Runtime Artifact Contract

Codex runtime output is summary-first and artifact-backed. The operator may see a small stdout payload, but audit evidence must remain complete and hash-verifiable.

## Contract

- `ARIA_RUN_LEDGER_FORMAT=v1|v2-shadow|v2` controls rollout.
- Default `v2-shadow` preserves legacy run fields while writing v2 artifact refs.
- `v2` run rows are thin and must resolve to a full artifact.
- `runs_reader` is the only supported consumer surface for `runs.jsonl`.
- Missing artifact, hash mismatch, path escape, write failure, or failed restore is `integrity_failed`.
- An artifact the compaction ledger attests as stripped is `compacted`: valid, counted apart, its
  raw-finding pointers verified structurally. Absent and unattested is still missing.

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
- `run-artifacts/compacted.jsonl`: the artifacts `state compact` stripped, attested by the
  compaction that stripped them (ARIA-HIGH-117; contract in `CONTRACTS.md` §12.5).
- `run-artifacts/manifest.jsonl`: artifact lifecycle events.
- `retention/events.jsonl`: archive/restore events.
- `observability/alerts.jsonl`: SLO and silence alerts.
- `observability/artifact-inventory.jsonl`: artifact byte inventory.

## Verification

### Retained runtime versions (R1)

Retained/native-history resolution in `runtime_artifacts.py` matches the complete v2 source
surface, artifact ID, original URI, content hash and native producer. The legacy public hot
reader validates the reference shape and URI/content hash; it does not independently join
every producer field. A missing hot file or a newer publication
at its URI can resolve to the exact verified retained version. A different hash alone never
qualifies another archive. Native manifest/inventory joins select the matching version and
producer; historical source-hash differences require a verified later native creation at
the same ID/URI/producer. The retained archive is still hashed against its original event.

New `retention_apply` records carry `source_descriptor` version 1 containing the original
artifact reference, and copy to `.archive/runtime/<sha256>/<artifact-id>/<original-filename>`
(for example, `tool_run.json`).
Genuine older runtime JSON archives without that descriptor require matching verified native
creation history, including original ID, URI, hash, creator, cycle and size. Missing or
ambiguous historical identity remains unavailable. This bridge covers the known runtime
JSON producer; it does not infer an arbitrary artifact's source from its filename.

Read-only resolution with an explicit tools root does not initialize a root, rewrite a ledger
or synthesize a hot index. An authorized restore appends its native retention event and
rehydrates identical bytes without rebuilding a compacted index. The existing optional
`retention_event_id` return can remain null. A string ID/URI restore requires one complete
identity; multiple native versions are ambiguous even when one is currently hot.

The cold resolver charges source-ledger reads, rows and candidate records through one
operation budget: 16 MiB source bytes, 32 source files, 20,000 rows, 32 candidates; artifact
reads share 16 MiB with a 2 MiB per-file admission limit. Attempted hot bytes in that private
resolver remain charged before archive fallback. These are per-operation bounds, not a
whole-verifier history-scan or wall-clock bound. The existing public hot JSON reader retains
its larger-file compatibility and 64-entry cache, keyed by path, expected digest and observed
file identity so native republication invalidates a cached version.

`state_manifest.py` declares retained runtime JSON/log leaves as artifacts. Snapshots attest
their actual hashes and sizes with `artifact_only` storage; this alone does not prove those
bytes are transported or retrievable after another host restores state. Current/legacy cold
resolution, post-restore verification, retained-A/new-hot-B continuity and large hot reads
are exercised by ordinary local fixtures. `record_run` fixture envelopes are not executed
tools or models. The JSON archive snapshot case does not execute a log producer.

R2 owns real validation-log resolution after native publish/restore and original-root loss.
R3/R4 own reference/prefix closure, participating writers and final concurrent eviction.
Their acceptance remains open; sequential R1 lookup is not evidence of universal retention,
concurrent eviction safety, portable restoration or measured learning usefulness.

Use:

```bash
aria-kernel runtime verify-artifacts
aria-kernel integrity verify
```

Both must pass before autonomous follow-on phases are trusted.

## Promotion Boundary

`--output full --artifact <path>` is an operator export, not a replacement for indexed audit evidence. A full export may help review, but `ok` status still depends on the hash-indexed runtime artifact graph under `run-artifacts/`.
