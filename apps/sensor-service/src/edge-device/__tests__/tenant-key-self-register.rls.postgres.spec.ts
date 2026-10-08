import { createHash, randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  applyTenantRlsToSchema,
  getTenantSchemaName,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';
import { collaborator, stub, stubMember } from '@aquaculture/testing';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type QueryRunner, type Repository } from 'typeorm';

import { CreateTenantProvisioningKeyDirectory1823000000000 } from '../../database/migrations/1823000000000-CreateTenantProvisioningKeyDirectory';
import { DeviceDirectoryService } from '../device-directory.service';
import { DeviceEventService } from '../device-event.service';
import type {
  CreateTenantKeyInput,
  DeviceFingerprint,
  SelfRegisterRequest,
} from '../dto/provisioning.dto';
import { EdgeDeviceDirectory } from '../entities/edge-device-directory.entity';
import { EdgeDevice } from '../entities/edge-device.entity';
import { TenantProvisioningKeyDirectory } from '../entities/tenant-provisioning-key-directory.entity';
import { TenantProvisioningKey } from '../entities/tenant-provisioning-key.entity';
import { InstallerScriptService, type ProvisioningConfig } from '../installer-script.service';
import { MqttAuthService } from '../mqtt-auth.service';
import { ProvisioningService } from '../provisioning.service';
import { TenantKeyService } from '../tenant-key.service';

/**
 * SENSOR-HIGH-175 on real Postgres: a self-registering agent presents a tenant
 * provisioning key with no tenant context. `tenant_provisioning_keys` (per
 * tenant) and the `sensor.tenant_provisioning_key_directory` route carry the
 * FORCED tenant-isolation policy; the runtime role does not own them. The
 * previous pooled UNION over every tenant schema saw zero rows here, so every
 * key was rejected as invalid and auto-provisioning never worked.
 *
 * Each refusal is paired with an acceptance on the same fixture, so a
 * deny-everything implementation fails this spec.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUNTIME_ROLE = 'sensor_key_route_rls_test';

jest.setTimeout(240_000);

describe('tenant-key self-register under FORCE RLS (SENSOR-HIGH-175)', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  let runtime: DataSource | undefined;
  let tenantKeys: TenantKeyService;
  let provisioning: ProvisioningService;

  async function withDdlAuthority(fn: () => Promise<void>): Promise<void> {
    const previous = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
      else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previous;
    }
  }

  /** One migration pass the way the runner does it: search_path pinned, one transaction. */
  async function migrationPass(dataSource: DataSource, schema: string): Promise<void> {
    const qr: QueryRunner = dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query(`SET search_path TO "${schema}", public`);
      await qr.startTransaction();
      await new CreateTenantProvisioningKeyDirectory1823000000000().up(qr);
      await qr.commitTransaction();
    } finally {
      await qr.release();
    }
  }

  function request(token: string, machineId: string): SelfRegisterRequest {
    return stub<SelfRegisterRequest>({
      tenant_token: token,
      fingerprint: stub<DeviceFingerprint>({ machineId, hostname: machineId }),
      agent_version: '1.0.0',
    });
  }

  async function createKey(
    tenantId: string,
    input: Partial<CreateTenantKeyInput>,
  ): Promise<string> {
    const created = await tenantKeys.createTenantKey(
      tenantId,
      stub<CreateTenantKeyInput>({ name: 'Fleet key', autoApprove: true, ...input }),
      'user-1',
    );
    return created.keyToken;
  }

  async function deviceCount(tenantId: string): Promise<number> {
    const rows: Array<{ n: string }> = await admin!.query(
      `SELECT count(*) AS n FROM "${getTenantSchemaName(tenantId)}".edge_devices`,
    );
    return Number(rows[0]?.n);
  }

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    const password = randomBytes(24).toString('hex');
    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query('CREATE SCHEMA sensor');
    await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${password}'`);

    // Source pass: the device directory (as 1805 left it) and the new key
    // directory created + armed by the migration under test.
    const sensorDdl = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: 'key-route-ddl-sensor',
      entities: [EdgeDeviceDirectory],
      synchronize: true,
      logging: false,
    });
    await sensorDdl.initialize();
    await sensorDdl.destroy();
    await withDdlAuthority(async () => {
      await migrationPass(admin!, 'sensor');
      const qr = admin!.createQueryRunner();
      await applyTenantRlsToSchema(qr, {
        schemaOverride: 'sensor',
        includeTables: ['edge_device_directory'],
      });
      await qr.release();
    });

    for (const tenantId of [TENANT_A, TENANT_B]) {
      const schema = getTenantSchemaName(tenantId);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const ddl = new DataSource({
        type: 'postgres',
        ...harness.connectionOptions,
        name: `key-route-ddl-${schema}`,
        schema,
        entities: [EdgeDevice, TenantProvisioningKey],
        synchronize: true,
        logging: false,
      });
      await ddl.initialize();
      await ddl.destroy();
      await withDdlAuthority(async () => {
        const qr = admin!.createQueryRunner();
        await applyTenantRlsToSchema(qr, { schemaOverride: schema });
        await qr.release();
      });
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${RUNTIME_ROLE}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO ${RUNTIME_ROLE}`,
      );
    }
    await admin.query(`GRANT USAGE ON SCHEMA sensor, public TO ${RUNTIME_ROLE}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE
         ON sensor.edge_device_directory, sensor.tenant_provisioning_key_directory
         TO ${RUNTIME_ROLE}`,
    );

    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: RUNTIME_ROLE,
      password,
      name: `key-route-runtime-${randomBytes(4).toString('hex')}`,
      entities: [
        EdgeDevice,
        EdgeDeviceDirectory,
        TenantProvisioningKey,
        TenantProvisioningKeyDirectory,
      ],
      synchronize: false,
      logging: false,
    });
    await runtime.initialize();

    const directory = new DeviceDirectoryService(runtime);
    const installer = collaborator<InstallerScriptService>(
      {
        buildTenantInstallerUrl: jest.fn(async () => 'https://host/install/tenant'),
        buildTenantInstallerCommand: jest.fn(async () => 'curl tenant | sudo bash'),
        getProvisioningConfig: jest.fn(async () =>
          stub<ProvisioningConfig>({ mqttBroker: 'mqtt.example', mqttPort: 8883 }),
        ),
      },
      'InstallerScriptService',
    );
    tenantKeys = new TenantKeyService(
      collaborator<Repository<TenantProvisioningKey>>(
        {
          create: stubMember<Repository<TenantProvisioningKey>['create']>(
            jest.fn((dto: Partial<TenantProvisioningKey>) =>
              Object.assign(new TenantProvisioningKey(), dto),
            ),
          ),
        },
        'TenantProvisioningKeyRepository',
      ),
      installer,
      runtime,
    );
    provisioning = new ProvisioningService(
      collaborator<Repository<EdgeDevice>>(
        {
          create: stubMember<Repository<EdgeDevice>['create']>(
            jest.fn((dto: Partial<EdgeDevice>) => Object.assign(new EdgeDevice(), dto)),
          ),
        },
        'EdgeDeviceRepository',
      ),
      runtime,
      new ConfigService({}),
      new MqttAuthService(new ConfigService({ MQTT_AUTH_MODE: 'http' }), directory),
      installer,
      tenantKeys,
      collaborator<DeviceEventService>({ logDeviceEvent: jest.fn() }, 'DeviceEventService'),
      directory,
    );
  });

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (harness) await shutdownHarness(harness);
  });

  it('self-registers a device into the key\'s tenant (was: every key "invalid")', async () => {
    const token = await createKey(TENANT_A, {});

    const response = await provisioning.selfRegisterDevice(request(token, 'machine-a1'));

    expect(response.success).toBe(true);
    expect(response.tenant_id).toBe(TENANT_A);
    expect(await deviceCount(TENANT_A)).toBe(1);
    expect(await deviceCount(TENANT_B)).toBe(0);
    const routes: Array<{ tenant_id: string }> = await admin!.query(
      'SELECT tenant_id FROM sensor.edge_device_directory WHERE device_id = $1',
      [response.device_id],
    );
    expect(routes).toEqual([{ tenant_id: TENANT_A }]);
  });

  it('never registers into another tenant: a route that names tenant B resolves nothing', async () => {
    const token = await createKey(TENANT_A, {});
    await expect(
      provisioning.selfRegisterDevice(request(token, 'machine-a2')),
    ).resolves.toMatchObject({ tenant_id: TENANT_A });

    const digest = createHash('sha256').update(token).digest('hex');
    await admin!.query(
      `UPDATE sensor.tenant_provisioning_key_directory d SET tenant_id = $1
         FROM "${getTenantSchemaName(TENANT_A)}".tenant_provisioning_keys k
        WHERE k.key_token = $2 AND d.key_id = k.id`,
      [TENANT_B, digest],
    );
    await expect(
      provisioning.selfRegisterDevice(request(token, 'machine-a3')),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await deviceCount(TENANT_B)).toBe(0);
  });

  it('denies a revoked key and an expired key, but admits a live key of the same tenant', async () => {
    const revoked = await createKey(TENANT_B, {});
    const created: Array<{ id: string }> = await admin!.query(
      `SELECT id FROM "${getTenantSchemaName(TENANT_B)}".tenant_provisioning_keys
        WHERE key_token = $1`,
      [createHash('sha256').update(revoked).digest('hex')],
    );
    await tenantKeys.revokeTenantKey(created[0]!.id, TENANT_B);
    await expect(
      provisioning.selfRegisterDevice(request(revoked, 'machine-b1')),
    ).rejects.toBeInstanceOf(BadRequestException);

    const expired = await createKey(TENANT_B, { expiresInDays: 1 });
    await admin!.query(
      `UPDATE "${getTenantSchemaName(TENANT_B)}".tenant_provisioning_keys
          SET expires_at = now() - interval '1 day' WHERE key_token = $1`,
      [createHash('sha256').update(expired).digest('hex')],
    );
    await expect(
      provisioning.selfRegisterDevice(request(expired, 'machine-b2')),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const live = await createKey(TENANT_B, {});
    await expect(
      provisioning.selfRegisterDevice(request(live, 'machine-b3')),
    ).resolves.toMatchObject({ tenant_id: TENANT_B });
  });

  it('claims a registration only on a key that is still active and unexpired (TOCTOU)', async () => {
    const schemaB = getTenantSchemaName(TENANT_B);
    const keyId = async (token: string): Promise<string> => {
      const found: Array<{ id: string }> = await admin!.query(
        `SELECT id FROM "${schemaB}".tenant_provisioning_keys WHERE key_token = $1`,
        [createHash('sha256').update(token).digest('hex')],
      );
      return found[0]!.id;
    };
    const claim = (id: string): Promise<void> =>
      runInTenantTransaction(runtime!, 'sensor', TENANT_B, (qr) =>
        tenantKeys.incrementUsedCount(id, qr.manager),
      );

    // Validated while live, then revoked / expired before the claim runs.
    const revoked = await keyId(await createKey(TENANT_B, {}));
    await admin!.query(
      `UPDATE "${schemaB}".tenant_provisioning_keys SET is_active = false WHERE id = $1`,
      [revoked],
    );
    await expect(claim(revoked)).rejects.toBeInstanceOf(ConflictException);

    const expired = await keyId(await createKey(TENANT_B, {}));
    await admin!.query(
      `UPDATE "${schemaB}".tenant_provisioning_keys SET expires_at = now() - interval '1 minute'
        WHERE id = $1`,
      [expired],
    );
    await expect(claim(expired)).rejects.toBeInstanceOf(ConflictException);

    const exhausted = await keyId(await createKey(TENANT_B, { maxDevices: 1 }));
    await claim(exhausted);
    await expect(claim(exhausted)).rejects.toBeInstanceOf(ConflictException);

    const live = await keyId(await createKey(TENANT_B, {}));
    await claim(live);
    const used: Array<{ used_count: number }> = await admin!.query(
      `SELECT used_count FROM "${schemaB}".tenant_provisioning_keys WHERE id = $1`,
      [live],
    );
    expect(used).toEqual([{ used_count: 1 }]);
  });

  it('denies a key with no route (unknown key)', async () => {
    await expect(
      provisioning.selfRegisterDevice(request(randomBytes(32).toString('hex'), 'machine-x')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('routes a pre-existing key once the backfill runs as the non-owner role', async () => {
    const token = randomBytes(32).toString('hex');
    await admin!.query(
      `INSERT INTO "${getTenantSchemaName(TENANT_B)}".tenant_provisioning_keys
         (tenant_id, key_token, name, is_active, used_count, auto_approve)
       VALUES ($1, $2, 'legacy key', true, 0, true)`,
      [TENANT_B, createHash('sha256').update(token).digest('hex')],
    );
    await expect(
      provisioning.selfRegisterDevice(request(token, 'machine-b4')),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Tenant passes as the runtime role under FORCE RLS; twice (idempotent).
    for (let run = 0; run < 2; run++) {
      for (const tenantId of [TENANT_A, TENANT_B]) {
        await migrationPass(runtime!, getTenantSchemaName(tenantId));
      }
    }

    await expect(
      provisioning.selfRegisterDevice(request(token, 'machine-b4')),
    ).resolves.toMatchObject({ tenant_id: TENANT_B });
    const routes: Array<{ tenant_id: string; n: string }> = await admin!.query(
      `SELECT tenant_id, count(*) AS n FROM sensor.tenant_provisioning_key_directory
        GROUP BY tenant_id ORDER BY tenant_id`,
    );
    // A: 2 keys from the tests above (one route was pointed at B, see test 2);
    // B: revoked + expired + live + legacy, the four claim-test keys, plus A's
    // misrouted one.
    expect(routes).toEqual([
      { tenant_id: TENANT_A, n: '1' },
      { tenant_id: TENANT_B, n: '9' },
    ]);
  });
});
