# Runbook: Edge Agent Audit Log Forensics

Operational runbook for the HMAC-chained audit log shipped by
the Suderra edge agent (`sens-api-gateway`) in Sprint 6.2
Phase 2 (Batches 74-80).

## What the audit log is

`/var/log/suderra/audit.log` is an append-only, HMAC-chained,
NDJSON-formatted file recording every regulated action:
command dispatch (pre + post), RBAC manifest rotation, force
value, firmware deploy, safe-state trigger, etc.

Each line has the shape:

```json
{
  "sequence": 42,
  "prev_hmac_hex": "0a1b2c...",
  "current_hmac_hex": "de4f56...",
  "entry": {
    "timestamp_unix_secs": 1745235600,
    "timestamp_nanos": 123456789,
    "correlation_id": "cmd-uuid-abc",
    "phase": "pre" | "post",
    "actor": { "label": "device:abc-123" },
    "tenant": [16-byte UUID],
    "policy_version": 42,
    "two_person_integrity_verified": false,
    "action": "tag_write" | "policy_update_applied" | ...,
    "resource": { ... },
    "outcome": "success" | "failure" | "authorization_denied",
    "detail": "elapsed_ms=12"
  }
}
```

**Tamper-evidence:** each entry's `current_hmac_hex` is
HMAC-SHA256 keyed on the master-derived key (via
`KeyPurpose::AuditHmacChain`). `prev_hmac_hex` links to the
previous entry. ANY modification (to content, ordering,
insertion, deletion) breaks the chain.

## Verifying log integrity (`audit-verify`)

Use the built-in CLI to verify a log file offline:

```bash
# On the edge device or a copy of the log file:
export SUDERRA_AUDIT_KEY_HEX=<64-char hex HMAC key>
suderra-agent --audit-verify /var/log/suderra/audit.log

# Expected output on clean chain:
# audit-verify: OK
#   path:           /var/log/suderra/audit.log
#   verified_count: 1234
#   last_sequence:  1234
#   last_hmac:      de4f56...
```

**Exit codes:**
- `0` — chain verified end-to-end.
- `1` — any failure: environment error, missing key, invalid
  JSON, HMAC mismatch, sequence gap, prev_hmac linkage break.

**Failure output shows the first broken entry:**

```
audit-verify: FAILED
  path:         /var/log/suderra/audit.log
  entry_number: 57
  reason:       HMAC mismatch: computed aabb... != stored ccdd...
```

The `entry_number` is 1-based. Entries BEFORE entry_number are
valid; the entry AT entry_number is the first tamper boundary.

## Obtaining the HMAC key

The audit HMAC key is NOT stored anywhere directly — it's
derived from the master key via
`HKDF-SHA256(master, info="suderra:audit:hmac-chain:v1")`.

To run `audit-verify` on a machine OTHER than the edge
device, you need the **derived** key bytes (not the master).
On the edge device:

```bash
# Edge-side helper script (future Batch 88 follow-up wires
# this as a subcommand `suderra-agent --dump-audit-key-hex`).
# Pre-batch workaround: the operator derives the key via:
# HKDF-SHA256(master_key_bytes, info="suderra:audit:hmac-chain:v1", L=32)
# and hex-encodes for SUDERRA_AUDIT_KEY_HEX.
```

The master key is derived at boot from:
- `/etc/suderra/keystore.passphrase` (operator-supplied).
- `/etc/suderra/keystore.salt` (≥16 random bytes).
- Argon2id params from `config.yaml` `keystore.argon2_*`.

## Rotation across rotation (logrotate compat)

The agent supports logrotate's `create + rename + SIGHUP`
pattern via Batch 80's SIGHUP handler:

1. logrotate renames `/var/log/suderra/audit.log` to
   `audit.log.1`.
2. logrotate creates a new empty `audit.log`.
3. logrotate sends SIGHUP to `suderra-agent`.
4. Agent's handler calls `AuditSink::reopen()` which closes
   the old fd and opens the new empty file. **In-memory
   chain state is preserved** — the new file's first entry's
   `prev_hmac_hex` matches the rotated file's last entry's
   `current_hmac_hex`.

**Cross-file verification:** when verifying across a
rotation boundary, run `audit-verify` on each file IN
CHRONOLOGICAL ORDER and assert that the `last_hmac` output
of file N equals the `prev_hmac_hex` of the FIRST entry of
file N+1:

```bash
# File 1 (oldest)
suderra-agent --audit-verify /var/log/suderra/audit.log.1
# -> last_hmac: abc123...

# File 2 (current)
head -1 /var/log/suderra/audit.log | jq -r .prev_hmac_hex
# -> abc123...  (must match above)

suderra-agent --audit-verify /var/log/suderra/audit.log
```

A batch CLI wrapper for multi-file verification lands in
Phase 2 / Batch 89.

## Incident response

### Torn tail (crash mid-fsync)

**Symptom:** `audit-verify` reports the boot banner noted
"dropped N torn-tail bytes" OR the verify passes but the
file ends without a newline.

**Cause:** agent crashed during an fsync, leaving a partial
line. Batch 75 chain recovery correctly resumes from the
LAST COMPLETE line, so forensic chain is intact.

**Action:** preserve the torn-tail bytes (do NOT truncate
the file) for post-mortem. Future agent starts will NOT
reset the chain; they'll continue from the recovered state.

### HMAC mismatch

**Symptom:** `audit-verify` FAILED at entry_number=N,
reason="HMAC mismatch".

**Causes (investigate in this order):**
1. **Wrong key**: verify SUDERRA_AUDIT_KEY_HEX was derived
   from the CURRENT master (not a rotated-out master).
2. **Key rotation**: if master rotation occurred between
   entries, use the master valid AT the time of entry N to
   recompute.
3. **Tamper**: if key + master are definitively correct, the
   entry content was modified. Escalate per incident-
   response runbook.

### Sequence gap / prev_hmac linkage break

**Symptom:** `audit-verify` FAILED with "sequence mismatch"
or "prev_hmac linkage broken".

**Cause:** an entry was deleted OR reordered. This is a
tamper signal with high confidence (can't be caused by
benign operational events like rotation — Batch 80 preserves
chain state across rotation).

**Action:** quarantine the log file, escalate, start a
fresh chain on the edge device (operator restart + new
passphrase derivation).

## Configuration reference

Minimal `config.yaml` for enterprise audit:

```yaml
audit:
  mode: enabled                      # pre+post events emitted
  # log_path defaults to /var/log/suderra/audit.log
  # hmac_key_hex: <64-char hex>      # rollout-stage path; prefer keystore below

keystore:
  mode: auto                         # TPM > systemd-creds > FileBacked
  argon2_memory_kib: 65536           # 64 MiB (OWASP 2024)
  argon2_iterations: 3
  argon2_parallelism: 4
  # paths default to /etc/suderra/keystore.{passphrase,salt,acceptance.json}
```

When `keystore.mode != Disabled`, the audit HMAC key is
automatically derived via `KeyPurpose::AuditHmacChain`. The
`audit.hmac_key_hex` field becomes unused.

## Related runbooks

- `edge-keystore-operations.md` — keystore provisioning +
  rotation.
- `edge-rbac-manifest-push.md` — pushing new policy
  manifests via MQTT `update_policy`.
