/**
 * Binding sensor channels to water-quality parameters, on real PostgreSQL
 * (FARM-HIGH-373, FARM-MEDIUM-374).
 *
 * The commands run through the real tenant transaction against a tenant
 * schema shaped like production's (helpers/source-database.ts), so the
 * parameter lock, the point lock, the live-row uniques, the CHECKs, the
 * one-active-config-per-quantity index and the quantity trigger are the ones
 * the commands meet in production. Only the sensor service is replaced: a
 * directory that answers from a table of channel descriptions, as
 * `request.sensor.describeChannels` would.
 */
import 'reflect-metadata';

import { withTenantContext } from '@aquaculture/backend-common/context';
import { stub } from '@aquaculture/testing';
import type { SensorChannelDescription, SensorChannelKey } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';

import { createFixtureAuditLogService } from '../../__tests__/e2e/helpers/farm-tenant-fixture';
import type { AuditLogService } from '../../database/services/audit-log.service';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { DeleteSystemCommand } from '../../system/commands/delete-system.command';
import { DeleteSystemHandler } from '../../system/handlers/delete-system.handler';
import { BindParameterChannelCommand } from '../commands/bind-parameter-channel.command';
import {
  ClearParameterQuantityCommand,
  DeclareParameterQuantityCommand,
} from '../commands/declare-parameter-quantity.command';
import { DeleteParamEquipmentCommand } from '../commands/delete-param-equipment.command';
import { DeleteParameterConfigCommand } from '../commands/delete-parameter-config.command';
import { ReplaceParameterChannelCommand } from '../commands/replace-parameter-channel.command';
import { UnbindParameterChannelCommand } from '../commands/unbind-parameter-channel.command';
import { UpdateParameterConfigCommand } from '../commands/update-parameter-config.command';
import {
  ChannelSourcePriority,
  MeasurementPosition,
  type WaterQualityParamEquipment,
} from '../entities/water-quality-param-equipment.entity';
import { BindParameterChannelHandler } from '../handlers/bind-parameter-channel.handler';
import {
  ClearParameterQuantityHandler,
  DeclareParameterQuantityHandler,
} from '../handlers/declare-parameter-quantity.handler';
import { DeleteParamEquipmentHandler } from '../handlers/delete-param-equipment.handler';
import { DeleteParameterConfigHandler } from '../handlers/delete-parameter-config.handler';
import { ReplaceParameterChannelHandler } from '../handlers/replace-parameter-channel.handler';
import { UnbindParameterChannelHandler } from '../handlers/unbind-parameter-channel.handler';
import { UpdateParameterConfigHandler } from '../handlers/update-parameter-config.handler';
import {
  CheckParameterChannelBindingQuery,
  ListParameterSourcesAtPointQuery,
} from '../queries/parameter-source-queries';
import {
  CheckParameterChannelBindingHandler,
  ListParameterSourcesAtPointHandler,
} from '../query-handlers/parameter-source-query.handlers';
import type { ParameterConfigCacheService } from '../services/parameter-config-cache.service';
import {
  closeSourcesAtPoints,
  type MeasurementPoint,
  type SourceLocation,
} from '../services/parameter-sources';
import type { SensorChannelDirectory } from '../services/sensor-channel-directory.service';

import {
  bootSourceDatabase,
  shutdownSourceDatabase,
  type SourceDatabase,
} from './helpers/source-database';
import { seedSourceTopology, type SourceTopology } from './helpers/source-topology';

jest.setTimeout(180_000);

const TENANT = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const USER = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const OTHER_TANK = '7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e';
const OTHER_SYSTEM = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f';

describe('parameter channel binding — real Postgres', () => {
  let database: SourceDatabase | undefined;
  let topology: SourceTopology;
  let auditLog: AuditLogService;
  const described = new Map<string, SensorChannelDescription>();
  const directory = stub<SensorChannelDirectory>({
    describe: async (_tenantId: string, keys: readonly SensorChannelKey[]) =>
      keys.map((key) => describedChannel(key)),
    describeOne: async (_tenantId: string, key: SensorChannelKey) => describedChannel(key),
  });
  const cache = stub<ParameterConfigCacheService>({ invalidate: () => undefined });

  function describedChannel(key: SensorChannelKey): SensorChannelDescription {
    return (
      described.get(`${key.sensorId}|${key.channelKey}`) ?? {
        ...key,
        presence: 'NO_SENSOR',
        sensorActive: null,
        siteId: null,
        systemId: null,
        tankId: null,
        equipmentId: null,
        channelId: null,
        enabled: null,
        quantity: null,
        quantityFamily: null,
        unit: null,
        calibrationDueAt: null,
        configuredAt: null,
        latestValue: null,
        latestAt: null,
        latestQuality: null,
      }
    );
  }

  /** A live channel of the topology's sensor, standing where `at` says. */
  function channel(
    channelKey: string,
    facts: Partial<SensorChannelDescription>,
    sensorId = topology.sensorId,
  ): SensorChannelKey {
    described.set(`${sensorId}|${channelKey}`, {
      sensorId,
      channelKey,
      presence: 'FOUND',
      sensorActive: true,
      siteId: topology.siteId,
      systemId: null,
      tankId: null,
      equipmentId: null,
      channelId: '4c4c4c4c-4c4c-4c4c-8c4c-4c4c4c4c4c4c',
      enabled: true,
      quantity: null,
      quantityFamily: null,
      unit: null,
      calibrationDueAt: null,
      configuredAt: null,
      latestValue: 0.42,
      latestAt: '2026-10-08T10:00:00Z',
      latestQuality: 'GOOD',
      ...facts,
    });
    return { sensorId, channelKey };
  }

  const at = (point: MeasurementPoint): SourceLocation => ({
    point,
    position: MeasurementPosition.REPRESENTATIVE,
    depthM: null,
  });
  const inTenant = <T>(work: () => Promise<T>): Promise<T> => withTenantContext(TENANT, work);
  const ds = (): SourceDatabase => {
    if (database === undefined) throw new Error('database not booted');
    return database;
  };

  const bind = (
    parameterConfigId: string,
    point: MeasurementPoint,
    key: SensorChannelKey,
    priority = ChannelSourcePriority.PRIMARY,
  ): Promise<WaterQualityParamEquipment> =>
    inTenant(() =>
      new BindParameterChannelHandler(ds().dataSource, directory, auditLog).execute(
        new BindParameterChannelCommand(
          TENANT,
          { parameterConfigId, location: at(point), channel: key, priority },
          USER,
        ),
      ),
    );

  beforeAll(async () => {
    database = await bootSourceDatabase(TENANT);
    topology = await seedSourceTopology(database.dataSource, database.schema, TENANT, USER);
    auditLog = createFixtureAuditLogService(database.dataSource);
  });

  afterAll(async () => {
    await shutdownSourceDatabase(database);
  });

  it('binds a TAN channel standing at the tank as the primary, and records who did it', async () => {
    const tank: MeasurementPoint = { kind: 'tank', id: topology.tankId };
    const source = await bind(
      topology.configs.tan,
      tank,
      channel('tan', { tankId: topology.tankId, quantity: 'tan', unit: 'mg/L' }),
    );
    expect(source).toEqual(
      expect.objectContaining({
        tankId: topology.tankId,
        channelKey: 'tan',
        priority: ChannelSourcePriority.PRIMARY,
        monitoringFrequency: null,
        alertEnabled: null,
        boundBy: USER,
      }),
    );
    const [audit] = await ds().dataSource.query(
      `SELECT action, metadata->>'source' AS source FROM farm.farm_audit_logs
        WHERE "entityId" = $1`,
      [source.id],
    );
    expect(audit).toEqual({ action: 'CREATE', source: 'parameter-sources:bindParameterChannel' });
  });

  it('refuses a channel with the problem codes the UI shows, and writes nothing', async () => {
    const tank: MeasurementPoint = { kind: 'tank', id: topology.tankId };
    await expect(
      bind(
        topology.configs.ph,
        tank,
        channel('nh3', { tankId: topology.tankId, quantity: 'nh3', unit: 'mg/L' }),
      ),
    ).rejects.toMatchObject({ problems: ['QUANTITY_MISMATCH'] });
    await expect(
      bind(
        topology.configs.ph,
        tank,
        channel('ph_far', { tankId: OTHER_TANK, quantity: 'ph', unit: 'pH', enabled: false }),
      ),
    ).rejects.toMatchObject({ problems: ['CHANNEL_DISABLED', 'NOT_AT_POINT'] });
    // ammonia names a family: until its basis is declared it takes no channel.
    await expect(
      bind(
        topology.configs.ammonia,
        tank,
        channel('nh4', { tankId: topology.tankId, quantity: 'nh4', unit: 'mg/L' }),
      ),
    ).rejects.toMatchObject({ problems: ['PARAMETER_HAS_NO_QUANTITY'] });
    const [{ n }] = await ds().dataSource.query(
      `SELECT count(*)::int AS n FROM "${ds().schema}".water_quality_param_equipment
        WHERE "parameterConfigId" IN ($1, $2)`,
      [topology.configs.ph, topology.configs.ammonia],
    );
    expect(n).toBe(0);
  });

  it('places a sensor by farm topology: equipment in the loop stands at the system', async () => {
    const system: MeasurementPoint = { kind: 'system', id: topology.systemId };
    // The sensor was registered against another system; farm says its unit is in this one.
    const loop = channel('temp', {
      equipmentId: topology.biofilterId,
      systemId: OTHER_SYSTEM,
      quantity: 'temperature',
      unit: '°F',
    });
    const source = await bind(topology.configs.temperature, system, loop);
    expect(source.systemId).toBe(topology.systemId);
    // A loop sensor does not stand at one of the loop's tanks.
    await expect(
      bind(topology.configs.temperature, { kind: 'tank', id: topology.tankId }, loop),
    ).rejects.toMatchObject({ problems: ['NOT_AT_POINT'] });
  });

  it('keeps one primary, puts a backup behind it, and promotes the backup on unbind', async () => {
    const biofilter: MeasurementPoint = { kind: 'equipment', id: topology.biofilterId };
    const first = channel('ph', { equipmentId: topology.biofilterId, quantity: 'ph', unit: 'pH' });
    const second = channel('ph_2', {
      equipmentId: topology.biofilterId,
      quantity: 'ph',
      unit: 'pH',
    });
    await expect(
      bind(topology.configs.ph, biofilter, second, ChannelSourcePriority.BACKUP),
    ).rejects.toThrow(/backup needs a primary/);
    const primary = await bind(topology.configs.ph, biofilter, first);
    await expect(bind(topology.configs.ph, biofilter, second)).rejects.toThrow(
      /already has a primary/,
    );
    await expect(
      bind(topology.configs.ph, biofilter, first, ChannelSourcePriority.BACKUP),
    ).rejects.toThrow(/already a source/);
    const backup = await bind(topology.configs.ph, biofilter, second, ChannelSourcePriority.BACKUP);

    const unbinding = await inTenant(() =>
      new UnbindParameterChannelHandler(ds().dataSource, auditLog).execute(
        new UnbindParameterChannelCommand(TENANT, primary.id, USER),
      ),
    );
    expect(unbinding.unbound).toEqual(expect.objectContaining({ id: primary.id, unboundBy: USER }));
    expect(unbinding.promoted).toEqual(
      expect.objectContaining({ id: backup.id, priority: ChannelSourcePriority.PRIMARY }),
    );
  });

  it('replaces a channel in one step, keeping place and priority, and keeps the old as history', async () => {
    const biofilter: MeasurementPoint = { kind: 'equipment', id: topology.biofilterId };
    const [live] = await ds().dataSource.query(
      `SELECT id FROM "${ds().schema}".water_quality_param_equipment
        WHERE "parameterConfigId" = $1 AND "equipmentId" = $2 AND "unboundAt" IS NULL`,
      [topology.configs.ph, biofilter.id],
    );
    const probe = channel('ph_3', {
      equipmentId: topology.biofilterId,
      quantity: 'ph',
      unit: 'pH',
    });
    const replacement = await inTenant(() =>
      new ReplaceParameterChannelHandler(ds().dataSource, directory, auditLog).execute(
        new ReplaceParameterChannelCommand(TENANT, live.id, probe, USER),
      ),
    );
    expect(replacement).toEqual(
      expect.objectContaining({
        equipmentId: topology.biofilterId,
        channelKey: 'ph_3',
        priority: ChannelSourcePriority.PRIMARY,
      }),
    );
    const [old] = await ds().dataSource.query(
      `SELECT "unboundAt" IS NOT NULL AS unbound FROM "${ds().schema}".water_quality_param_equipment
        WHERE id = $1`,
      [live.id],
    );
    expect(old).toEqual({ unbound: true });
  });

  it('dry-runs a bind with the same rule, and lists a point’s sources with their problems now', async () => {
    const tank: MeasurementPoint = { kind: 'tank', id: topology.tankId };
    const candidate = channel('tan_2', { tankId: OTHER_TANK, quantity: 'tan', unit: 'mg/L' });
    const check = await inTenant(() =>
      new CheckParameterChannelBindingHandler(ds().dataSource, directory).execute(
        new CheckParameterChannelBindingQuery(TENANT, {
          parameterConfigId: topology.configs.tan,
          location: at(tank),
          channel: candidate,
        }),
      ),
    );
    expect(check.problems).toEqual(['NOT_AT_POINT']);
    expect(check.channel.latestAt).toEqual(new Date('2026-10-08T10:00:00Z'));

    // The bound TAN channel is disabled after it was bound: the read says so.
    channel('tan', { tankId: topology.tankId, quantity: 'tan', unit: 'mg/L', enabled: false });
    const statuses = await inTenant(() =>
      new ListParameterSourcesAtPointHandler(ds().dataSource, directory).execute(
        new ListParameterSourcesAtPointQuery(TENANT, tank),
      ),
    );
    const tan = statuses.find((status) => status.source.channelKey === 'tan');
    expect(tan?.problems).toEqual(['CHANNEL_DISABLED']);
    expect(tan?.channel?.presence).toBe('FOUND');
  });

  it('declares a family member, keeps one active config per quantity, and records it', async () => {
    const declare = (quantity: string): Promise<unknown> =>
      inTenant(() =>
        new DeclareParameterQuantityHandler(ds().dataSource, auditLog, cache).execute(
          new DeclareParameterQuantityCommand(TENANT, topology.configs.ammonia, quantity, USER),
        ),
      );
    await expect(declare('nitriteN')).rejects.toThrow(/cannot record nitriteN/);
    // total_ammonia_nitrogen already records TAN: the database refuses a second.
    await expect(declare('tan')).rejects.toThrow(/already records this measured quantity/);
    await declare('nh3');
    const [config] = await ds().dataSource.query(
      `SELECT "declaredQuantity", "effectiveQuantity", "quantityConfiguredAt" IS NOT NULL AS stamped
         FROM "${ds().schema}".water_quality_parameter_configs WHERE id = $1`,
      [topology.configs.ammonia],
    );
    expect(config).toEqual({ declaredQuantity: 'nh3', effectiveQuantity: 'nh3', stamped: true });
    const ledger = await ds().dataSource.query(
      `SELECT quantity, reason, "declaredBy" FROM "${ds().schema}".parameter_quantity_declarations
        WHERE "parameterConfigId" = $1`,
      [topology.configs.ammonia],
    );
    expect(ledger).toEqual([{ quantity: 'nh3', reason: 'declared', declaredBy: USER }]);

    // Bound, its meaning is fixed: unbind before clearing or re-declaring.
    await bind(
      topology.configs.ammonia,
      { kind: 'tank', id: topology.tankId },
      channel('nh3', { tankId: topology.tankId, quantity: 'nh3', unit: 'mg/L' }),
    );
    await expect(
      inTenant(() =>
        new ClearParameterQuantityHandler(ds().dataSource, auditLog, cache).execute(
          new ClearParameterQuantityCommand(TENANT, topology.configs.ammonia, USER),
        ),
      ),
    ).rejects.toThrow(/unbind it before changing what it records/);
  });

  it('fixes a bound parameter’s code, unit and activity, and keeps plan writers off channel rows', async () => {
    await expect(
      inTenant(() =>
        new UpdateParameterConfigHandler(ds().dataSource, cache).execute(
          new UpdateParameterConfigCommand(TENANT, topology.configs.tan, { unit: 'µg/L' }, USER),
        ),
      ),
    ).rejects.toThrow(/unbind it before changing its code, unit or activity/);
    await expect(
      inTenant(() =>
        new DeleteParameterConfigHandler(ds().dataSource, cache).execute(
          new DeleteParameterConfigCommand(TENANT, topology.configs.tan),
        ),
      ),
    ).rejects.toThrow(/unbind it before deleting/);
    const [tan] = await ds().dataSource.query(
      `SELECT id FROM "${ds().schema}".water_quality_param_equipment
        WHERE "channelKey" = 'tan' AND "unboundAt" IS NULL`,
    );
    await expect(
      inTenant(() =>
        new DeleteParamEquipmentHandler(ds().dataSource).execute(
          new DeleteParamEquipmentCommand(TENANT, tan.id, USER),
        ),
      ),
    ).rejects.toThrow(/unbindParameterChannel/);
  });

  it('closes every source at a removed tank in the deleting transaction, as history', async () => {
    const closed = await inTenant(() =>
      ds().dataSource.transaction((manager) =>
        closeSourcesAtPoints(manager, TENANT, [{ kind: 'tank', id: topology.tankId }], USER),
      ),
    );
    expect(closed).toBeGreaterThan(0);
    const [{ live }] = await ds().dataSource.query(
      `SELECT count(*)::int AS live FROM "${ds().schema}".water_quality_param_equipment
        WHERE "tankId" = $1 AND "unboundAt" IS NULL`,
      [topology.tankId],
    );
    expect(live).toBe(0);
  });

  it('deleting a system closes its sources and those of the equipment it deactivates', async () => {
    await inTenant(() =>
      new DeleteSystemHandler(ds().dataSource, auditLog, new OutboxPublisher(FarmOutbox)).execute(
        new DeleteSystemCommand(topology.systemId, TENANT, USER),
      ),
    );
    const rows: Array<{ point: string; live: number }> = await ds().dataSource.query(
      `SELECT CASE WHEN "systemId" IS NOT NULL THEN 'system' ELSE 'equipment' END AS point,
              count(*) FILTER (WHERE "unboundAt" IS NULL)::int AS live
         FROM "${ds().schema}".water_quality_param_equipment
        WHERE "systemId" = $1 OR "equipmentId" = $2
        GROUP BY 1 ORDER BY 1`,
      [topology.systemId, topology.biofilterId],
    );
    expect(rows).toEqual([
      { point: 'equipment', live: 0 },
      { point: 'system', live: 0 },
    ]);
  });
});
