# Research: SQLCipher Offline Queue, Gzip Backup, Process Image, Retention

**Topic:** SQLCipher-encrypted SQLite offline queues, bounded queue sizes, FIFO ordering, gzip backups with magic header, retention, process-image last-known-good values + quality codes
**Date:** 2026-04-08
**Agent:** edge-expert

## Sources

- [Zetetic — SQLCipher product page](https://www.zetetic.net/sqlcipher/)
- [Zetetic — SQLCipher API (PRAGMAs, functions, settings)](https://www.zetetic.net/sqlcipher/sqlcipher-api/)
- [Zetetic — "How to protect the key?" (FAQ)](https://discuss.zetetic.net/t/sqlcipher-how-to-protect-the-key/522)
- [Zetetic — Enhancing PBKDF Techniques (PasswordsCon 2014 whitepaper)](https://www.zetetic.net/storage/files/enhancing-password-based-key-derivation-techniques.pdf)
- [Zetetic — Upgrading to SQLCipher 4 (defaults reference)](https://discuss.zetetic.net/t/upgrading-to-sqlcipher-4/3283)
- [GitHub — `sqlcipher/sqlcipher`](https://github.com/sqlcipher/sqlcipher)
- [SQLite forum — Building a queue based on SQLite](https://sqlite.org/forum/info/b047f5ef5b76edff)
- [IETF RFC 1952 — GZIP file format specification 4.3](https://www.rfc-editor.org/rfc/rfc1952)
- [IETF RFC 6713 — `application/gzip` media type](https://datatracker.ietf.org/doc/rfc6713/)
- [GNU Gzip manual](https://www.gnu.org/software/gzip/manual/gzip.html)
- [OPC UA Part 8: Data Access — §A.4.3.3 Quality](https://reference.opcfoundation.org/Core/Part8/v104/docs/A.4.3.3)
- [OPC UA Part 4: Services — §7.34 StatusCode](https://reference.opcfoundation.org/Core/Part4/v104/docs/7.34)
- [OPC UA Part 8: Data Access — §6.3 DA status codes](https://reference.opcfoundation.org/Core/Part8/v104/docs/6.3)
- [OPC Foundation Forum — Usage of BAD quality codes](https://opcfoundation.org/forum/opc-ua-standard/usage-of-bad-opcqualitycode/)

## Key Findings

### SQLCipher crypto defaults and key derivation (Zetetic)
- **SQLCipher 4 defaults**: AES-256-CBC, HMAC-SHA512 per-page, PBKDF2-HMAC-SHA512 for key derivation, **256,000 iterations**, per-database random salt stored in page 1 header, 4096-byte page size.
- **`PRAGMA key` ordering is load-bearing**: `PRAGMA key = '...'` must be the first statement after `sqlite3_open`, before any data access. The C API equivalent is `sqlite3_key_v2`.
- **Non-default `kdf_iter` must be re-applied on every open.** If a database is created with a custom `kdf_iter`, the same value must be set on every subsequent open via `PRAGMA kdf_iter`; otherwise open will fail or silently fall back. Reviews must verify this invariant holds on the edge agent.
- **`PRAGMA cipher_default_kdf_iter`** applies a process-wide default — useful when the open path is abstracted behind an ORM and you cannot inject `PRAGMA kdf_iter` early enough.
- **Do not lower iterations on a production passphrase.** Reducing iterations for performance is only acceptable when the key is a high-entropy raw key (`x'...'` hex blob), because PBKDF2 iteration count has no security value for an already-uniform 256-bit secret.
- **Key storage**: Zetetic's FAQ lists three defensible patterns: (1) OS-provided keystore (Linux Keyring via `keyutils`, TPM-backed keyring), (2) derive from a hardware root of trust (TPM-sealed key), (3) passphrase entered at provisioning and then stored encrypted by a device-specific root key. Hard-coded keys in the binary are FORBIDDEN.
- **WAL mode + encryption**: SQLCipher supports WAL. The `-shm` and `-wal` side files are also encrypted. Journal mode changes require the DB to be unlocked first.

### SQLite-as-a-queue pattern (SQLite forum)
- **Bounded, FIFO, durable queue in SQLite:**
  ```sql
  CREATE TABLE outbox (
      id        INTEGER PRIMARY KEY AUTOINCREMENT, -- FIFO monotonic
      topic     TEXT NOT NULL,
      payload   BLOB NOT NULL,
      qos       INTEGER NOT NULL,
      retain    INTEGER NOT NULL,
      enqueued  INTEGER NOT NULL, -- unix_ms
      attempts  INTEGER NOT NULL DEFAULT 0,
      next_try  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_outbox_next ON outbox(next_try, id);
  ```
- **FIFO ordering is preserved by `ORDER BY id ASC`** (AUTOINCREMENT guarantees no reuse even after deletes). Without AUTOINCREMENT, SQLite can reuse the largest-ever id after a delete, which breaks FIFO after a vacuum.
- **Bounded size**: enforce `COUNT(*) <= MAX_ROWS` via an `INSERT` trigger that deletes oldest if above threshold (drop-oldest policy) or rejects insert (backpressure policy). Drop-oldest is typical for telemetry; reject-insert for control commands.
- **WAL mode + `PRAGMA synchronous = NORMAL`** gives the best crash-safety-vs-throughput tradeoff for an embedded edge queue. `FULL` is needed only if the device has no UPS and sudden power loss is common.
- **Dequeue pattern**: begin-immediate transaction, `SELECT ... ORDER BY id LIMIT N`, attempt publish, on success `DELETE WHERE id IN (...)`, commit. On failure, `UPDATE SET attempts = attempts + 1, next_try = ?`.

### Gzip backup format (RFC 1952)
- **Magic header**: ID1=0x1f, ID2=0x8b, CM=0x08 (deflate). Any decompressor **must** verify these bytes and raise an error on mismatch.
- **CRC-32 trailer**: the last 8 bytes of a gzip stream are CRC-32 of the uncompressed data (little-endian) + ISIZE (uncompressed size mod 2^32). These must be validated on decompress to detect tampering or bit-rot.
- **Extended header**: FNAME (original filename), FCOMMENT, FEXTRA fields permit embedding metadata (backup version, timestamp, checksum of schema) — useful for edge backups so a restore workflow can validate against the current schema before loading.
- **Custom application magic**: for edge backups, the gzip payload can be prefixed with an application-level magic (e.g. `b"AQS1"` + u32 version + u32 schema_hash) before the gzip stream, or embedded as an FEXTRA subfield, so the restore tool rejects wrong-type files immediately.

### Retention policy (practical edge)
A documented retention policy for `backup.rs` should specify:
- **Per-file retention**: keep last N daily backups, last M weekly backups, last K monthly backups (grandfather-father-son).
- **Disk headroom guard**: stop creating new backups when free disk space < X% (typical: 15 % on embedded); raise a telemetry alarm.
- **Age cap**: max retention age regardless of count (GDPR / data minimization).
- **Integrity scrub**: periodic background task that re-validates gzip CRC-32 on stored backups and removes/flags corrupted files.

### Process image — last-known-good + quality codes (OPC UA)
OPC UA Part 8 defines `StatusCode` values that the edge process image must mirror in `process_image.rs`:
- `Good (0x00000000)` — value is current, acquired within the configured sample interval.
- `Uncertain (0x40000000)` and subcodes — value is present but its reliability is degraded. Key subcodes:
  - `Uncertain_LastUsableValue` (0x40900000) — sensor communication failed, the last good value is being reported.
  - `Uncertain_SubNormal` — fewer operands contributed than expected (e.g. one of three redundant sensors failed).
  - `Uncertain_SensorNotAccurate` — sensor out of range but still reporting.
- `Bad (0x80000000)` and subcodes — value is not trustworthy and **must not be used for control**:
  - `Bad_NoCommunication`
  - `Bad_OutOfService`
  - `Bad_DeviceFailure`
  - `Bad_SensorFailure`

**Critical rule from OPC UA**: when `Severity = Bad`, the value field **shall be Null**; the legacy DA "LAST_KNOWN_VALUE with Bad" pattern maps to `Uncertain_LastUsableValue` in UA. Control logic must not read the numeric value from a Bad-quality tag.

**Additional fields for a conformant process image entry:**
- `ServerTimestamp` and `SourceTimestamp` (the latter is when the sensor produced the value, the former when the edge recorded it) — required to detect stale data.
- Monotonic sequence number for ordering.
- `Limit` bits (high-limited, low-limited, constant) for alarm-bearing values.
- Substitution mode: an HMI operator can manually inject a substitute value; the process image must record the substitution and emit `Uncertain_SubstituteValue`.

## Security Concerns

- **Hard-coded or env-variable SQLCipher keys** expose the offline queue contents to any process with disk access; keys must come from Linux Keyring, TPM, or a device-sealed root.
- **Key logging**: any log line that includes the `PRAGMA key` value (even masked) is an audit failure. The `security.rs` credential masker must blocklist `key=`, `PRAGMA key`, and common variants.
- **WAL file residue**: if encryption is mis-configured after DB creation, `-wal` / `-shm` files can leak plaintext. Every DB open must immediately `PRAGMA key` before any query.
- **No integrity on offline queue**: beyond SQLCipher's per-page HMAC, an attacker with write access could replay or reorder rows. The edge queue should use `id` monotonicity + a HMAC over `(id, topic, payload)` in a separate column to detect tampering.
- **Retention policy not enforced**: an unbounded offline queue is a **disk-exhaustion DoS** — a compromised backend that fails PUBACKs indefinitely can fill the device disk.
- **Bad-quality-as-good substitution bug**: if `process_image.rs` silently forwards the last-known value when quality is Bad, the control loop acts on stale data → life-safety violation.

## Performance Concerns

- `synchronous = FULL` on a SD card roughly halves insert throughput vs `NORMAL`; choose based on power-loss model.
- Large `kdf_iter` (>300k) adds ~1 s to DB open on RevPi Connect 4 (BCM2711) — acceptable at boot, unacceptable if DB is closed/reopened per operation. Keep the handle open for the lifetime of the queue actor.
- `gzip` compression level 9 on an RPi 4 is CPU-bound at ~8 MB/s; level 6 (default) reaches ~25 MB/s and produces files only ~3 % larger.
- SQLite `VACUUM` on an encrypted DB is expensive; prefer `PRAGMA auto_vacuum = INCREMENTAL` and scheduled `incremental_vacuum(N)` during quiet windows.

## Architectural Implications for edge-expert reviews

1. `offline_queue.rs` must open SQLCipher with: `PRAGMA key` as the very first statement, `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, `PRAGMA auto_vacuum = INCREMENTAL`. Any deviation requires a commented rationale.
2. Encryption key sourced from Linux Keyring (preferred), TPM-sealed key, or a device-derived root — never from a config file, environment variable, or binary literal.
3. Queue schema uses `INTEGER PRIMARY KEY AUTOINCREMENT` for monotonic FIFO.
4. Bounded queue enforced by trigger or code path; drop-oldest vs reject is documented per topic class (telemetry vs command).
5. HMAC column on each row computed over `(id || topic || payload || enqueued)` with a per-queue secret to detect tampering beyond SQLCipher's page-level HMAC.
6. `backup.rs` writes files with a documented header: 4-byte ASCII magic (`AQS1`) + 4-byte LE version + 4-byte LE schema_hash + gzip stream. Restore validates all three before `PRAGMA key`.
7. Gzip CRC-32 trailer validation on restore is mandatory; a failed CRC triggers a telemetry alarm and the backup is quarantined, not deleted.
8. Retention policy is explicit: GFS rotation + disk-headroom guard + max-age cap + periodic integrity scrub.
9. `process_image.rs` values are typed as `(value: Option<Variant>, quality: StatusCode, source_ts: u64, server_ts: u64, seq: u64)`. `value` is `None` when `quality.severity() == Bad`. Control logic must pattern-match on quality and refuse to read the numeric value from a Bad entry.
10. Scripting engine reads from process image through a typed accessor that returns `Result<Variant, QualityError>`; no raw field access.

## Domain Rule Additions for edge-expert

- **R-OFF-01:** SQLCipher key sourced from Linux Keyring, TPM, or device-sealed root. Hard-coded keys, env vars, and plain config-file keys are FORBIDDEN.
- **R-OFF-02:** `PRAGMA key` is the FIRST statement after `sqlite3_open`. `journal_mode = WAL`, `synchronous = NORMAL`, `auto_vacuum = INCREMENTAL`.
- **R-OFF-03:** KDF iter count ≥ SQLCipher 4 default (256,000) when using a passphrase; may only be lowered for a raw uniform-256-bit key with a comment.
- **R-OFF-04:** Queue schema uses `INTEGER PRIMARY KEY AUTOINCREMENT` for FIFO monotonicity.
- **R-OFF-05:** Queue size bounded by trigger or code; policy (drop-oldest vs reject) documented per topic class.
- **R-OFF-06:** Per-row HMAC over `(id || topic || payload || enqueued)` with a per-queue secret detects tampering beyond SQLCipher page-level HMAC.
- **R-OFF-07:** No log line may contain `PRAGMA key` or the key value; `security.rs` credential masker enforces.
- **R-BAK-01:** Backup file header: 4-byte magic `AQS1` + version + schema_hash BEFORE the gzip stream. Restore validates all three.
- **R-BAK-02:** Gzip magic (0x1f 0x8b 0x08) and CRC-32 trailer validated on every restore.
- **R-BAK-03:** Retention policy is explicit GFS + disk-headroom guard + max-age cap. Corrupted backups quarantined, not deleted.
- **R-BAK-04:** Periodic integrity scrub task re-validates gzip CRC-32 on stored backups; failures emit telemetry alarms.
- **R-PI-01:** `process_image.rs` entries include `value: Option<Variant>`, `quality: StatusCode` (OPC UA compliant), `source_ts`, `server_ts`, monotonic `seq`.
- **R-PI-02:** When `quality.severity() == Bad`, `value` MUST be `None`. Control logic reading a Bad-quality numeric value is a CRITICAL finding.
- **R-PI-03:** `Uncertain_LastUsableValue` is the correct code for "sensor down, last value available"; reporting the last value with `Good` is FORBIDDEN.
- **R-PI-04:** Scripting engine reads process image via typed accessor returning `Result<Variant, QualityError>`; no raw field access.
- **R-PI-05:** Operator substitution must record `Uncertain_SubstituteValue` and log the substitution to an append-only audit table in the offline queue DB.
