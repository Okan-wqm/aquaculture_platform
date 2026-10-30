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
 * Every pass with a `sensors` table (the `sensor` template, which new tenant
 * schemas are cloned from, and each tenant schema) gains three nullable
 * columns: `mqtt_username`, the HMAC-SHA-256 of the secret under a server-side
 * pepper (`mqtt_secret_hmac`) and the pepper's key id (`mqtt_secret_key_id`).
 * The secret itself is never stored. Checks keep the three together, keep the
 * username to the issued shape (`s` + 22 base32 characters) and keep it off
 * child sensors, which share their parent's connection.
 *
 * Source-schema pass (`current_schema() = 'sensor'`): create the cross-tenant
 * `sensor.sensor_mqtt_directory` (username → sensor → tenant), which the
 * broker's CONNECT and ACL hooks read with no tenant, under the FORCED tenant
 * isolation policy (MODULE_SCHEMAS['sensor'].infrastructureTables); and the
 * trigger function that keeps it in step with `sensors`.
 *
 * Tenant pass: the trigger. The directory is a derived index of
 * `sensors.mqtt_username`, written only by this trigger, so no code path can
 * leave it behind: issuing, rotating or clearing a username, and deleting the
 * sensor (directly or by its parent's cascade), change the directory in the
 * same statement. A username already routed (another tenant's) fails the
 * insert and with it the issuing statement.
 *
 * The runner migrates the source schema before any tenant schema, and tenant
 * provisioning replays the migrations with search_path pinned to the new
 * schema, so a new tenant gets the trigger too (CREATE TABLE LIKE copies the
 * columns and checks but not triggers).
 *
 * # Reversibility
 *
 * `down` drops the trigger, the columns, and (source pass) the directory and
 * the function. Issued credentials are lost; the sensors fall back to having
 * no broker principal.
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
    await queryRunner.query(`
      ALTER TABLE "sensors"
        ADD COLUMN IF NOT EXISTS "mqtt_username" varchar(23),
        ADD COLUMN IF NOT EXISTS "mqtt_secret_hmac" char(64),
        ADD COLUMN IF NOT EXISTS "mqtt_secret_key_id" varchar(64)
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "sensors" ADD CONSTRAINT "CHK_sensors_mqtt_identity_complete" CHECK (
          ("mqtt_username" IS NULL) = ("mqtt_secret_hmac" IS NULL)
          AND ("mqtt_username" IS NULL) = ("mqtt_secret_key_id" IS NULL)
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "sensors" ADD CONSTRAINT "CHK_sensors_mqtt_identity_shape" CHECK (
          "mqtt_username" IS NULL
          OR ("mqtt_username" ~ '^s[a-z2-7]{22}$' AND "mqtt_secret_hmac" ~ '^[0-9a-f]{64}$')
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "sensors" ADD CONSTRAINT "CHK_sensors_mqtt_identity_principal" CHECK (
          "mqtt_username" IS NULL OR "parent_id" IS NULL
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    if (schema.startsWith('tenant_')) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_sensors_mqtt_directory" ON "sensors"`);
      await queryRunner.query(`
        CREATE TRIGGER "TRG_sensors_mqtt_directory"
        AFTER INSERT OR DELETE OR UPDATE OF "mqtt_username" ON "sensors"
        FOR EACH ROW
        EXECUTE FUNCTION sensor.sync_sensor_mqtt_directory()
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = await currentSchema(queryRunner);
    if (await hasTable(queryRunner, 'sensors')) {
      await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
      await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_sensors_mqtt_directory" ON "sensors"`);
      await queryRunner.query(`
        ALTER TABLE "sensors"
          DROP CONSTRAINT IF EXISTS "CHK_sensors_mqtt_identity_principal",
          DROP CONSTRAINT IF EXISTS "CHK_sensors_mqtt_identity_shape",
          DROP CONSTRAINT IF EXISTS "CHK_sensors_mqtt_identity_complete",
          DROP COLUMN IF EXISTS "mqtt_secret_key_id",
          DROP COLUMN IF EXISTS "mqtt_secret_hmac",
          DROP COLUMN IF EXISTS "mqtt_username"
      `);
    }
    if (schema === 'sensor') {
      await queryRunner.query(
        `DROP FUNCTION IF EXISTS sensor.sync_sensor_mqtt_directory() CASCADE`,
      );
      await queryRunner.query(`DROP TABLE IF EXISTS sensor.sensor_mqtt_directory`);
    }
  }
}

async function createDirectory(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE IF NOT EXISTS sensor.sensor_mqtt_directory (
      mqtt_username varchar(23) PRIMARY KEY,
      sensor_id uuid NOT NULL,
      tenant_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
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
  // AFTER trigger, so the row it routes is already written; runs as the
  // invoking role inside the tenant's transaction, so the directory's policy
  // admits exactly that tenant's rows. search_path is fixed: the function
  // names its table and must not follow the caller's path.
  await queryRunner.query(`
    CREATE OR REPLACE FUNCTION sensor.sync_sensor_mqtt_directory()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $$
    BEGIN
      IF TG_OP <> 'INSERT' AND OLD.mqtt_username IS NOT NULL
         AND (TG_OP = 'DELETE' OR NEW.mqtt_username IS DISTINCT FROM OLD.mqtt_username) THEN
        DELETE FROM sensor.sensor_mqtt_directory WHERE mqtt_username = OLD.mqtt_username;
      END IF;
      IF TG_OP <> 'DELETE' AND NEW.mqtt_username IS NOT NULL
         AND (TG_OP = 'INSERT' OR NEW.mqtt_username IS DISTINCT FROM OLD.mqtt_username) THEN
        INSERT INTO sensor.sensor_mqtt_directory (mqtt_username, sensor_id, tenant_id)
        VALUES (NEW.mqtt_username, NEW.id, NEW.tenant_id);
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
