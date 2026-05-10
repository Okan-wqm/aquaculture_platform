--
-- insert-baseline-as-applied.sql
--
-- WHEN TO RUN
--   Pre-deploy on legacy droplets whose service schemas already
--   contain the post-Wave-4-A.2 baseline tables (created by manual
--   psql, an out-of-band migration, or an init-script run that
--   pre-dates the new migration runners).
--
--   Run this script ONCE on each affected droplet, BEFORE the next
--   `db-migrate` invocation. Running it on a fresh droplet is also
--   safe — every INSERT is guarded by `WHERE NOT EXISTS`, so the
--   script is idempotent.
--
-- WHY
--   Wave 4-A.2 established a baseline migration in every service
--   directory:
--
--     - auth-service:        1700000000000-CreateInitialSchema.ts
--     - farm-service:        1700000000000-CreateInitialSchema.ts
--     - sensor-service:      1735800000000-CreateSensorReadingsHypertable.ts
--                            1735850000000-CreateSensorBaselineTables.ts
--                            1736800001000-AddLoraDevicesEdgeDeviceFk.ts
--     - billing-service:     1700000000000-CreateInitialSchema.ts
--     - alert-engine:        1700000000000-CreateInitialSchema.ts
--     - admin-api-service:   1780000000000-CreateInitialSchema.ts
--     - ai-service:          1700000000000-CreateInitialSchema.ts
--     - hydroponics-service: 1700000000000-CreateInitialSchema.ts
--
--   On a legacy droplet the tables already exist, so re-running the
--   baseline migration's `up()` would fail with "relation X already
--   exists" and crash the migration runner on boot. The architectural
--   contract is that every migration is recorded once in its
--   service's `<schema>.migrations` ledger — we record the baselines
--   as already-applied so the runner skips them.
--
--   This is NOT a workaround. It is the canonical "baseline" pattern
--   documented in TypeORM operations literature: the first migration
--   captures the existing schema state, and on legacy systems is
--   marked as already-applied to prevent re-execution. Greenfield
--   droplets run the baseline normally; legacy droplets carry the
--   `applied_at` row from this script.
--
-- HOW
--   On the droplet host:
--
--     docker exec -i aqua-postgres psql -U "$POSTGRES_USER" \
--       -d "$POSTGRES_DB" \
--       -f /var/aqua-saas/tools/bootstrap-restore/insert-baseline-as-applied.sql
--
--   Or, mounted into the postgres container:
--
--     psql -U aquaculture -d aquaculture \
--       -f /sql/insert-baseline-as-applied.sql
--
--   Verify after the run:
--
--     SELECT * FROM auth.migrations    ORDER BY timestamp;
--     SELECT * FROM farm.migrations    ORDER BY timestamp;
--     SELECT * FROM sensor.migrations  ORDER BY timestamp;
--     SELECT * FROM billing.migrations ORDER BY timestamp;
--     SELECT * FROM alert.migrations   ORDER BY timestamp;
--     SELECT * FROM admin.migrations   ORDER BY timestamp;
--     SELECT * FROM ai.migrations      ORDER BY timestamp;
--     SELECT * FROM hydroponics.migrations ORDER BY timestamp;
--
--   Each ledger should contain at least the row inserted below
--   (plus any later migrations applied previously).
--
-- TOTAL ROWS INSERTED: 10 (1 auth + 1 farm + 3 sensor + 1 billing +
-- 1 alert + 1 admin + 1 ai + 1 hydroponics)
--

-- -----------------------------------------------------------------
-- auth-service Wave 1 baseline
-- -----------------------------------------------------------------
INSERT INTO auth.migrations (timestamp, name)
  SELECT 1700000000000, 'CreateInitialSchema1700000000000'
  WHERE NOT EXISTS (
    SELECT 1 FROM auth.migrations
    WHERE name = 'CreateInitialSchema1700000000000'
  );

-- -----------------------------------------------------------------
-- farm-service Wave 2-A + W4-A.1 + W4-A.2 baseline
-- -----------------------------------------------------------------
INSERT INTO farm.migrations (timestamp, name)
  SELECT 1700000000000, 'CreateInitialSchema1700000000000'
  WHERE NOT EXISTS (
    SELECT 1 FROM farm.migrations
    WHERE name = 'CreateInitialSchema1700000000000'
  );

-- -----------------------------------------------------------------
-- sensor-service Wave 2-B + W4-A.2 baseline (3 migrations)
-- -----------------------------------------------------------------
INSERT INTO sensor.migrations (timestamp, name)
  SELECT 1735800000000, 'CreateSensorReadingsHypertable1735800000000'
  WHERE NOT EXISTS (
    SELECT 1 FROM sensor.migrations
    WHERE name = 'CreateSensorReadingsHypertable1735800000000'
  );

INSERT INTO sensor.migrations (timestamp, name)
  SELECT 1735850000000, 'CreateSensorBaselineTables1735850000000'
  WHERE NOT EXISTS (
    SELECT 1 FROM sensor.migrations
    WHERE name = 'CreateSensorBaselineTables1735850000000'
  );

INSERT INTO sensor.migrations (timestamp, name)
  SELECT 1736800001000, 'AddLoraDevicesEdgeDeviceFk1736800001000'
  WHERE NOT EXISTS (
    SELECT 1 FROM sensor.migrations
    WHERE name = 'AddLoraDevicesEdgeDeviceFk1736800001000'
  );

-- -----------------------------------------------------------------
-- billing-service Wave 2-C + W4-A.2 baseline
-- -----------------------------------------------------------------
INSERT INTO billing.migrations (timestamp, name)
  SELECT 1700000000000, 'CreateInitialSchema1700000000000'
  WHERE NOT EXISTS (
    SELECT 1 FROM billing.migrations
    WHERE name = 'CreateInitialSchema1700000000000'
  );

-- -----------------------------------------------------------------
-- alert-engine Wave 3-A + W4-A.2 baseline
-- -----------------------------------------------------------------
INSERT INTO alert.migrations (timestamp, name)
  SELECT 1700000000000, 'CreateInitialSchema1700000000000'
  WHERE NOT EXISTS (
    SELECT 1 FROM alert.migrations
    WHERE name = 'CreateInitialSchema1700000000000'
  );

-- -----------------------------------------------------------------
-- admin-api-service Wave 3-B + W4-A.2 baseline
-- -----------------------------------------------------------------
INSERT INTO admin.migrations (timestamp, name)
  SELECT 1780000000000, 'CreateInitialSchema1780000000000'
  WHERE NOT EXISTS (
    SELECT 1 FROM admin.migrations
    WHERE name = 'CreateInitialSchema1780000000000'
  );

-- -----------------------------------------------------------------
-- ai-service Wave 4-A.2 baseline
-- -----------------------------------------------------------------
INSERT INTO ai.migrations (timestamp, name)
  SELECT 1700000000000, 'CreateInitialSchema1700000000000'
  WHERE NOT EXISTS (
    SELECT 1 FROM ai.migrations
    WHERE name = 'CreateInitialSchema1700000000000'
  );

-- -----------------------------------------------------------------
-- hydroponics-service Wave 4-A.2 baseline
-- -----------------------------------------------------------------
INSERT INTO hydroponics.migrations (timestamp, name)
  SELECT 1700000000000, 'CreateInitialSchema1700000000000'
  WHERE NOT EXISTS (
    SELECT 1 FROM hydroponics.migrations
    WHERE name = 'CreateInitialSchema1700000000000'
  );

-- -----------------------------------------------------------------
-- Final sanity print: row counts per ledger.
-- -----------------------------------------------------------------
SELECT 'auth'        AS schema, COUNT(*) FROM auth.migrations
UNION ALL SELECT 'farm',        COUNT(*) FROM farm.migrations
UNION ALL SELECT 'sensor',      COUNT(*) FROM sensor.migrations
UNION ALL SELECT 'billing',     COUNT(*) FROM billing.migrations
UNION ALL SELECT 'alert',       COUNT(*) FROM alert.migrations
UNION ALL SELECT 'admin',       COUNT(*) FROM admin.migrations
UNION ALL SELECT 'ai',          COUNT(*) FROM ai.migrations
UNION ALL SELECT 'hydroponics', COUNT(*) FROM hydroponics.migrations;
