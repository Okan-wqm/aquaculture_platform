# Research: PostgreSQL Column Type Discipline — DECIMAL, TIMESTAMPTZ, UUID, TEXT, PII

**Topic:** Enterprise column-type discipline for multi-tenant PostgreSQL schemas — money precision, absolute timestamps, cross-service identifiers, text width, and PII encryption at rest.
**Date:** 2026-04-08
**Agent:** database-reviewer

## Sources
- [PostgreSQL: Documentation 15 — Numeric Types](https://www.postgresql.org/docs/15/datatype-numeric.html)
- [PostgreSQL: Documentation 15 — Date/Time Types](https://www.postgresql.org/docs/15/datatype-datetime.html)
- [PostgreSQL: Documentation 15 — Character Types](https://www.postgresql.org/docs/15/datatype-character.html)
- [PostgreSQL: Documentation 15 — UUID Type](https://www.postgresql.org/docs/15/datatype-uuid.html)
- [PostgreSQL: Documentation 15 — pgcrypto](https://www.postgresql.org/docs/15/pgcrypto.html)
- [PostgreSQL: Documentation 15 — Encryption Options](https://www.postgresql.org/docs/15/encryption-options.html)
- [PostgreSQL Wiki: Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This)
- [Tiger Data: Best Practices for Picking PostgreSQL Data Types](https://www.tigerdata.com/blog/best-practices-for-picking-postgresql-data-types)
- [Crunchy Data: Working with Money in Postgres](https://www.crunchydata.com/blog/working-with-money-in-postgres)
- [Crunchy Data: Working with Time in Postgres](https://www.crunchydata.com/blog/working-with-time-in-postgres)
- [Crunchy Data: Data Encryption in Postgres — A Guidebook](https://www.crunchydata.com/blog/data-encryption-in-postgres-a-guidebook)
- [Crunchy Data: Postgres Serials Should Be BIGINT](https://www.crunchydata.com/blog/postgres-serials-should-be-bigint-and-how-to-migrate)
- [Cybertec: UUID, serial or identity columns for PostgreSQL primary keys](https://www.cybertec-postgresql.com/en/uuid-serial-or-identity-columns-for-postgresql-auto-generated-primary-keys/)
- [Cybertec: Unexpected downsides of UUID keys in PostgreSQL](https://www.cybertec-postgresql.com/en/unexpected-downsides-of-uuid-keys-in-postgresql/)
- [AWS Aurora PostgreSQL: Column encryption](https://docs.aws.amazon.com/dms/latest/sql-server-to-aurora-postgresql-migration-playbook/chap-sql-server-aurora-pg.security.columnencryption.html)
- [Google Cloud SQL: Data privacy strategies for PostgreSQL](https://cloud.google.com/sql/docs/postgres/data-privacy-strategies)

## Key Findings

1. **Floating-point for money is a data-corruption anti-pattern.** `FLOAT`, `REAL`, and `DOUBLE PRECISION` use IEEE 754 binary floating point; values like `0.1` cannot be represented exactly, and arithmetic accumulates rounding drift. PostgreSQL documents this explicitly: "If you require exact storage and calculations (such as for monetary amounts), use the numeric type instead." Any monetary, weight, pH, dissolved-oxygen, or compliance-precision column on a floating-point type = CRITICAL.
2. **`DECIMAL` and `NUMERIC` are the same type.** The two names are aliases in PostgreSQL. Both accept an optional `(precision, scale)` — precision is the total significant digits, scale is the digits to the right of the decimal point. `NUMERIC` without precision/scale is unconstrained (up to 1000 digits), which is legal but obscures intent; reviewers should require explicit `NUMERIC(p,s)` on all monetary and precision columns.
3. **`money` is not "the money type."** The PostgreSQL wiki `Don't Do This` page explicitly warns against the `money` type: it does not handle fractions smaller than the locale's smallest unit, has ambiguous rounding, and silently depends on `lc_monetary`. A locale change mutates every existing money value. `money` in any new schema = HIGH.
4. **Integer cents is a legitimate alternative** when no sub-cent precision is needed and the currency is fixed per table. Storing cents as `BIGINT` is faster and smaller than `NUMERIC` and eliminates all rounding ambiguity. Either `NUMERIC(p,s)` or "integer cents + separate currency column" is acceptable — mixing the two within one domain is MEDIUM.
5. **`TIMESTAMP WITHOUT TIME ZONE` is a trap.** The wiki says: "Don't use the timestamp type to store timestamps, use timestamptz." A `TIMESTAMP` stores a wall-clock reading with no reference frame; the same value means different instants in different sessions. `TIMESTAMPTZ` stores an absolute instant (UTC epoch microseconds) and converts on display according to the session's `TIMEZONE`. Audit / compliance / financial columns on `TIMESTAMP` = CRITICAL.
6. **`TIMESTAMPTZ` does NOT cost extra storage.** Both `TIMESTAMP` and `TIMESTAMPTZ` are 8 bytes. Any argument for `TIMESTAMP` on "size" grounds is wrong.
7. **`TIMESTAMPTZ` interacts correctly with daylight-saving time and cross-region replication.** `TIMESTAMP` arithmetic across a DST boundary is silently wrong. For a multi-tenant aquaculture platform with farms in multiple time zones, `TIMESTAMP` would yield inconsistent "now" semantics across the fleet.
8. **`SERIAL` / `BIGSERIAL` vs `UUID` is a tradeoff, not a verdict.** Sequential integer keys are smaller (4/8 bytes vs 16 bytes), faster to index (better cache locality), and produce tighter B-trees. UUIDs are globally unique without a sequence round-trip, survive sharding, and do not leak row counts. `SERIAL` is legacy syntax; modern PostgreSQL (10+) uses `GENERATED ALWAYS AS IDENTITY` which is SQL-standard and cannot be accidentally overridden.
9. **Random UUIDv4 destroys B-tree locality.** Every insert hits a random position in the index, causing page splits and cache churn. For write-heavy tables at scale, this is a measurable throughput hit. UUIDv7 (time-ordered) preserves temporal locality and should be preferred when UUID is required.
10. **Cross-service identifiers MUST be UUID.** Any column that is referenced by another service (via event contract, federated GraphQL, or cross-schema join) must not be a sequence integer — sequences are local to one database and cannot survive split-brain or sharding. Tenant IDs, user IDs, batch IDs, sensor IDs, farm IDs = UUID.
11. **`VARCHAR(255)` is meaningless.** The 255 ceiling is a MySQL relic (byte length of a single-byte index key in MyISAM). In PostgreSQL, `VARCHAR(n)` and `TEXT` have identical storage and performance — both are TOAST-compressed variable-length. `VARCHAR(n)` only differs by runtime length validation. PostgreSQL docs recommend: "Don't use the type varchar(n) by default. Consider varchar (without the length limit) or text instead."
12. **`VARCHAR(n)` is appropriate only when `n` is a hard business rule** (e.g., ISO 3166 country code = `CHAR(2)`, IBAN `VARCHAR(34)`, phone E.164 `VARCHAR(16)`). Arbitrary caps like `VARCHAR(50)` for names or `VARCHAR(100)` for email are schema debt — they reject valid input and require migrations to fix.
13. **`CHAR(n)` is never right.** PostgreSQL `CHAR(n)` pads with spaces, is slower than `VARCHAR` / `TEXT`, and has no performance advantage. Use it only for genuinely fixed-width encoded data (e.g., `CHAR(2)` ISO country code).
14. **`JSON` is a deprecated choice; use `JSONB`.** `JSON` stores the raw text, preserves whitespace and duplicate keys, has no GIN index support, and re-parses on every access. `JSONB` stores a parsed binary form, deduplicates keys, supports GIN indexes with `jsonb_ops` or `jsonb_path_ops`, and is the universally-correct choice. Any `JSON` column = MEDIUM.
15. **PII at rest requires pgcrypto or equivalent.** PostgreSQL provides three encryption layers: (a) cluster-level TDE (via filesystem or block-device encryption — satisfies disk-theft threat only), (b) column-level via `pgcrypto` using PGP or symmetric AES (satisfies DBA / backup-theft threat), (c) client-side encryption where the key never reaches the database (satisfies insider threat). Plain `TEXT` columns storing SSN, bank account, passport number, genetic data = CRITICAL.
16. **`pgcrypto` is the canonical choice** for column-level encryption inside PostgreSQL. `pgp_sym_encrypt()` / `pgp_sym_decrypt()` use PGP symmetric encryption; AES-128/192/256 is supported via `encrypt()` / `decrypt()`. Keys must NOT live in application environment variables alone — use AWS Secrets Manager / Google Secret Manager / HashiCorp Vault with short-lived credentials.
17. **pgcrypto columns cannot be indexed for equality on the plaintext.** Either store a separate `HMAC` digest column for deterministic lookup (losing semantic security but enabling equality), or accept full-table decryption scans. Hashing-for-lookup + encryption-for-storage is the standard pattern.
18. **Email, phone, names** are PII but usually need equality / prefix search. The production pattern is: lower-cased normalized copy + case-insensitive unique index for lookup, plus masked logging (first character + `***@domain`). Storing raw PII in plaintext is acceptable IF backups are encrypted at rest AND access is audit-logged AND the DBA role is restricted.

## Security Concerns
- Floating-point money column that accumulates drift over a year of transactions = CRITICAL data corruption.
- `TIMESTAMP WITHOUT TIME ZONE` on audit / compliance columns across multi-timezone fleet = CRITICAL (audit trail ambiguity, regulatory non-conformance).
- Plain `TEXT` SSN / bank account / health data = CRITICAL (GDPR Article 32, HIPAA, PCI DSS violations on backup theft).
- `VARCHAR(n)` too-small on user-facing fields = HIGH availability risk (rejection of legitimate data, migration churn).
- `SERIAL` identifier exposed in a cross-service event contract = HIGH (row-count leak, cross-service collision risk).
- Encryption key stored in environment variable of the same process that decrypts = HIGH (compromise of app host = compromise of data at rest).
- pgcrypto `encrypt()` without IV = HIGH (deterministic ciphertext leaks plaintext equality).

## Performance Concerns
- Random UUIDv4 on write-heavy hot tables = HIGH (B-tree bloat, write amplification, cache churn). Recommend UUIDv7 or sequential identity where cross-service sharing is not required.
- Unbounded `NUMERIC` (no precision/scale) = LOW (marginal CPU overhead per arithmetic op) but MEDIUM for schema documentation — intent is unclear.
- `VARCHAR(n)` with tiny `n` = LOW runtime cost but MEDIUM schema debt — every widening requires an `ALTER TABLE` that may rewrite the table on older PostgreSQL versions.
- `JSON` (not `JSONB`) causing re-parse on every read = MEDIUM (quadratic over many accesses), and MEDIUM for missing GIN index support.
- Full-table scans on encrypted columns because lookup index was omitted = HIGH on any table larger than a few thousand rows.

## Architectural Implications for database-reviewer

- Every migration creating a monetary, weight, pH, DO, temperature, or other precision column MUST use `NUMERIC(p,s)` with explicit precision/scale. No `FLOAT`, no `REAL`, no `DOUBLE PRECISION`, no bare `NUMERIC`.
- Every migration creating a timestamp column MUST use `TIMESTAMPTZ`. Raw `TIMESTAMP` is banned without a written exception in the migration comment.
- Every migration creating a cross-service identifier MUST use `UUID` with `gen_random_uuid()` default (PostgreSQL 13+) or `uuid_generate_v4()` if `uuid-ossp` is already installed. UUIDv7 strongly preferred for write-heavy tables once the extension is available.
- `VARCHAR(n)` is only allowed when `n` is an externally-defined hard limit (ISO country, E.164 phone, ISBN, IBAN). `VARCHAR(255)` as a default = reject.
- PII columns (SSN, bank account, passport, health data) MUST be encrypted using pgcrypto or client-side. Plain `TEXT` = block deploy.
- PII columns needing equality lookup MUST have a separate HMAC / hash column and unique index on the hash, never on the ciphertext directly.
- Entity definitions in TypeORM MUST use `@Column({ type: 'numeric', precision: 18, scale: 4 })` for money, not `type: 'float'` or `type: 'double precision'`. Flag any mismatch between migration and entity.

## Domain Rule Additions for database-reviewer

Add to `## Domain Rules → Column Type Discipline (Critical)`:

- `money` PostgreSQL type is BANNED — locale-dependent, no sub-cent precision, silent mutation on `lc_monetary` change. Any occurrence = HIGH, recommend migration to `NUMERIC(p,s)` or integer cents + separate currency column.
- Bare `NUMERIC` (no precision/scale) on a monetary / precision column = MEDIUM. Explicit `NUMERIC(18,4)` or similar is mandatory — the precision documents intent.
- `TIMESTAMP` (without time zone) on any column = CRITICAL for audit / compliance columns, HIGH otherwise. Both types are 8 bytes, so the storage argument is void.
- `SERIAL` / `BIGSERIAL` on a column exposed across services = HIGH. Use `GENERATED ALWAYS AS IDENTITY` for single-service PKs or `UUID` (UUIDv7 preferred) for cross-service identifiers.
- `VARCHAR(n)` without a business justification in the migration comment = MEDIUM. `VARCHAR(255)` default = reject.
- `CHAR(n)` except for genuinely fixed-width codes = MEDIUM. PostgreSQL `CHAR` is slower than `VARCHAR` / `TEXT` due to padding.
- `JSON` (not `JSONB`) = MEDIUM — no GIN support, re-parses on access. Recommend migration to `JSONB`.
- Plain `TEXT` storing SSN, bank account, national ID, passport, or health data = CRITICAL. Must use pgcrypto symmetric encryption or client-side encryption with keys outside the DB.
- pgcrypto column with equality lookups MUST have a companion HMAC column indexed for lookup; lookup on ciphertext = HIGH (full scan).
- Encryption keys stored in same process memory as decrypted values with no rotation = HIGH. Recommend KMS-backed envelope encryption.
