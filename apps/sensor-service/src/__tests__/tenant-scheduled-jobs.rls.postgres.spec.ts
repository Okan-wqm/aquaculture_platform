import { randomBytes, randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { applyTenantRlsToSchema, getTenantSchemaName } from '@aquaculture/backend-common/database';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, Repository } from 'typeorm';

import { AutomationService } from '../automation/automation.service';
import { AutomationProgram, ProgramStatus } from '../automation/entities/automation-program.entity';
import { DeploymentLog, DeploymentStatus } from '../automation/entities/deployment-log.entity';
import { DeploymentLogService } from '../automation/services/deployment-log.service';
import { EdgeDeviceService } from '../edge-device/edge-device.service';
import { DeviceIoConfig } from '../edge-device/entities/device-io-config.entity';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeDevice,
} from '../edge-device/entities/edge-device.entity';
import { InstallerScriptService } from '../edge-device/installer-script.service';
import { LoRaDevice } from '../edge-device/entities/lora-device.entity';
import { ArtifactService } from '../deploy-artifact/artifact.service';
import { AutomationEventsPublisher } from '../automation/events/automation-events.publisher';
import { MqttClientService } from '../shared-mqtt/mqtt-client.service';

/**
 * SENSOR-MEDIUM-136 on real Postgres: the sensor-service scheduled jobs walk
 * every tenant with no request context. They pinned search_path per schema
 * and nothing else, and tenant tables carry FORCE RLS on a deny-by-default
 * pool, so both jobs matched zero rows: a dead edge device stayed "online"
 * and a stuck deploy stayed DEPLOYING forever.
 *
 * Runtime is a non-owner role, two tenants, FORCE RLS armed by the production
 * helper; the assertions are the rows each job exists to change.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUNTIME_ROLE = 'sensor_jobs_rls_test';
const ENTITIES = [EdgeDevice, AutomationProgram, DeploymentLog];
const AN_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);

jest.setTimeout(180_000);

describe('sensor-service scheduled jobs under FORCE RLS (SENSOR-MEDIUM-136)', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  let runtime: DataSource | undefined;
  const schemas: Record<string, string> = {};
  const programIds: Record<string, string> = {};

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    const password = randomBytes(24).toString('hex');
    const bootstrap = harness.dataSource;

    await bootstrap.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await bootstrap.query('CREATE SCHEMA sensor');
    await bootstrap.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${password}'`);

    for (const tenantId of [TENANT_A, TENANT_B]) {
      const schema = getTenantSchemaName(tenantId);
      schemas[tenantId] = schema;
      await bootstrap.query(`CREATE SCHEMA "${schema}"`);

      const ddl = new DataSource({
        type: 'postgres',
        ...harness.connectionOptions,
        name: `jobs-rls-ddl-${schema}`,
        schema,
        entities: ENTITIES,
        synchronize: true,
        logging: false,
      });
      await ddl.initialize();

      // Seed through the owner connection: one edge device silent for an hour
      // and one program stuck in DEPLOYING for an hour, per tenant.
      await ddl.manager.save(
        ddl.manager.create(EdgeDevice, {
          tenantId,
          deviceCode: `EDGE-${schema.slice(-6)}`,
          deviceName: 'Pond gateway',
          deviceModel: DeviceModel.RASPBERRY_PI_5,
          lifecycleState: DeviceLifecycleState.ACTIVE,
          isOnline: true,
          lastSeenAt: AN_HOUR_AGO,
        }),
      );
      const program = await ddl.manager.save(
        ddl.manager.create(AutomationProgram, {
          tenantId,
          programName: 'Aeration schedule',
          programCode: `PRG-${schema.slice(-6)}`,
          status: ProgramStatus.DEPLOYING,
          deployedAt: AN_HOUR_AGO,
        }),
      );
      programIds[tenantId] = program.id;
      await ddl.manager.save(
        ddl.manager.create(DeploymentLog, {
          tenantId,
          programId: program.id,
          deviceId: randomUUID(),
          commandId: randomUUID(),
          version: 1,
          status: DeploymentStatus.DEPLOYING,
          deployedAt: AN_HOUR_AGO,
        }),
      );
      await ddl.destroy();

      const previousDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
      process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
      try {
        const qr = bootstrap.createQueryRunner();
        await applyTenantRlsToSchema(qr, { schemaOverride: schema });
        await qr.release();
      } finally {
        if (previousDdlAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
        else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousDdlAuthority;
      }

      await bootstrap.query(`GRANT USAGE ON SCHEMA "${schema}", sensor, public TO ${RUNTIME_ROLE}`);
      await bootstrap.query(
        `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO ${RUNTIME_ROLE}`,
      );
    }

    await bootstrap.query('CREATE SCHEMA IF NOT EXISTS platform');
    await bootstrap.query(`
      CREATE OR REPLACE FUNCTION platform.list_active_tenant_schema_mappings()
      RETURNS TABLE (schema_name text, tenant_id uuid, schema_exists boolean, committed_proof boolean)
      LANGUAGE sql STABLE AS $fn$
        SELECT * FROM (VALUES
          ('${schemas[TENANT_A]}', '${TENANT_A}'::uuid, true, true),
          ('${schemas[TENANT_B]}', '${TENANT_B}'::uuid, true, true)
        ) AS t(schema_name, tenant_id, schema_exists, committed_proof)
      $fn$`);
    await bootstrap.query(`GRANT USAGE ON SCHEMA platform TO ${RUNTIME_ROLE}`);
    await bootstrap.query(
      `GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO ${RUNTIME_ROLE}`,
    );

    admin = bootstrap;
    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: RUNTIME_ROLE,
      password,
      name: `jobs-rls-runtime-${randomBytes(4).toString('hex')}`,
      entities: ENTITIES,
      synchronize: false,
      logging: false,
    });
    await runtime.initialize();
  });

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (harness) await shutdownHarness(harness);
  });

  const scheduledJobs = createScheduledJobTestExecutor().executor;
  function unusedRepository<T extends object>(): Repository<T> {
    return {} as Partial<Repository<T>> as Repository<T>;
  }

  it('marks a silent edge device offline in every tenant (was: zero rows)', async () => {
    const service = new EdgeDeviceService(
      unusedRepository<EdgeDevice>(),
      unusedRepository<DeviceIoConfig>(),
      unusedRepository<LoRaDevice>(),
      runtime!,
      scheduledJobs,
      null,
      {} as Partial<InstallerScriptService> as InstallerScriptService,
      { get: () => undefined } as Partial<ConfigService> as ConfigService,
    );

    await expect(service.markStaleDevicesOffline(5)).resolves.toBe(2);

    for (const tenantId of [TENANT_A, TENANT_B]) {
      const [device] = await admin!.query(
        `SELECT is_online, lifecycle_state FROM "${schemas[tenantId]}".edge_devices`,
      );
      expect(device).toEqual({ is_online: false, lifecycle_state: 'offline' });
    }
  });

  it('reverts a deploy stuck past the timeout and fails its log (was: never reverted)', async () => {
    const service = new AutomationService(
      unusedRepository(),
      unusedRepository(),
      unusedRepository(),
      unusedRepository(),
      unusedRepository(),
      runtime!,
      scheduledJobs,
      {} as Partial<EdgeDeviceService> as EdgeDeviceService,
      {} as Partial<MqttClientService> as MqttClientService,
      {} as Partial<DeploymentLogService> as DeploymentLogService,
      {} as Partial<AutomationEventsPublisher> as AutomationEventsPublisher,
      {} as Partial<ArtifactService> as ArtifactService,
    );

    await service.checkDeployTimeout();

    for (const tenantId of [TENANT_A, TENANT_B]) {
      const schema = schemas[tenantId];
      const [program] = await admin!.query(
        `SELECT status FROM "${schema}".automation_programs WHERE id = $1`,
        [programIds[tenantId]],
      );
      const [log] = await admin!.query(
        `SELECT status FROM "${schema}".deployment_logs WHERE program_id = $1`,
        [programIds[tenantId]],
      );
      expect(program.status).toBe('approved');
      expect(log.status).toBe('failed');
    }
  });
});
