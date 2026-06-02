# Auth DB Ownership

`apps/auth-service` is the single production owner for the `auth` schema. Admin-api and other services may read `auth.*` for operational views, but DML writes and auth-schema DDL must go through auth-service-owned code or migrations.

## Boundary

Allowed write paths:

- Auth-service TypeORM repositories and auth-service migrations.
- Typed auth-service NATS handlers for admin operations.

Disallowed write paths:

- Raw `INSERT`, `UPDATE`, or `DELETE` against `auth.*` outside auth-service.
- `CREATE`, `ALTER`, `DROP`, or `TRUNCATE` DDL against `auth.*` outside auth-service.
- Baseline exemptions for production code.
- Admin-api migrations that backfill or mutate auth-owned tables.

The CI gate is `npm run gates:auth-db-ownership`. Its baseline must remain empty unless an explicitly reviewed historical migration is being removed from service ownership; new auth DML/DDL outside auth-service must fail.
