# Database Initialization Reference

> Source files:
> - `infrastructure/docker/init-scripts/00-init-schemas.sh` (primary — shell wrapper with env-based passwords)
> - `infrastructure/database/init-schemas.sql` (standalone SQL, hardcoded `aquaculture` user, no per-service roles)
> - `infrastructure/docker/init-scripts/00-init-schemas.sql` (DEPRECATED — empty stub kept for tooling compat)
> - `infrastructure/docker/init-scripts/01-init-databases.sql` (auth schema tables + extensions)

---

## Schemas Created

| Schema | Service | Purpose |
|--------|---------|---------|
| `public` | shared | Default PostgreSQL schema; used by notification-service for shared tables. Consider deprecating in favor of explicit schema assignment. |
| `auth` | auth-service | Users, tenants, authentication, invitations, tenant_modules, tenant_roles |
| `billing` | billing-service | Subscriptions, invoices, payments |
| `farm` | farm-service | Farms, tanks, batches, harvests |
| `sensor` | sensor-service | Sensors, readings, alerts, time-series data |
| `admin` | admin-api-service | Analytics, system settings |
| `alert` | alert-engine | Alert rules, incidents |
| `hr` | hr-service | Employees, departments |
| `gateway` | gateway-api | Rate limits, audit logs |
| `hydroponics` | hydroponics-service | Grow systems, nutrients, cycles |
| `ai` | ai-service | Models, predictions, recommendations |

Additionally, tenant-specific schemas (`tenant_*`) are created dynamically at runtime by the multi-tenant middleware in each service.

### Grants to shared application user (`${POSTGRES_USER}` / `aquaculture`)

Every schema listed above receives the following grants to the shared application user:

1. `GRANT USAGE ON SCHEMA <schema>`
2. `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA <schema>`
3. `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA <schema>`
4. `ALTER DEFAULT PRIVILEGES IN SCHEMA <schema> GRANT ALL ON TABLES`
5. `ALTER DEFAULT PRIVILEGES IN SCHEMA <schema> GRANT ALL ON SEQUENCES`

### Cross-schema read access

`admin-api-service` (via both the shared user and `admin_service` role) has read-only (`SELECT`) access to:
- `auth` schema — for analytics queries on tenants/users
- `billing` schema — for subscription/revenue analytics

---

## Missing Schemas

These schemas do **not** need to be added — they already exist in `00-init-schemas.sh`:

| Schema | Status | Added in |
|--------|--------|----------|
| `hydroponics` | PRESENT | `00-init-schemas.sh` line 86 |
| `ai` | PRESENT | `00-init-schemas.sh` line 87 |

> **Note:** The standalone `infrastructure/database/init-schemas.sql` also includes both `hydroponics` and `ai` schemas. These are **not missing** from the init scripts.

### Schemas that do NOT exist (potential gap)

| Schema | Service | Current Behavior |
|--------|---------|-----------------|
| `notification` | notification-service | No dedicated schema. The `notification_service` DB role uses the `public` schema instead (see line 267-269 of `00-init-schemas.sh`). Consider creating a `notification` schema if the service grows beyond shared tables. |

---

## Service Database Users

Created via `DO $$ ... END $$` block with conditional `CREATE ROLE ... IF NOT EXISTS`.

| DB Role | Env Var for Password | Owns Schema | Extra Privileges |
|---------|---------------------|-------------|------------------|
| `auth_service` | `AUTH_SERVICE_DB_PASS` | `auth` | Standard (USAGE, ALL on tables/sequences, DEFAULT PRIVILEGES) |
| `farm_service` | `FARM_SERVICE_DB_PASS` | `farm` | Standard |
| `sensor_service` | `SENSOR_SERVICE_DB_PASS` | `sensor` | Standard |
| `billing_service` | `BILLING_SERVICE_DB_PASS` | `billing` | Standard |
| `hr_service` | `HR_SERVICE_DB_PASS` | `hr` | Standard |
| `alert_service` | `ALERT_SERVICE_DB_PASS` | `alert` | Standard |
| `admin_service` | `ADMIN_SERVICE_DB_PASS` | `admin` | + `SELECT` on `auth` and `billing` schemas (cross-schema analytics) |
| `gateway_service` | `GATEWAY_SERVICE_DB_PASS` | `gateway` | Standard |
| `notification_service` | `NOTIFICATION_SERVICE_DB_PASS` | `public` (no own schema) | USAGE + ALL on `public` tables, DEFAULT PRIVILEGES on `public` |
| `hydroponics_service` | `HYDROPONICS_SERVICE_DB_PASS` | `hydroponics` | Standard + `CREATE ON DATABASE` + `USAGE ON SCHEMA public` |
| `ai_service` | `AI_SERVICE_DB_PASS` | `ai` | Standard |

### Password provisioning (SEC-015)

- Passwords are read from environment variables passed to the Postgres container.
- If an env var is **not set**, a cryptographically random 32-byte password is generated via `openssl rand -base64 32`.
- Single quotes in passwords are escaped for safe embedding in SQL `PASSWORD '...'` literals.
- The init script logs whether each password was provided or auto-generated (without revealing values).

### Standard grant set (per service user)

Each service user receives five grants on its own schema:
```sql
GRANT USAGE ON SCHEMA <schema> TO <role>;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA <schema> TO <role>;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA <schema> TO <role>;
ALTER DEFAULT PRIVILEGES IN SCHEMA <schema> GRANT ALL ON TABLES TO <role>;
ALTER DEFAULT PRIVILEGES IN SCHEMA <schema> GRANT ALL ON SEQUENCES TO <role>;
```

---

## Extensions

Installed across the init script chain:

| Extension | Installed In | Purpose |
|-----------|-------------|---------|
| `timescaledb` | `00-init-schemas.sh` | Time-series optimization for sensor data. Installed with `CASCADE`. Verified via `pg_extension` check with NOTICE/WARNING. |
| `uuid-ossp` | `01-init-databases.sql`, `03-farm-tables-and-seed.sql` | UUID generation (`uuid_generate_v4()`) |
| `pgcrypto` | `01-init-databases.sql` | Cryptographic functions (`gen_random_uuid()`, though bcrypt hashing is done in Node.js, not SQL) |
| `pg_trgm` | `01-init-databases.sql` | Trigram-based text similarity/search |
| `btree_gist` | `apps/farm-service/src/database/migrations/001_create_extensions.sql` | GiST index support for exclusion constraints (farm-service migration, not init scripts) |

### Docker image

All compose files use `timescale/timescaledb:latest-pg16` which bundles TimescaleDB on top of PostgreSQL 16.

---

## Initialization Order

Scripts execute in lexicographic filename order via PostgreSQL's docker-entrypoint-initdb.d mechanism:

### Step 0: `00-trust-auth.sh`
- Appends `host all all 0.0.0.0/0 trust` to `pg_hba.conf`
- **Development only** — disables password authentication for all connections

### Step 1: `00-init-schemas.sh` (primary init)
Execution order within the script:
1. **Password generation** — reads `*_SERVICE_DB_PASS` env vars, falls back to `openssl rand`
2. **Extension: TimescaleDB** — `CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE`
3. **Schema creation** — 10 schemas: `auth`, `billing`, `farm`, `sensor`, `admin`, `alert`, `hr`, `gateway`, `hydroponics`, `ai`
4. **Shared user grants** — USAGE, ALL TABLES, ALL SEQUENCES, DEFAULT PRIVILEGES for `${POSTGRES_USER}`
5. **Cross-schema read access** — admin gets SELECT on `auth` and `billing`
6. **Per-service role creation** — 11 roles created conditionally (`IF NOT EXISTS`)
7. **Per-service grants** — each role gets access to its own schema
8. **Special grants** — `admin_service` cross-schema read, `notification_service` public schema, `hydroponics_service` CREATE on DB
9. **Verification query** — lists all schemas with owners

### Step 2: `00-init-schemas.sql`
- **DEPRECATED** — empty file, kept for backward compatibility
- All logic moved to `00-init-schemas.sh` (SEC-015)

### Step 3: `01-init-databases.sql`
1. **Extensions** — `uuid-ossp`, `pgcrypto`, `pg_trgm`
2. **Database grant** — `GRANT ALL PRIVILEGES ON DATABASE aquaculture TO aquaculture`
3. **Auth schema tables** — `tenants`, `users`, `invitations`, `tenant_modules`, `tenant_roles`
4. **Indexes** — on slug, status, email, tenantId, role, token, code

### Step 4: `02-migrate-tanks-to-equipment.sql`
- Farm schema migration (tanks to equipment restructure)

### Step 5: `03-farm-tables-and-seed.sql`
- Farm schema tables and seed data
- Re-creates `uuid-ossp` extension (idempotent)

### Step 6: `04-billing-tables.sql`
- Billing schema table definitions

### Step 7: `05-seed-module-pricing.sql`
- Module pricing seed data

---

## Docker Entrypoint

### How init scripts are executed

The PostgreSQL docker-entrypoint-initdb.d mechanism works as follows:

1. The init-scripts directory is **bind-mounted** into the container:
   ```yaml
   volumes:
     - ./infrastructure/docker/init-scripts:/docker-entrypoint-initdb.d
   ```

2. Scripts run **only on first container start** (when the data volume is empty). If `postgres_data` volume already exists with data, init scripts are skipped entirely.

3. Scripts execute in **lexicographic order** by filename: `.sh` files are sourced by bash, `.sql` files are executed via `psql`.

4. The `00-init-schemas.sh` script uses `set -euo pipefail` and `psql -v ON_ERROR_STOP=1` for fail-fast behavior.

### Compose file variants

| File | Mount Mode | Port |
|------|-----------|------|
| `docker-compose.yml` | read-write | 5432 |
| `docker-compose.dev.yml` | read-write | 5432 |
| `docker-compose.infra.yml` | read-write | 5433 |
| `docker-compose.droplet.yml` | **read-only** (`:ro`) | 5432 |
| `docker-compose.prod.yml` | (via infrastructure/docker/) | 5432 |

### Environment variables passed to Postgres container

```yaml
environment:
  POSTGRES_USER: aquaculture
  POSTGRES_PASSWORD: ${DB_PASSWORD:-devpassword}
  POSTGRES_DB: aquaculture
  # SEC-015: Per-service DB passwords
  AUTH_SERVICE_DB_PASS: ${AUTH_SERVICE_DB_PASS:-}
  FARM_SERVICE_DB_PASS: ${FARM_SERVICE_DB_PASS:-}
  SENSOR_SERVICE_DB_PASS: ${SENSOR_SERVICE_DB_PASS:-}
  BILLING_SERVICE_DB_PASS: ${BILLING_SERVICE_DB_PASS:-}
  HR_SERVICE_DB_PASS: ${HR_SERVICE_DB_PASS:-}
  ALERT_SERVICE_DB_PASS: ${ALERT_SERVICE_DB_PASS:-}
  ADMIN_SERVICE_DB_PASS: ${ADMIN_SERVICE_DB_PASS:-}
  GATEWAY_SERVICE_DB_PASS: ${GATEWAY_SERVICE_DB_PASS:-}
  NOTIFICATION_SERVICE_DB_PASS: ${NOTIFICATION_SERVICE_DB_PASS:-}
  HYDROPONICS_SERVICE_DB_PASS: ${HYDROPONICS_SERVICE_DB_PASS:-}
  AI_SERVICE_DB_PASS: ${AI_SERVICE_DB_PASS:-}
```

### Re-initialization

To re-run init scripts after schema changes:
```bash
docker compose down
docker volume rm aqua-saas_postgres_data   # destroys all data
docker compose up -d
```

> **Warning:** This destroys all data. For production, use migrations instead.

---

## Standalone SQL File

`infrastructure/database/init-schemas.sql` is a **separate, self-contained** SQL file that:
- Creates the same 10 schemas
- Grants all privileges to the hardcoded `aquaculture` user
- Does **not** create per-service roles (SEC-015 not implemented)
- Does **not** install TimescaleDB
- Contains commented-out `ALTER SCHEMA ... OWNER TO` statements for future use
- Intended for manual execution or non-Docker environments

This file and `00-init-schemas.sh` must be kept in sync when schemas are added or removed.
