import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { BackfillParentChannelsFromChildren1819000000000 } from '../1819000000000-BackfillParentChannelsFromChildren';

/**
 * SENSOR-HIGH-117 backfill migration on real Postgres (prod image digest via
 * the migration harness): tenant schemas created before the parent-channel
 * fix gain one parent channel per child data_path; idempotent, collision-safe,
 * and a no-op outside tenant schemas.
 */

const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';

jest.setTimeout(180_000);

describe('BackfillParentChannelsFromChildren1819000000000', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
  });

  afterAll(async () => {
    if (harness) await shutdownHarness(harness);
  });

  async function createTenantSchemaWithSensors(): Promise<string> {
    const schema = getTenantSchemaName(TENANT);
    await admin!.query(`CREATE SCHEMA "${schema}"`);
    await admin!.query(`
      CREATE TABLE "${schema}".sensors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        type varchar(50) NOT NULL,
        serial_number varchar(100),
        protocol_configuration jsonb,
        is_parent_device boolean NOT NULL DEFAULT false,
        sensor_role varchar(20),
        parent_id uuid,
        data_path varchar(255),
        unit varchar(50),
        min_value numeric(15,6),
        max_value numeric(15,6),
        calibration_enabled boolean NOT NULL DEFAULT false,
        calibration_multiplier numeric(15,6) NOT NULL DEFAULT 1,
        calibration_offset numeric(15,6) NOT NULL DEFAULT 0,
        alert_thresholds jsonb,
        display_settings jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await admin!.query(`
      CREATE TABLE "${schema}".sensor_data_channels (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sensor_id uuid NOT NULL,
        tenant_id uuid NOT NULL,
        channel_key varchar(100) NOT NULL,
        display_label varchar(200) NOT NULL,
        data_type varchar(20) NOT NULL DEFAULT 'number',
        unit varchar(50),
        "dataPath" varchar(255),
        "minValue" numeric(15,6),
        "maxValue" numeric(15,6),
        calibration_enabled boolean NOT NULL DEFAULT false,
        calibration_multiplier numeric(15,6) NOT NULL DEFAULT 1,
        calibration_offset numeric(15,6) NOT NULL DEFAULT 0,
        "alertThresholds" jsonb,
        "displaySettings" jsonb,
        is_enabled boolean NOT NULL DEFAULT true,
        display_order integer NOT NULL DEFAULT 0,
        discovery_source varchar(20),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_channels UNIQUE (tenant_id, sensor_id, channel_key)
      )`);
    return schema;
  }

  async function seedParentWithChildren(
    schema: string,
    childSpecs: Array<{ name: string; dataPath: string | null }>,
  ): Promise<string> {
    const parent = await admin!.query(
      `INSERT INTO "${schema}".sensors (tenant_id, name, type, protocol_configuration, is_parent_device, sensor_role)
       VALUES ($1, 'Sonde', 'multi_parameter', $2::jsonb, true, 'parent')
       RETURNING id`,
      [TENANT, JSON.stringify({ topic: 'sensors/site-1/sonde' })],
    );
    const parentId = parent[0].id;
    for (const child of childSpecs) {
      await admin!.query(
        `INSERT INTO "${schema}".sensors (tenant_id, name, type, is_parent_device, sensor_role, parent_id, data_path)
         VALUES ($1, $2, $3, false, 'child', $4, $5)`,
        [TENANT, child.name, 'temperature', parentId, child.dataPath],
      );
    }
    return parentId as string;
  }

  async function runMigrationAgainst(schema: string): Promise<void> {
    const qr = admin!.createQueryRunner();
    try {
      // Transaction-LOCAL search_path pin: session-scoped set_config lands on
      // whatever pooled connection served it — under CI parallelism the
      // migration may run on a DIFFERENT connection and silently see public.
      await qr.startTransaction();
      await qr.query(`SELECT set_config('search_path', $1, true)`, [`${schema},public`]);
      await new BackfillParentChannelsFromChildren1819000000000().up(qr);
      await qr.commitTransaction();
    } finally {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      await qr.release();
    }
  }

  it('creates one parent channel per child with a sanitized key and stable display order', async () => {
    const schema = await createTenantSchemaWithSensors();
    try {
      const parentId = await seedParentWithChildren(schema, [
        { name: 'Su Sıcaklığı', dataPath: 'sensors.mid' },
        { name: 'pH', dataPath: 'ph' },
      ]);

      await runMigrationAgainst(schema);

      const channels = await admin!.query(
        `SELECT channel_key, display_label, "dataPath", display_order
           FROM "${schema}".sensor_data_channels
          WHERE sensor_id = $1
          ORDER BY display_order`,
        [parentId],
      );
      expect(channels).toHaveLength(2);
      expect(channels[0]).toMatchObject({
        channel_key: 'sensors_mid',
        display_label: 'Su Sıcaklığı',
        dataPath: 'sensors.mid',
        display_order: 0,
      });
      expect(channels[1]).toMatchObject({ channel_key: 'ph', dataPath: 'ph', display_order: 1 });
    } finally {
      await admin!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('is idempotent and never clobbers an existing operator channel', async () => {
    const schema = await createTenantSchemaWithSensors();
    try {
      const parentId = await seedParentWithChildren(schema, [
        { name: 'T', dataPath: 'temperature' },
      ]);
      await admin!.query(
        `INSERT INTO "${schema}".sensor_data_channels
           (sensor_id, tenant_id, channel_key, display_label, "dataPath")
         VALUES ($1, $2, 'temperature', 'Operator Label', 'temperature')`,
        [parentId, TENANT],
      );

      await runMigrationAgainst(schema);
      await runMigrationAgainst(schema); // idempotency

      const channels = await admin!.query(
        `SELECT channel_key, display_label FROM "${schema}".sensor_data_channels WHERE sensor_id = $1`,
        [parentId],
      );
      expect(channels).toHaveLength(1);
      expect(channels[0].display_label).toBe('Operator Label'); // first writer wins
    } finally {
      await admin!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('keeps exactly one channel when two children sanitize to the same key', async () => {
    const schema = await createTenantSchemaWithSensors();
    try {
      const parentId = await seedParentWithChildren(schema, [
        { name: 'A', dataPath: 'water.temp' },
        { name: 'B', dataPath: 'water_temp' },
      ]);

      await runMigrationAgainst(schema);

      const channels = await admin!.query(
        `SELECT channel_key FROM "${schema}".sensor_data_channels WHERE sensor_id = $1`,
        [parentId],
      );
      expect(channels).toHaveLength(1);
      expect(channels[0].channel_key).toBe('water_temp');
    } finally {
      await admin!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('is a no-op outside tenant schemas (source-schema pass)', async () => {
    const qr = admin!.createQueryRunner();
    try {
      await qr.query(`SELECT set_config('search_path', 'public', false)`);
      await expect(
        new BackfillParentChannelsFromChildren1819000000000().up(qr),
      ).resolves.toBeUndefined();
    } finally {
      await qr.query(`SELECT set_config('search_path', 'public', false)`);
      await qr.release();
    }
  });
});
