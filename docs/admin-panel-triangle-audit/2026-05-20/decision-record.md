# Decision Record - 2026-05-20

## Platform Admin Boundary

Admin API is treated as a platform-admin-only service boundary. Product terminology says "platform admin"; the current auth-service role enum stores that actor as `SUPER_ADMIN`, so this PR uses `SUPER_ADMIN` as the single code-level role.

Route decorators cannot widen this boundary to tenant admin or module roles. A literal `PLATFORM_ADMIN` token role is not accepted until the auth-service role model is migrated end to end.

## Analytics Contract

The admin analytics frontend and backend now use explicit `range` and `granularity` parameters for the three in-scope charts. Legacy `period/dataPoints` remains only for backward-compatible endpoints outside this route work.

## Report Artifacts

Report execution records are the source of truth. Artifacts are stored in object storage with object key, content type, byte size, and SHA-256 on the execution row. Redis can still cache expensive computation, but it is not a durable artifact store and downloads do not regenerate missing artifacts.

## Snapshot Identity

Daily analytics snapshots are unique by `snapshotType`, `category`, and `snapshotDate`. Re-running a snapshot updates the same row instead of creating duplicates.
