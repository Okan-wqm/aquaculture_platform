import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A directly publishing MQTT sensor's own broker principal (ADR-047 §1,
 * SENSOR-CRITICAL-173).
 *
 * # Why
 *
 * A sensor that speaks MQTT itself had no identity on the platform broker: it
 * published with the `sensor_service` account, which can also write every
 * tenant's command topics, and its topic was free text resolved by scanning
 * tenants. Each such sensor now holds its own username and secret.
 *
 * # What it does
 *
 * Source-schema pass (`current_schema() = 'sensor'`): create the cross-tenant
 * `sensor.sensor_mqtt_directory` — the one home of a principal: its username,
 * tenant and sensor, and the HMAC-SHA-256 of its secret under a server-side
 * pepper with the pepper's key id (the secret itself is never stored). The
 * broker's CONNECT and ACL hooks answer from this one row with no tenant, so
 * every check is one indexed read. FORCE RLS on tenant_id; cross-tenant
 * infrastructure (MODULE_SCHEMAS['sensor'].infrastructureTables).
 *
 * Every pass with a `sensors` table (the `sensor` template new tenant schemas
 * are cloned from, and each tenant schema) gains `mqtt_username`, the tenant
 * side of the link. Checks keep it to the issued shape (`s` + 22 base32
 * characters), off child sensors (they share their parent's connection) and
 * off suspended sensors (suspension withdraws the credential).
 *
 * Tenant pass: two triggers keep the directory and `mqtt_username` one fact.
 * - Clearing or changing a sensor's username, or deleting the sensor
 *   (directly or by its parent's cascade), removes the old route in the same
 *   statement.
 * - A constraint trigger checked at commit refuses a sensor that names a
 *   username the directory does not route to it: no writer can set the link
 *   without the credential.
 * So a directory row exists exactly while a live, unsuspended sensor of that
 * tenant holds its username, which is what lets the broker trust the row.
 *
 * The runner migrates the source schema before any tenant schema, and tenant
 * provisioning replays the migrations with search_path pinned to the new
 * schema, so a new tenant gets the triggers too (CREATE TABLE LIKE copies the
 * column and checks, not triggers). Rows of a tenant whose schema is dropped
 * are removed by the schema delete job and by tenant erasure.
 *
 * # Reversibility
 *
 * `down` drops the triggers, the column and its checks, and (source pass) the
 * functions and the directory. Issued credentials are lost; the sensors fall
 * back to having no broker principal.
 */
export class AddSensorMqttIdentity1826000000000 implements MigrationInterface {
  name = 'AddSensorMqttIdentity1826000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await currentSchema(queryRunner);

    if (schema === 'sensor') {
      await createDirectory(queryRunner);
    }
    if (!(await hasTable(queryRunner, 'sensors'))) {
      return;
    }

    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(
      `ALTER TABLE "sensors" ADD COLUMN IF NOT EXISTS "mqtt_username" varchar(23)`,
    );
    await addCheck(
      queryRunner,
      'CHK_sensors_mqtt_username_shape',
      `"mqtt_username" IS NULL OR "mqtt_username" ~ '^s[a-z2-7]{22}$'`,
    );
    await addCheck(
      queryRunner,
      'CHK_sensors_mqtt_identity_principal',
      `"mqtt_username" IS NULL OR "parent_id" IS NULL`,
    );
    await addCheck(
      queryRunner,
      'CHK_sensors_mqtt_identity_not_suspended',
      `"mqtt_username" IS NULL OR "registration_status" <> 'suspended'`,
    );

    if (schema.startsWith('tenant_')) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_sensors_mqtt_unroute" ON "sensors"`);
      await queryRunner.query(`
        CREATE TRIGGER "TRG_sensors_mqtt_unroute"
        AFTER DELETE OR UPDATE OF "mqtt_username" ON "sensors"
        FOR EACH ROW
        EXECUTE FUNCTION sensor.unroute_sensor_mqtt_username()
      `);
      await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_sensors_mqtt_routed" ON "sensors"`);
      await queryRunner.query(`
        CREATE CONSTRAINT TRIGGER "TRG_sensors_mqtt_routed"
        AFTER INSERT OR UPDATE OF "mqtt_username" ON "sensors"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION sensor.assert_sensor_mqtt_routed()
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = await currentSchema(queryRunner);
    if (await hasTable(queryRunner, 'sensors')) {
      await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
      await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_sensors_mqtt_routed" ON "sensors"`);
      await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_sensors_mqtt_unroute" ON "sensors"`);
      await queryRunner.query(`
        ALTER TABLE "sensors"
          DROP CONSTRAINT IF EXISTS "CHK_sensors_mqtt_identity_not_suspended",
          DROP CONSTRAINT IF EXISTS "CHK_sensors_mqtt_identity_principal",
          DROP CONSTRAINT IF EXISTS "CHK_sensors_mqtt_username_shape",
          DROP COLUMN IF EXISTS "mqtt_username"
      `);
    }
    if (schema === 'sensor') {
      await queryRunner.query(`DROP FUNCTION IF EXISTS sensor.assert_sensor_mqtt_routed() CASCADE`);
      await queryRunner.query(
        `DROP FUNCTION IF EXISTS sensor.unroute_sensor_mqtt_username() CASCADE`,
      );
      await queryRunner.query(`DROP TABLE IF EXISTS sensor.sensor_mqtt_directory`);
    }
  }
}

async function addCheck(queryRunner: QueryRunner, name: string, condition: string): Promise<void> {
  await queryRunner.query(`
    DO $$
    BEGIN
      ALTER TABLE "sensors" ADD CONSTRAINT "${name}" CHECK (${condition});
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
}

async function createDirectory(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE IF NOT EXISTS sensor.sensor_mqtt_directory (
      mqtt_username varchar(23) PRIMARY KEY,
      sensor_id uuid NOT NULL,
      tenant_id uuid NOT NULL,
      secret_hmac char(64) NOT NULL,
      secret_key_id varchar(64) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "CHK_sensor_mqtt_directory_shape" CHECK (
        mqtt_username ~ '^s[a-z2-7]{22}$' AND secret_hmac ~ '^[0-9a-f]{64}$'
      )
    )
  `);
  await queryRunner.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_sensor_mqtt_directory_sensor_id
       ON sensor.sensor_mqtt_directory (sensor_id)`,
  );
  await queryRunner.query(
    `CREATE INDEX IF NOT EXISTS idx_sensor_mqtt_directory_tenant_id
       ON sensor.sensor_mqtt_directory (tenant_id)`,
  );
  await applyTenantRlsToSchema(queryRunner, {
    schemaOverride: 'sensor',
    tenantIdColumns: ['tenant_id'],
    includeTables: ['sensor_mqtt_directory'],
  });
  // Both run as the invoking role inside the tenant's transaction, so the
  // directory's policy admits exactly that tenant's rows. search_path is
  // fixed: they name their tables and must not follow the caller's path.
  await queryRunner.query(`
    CREATE OR REPLACE FUNCTION sensor.unroute_sensor_mqtt_username()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $$
    BEGIN
      IF OLD.mqtt_username IS NOT NULL
         AND (TG_OP = 'DELETE' OR NEW.mqtt_username IS DISTINCT FROM OLD.mqtt_username) THEN
        DELETE FROM sensor.sensor_mqtt_directory
         WHERE mqtt_username = OLD.mqtt_username AND sensor_id = OLD.id;
      END IF;
      RETURN NULL;
    END;
    $$
  `);
  // Checked at commit: the writer sets the username and inserts its route
  // in one transaction, in either order. A row superseded or deleted later in
  // the same transaction is judged by what it holds at commit.
  await queryRunner.query(`
    CREATE OR REPLACE FUNCTION sensor.assert_sensor_mqtt_routed()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $$
    DECLARE
      held varchar;
    BEGIN
      IF NEW.mqtt_username IS NULL THEN
        RETURN NULL;
      END IF;
      EXECUTE format('SELECT mqtt_username FROM %I.sensors WHERE id = $1', TG_TABLE_SCHEMA)
         INTO held
        USING NEW.id;
      IF held IS DISTINCT FROM NEW.mqtt_username THEN
        RETURN NULL;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM sensor.sensor_mqtt_directory
         WHERE mqtt_username = NEW.mqtt_username
           AND sensor_id = NEW.id
           AND tenant_id = NEW.tenant_id
      ) THEN
        RAISE EXCEPTION 'sensor % names broker username % that no route holds', NEW.id, NEW.mqtt_username
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END;
    $$
  `);
}

async function currentSchema(queryRunner: QueryRunner): Promise<string> {
  const rows: Array<{ schema: string | null }> = await queryRunner.query(
    `SELECT current_schema() AS schema`,
  );
  return rows[0]?.schema ?? '';
}

async function hasTable(queryRunner: QueryRunner, table: string): Promise<boolean> {
  const present: Array<{ ready: boolean }> = await queryRunner.query(
    `SELECT to_regclass($1) IS NOT NULL AS ready`,
    [table],
  );
  return present[0]?.ready === true;
}
