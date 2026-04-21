# ADR-023: Encrypted-Column Schema Contract

**Status**: Proposed (2026-04-21) — lands in Phase 2 of the db-migrate enterprise refactor plan
**Plan reference**: `docs/plans/2026-04-21-db-migrate-enterprise-refactor.md` §v3 R15
**Related**: ADR-011, ADR-019, ADR-022

## Context

Plan v2's Phase 3 `alignColumnType` primitive compares entity `@Column({type: 'text'})` against DB column `data_type`; if mismatched, emits `ALTER COLUMN TYPE`. Compliance-expert audit (v3) flagged this silently corrupts columns protected via `pgp_sym_encrypt` (bytea ciphertext): the primitive would issue `ALTER COLUMN x TYPE text USING x::text`, which does NOT decrypt — it stringifies the raw binary, destroying rows.

The entity model has no way to declare "this column is encrypted; hands off to the migration tool". The drift validator and primitives must cooperate with a declarative contract that identifies encrypted columns and refuses DDL against them.

## Decision

Introduce `@EncryptedAtRest` decorator + drift validator Class J.

### Decorator

```ts
@Column({ name: 'national_id', type: 'bytea' })
@EncryptedAtRest({
  keyId: 'tenant-pii-v1',
  algorithm: 'pgp_sym',
})
nationalId: Buffer;
```

Location: `libs/backend-common/src/database/encrypted-at-rest.decorator.ts`

### Validator Class J (encrypted-column protection)

`SchemaDriftValidator.validateEntity()` extended to:
1. Read `@EncryptedAtRest` metadata for each column
2. If decorator present, assert DB column has `data_type = 'bytea'` (required storage for all supported algorithms)
3. If present, SKIP type-mismatch detection (Class B) — entity's declared type is the cipher's output shape, not the logical value type
4. Emit Class J violation if (a) decorated but DB column is not bytea, (b) not decorated but DB column is bytea AND named in a known-encrypted list

### Primitive refusal contract

Every primitive in `libs/backend-common/src/database/base-migration.ts` that alters column shape MUST:
1. Read `@EncryptedAtRest` metadata before proposing DDL
2. If decorated, emit `MigrationEncryptionProtected { schema, table, column, keyId }` event and REFUSE to alter (throw with clear error message pointing to key-rotation runbook)
3. Remediation path: `docs/runbooks/encrypted-column-key-rotation.md` — separate operator script, never a migration, uses `pgp_sym_decrypt(old_key)` + `pgp_sym_encrypt(new_key)` in an app-aware job

### Supported algorithms (initial)

| Algorithm | Storage | Decrypt |
|---|---|---|
| `pgp_sym` | bytea | `pgp_sym_decrypt(col, key)` |
| `pgp_pub` | bytea | `pgp_pub_decrypt(col, private_key)` |
| `aes_256_gcm` | bytea | app-side (Node `crypto.createDecipheriv`) |

## Consequences

**Positive**:
- Eliminates silent ciphertext corruption class of bug
- SOC2 CC6.1 evidence: "encrypted columns covered by explicit decorator + drift validation"
- Key rotation path separate from migration path — reduces blast radius

**Negative**:
- All existing `bytea`-stored encrypted columns across the codebase must backfill the decorator in Phase 2 (tracked work)
- Key rotation runbook + operator tooling is additional maintenance burden
- Primitive refusal means schema changes on encrypted columns require explicit operator intervention — slower iteration

## Alternatives Considered

1. **Column-name allowlist** (string-match "_encrypted" suffix): brittle, no type safety.
2. **Separate schema namespace for encrypted columns**: over-engineered; most tables have mixed encrypted + clear-text columns.
3. **Heuristic detection (entity type=bytea + has @Column comment)**: unreliable.

## Validation

- Unit: `libs/backend-common/src/database/__tests__/encrypted-at-rest.decorator.spec.ts` — decorator metadata round-trip
- Unit: primitive refusal test — decorated column + attempt alter → throws with remediation link
- Integration: `e2e/tests/integration/encrypted-column-drift.spec.ts` — seed drifted encrypted column + validator reports Class J (not Class B type-mismatch)
- Audit: data-expert (primary); auth-security-expert (crypto contract); compliance-expert (keyId + algorithm classification for audit trail)

## References

- PostgreSQL `pgcrypto` extension documentation
- OWASP Cryptographic Storage Cheat Sheet
- NIST SP 800-57 — key management guidelines
