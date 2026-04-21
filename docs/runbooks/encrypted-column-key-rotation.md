# Runbook: Encrypted-Column Key Rotation

**Referenced by**: ADR-023 Class J refusal contract,
`@EncryptedAtRest` decorator, `addMissingColumns`,
`alignColumnNullability`, `alignColumnType`, `dropOrphanedColumns`.

**Purpose**: The migration-primitive layer REFUSES to alter any column
decorated `@EncryptedAtRest` (Class J). Schema changes on encrypted
columns require operator cooperation to avoid ciphertext corruption.
This runbook is the explicit operator-side remediation path.

---

## When to invoke

- The drift validator reports a Class J violation (DB type !== bytea
  on a decorated property).
- The application adds a new @EncryptedAtRest column to an existing
  table.
- A key rotation becomes necessary (keyId versioning, suspected
  compromise).
- An encrypted column's algorithm must change (e.g. pgp_sym → aes_256_gcm).

## What the primitive DOES NOT do

Phase 3 primitives refuse DDL on `@EncryptedAtRest` columns. Attempting
to run `alignColumnType` / `addMissingColumns` / `dropOrphanedColumns`
against a decorated property throws with a pointer back to this
document.

## Canonical sequence

The platform does not ship an automated "rotate key" CLI. Every
rotation is a scheduled operator action under change-management
review. The sequence is:

1. **Acquire separate operator authorization** — rotation is a
   `drift_fatal_bypass` candidate via `aqua-ctl drift-bypass`;
   provide the ticket ID + TTL.

2. **Take a backup** of the table's encrypted column + verify restore
   works on a staging copy BEFORE touching production.

3. **Add the new column alongside the old** — never transform in place:

   ```sql
   ALTER TABLE hr.employees
     ADD COLUMN national_id_v2 bytea;
   ```

4. **Backfill** via an app-aware job that reads the old column via
   the old key, re-encrypts via the new key, writes the new column:

   ```ts
   for batch of employees:
     clear = pgp_sym_decrypt(emp.national_id, OLD_KEY)
     emp.national_id_v2 = pgp_sym_encrypt(clear, NEW_KEY)
   ```

   Use `backfillColumn` for the chunked pattern, but the update
   expression MUST be a cipher-aware app-level script — SQL
   primitives cannot decrypt.

5. **Switch app reads** to the new column via a deploy under feature
   flag. Verify.

6. **Drop the old column** via an explicit migration (not via
   `dropOrphanedColumns` — the decorator refuses); update the entity
   `@EncryptedAtRest.keyId` to the new version.

7. **Archive** the backup per the retention matrix (ADR-024). The
   OLD key is retained under SOC2 CC6.1 evidence for the audit
   window, then destroyed.

## Post-rotation validation

- Drift validator reports zero Class J violations for the affected
  entity.
- CI invariant `drift-class-parity.spec.ts` still green.
- Sampling: 1% of rows decrypt successfully via the new key.

## References

- ADR-023 Encrypted-Column Schema Contract
- ADR-022 Pseudonymisation Key Management (HMAC pepper, similar
  rotation discipline)
- ADR-024 Compliance Retention Matrix (old-key retention window)
