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
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { collaborator, stub } from '@aquaculture/testing';
import { ForbiddenException, HttpException } from '@nestjs/common';
import type { SensorChannelDescription, SensorChannelKey } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import type { QueryRunner } from 'typeorm';

import { createFixtureAuditLogService } from '../../__tests__/e2e/helpers/farm-tenant-fixture';
import type { AuditLogService } from '../../database/services/audit-log.service';
import type { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { DeleteSystemCommand } from '../../system/commands/delete-system.command';
import { DeleteSystemHandler } from '../../system/handlers/delete-system.handler';
import { DeleteTankCommand } from '../../tank/commands/delete-tank.command';
import { DeleteTankHandler } from '../../tank/handlers/delete-tank.handler';
import { UpdateEquipmentCommand } from '../../equipment/commands/update-equipment.command';
import { UpdateEquipmentHandler } from '../../equipment/handlers/update-equipment.handler';
import type { TankEquipmentAdapterService } from '../../equipment/services/tank-equipment-adapter.service';
import { CreateParamEquipmentCommand } from '../commands/create-param-equipment.command';
import { CreateParamEquipmentHandler } from '../handlers/create-param-equipment.handler';
import { UpdateSystemCommand } from '../../system/commands/update-system.command';
import { UpdateSystemHandler } from '../../system/handlers/update-system.handler';
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
import { GetUnitMeasurementPlanQuery } from '../queries/get-unit-measurement-plan.query';
import { GetUnitMeasurementPlanHandler } from '../query-handlers/get-unit-measurement-plan.handler';
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
import {
  seedLoop,
  seedSourceTopology,
  seedTank,
  type SourceTopology,
} from './helpers/source-topology';

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
    describeOne: async (_tenantId: string, key: SensorChannelKey) => {
      // A concurrent change landing while the bind waits on the sensor service.
      const meanwhile = whileDescribing;
      whileDescribing = null;
      if (meanwhile !== null) await meanwhile();
      return describedChannel(key);
    },
  });
  let whileDescribing: (() => Promise<void>) | null = null;
  const MANAGER = { sub: USER, roles: [Role.MODULE_MANAGER] };
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

  const farmStockProjection = collaborator<FarmStockProjectionService>(
    { refreshContainers: async () => undefined },
    'FarmStockProjectionService',
  );
  const deleteTank = (tankId: string): Promise<boolean> =>
    inTenant(() =>
      new DeleteTankHandler(
        ds().dataSource,
        auditLog,
        new OutboxPublisher(FarmOutbox),
        farmStockProjection,
      ).execute(new DeleteTankCommand(TENANT, USER, tankId)),
    );
  const deleteSystem = (systemId: string): Promise<boolean> =>
    inTenant(() =>
      new DeleteSystemHandler(ds().dataSource, auditLog, new OutboxPublisher(FarmOutbox)).execute(
        new DeleteSystemCommand(systemId, TENANT, USER),
      ),
    );

  /** A racing write either lands or is refused as a conflict or a gone point — never a 500. */
  function expectClientOutcome(result: PromiseSettledResult<unknown>): void {
    if (result.status === 'fulfilled') return;
    const reason: unknown = result.reason;
    if (!(reason instanceof HttpException)) throw reason;
    expect([404, 409]).toContain(reason.getStatus());
  }

  /** A second connection's transaction on the tenant schema, for forcing an interleaving. */
  async function openTransaction(): Promise<QueryRunner> {
    const runner = ds().dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query(`SET LOCAL search_path TO "${ds().schema}", public`);
    return runner;
  }

  /** Runs the last step of a held transaction and commits it. */
  async function finish(
    runner: QueryRunner | undefined,
    last: (runner: QueryRunner) => Promise<unknown>,
  ): Promise<void> {
    if (runner === undefined) throw new Error('the interleaving never opened its transaction');
    try {
      await last(runner);
      await runner.commitTransaction();
    } finally {
      await runner.release();
    }
  }

  /** Long enough for the other connection to reach the lock it waits on. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500));

  /** No live source at a retired point, and every row's validity window is ordered. */
  async function expectNoLiveSourcesAt(
    column: string,
    id: string,
    kind: 'any' | 'channel' = 'any',
  ): Promise<void> {
    const channelOnly = kind === 'channel' ? 'AND "channelKey" IS NOT NULL' : '';
    const [{ live, disordered }] = await ds().dataSource.query(
      `SELECT count(*) FILTER (
                WHERE "unboundAt" IS NULL AND "${column}" = $1 ${channelOnly})::int AS live,
              count(*) FILTER (WHERE "unboundAt" < "boundAt")::int AS disordered
         FROM "${ds().schema}".water_quality_param_equipment`,
      [id],
    );
    expect({ live, disordered }).toEqual({ live: 0, disordered: 0 });
  }

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

  it('leaves an unplanned unit unplanned: a bound channel is not a manual plan line', async () => {
    const plan = await inTenant(() =>
      new GetUnitMeasurementPlanHandler(ds().dataSource).execute(
        new GetUnitMeasurementPlanQuery(TENANT, topology.tankId),
      ),
    );
    expect(plan.planned).toBe(false);
    expect(plan.entries.map((entry) => entry.parameter.id).sort()).toEqual(
      Object.values(topology.configs).sort(),
    );
    expect(plan.entries.every((entry) => !entry.required)).toBe(true);
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
      new ListParameterSourcesAtPointHandler(
        ds().dataSource,
        directory,
        new SiteAuthorizationService(),
      ).execute(new ListParameterSourcesAtPointQuery(TENANT, tank, MANAGER)),
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

  it('refuses to bind on a parameter whose meaning changed while the sensor service answered', async () => {
    const tank: MeasurementPoint = { kind: 'tank', id: topology.tankId };
    const key = channel('ph_tank', { tankId: topology.tankId, quantity: 'ph', unit: 'pH' });
    // 'NBS' is a spelling of the pH unit: the channel rule alone would still pass.
    whileDescribing = async () => {
      await ds().dataSource.query(
        `UPDATE "${ds().schema}".water_quality_parameter_configs SET unit = 'NBS' WHERE id = $1`,
        [topology.configs.ph],
      );
    };
    await expect(bind(topology.configs.ph, tank, key)).rejects.toThrow(/changed while binding/);
    await ds().dataSource.query(
      `UPDATE "${ds().schema}".water_quality_parameter_configs SET unit = 'pH' WHERE id = $1`,
      [topology.configs.ph],
    );
  });

  it('refuses to bind at a point removed while the sensor service answered', async () => {
    const doomed = await seedTank(ds().dataSource, TENANT, topology, 'DOOMED-1', USER);
    const key = channel('ph_doomed', { tankId: doomed, quantity: 'ph', unit: 'pH' });
    whileDescribing = async () => {
      await ds().dataSource.query(
        `UPDATE "${ds().schema}".tanks SET "isActive" = false WHERE id = $1`,
        [doomed],
      );
    };
    await expect(bind(topology.configs.ph, { kind: 'tank', id: doomed }, key)).rejects.toThrow(
      /was removed; nothing was bound/,
    );
  });

  it('shows a MODULE_USER the sources at a point only at an assigned site', async () => {
    const list = (assignedSiteIds: string[]): Promise<unknown> =>
      inTenant(() =>
        new ListParameterSourcesAtPointHandler(
          ds().dataSource,
          directory,
          new SiteAuthorizationService(),
        ).execute(
          new ListParameterSourcesAtPointQuery(
            TENANT,
            { kind: 'tank', id: topology.tankId },
            { sub: USER, roles: [Role.MODULE_USER], assignedSiteIds },
          ),
        ),
      );
    await expect(list(['99999999-9999-4999-8999-999999999999'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(list([topology.siteId])).resolves.toEqual(expect.any(Array));
  });

  it('fixes a parameter’s code and unit once measurements recorded it', async () => {
    const [{ id: turbidity }] = await ds().dataSource.query(
      `INSERT INTO "${ds().schema}".water_quality_parameter_configs
         ("tenantId", code, name, unit, "effectiveQuantity")
       VALUES ($1, 'turbidity', 'Turbidity', 'NTU', 'turbidity') RETURNING id`,
      [TENANT],
    );
    const updateUnit = (unit: string): Promise<unknown> =>
      inTenant(() =>
        new UpdateParameterConfigHandler(ds().dataSource, cache).execute(
          new UpdateParameterConfigCommand(TENANT, turbidity, { unit }, USER),
        ),
      );
    await updateUnit('FNU');
    await ds().dataSource.query(
      `INSERT INTO "${ds().schema}".water_quality_measurements
         ("tenantId", "measuredAt", source, parameters, "overallStatus", "hasAlarm")
       VALUES ($1, now(), 'manual', '{"turbidity": 3.1}'::jsonb, 'optimal', false)`,
      [TENANT],
    );
    await expect(updateUnit('NTU')).rejects.toThrow(/Measurements already record 'turbidity'/);
  });

  it('serializes two binds of one primary: one lands, the other is a 409', async () => {
    const tank = await seedTank(ds().dataSource, TENANT, topology, 'RACE-BIND', USER);
    const point: MeasurementPoint = { kind: 'tank', id: tank };
    const first = channel('ph_a', { tankId: tank, quantity: 'ph', unit: 'pH' });
    const second = channel('ph_b', { tankId: tank, quantity: 'ph', unit: 'pH' });
    const results = await Promise.allSettled([
      bind(topology.configs.ph, point, first),
      bind(topology.configs.ph, point, second),
    ]);
    results.forEach(expectClientOutcome);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toEqual(
      expect.objectContaining({ reason: expect.objectContaining({ code: 'SOURCE_CONFLICT' }) }),
    );
  });

  it('blocks a bind on its point while a retirement holds it: the bind is refused, nothing stays live', async () => {
    const tank = await seedTank(ds().dataSource, TENANT, topology, 'HELD-TANK', USER);
    const key = channel('ph_held', { tankId: tank, quantity: 'ph', unit: 'pH' });
    let retiring: QueryRunner | undefined;
    // The tank's retirement starts while the bind waits on the sensor service:
    // it writes the point row and holds it.
    whileDescribing = async () => {
      retiring = await openTransaction();
      await retiring.query(`UPDATE tanks SET "isActive" = false WHERE id = $1`, [tank]);
    };
    const binding = bind(topology.configs.ph, { kind: 'tank', id: tank }, key);
    binding.catch(() => undefined);
    await settle();
    // Without the bind's point lock it would have committed by now, and the
    // retirement below would close it after the fact — or miss it.
    await finish(retiring, (runner) =>
      closeSourcesAtPoints(runner.manager, TENANT, [{ kind: 'tank', id: tank }], USER, 'all'),
    );
    await expect(binding).rejects.toMatchObject({ code: 'POINT_RETIRED' });
    await expectNoLiveSourcesAt('tankId', tank);
  });

  it('stamps a close with its own statement time, never before a bind committed meanwhile', async () => {
    const tank = await seedTank(ds().dataSource, TENANT, topology, 'CLOCK-TANK', USER);
    const key = channel('ph_clock', { tankId: tank, quantity: 'ph', unit: 'pH' });
    // The closing transaction starts first: its now() precedes the bind.
    const closing = await openTransaction();
    await closing.query('SELECT 1');
    await settle();
    await bind(topology.configs.ph, { kind: 'tank', id: tank }, key);
    // With unboundAt = now() this violates CHK_wqpe_unbound (unboundAt < boundAt).
    await finish(closing, (runner) =>
      closeSourcesAtPoints(runner.manager, TENANT, [{ kind: 'tank', id: tank }], USER, 'all'),
    );
    await expectNoLiveSourcesAt('tankId', tank);
  });

  it('takes the point before the source rows: a replace waits for a system retirement, no deadlock', async () => {
    const loop = await seedLoop(ds().dataSource, TENANT, topology, 'RAS-HELD');
    const point: MeasurementPoint = { kind: 'system', id: loop.systemId };
    const bound = await bind(
      topology.configs.ph,
      point,
      channel('ph_loop', { equipmentId: loop.equipmentId, quantity: 'ph', unit: 'pH' }),
    );
    const replacement = channel('ph_loop_new', {
      equipmentId: loop.equipmentId,
      quantity: 'ph',
      unit: 'pH',
    });
    let retiring: QueryRunner | undefined;
    whileDescribing = async () => {
      retiring = await openTransaction();
      await retiring.query(
        `UPDATE systems SET "isDeleted" = true, "isActive" = false WHERE id = $1`,
        [loop.systemId],
      );
    };
    const replacing = inTenant(() =>
      new ReplaceParameterChannelHandler(ds().dataSource, directory, auditLog).execute(
        new ReplaceParameterChannelCommand(TENANT, bound.id, replacement, USER),
      ),
    );
    replacing.catch(() => undefined);
    await settle();
    // Had the replace locked the source rows before the point, this close
    // would wait on it while it waits on the point: a deadlock.
    await finish(retiring, (runner) =>
      closeSourcesAtPoints(runner.manager, TENANT, [point], USER, 'all'),
    );
    await expect(replacing).rejects.toMatchObject({ code: 'POINT_RETIRED' });
    await expectNoLiveSourcesAt('systemId', loop.systemId);
  });

  it('closes the sources of a system deactivated through its update', async () => {
    const loop = await seedLoop(ds().dataSource, TENANT, topology, 'RAS-OFF');
    await bind(
      topology.configs.ph,
      { kind: 'system', id: loop.systemId },
      channel('ph_off', { equipmentId: loop.equipmentId, quantity: 'ph', unit: 'pH' }),
    );
    await inTenant(() =>
      new UpdateSystemHandler(ds().dataSource, auditLog, new OutboxPublisher(FarmOutbox)).execute(
        new UpdateSystemCommand({ id: loop.systemId, isActive: false }, TENANT, USER),
      ),
    );
    await expectNoLiveSourcesAt('systemId', loop.systemId);
  });

  it('keeps a unit’s manual plan across deactivation, closing only its channel sources', async () => {
    const loop = await seedLoop(ds().dataSource, TENANT, topology, 'RAS-MAINT');
    const unit = loop.equipmentId;
    await inTenant(() =>
      new CreateParamEquipmentHandler(ds().dataSource).execute(
        new CreateParamEquipmentCommand(
          TENANT,
          { parameterConfigId: topology.configs.temperature, equipmentId: unit },
          USER,
        ),
      ),
    );
    await bind(
      topology.configs.ph,
      { kind: 'equipment', id: unit },
      channel('ph_maint', { equipmentId: unit, quantity: 'ph', unit: 'pH' }),
    );
    const setActive = (isActive: boolean): Promise<unknown> =>
      inTenant(() =>
        new UpdateEquipmentHandler(
          ds().dataSource,
          auditLog,
          new OutboxPublisher(FarmOutbox),
          collaborator<TankEquipmentAdapterService>({}, 'TankEquipmentAdapterService'),
        ).execute(new UpdateEquipmentCommand(unit, { id: unit, isActive }, TENANT, USER)),
      );
    // Maintenance: deactivate, then reactivate.
    await setActive(false);
    await setActive(true);
    const plan = await inTenant(() =>
      new GetUnitMeasurementPlanHandler(ds().dataSource).execute(
        new GetUnitMeasurementPlanQuery(TENANT, unit),
      ),
    );
    expect(plan.planned).toBe(true);
    expect(plan.entries.map((entry) => entry.parameter.id)).toEqual([topology.configs.temperature]);
    await expectNoLiveSourcesAt('equipmentId', unit, 'channel');
  });

  it('accepts a spelling of the same unit despite measurements, and refuses another unit', async () => {
    await ds().dataSource.query(
      `UPDATE "${ds().schema}".water_quality_parameter_configs SET unit = '' WHERE id = $1`,
      [topology.configs.ph],
    );
    const [{ id: alkalinity }] = await ds().dataSource.query(
      `INSERT INTO "${ds().schema}".water_quality_parameter_configs
         ("tenantId", code, name, unit, "effectiveQuantity")
       VALUES ($1, 'alkalinity', 'Alkalinity', 'mg/L CaCO₃', 'alkalinity') RETURNING id`,
      [TENANT],
    );
    await ds().dataSource.query(
      `INSERT INTO "${ds().schema}".water_quality_measurements
         ("tenantId", "measuredAt", source, parameters, "overallStatus", "hasAlarm")
       VALUES ($1, now(), 'manual', '{"ph": 7.2, "alkalinity": 120}'::jsonb, 'optimal', false)`,
      [TENANT],
    );
    const updateUnit = (id: string, unit: string): Promise<unknown> =>
      inTenant(() =>
        new UpdateParameterConfigHandler(ds().dataSource, cache).execute(
          new UpdateParameterConfigCommand(TENANT, id, { unit }, USER),
        ),
      );
    // Prod's old template spellings: '' for pH, 'mg/L CaCO₃' for alkalinity.
    await updateUnit(topology.configs.ph, 'pH');
    await updateUnit(alkalinity, 'mg/L CaCO3');
    await expect(updateUnit(alkalinity, 'mg/L')).rejects.toMatchObject({
      code: 'PARAMETER_HAS_MEASUREMENTS',
    });
  });

  it('deleting a tank closes its sources in the deleting transaction, as history', async () => {
    await deleteTank(topology.tankId);
    const [{ live, closed }] = await ds().dataSource.query(
      `SELECT count(*) FILTER (WHERE "unboundAt" IS NULL)::int AS live,
              count(*) FILTER (WHERE "unboundBy" = $2)::int AS closed
         FROM "${ds().schema}".water_quality_param_equipment WHERE "tankId" = $1`,
      [topology.tankId, USER],
    );
    expect({ live, closed: closed > 0 }).toEqual({ live: 0, closed: true });
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
