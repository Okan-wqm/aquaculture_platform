import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner } from 'typeorm';

import { ExtendParamEquipmentToChannelSources1822000000000 } from '../1822000000000-ExtendParamEquipmentToChannelSources';

/**
 * The binding owner's expand migration on real Postgres, run the way the
 * orchestrator runs it: once per schema with the search_path pinned.
 *
 * The tenant schema starts in the Baseline shape (the legacy unique, NOT NULL
 * point, the shared monitoring-frequency enum in `farm`), CLONED from a source
 * schema with LIKE … INCLUDING ALL the way pre-2026-04-28 tenants were — so its
 * legacy unique carries a Postgres-generated name, as in prod — with the legacy rows
 * prod could hold: a mapping whose equipmentId is a tank, one with a sensorId,
 * configs whose code names a quantity or a family, and measurements filed in
 * both unit columns. Every rule the migration adds is then exercised by the
 * statement it must refuse.
 */

const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';
const OTHER_TENANT = '11111111-1111-4111-8111-111111111111';
const TANK = 'aaaaaaaa-0000-4000-8000-000000000001';
const TANK_EQUIPMENT = 'aaaaaaaa-0000-4000-8000-000000000002';
const BIOFILTER = 'aaaaaaaa-0000-4000-8000-000000000003';
const SENSOR = 'bbbbbbbb-0000-4000-8000-000000000001';
const TEMPERATURE = 'cccccccc-0000-4000-8000-000000000001';
const AMMONIA = 'cccccccc-0000-4000-8000-000000000002';
const PH = 'cccccccc-0000-4000-8000-000000000003';

jest.setTimeout(180_000);

describe('ExtendParamEquipmentToChannelSources1822000000000', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  const schema = getTenantSchemaName(TENANT);
  const unused = getTenantSchemaName(OTHER_TENANT);

  const LEGACY_TABLES = [
    'tanks',
    'equipment',
    'water_quality_parameter_configs',
    'water_quality_param_equipment',
    'water_quality_measurements',
  ];

  /** A tenant schema cloned from the Baseline-shaped source: generated index names. */
  async function likeClone(target: string): Promise<void> {
    await admin!.query(`CREATE SCHEMA "${target}"`);
    for (const table of LEGACY_TABLES) {
      await admin!.query(
        `CREATE TABLE "${target}"."${table}" (LIKE "baseline_src"."${table}" INCLUDING ALL)`,
      );
    }
  }

  async function baseline(target: string): Promise<void> {
    await admin!.query(`CREATE SCHEMA "${target}"`);
    await admin!.query(`
      CREATE TABLE "${target}".tanks (id uuid PRIMARY KEY, "tenantId" uuid NOT NULL)`);
    await admin!.query(`
      CREATE TABLE "${target}".equipment (
        id uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "isTank" boolean NOT NULL DEFAULT false)`);
    await admin!.query(`
      CREATE TABLE "${target}".water_quality_parameter_configs (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        code varchar(50) NOT NULL,
        name varchar(100) NOT NULL,
        unit varchar(30) NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true)`);
    await admin!.query(`
      CREATE TABLE "${target}".water_quality_param_equipment (
        id uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "parameterConfigId" uuid NOT NULL,
        "equipmentId" uuid NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "monitoringFrequency" farm.water_quality_param_equipment_monitoringfrequency_enum
          NOT NULL DEFAULT 'on_demand',
        "sensorId" uuid,
        "alertEnabled" boolean NOT NULL DEFAULT true,
        notes text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id))`);
    await admin!.query(`
      CREATE UNIQUE INDEX "IDX_3283cafd2982b3e394ac021307"
        ON "${target}".water_quality_param_equipment ("tenantId", "parameterConfigId", "equipmentId")`);
    await admin!.query(`
      CREATE TABLE "${target}".water_quality_measurements (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "tankId" uuid,
        "equipmentId" uuid,
        "measuredAt" timestamptz NOT NULL DEFAULT now())`);
  }

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    await admin.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await admin.query(`CREATE SCHEMA IF NOT EXISTS farm`);
    await admin.query(`
      CREATE TYPE farm.water_quality_param_equipment_monitoringfrequency_enum
        AS ENUM ('continuous', 'hourly', 'daily', 'weekly', 'on_demand')`);
    await baseline('baseline_src');
    await likeClone(schema);
    // The other tenant was built by migration replay: Baseline index names.
    await baseline(unused);
    await admin.query(`CREATE SCHEMA "empty_schema"`);

    await admin.query(`INSERT INTO "${schema}".tanks VALUES ($1, $2)`, [TANK, TENANT]);
    await admin.query(`INSERT INTO "${schema}".equipment VALUES ($1, $2, true), ($3, $2, false)`, [
      TANK_EQUIPMENT,
      TENANT,
      BIOFILTER,
    ]);
    await admin.query(
      `INSERT INTO "${schema}".water_quality_parameter_configs (id, "tenantId", code, name, unit)
       VALUES ($1, $4, 'temperature', 'Temperature', '°C'),
              ($2, $4, 'ammonia', 'Ammonia', 'mg/L'),
              ($3, $4, 'ph', 'pH', 'pH')`,
      [TEMPERATURE, AMMONIA, PH, TENANT],
    );
    await admin.query(
      `INSERT INTO "${schema}".water_quality_param_equipment
         ("tenantId", "parameterConfigId", "equipmentId", "sensorId", "createdAt")
       VALUES ($1, $2, $3, NULL, '2026-09-01T00:00:00Z'),
              ($1, $2, $4, $5, '2026-09-02T00:00:00Z'),
              ($1, $2, $6, NULL, '2026-09-03T00:00:00Z')`,
      [TENANT, TEMPERATURE, TANK, BIOFILTER, SENSOR, TANK_EQUIPMENT],
    );
    await admin.query(
      `INSERT INTO "${schema}".water_quality_measurements ("tenantId", "tankId", "equipmentId")
       VALUES ($1, $2, $2), ($1, $3, $3), ($1, $2, $3)`,
      [TENANT, TANK, BIOFILTER],
    );
    // The unused schema holds only the legacy shape: down may revert it.
    await admin.query(`INSERT INTO "${unused}".equipment VALUES ($1, $2, false)`, [
      BIOFILTER,
      OTHER_TENANT,
    ]);
    await admin.query(
      `INSERT INTO "${unused}".water_quality_parameter_configs (id, "tenantId", code, name, unit)
       VALUES ($1, $2, 'ph', 'pH', 'pH')`,
      [PH, OTHER_TENANT],
    );
    await admin.query(
      `INSERT INTO "${unused}".water_quality_param_equipment
         ("tenantId", "parameterConfigId", "equipmentId") VALUES ($1, $2, $3)`,
      [OTHER_TENANT, PH, BIOFILTER],
    );
  });

  afterAll(async () => {
    if (harness) await shutdownHarness(harness);
  });

  async function inSchema<T>(target: string, run: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = admin!.createQueryRunner();
    try {
      await qr.query(`SET search_path TO "${target}", public`);
      await qr.startTransaction();
      const result = await run(qr);
      await qr.commitTransaction();
      return result;
    } catch (error) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  const migration = new ExtendParamEquipmentToChannelSources1822000000000();
  const mappings = `"${schema}".water_quality_param_equipment`;
  const configs = `"${schema}".water_quality_parameter_configs`;

  it('starts from a LIKE clone whose legacy unique has a generated name', async () => {
    const indexes: Array<{ indexname: string }> = await admin!.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'water_quality_param_equipment'
          AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexname NOT LIKE '%pkey'`,
      [schema],
    );
    expect(indexes.map((index) => index.indexname)).toEqual([
      'water_quality_param_equipment_tenantId_parameterConfigId_eq_idx',
    ]);
  });

  it('applies, re-applies as a no-op, and passes its post-condition', async () => {
    await inSchema(schema, (qr) => migration.up(qr));
    await inSchema(schema, (qr) => migration.up(qr));
    await expect(inSchema(schema, (qr) => migration.postCondition(qr))).resolves.toBe(true);
    await expect(inSchema('empty_schema', (qr) => migration.up(qr))).resolves.toBeUndefined();
    await expect(inSchema('empty_schema', (qr) => migration.postCondition(qr))).resolves.toBe(true);
  });

  it('moves a tank filed as equipment to the tank point and clears the unread sensor link', async () => {
    const rows: Array<Record<string, unknown>> = await admin!.query(
      `SELECT "tankId", "equipmentId", "sensorId", "pointKey", "boundAt" = "createdAt" AS backfilled
         FROM ${mappings} ORDER BY "createdAt"`,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        tankId: TANK,
        equipmentId: null,
        pointKey: `tank:${TANK}|representative|`,
      }),
      expect.objectContaining({ tankId: null, equipmentId: BIOFILTER, sensorId: null }),
      // An equipment row flagged isTank is a tank, as the unit classifier says.
      expect.objectContaining({ tankId: TANK_EQUIPMENT, equipmentId: null }),
    ]);
    expect(rows.every((row) => row['backfilled'] === true)).toBe(true);
  });

  it('refuses a row with no point, two points, or a channel without its key and priority', async () => {
    const insert = (columns: string, values: string): Promise<unknown> =>
      admin!.query(
        `INSERT INTO ${mappings} ("tenantId", "parameterConfigId", ${columns})
         VALUES ('${TENANT}', '${PH}', ${values})`,
      );
    // A row without a point has no point key: refused before any check runs.
    await expect(insert(`"isActive"`, `true`)).rejects.toThrow(/"pointKey".*not-null/);
    await expect(insert(`"tankId", "systemId"`, `'${TANK}', '${TANK}'`)).rejects.toThrow(
      /CHK_wqpe_one_point/,
    );
    await expect(
      insert(
        `"tankId", "channelKey", "monitoringFrequency", "alertEnabled"`,
        `'${TANK}', 'ph', NULL, NULL`,
      ),
    ).rejects.toThrow(/CHK_wqpe_channel_source/);
    // A channel source carries no manual cadence or alert switch.
    await expect(
      insert(
        `"tankId", "sensorId", "channelKey", "priority"`,
        `'${TANK}', '${SENSOR}', 'ph', 'primary'`,
      ),
    ).rejects.toThrow(/CHK_wqpe_source_settings/);
    await expect(insert(`"tankId", "position"`, `'${TANK}', 'middle'`)).rejects.toThrow(
      /CHK_wqpe_position/,
    );
  });

  it('keeps one live manual source and one primary per parameter and point, with history', async () => {
    const channel = (priority: string, channelKey: string): Promise<unknown> =>
      admin!.query(
        `INSERT INTO ${mappings}
           ("tenantId", "parameterConfigId", "tankId", "sensorId", "channelKey", "priority",
            "monitoringFrequency", "alertEnabled", "boundBy")
         VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, 'user-1')`,
        [TENANT, PH, TANK, SENSOR, channelKey, priority],
      );
    await channel('primary', 'ph');
    await expect(channel('backup', 'ph')).rejects.toThrow(/UQ_wqpe_channel_key/);
    await channel('backup', 'ph_2');
    await expect(channel('primary', 'ph_3')).rejects.toThrow(/UQ_wqpe_channel_priority/);

    // A second live manual source at the tank is refused; once the first is
    // unbound it stays as history and a new one binds.
    const manual = (): Promise<unknown> =>
      admin!.query(
        `INSERT INTO ${mappings} ("tenantId", "parameterConfigId", "tankId") VALUES ($1, $2, $3)`,
        [TENANT, TEMPERATURE, TANK],
      );
    await expect(manual()).rejects.toThrow(/UQ_wqpe_manual_source/);
    await admin!.query(
      `UPDATE ${mappings} SET "unboundAt" = now(), "unboundBy" = 'user-1'
        WHERE "tankId" = $1 AND "parameterConfigId" = $2`,
      [TANK, TEMPERATURE],
    );
    await manual();
    // The same parameter at another position or depth is another point.
    await admin!.query(
      `INSERT INTO ${mappings} ("tenantId", "parameterConfigId", "tankId", "position", "depthM")
       VALUES ($1, $2, $3, 'outlet', 1.5)`,
      [TENANT, TEMPERATURE, TANK],
    );
    // The renamed legacy unique is gone: otherwise this second live row of the
    // same (tenant, parameter, point) would have been refused above.
    const [{ live, history }] = await admin!.query(
      `SELECT count(*) FILTER (WHERE "unboundAt" IS NULL)::int AS live,
              count(*) FILTER (WHERE "unboundAt" IS NOT NULL)::int AS history
         FROM ${mappings} WHERE "parameterConfigId" = $1 AND "tankId" = $2`,
      [TEMPERATURE, TANK],
    );
    expect({ live, history }).toEqual({ live: 2, history: 1 });
  });

  it('drops the renamed legacy unique: an equipment point takes history and a backup', async () => {
    await admin!.query(
      `UPDATE ${mappings} SET "unboundAt" = now(), "unboundBy" = 'user-1'
        WHERE "equipmentId" = $1 AND "parameterConfigId" = $2`,
      [BIOFILTER, TEMPERATURE],
    );
    await admin!.query(
      `INSERT INTO ${mappings} ("tenantId", "parameterConfigId", "equipmentId") VALUES ($1, $2, $3)`,
      [TENANT, TEMPERATURE, BIOFILTER],
    );
    for (const [priority, key] of [
      ['primary', 'temp'],
      ['backup', 'temp_2'],
    ]) {
      await admin!.query(
        `INSERT INTO ${mappings}
           ("tenantId", "parameterConfigId", "equipmentId", "sensorId", "channelKey", "priority",
            "monitoringFrequency", "alertEnabled")
         VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)`,
        [TENANT, TEMPERATURE, BIOFILTER, SENSOR, key, priority],
      );
    }
    const [{ n }] = await admin!.query(
      `SELECT count(*)::int AS n FROM ${mappings} WHERE "equipmentId" = $1`,
      [BIOFILTER],
    );
    expect(n).toBe(4);
  });

  it('derives what each config records, keeps one active config per quantity, and stamps changes', async () => {
    const quantities: Array<{ code: string; effectiveQuantity: string | null }> =
      await admin!.query(`SELECT code, "effectiveQuantity" FROM ${configs} ORDER BY code`);
    expect(quantities).toEqual([
      { code: 'ammonia', effectiveQuantity: null },
      { code: 'ph', effectiveQuantity: 'ph' },
      { code: 'temperature', effectiveQuantity: 'temperature' },
    ]);
    const duplicate = (active: boolean): Promise<unknown> =>
      admin!.query(
        `INSERT INTO ${configs} ("tenantId", code, name, unit, "isActive", "effectiveQuantity")
         VALUES ($1, $2, 'Temp 2', '°C', $3, 'temperature')`,
        [TENANT, active ? 'water_temp' : 'old_temp', active],
      );
    await expect(duplicate(true)).rejects.toThrow(/UQ_wqpc_tenant_effective_quantity/);
    await duplicate(false);

    const stamp = async (): Promise<string | null> => {
      const [row] = await admin!.query(
        `SELECT "quantityConfiguredAt"::text AS at FROM ${configs} WHERE id = $1`,
        [AMMONIA],
      );
      return row.at;
    };
    expect(await stamp()).toBeNull();
    await admin!.query(`UPDATE ${configs} SET name = 'Ammonia (NH3)' WHERE id = $1`, [AMMONIA]);
    expect(await stamp()).toBeNull();
    await admin!.query(`UPDATE ${configs} SET "declaredQuantity" = 'tan' WHERE id = $1`, [AMMONIA]);
    const declaredAt = await stamp();
    expect(declaredAt).not.toBeNull();
    // An attempt to write the stamp by hand is overruled.
    await admin!.query(
      `UPDATE ${configs} SET "quantityConfiguredAt" = '2000-01-01' WHERE id = $1`,
      [AMMONIA],
    );
    expect(await stamp()).toBe(declaredAt);
    const [inserted] = await admin!.query(
      `SELECT "quantityConfiguredAt" IS NOT NULL AS stamped FROM ${configs} WHERE code = 'old_temp'`,
    );
    expect(inserted).toEqual({ stamped: true });
  });

  it('creates an insertable declaration ledger', async () => {
    await admin!.query(
      `INSERT INTO "${schema}".parameter_quantity_declarations
         ("tenantId", "parameterConfigId", code, quantity, unit, reason, "declaredBy")
       VALUES ($1, $2, 'ammonia', 'tan', 'mg/L', 'declared', 'user-1')`,
      [TENANT, AMMONIA],
    );
    await expect(
      admin!.query(
        `INSERT INTO "${schema}".parameter_quantity_declarations
           ("tenantId", "parameterConfigId", code, unit, reason, "declaredBy")
         VALUES ($1, $2, 'ammonia', 'mg/L', 'guessed', 'user-1')`,
        [TENANT, AMMONIA],
      ),
    ).rejects.toThrow(/CHK_pqd_reason/);
  });

  it('files each measurement under one point, keeping what readers already resolved', async () => {
    const rows: Array<{ tankId: string | null; equipmentId: string | null }> = await admin!.query(
      `SELECT "tankId", "equipmentId" FROM "${schema}".water_quality_measurements
        ORDER BY "tankId" NULLS LAST, "equipmentId"`,
    );
    expect(rows).toEqual([
      // equal tank pair, and a differing pair resolved to its tank (COALESCE)
      { tankId: TANK, equipmentId: null },
      { tankId: TANK, equipmentId: null },
      // equal pair of a non-tank unit
      { tankId: null, equipmentId: BIOFILTER },
    ]);
    await expect(
      admin!.query(
        `INSERT INTO "${schema}".water_quality_measurements ("tenantId", "tankId", "systemId")
         VALUES ($1, $2, $2)`,
        [TENANT, TANK],
      ),
    ).rejects.toThrow(/CHK_wqm_one_point/);
  });

  it('refuses to revert a schema whose sources use the new shape', async () => {
    await expect(inSchema(schema, (qr) => migration.down(qr))).rejects.toThrow(/down refused/);
  });

  it('reverts a schema that only holds the legacy shape', async () => {
    await inSchema(unused, (qr) => migration.up(qr));
    await inSchema(unused, (qr) => migration.down(qr));
    const columns: Array<{ column_name: string; is_nullable: string }> = await admin!.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'water_quality_param_equipment'
        ORDER BY ordinal_position`,
      [unused],
    );
    expect(columns.map((column) => column.column_name)).not.toContain('pointKey');
    expect(columns.find((column) => column.column_name === 'equipmentId')?.is_nullable).toBe('NO');
    const [legacyUnique] = await admin!.query(
      `SELECT count(*)::int AS n FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'IDX_3283cafd2982b3e394ac021307'`,
      [unused],
    );
    expect(legacyUnique).toEqual({ n: 1 });
    const [ledger] = await admin!.query(`SELECT to_regclass($1) IS NULL AS gone`, [
      `"${unused}".parameter_quantity_declarations`,
    ]);
    expect(ledger).toEqual({ gone: true });
  });
});
