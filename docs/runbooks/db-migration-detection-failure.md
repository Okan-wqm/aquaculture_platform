# Runbook: SQLCipher migration detection failure

**Owner:** edge platform team
**Related batches:** #329 (manifest primitive), #330 (boot detector)
**Related plan:** Plan §5 Faz 2 D-3 (UH-017 SQLCipher v1→v2 migration)
**Audit closure:** LOW-007 (operator-actionable diagnostic gap)

## Purpose

Operator-actionable response procedures for the three classes of
SQLCipher key-source manifest detection failures the boot-time
detector (`db_migration::boot_detector::detect_db_migration_backlog`)
emits as `tracing::error!` with `event_kind="db_migration_detection_failure"`.

These are NOT migration backlog entries — the migration tool cannot
safely rekey a DB whose manifest is unreadable. Each class needs a
different operator response.

## Failure class taxonomy

The structured `error!` log line carries a `reason` field with a
canonical kind prefix. Use the prefix to route:

| Reason prefix                | Class                       | Response section |
|------------------------------|-----------------------------|------------------|
| `corrupt_manifest:`          | Sidecar JSON unparseable    | §1 below         |
| `envelope_version_mismatch:` | Forward-incompat manifest   | §2 below         |
| `io_error:`                  | Filesystem read failure     | §3 below         |
| `write_error:`               | Should not occur on read    | §4 below         |

## §1 — corrupt_manifest

**Symptom:** the sidecar `<db>.key-source.json` exists but the JSON
is unparseable (truncated, hand-edited to invalid shape, or filesystem
corruption).

**Why fail-closed:** the migration tool cannot guess the schema_version
without a valid manifest. Wrong-key derivation bricks the DB; refusing
to migrate is the safe choice.

**Operator response:**

1. **Capture the corrupt sidecar** for forensic analysis:
   ```sh
   cp /var/lib/suderra/<db>.key-source.json /tmp/corrupt-manifest-$(date +%s).json
   ```
2. **Check filesystem health** — corrupt JSON often indicates an
   underlying disk issue:
   ```sh
   sudo dmesg | grep -iE "ext4|filesystem|i/o error"
   sudo smartctl -a /dev/sda 2>&1 | tail -30   # or appropriate device
   ```
3. **Restore from the most recent backup** if available:
   ```sh
   # The sidecar + the DB file MUST be restored together — they are
   # tightly coupled (manifest declares which key opens which DB).
   sudo systemctl stop suderra-agent
   tar -xzf /var/backups/suderra/<latest>.tgz -C /var/lib/suderra
   sudo systemctl start suderra-agent
   ```
4. **If no backup is available** and the DB file is otherwise intact,
   contact the platform team — manual reconstruction of the manifest
   based on the agent's schema_version history is possible but
   requires verifying the underlying derivation against operator
   records of the last migration.
5. **Do NOT** delete the sidecar or hand-edit it to "fix" the JSON.
   Once an operator-edited manifest passes parsing, the migration
   tool will trust it — wrong values brick the DB.

## §2 — envelope_version_mismatch

**Symptom:** the manifest's `manifest_envelope_version` field is a
value this agent does not recognize (typically a value > 1 written
by a future agent version).

**Why fail-closed:** the older agent does not know how the newer
envelope shape encodes the schema_version field; reading it as the
v1 shape could pick the wrong key derivation.

**Operator response:**

1. **Check the agent version** vs the version on neighboring devices
   in the fleet:
   ```sh
   suderra-agent --version
   # Compare against fleet inventory.
   ```
2. **Roll forward** the agent to the newest deployed version on this
   device. Manifest envelope bumps require a coordinated migration
   ADR — the new agent version includes the reader for the new
   envelope shape.
3. **If rollback is required** for unrelated reasons, the manifest
   can be restored from the last backup taken before the agent
   upgrade — the older agent reads the older manifest correctly.
4. **Do NOT** hand-edit `manifest_envelope_version` — rejecting the
   field is a safety property, not a bug.

## §3 — io_error

**Symptom:** the sidecar file exists but cannot be read (permission
denied, I/O error, EBUSY, etc.).

**Operator response:**

1. **Check file permissions:**
   ```sh
   ls -la /var/lib/suderra/<db>.key-source.json
   # Expected: owner=suderra, mode=0640 (operator-readable for cat).
   ```
2. **Check mount state:**
   ```sh
   findmnt /var/lib/suderra
   sudo mount -v | grep suderra
   # Verify the filesystem is mounted rw + not in read-only-fallback
   # mode (kernel auto-remounts ro on certain ext4 errors).
   ```
3. **Check kernel log** for ext4 / I/O errors as in §1 step 2.
4. **Restart the agent** with elevated diagnostics if the cause is
   not obvious:
   ```sh
   sudo SUDERRA_LOG=debug systemctl restart suderra-agent
   ```

## §4 — write_error (should not occur on read path)

**Symptom:** the boot detector emits a `write_error:` reason. This
is unexpected — the detector is read-only.

**Operator response:** capture the full log line + the call stack +
file an issue against the agent. The detector module's
`classify_error_reason` (`src/db_migration/boot_detector.rs`) routes
all known read-path errors; a `write_error` reason indicates either
a bug in the classifier or a future code path that should never
reach this site.

## Logging contract

The boot detector emits each detection failure as:

```
ERROR event_kind=db_migration_detection_failure
      db_path=<path>
      reason=<canonical_kind>: <human-readable>
      runbook_url=docs/runbooks/db-migration-detection-failure.md
```

Operators search log aggregators by the `event_kind` field to
locate detection failures across the fleet. The `runbook_url` field
is the canonical link to this document — kept relative-to-repo so
the audit trail survives a docs reorganization.

## Plan-level context

Plan §5 Faz 2 D-3 (UH-017) is the SQLCipher v1→v2 migration arc.
Key derivation primitives (Batches #329-#332 + #335-#337):

- `db_migration::schema_version::DbKeySchemaVersion` (#329) — v1
  legacy machine-id-derived; v2 keystore-derived target.
- `db_migration::manifest` (#329, #338) — `.key-source.json`
  sidecar; atomic temp+fsync+rename+parent-dir-fsync via
  `shared_io::atomic_json_sidecar`.
- `db_migration::boot_detector` (#330) — emits the WARN/ERROR
  log lines this runbook responds to.
- `db_migration::v1_legacy_key` (#331, #335) — pure HMAC-SHA256
  kernel; offline_queue delegates to it (algorithm SSoT).
- `db_migration::v2_keystore_key` (#332, #336, #337) —
  Zeroize-wrapped async shim around `keystore.derive_key` with
  wrong-purpose runtime guard.

The actual rekey binary (`db-migrate-cli`) lands in PR-195 along
with per-consumer migration. This runbook covers the boot-detector
diagnostic path that is in PR-194 scope.
