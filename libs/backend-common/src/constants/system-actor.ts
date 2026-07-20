/**
 * Canonical system-principal actor UUID.
 *
 * Machine/cron writes that record an actor (e.g. a `revertedBy`/`authorId`
 * audit column) but have NO human actor must use this sentinel instead of a
 * non-UUID string like `'system'` — inserting `'system'` into a `uuid` column
 * fails with Postgres 22P02 (invalid input syntax for type uuid) at runtime.
 *
 * It is the RFC-4122 nil UUID: a structurally valid uuid that
 * `uuid_generate_v4()`/`gen_random_uuid()` never produce (no collision with a
 * real principal), and it round-trips cleanly through the DB, JSON, and logs.
 *
 * Sibling of `GLOBAL_TENANT_UUID` (`../tenant/constants`). The two share the nil
 * literal but are semantically distinct (actor vs tenant) and must stay
 * separate constants — never collapse them.
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
