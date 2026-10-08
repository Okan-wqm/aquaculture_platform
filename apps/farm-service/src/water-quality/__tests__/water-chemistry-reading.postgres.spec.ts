/**
 * Reading a parameter's value at a point, and a water-chemistry calculation's
 * inputs, on real PostgreSQL (plan rev2 PR-4: D2, D3, D12, FARM-MEDIUM-378).
 *
 * Sources are bound through the real bind command and samples written to the
 * tenant schema shaped like production's (helpers/source-database.ts); the
 * resolver reads them through the real tenant reads. Only the sensor service
 * is replaced: a directory that answers from a table of channel descriptions,
 * as `request.sensor.describeChannels` would — moving a sensor is changing
 * its row there, as re-registering it would.
 */
import 'reflect-metadata';

import { withTenantContext } from '@aquaculture/backend-common/context';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { stub } from '@aquaculture/testing';
import { PARAMETER_SOURCE_ERROR } from '@aquaculture/shared-contracts';
import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { SensorChannelDescription, SensorChannelKey } from '@platform/event-contracts';

import { createFixtureAuditLogService } from '../../__tests__/e2e/helpers/farm-tenant-fixture';
import { ParameterSourceError } from '../../common/errors/farm-errors';
import type { AuditLogService } from '../../database/services/audit-log.service';
import { BindParameterChannelCommand } from '../commands/bind-parameter-channel.command';
import type { WaterChemistryInputSet } from '../data/water-chemistry-input-sets';
import type {
  ParameterReading,
  WaterChemistryInputsResult,
} from '../dto/water-chemistry-reading.response';
import {
  ChannelSourcePriority,
  MeasurementPosition,
} from '../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { BindParameterChannelHandler } from '../handlers/bind-parameter-channel.handler';
import type { SourceReader } from '../queries/parameter-source-queries';
import {
  ResolveParameterValueQuery,
  ResolveWaterChemistryInputsQuery,
} from '../queries/reading-queries';
import {
  ResolveParameterValueHandler,
  ResolveWaterChemistryInputsHandler,
} from '../query-handlers/reading-query.handlers';
import { ParameterReadingResolver } from '../services/parameter-reading-resolver.service';
import type { MeasurementPoint } from '../services/parameter-sources';
import type { SensorChannelDirectory } from '../services/sensor-channel-directory.service';

import {
  bootSourceDatabase,
  shutdownSourceDatabase,
  type SourceDatabase,
} from './helpers/source-database';
import { seedSourceTopology, seedTank, type SourceTopology } from './helpers/source-topology';

jest.setTimeout(180_000);

const TENANT = '5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const USER = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
const OTHER_TANK = '7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e';
const MOVED_SENSOR = '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b';
const SITE_SENSOR = '8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c8c';
const MANAGER: SourceReader = { sub: USER, roles: [Role.MODULE_MANAGER] };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('water-chemistry reading — real Postgres', () => {
  let database: SourceDatabase | undefined;
  let topology: SourceTopology;
  let auditLog: AuditLogService;
  const configs: Record<'alkalinity' | 'salinity' | 'calcium' | 'h2s', string> = {
    alkalinity: '',
    salinity: '',
    calcium: '',
    h2s: '',
  };
  const described = new Map<string, SensorChannelDescription>();
  const directory = stub<SensorChannelDirectory>({
    describe: async (_tenantId: string, keys: readonly SensorChannelKey[]) =>
      keys.map((key) => describedChannel(key)),
    describeOne: async (_tenantId: string, key: SensorChannelKey) => describedChannel(key),
  });

  const ds = (): SourceDatabase => {
    if (database === undefined) throw new Error('database not booted');
    return database;
  };
  const inTenant = <T>(work: () => Promise<T>): Promise<T> => withTenantContext(TENANT, work);
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

  function describedChannel(key: SensorChannelKey): SensorChannelDescription {
    const found = described.get(`${key.sensorId}|${key.channelKey}`);
    if (found === undefined) throw new Error(`undescribed channel ${key.channelKey}`);
    return found;
  }

  /** A live channel reporting `quantity` in `unit`, standing where `facts` says. */
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
      latestValue: null,
      latestAt: ago(5 * MINUTE),
      latestQuality: 'GOOD',
      ...facts,
    });
    return { sensorId, channelKey };
  }

  const bind = async (
    parameterConfigId: string,
    point: MeasurementPoint,
    key: SensorChannelKey,
    priority = ChannelSourcePriority.PRIMARY,
  ): Promise<string> => {
    const source = await inTenant(() =>
      new BindParameterChannelHandler(ds().dataSource, directory, auditLog).execute(
        new BindParameterChannelCommand(
          TENANT,
          {
            parameterConfigId,
            location: { point, position: MeasurementPosition.REPRESENTATIVE, depthM: null },
            channel: key,
            priority,
          },
          USER,
        ),
      ),
    );
    return source.id;
  };

  /** A sample taken at a unit (tankId) or a loop (systemId), `msAgo` ago. */
  async function sample(
    point: { tankId?: string; systemId?: string },
    parameters: Record<string, number | string>,
    msAgo: number,
    source = 'manual',
  ): Promise<string> {
    const [{ id }] = await ds().dataSource.query(
      `INSERT INTO "${ds().schema}".water_quality_measurements
         ("tenantId", "tankId", "systemId", "measuredAt", source, parameters, "overallStatus",
          "hasAlarm")
       VALUES ($1, $2, $3, now() - make_interval(secs => $4), $5, $6::jsonb, 'optimal', false)
       RETURNING id`,
      [
        TENANT,
        point.tankId ?? null,
        point.systemId ?? null,
        msAgo / 1000,
        source,
        JSON.stringify(parameters),
      ],
    );
    return id;
  }

  const resolve = (
    parameterConfigId: string,
    point: MeasurementPoint,
    caller: SourceReader = MANAGER,
  ): Promise<ParameterReading> =>
    inTenant(() =>
      new ResolveParameterValueHandler(
        ds().dataSource,
        new SiteAuthorizationService(),
        new ParameterReadingResolver(ds().dataSource, directory),
      ).execute(
        new ResolveParameterValueQuery(
          TENANT,
          parameterConfigId,
          { point, position: MeasurementPosition.REPRESENTATIVE, depthM: null },
          null,
          caller,
        ),
      ),
    );

  const inputsAt = (
    point: MeasurementPoint,
    set: WaterChemistryInputSet,
    caller: SourceReader = MANAGER,
  ): Promise<WaterChemistryInputsResult> =>
    inTenant(() =>
      new ResolveWaterChemistryInputsHandler(
        ds().dataSource,
        new SiteAuthorizationService(),
        new ParameterReadingResolver(ds().dataSource, directory),
      ).execute(new ResolveWaterChemistryInputsQuery(TENANT, point, set, caller)),
    );

  const byInput = (result: WaterChemistryInputsResult): Record<string, unknown> =>
    Object.fromEntries(
      result.inputs.map((input) => [
        input.engineInput,
        {
          problems: input.problems,
          value: input.reading === null ? null : input.reading.value,
          from: input.reading === null ? null : input.reading.inheritedFrom,
        },
      ]),
    );

  const tankPoint = (): MeasurementPoint => ({ kind: 'tank', id: topology.tankId });
  const systemPoint = (): MeasurementPoint => ({ kind: 'system', id: topology.systemId });

  beforeAll(async () => {
    database = await bootSourceDatabase(TENANT);
    topology = await seedSourceTopology(database.dataSource, database.schema, TENANT, USER);
    auditLog = createFixtureAuditLogService(database.dataSource);
    const manager = database.dataSource.manager;
    await withTenantContext(TENANT, async () => {
      for (const [code, unit] of [
        ['alkalinity', 'mg/L CaCO3'],
        ['salinity', 'ppt'],
        ['calcium', 'mg/L'],
        ['h2s', 'µg/L'],
      ] as const) {
        const saved = await manager.save(
          manager.create(WaterQualityParameterConfig, { tenantId: TENANT, code, name: code, unit }),
        );
        configs[code] = saved.id;
      }
    });
  });

  afterAll(async () => {
    await shutdownSourceDatabase(database);
  });

  it('inherits a loop-homogeneous quantity from the system, converted into the parameter’s unit', async () => {
    // A temperature probe on the biofilter: farm puts the biofilter in the loop.
    await bind(
      topology.configs.temperature,
      systemPoint(),
      channel('loop_temp', {
        equipmentId: topology.biofilterId,
        quantity: 'temperature',
        unit: '°F',
        latestValue: 59,
        latestAt: ago(10 * MINUTE),
      }),
    );
    const reading = await resolve(topology.configs.temperature, tankPoint());
    expect(reading.value).toBeCloseTo(15, 6);
    expect(reading).toMatchObject({
      unit: '°C',
      quantity: 'temperature',
      sourceKind: 'CHANNEL_PRIMARY',
      inheritedFrom: 'system',
      resolvedAt: { kind: 'system', id: topology.systemId },
      channelKey: 'loop_temp',
      quality: 'GOOD',
      unresolved: null,
    });
    expect(reading.ageSeconds).toBeGreaterThanOrEqual(600);
    expect(reading.ageSeconds).toBeLessThan(900);
  });

  it('never inherits pH; a person’s sample at the tank answers, a machine row never does', async () => {
    await bind(
      topology.configs.ph,
      systemPoint(),
      channel('loop_ph', {
        equipmentId: topology.biofilterId,
        quantity: 'ph',
        unit: 'pH',
        latestValue: 7.6,
      }),
    );
    const none = await resolve(topology.configs.ph, tankPoint());
    expect(none).toMatchObject({ value: null, unresolved: 'NO_SOURCE', skipped: [] });

    const manual = await sample({ tankId: topology.tankId }, { ph: 7.2 }, HOUR);
    await sample({ tankId: topology.tankId }, { ph: 6.0 }, MINUTE, 'sensor_auto');
    const reading = await resolve(topology.configs.ph, tankPoint());
    expect(reading).toMatchObject({
      value: 7.2,
      sourceKind: 'MANUAL',
      measurementId: manual,
      inheritedFrom: null,
      quality: null,
    });
  });

  it('re-derives placement at read time: a primary whose sensor moved away is skipped', async () => {
    const primary = channel(
      'tank_ph',
      { tankId: topology.tankId, quantity: 'ph', unit: 'pH', latestValue: 7.3 },
      MOVED_SENSOR,
    );
    const primaryId = await bind(topology.configs.ph, tankPoint(), primary);
    await bind(
      topology.configs.ph,
      tankPoint(),
      channel('tank_ph_2', {
        tankId: topology.tankId,
        quantity: 'ph',
        unit: 'pH',
        latestValue: 7.4,
      }),
      ChannelSourcePriority.BACKUP,
    );
    expect(await resolve(topology.configs.ph, tankPoint())).toMatchObject({
      value: 7.3,
      sourceKind: 'CHANNEL_PRIMARY',
    });

    // The sensor was re-registered at another tank; its binding still names this one.
    channel(
      'tank_ph',
      { tankId: OTHER_TANK, quantity: 'ph', unit: 'pH', latestValue: 7.3 },
      MOVED_SENSOR,
    );
    const reading = await resolve(topology.configs.ph, tankPoint());
    expect(reading).toMatchObject({ value: 7.4, sourceKind: 'CHANNEL_BACKUP' });
    expect(reading.skipped).toEqual([
      expect.objectContaining({
        sourceKind: 'CHANNEL_PRIMARY',
        sourceId: primaryId,
        bindingProblems: ['NOT_AT_POINT'],
        readingProblems: [],
      }),
    ]);
  });

  it('resolves the toxicity inputs at a tank: READY, with temperature and salinity inherited', async () => {
    // Salinity from a probe that stands at the site only (the intake), inherited by every loop.
    await bind(
      configs.salinity,
      { kind: 'site', id: topology.siteId },
      channel('salinity', { quantity: 'salinity', unit: 'psu', latestValue: 33.5 }, SITE_SENSOR),
    );
    await sample({ tankId: topology.tankId }, { total_ammonia_nitrogen: 0.8 }, HOUR);
    await bind(
      configs.h2s,
      tankPoint(),
      channel('h2s', {
        tankId: topology.tankId,
        quantity: 'h2s',
        unit: 'mg/L',
        latestValue: 0.002,
      }),
    );
    const result = await inputsAt(tankPoint(), 'TOXICITY');
    expect(result.verdict).toBe('READY');
    expect(result.problems).toEqual([]);
    expect(byInput(result)).toEqual({
      pH: { problems: [], value: 7.4, from: null },
      tempC: { problems: [], value: expect.closeTo(15, 6), from: 'system' },
      salinity: { problems: [], value: 33.5, from: 'site' },
      tan: { problems: [], value: 0.8, from: null },
      h2sUgL: { problems: [], value: expect.closeTo(2, 6), from: null },
    });
    expect(result.inputs.find((input) => input.engineInput === 'h2sUgL')).toMatchObject({
      unit: 'µg/L',
      coherenceWindow: 'SHORT',
      windowSeconds: 4 * 3600,
    });
  });

  it('is INCOMPLETE at a tank whose TAN sample is older than its window, saying why', async () => {
    const tank = await seedTank(
      ds().dataSource,
      TENANT,
      topology,
      'WC-TANK-2',
      USER,
      topology.systemId,
    );
    await sample({ tankId: tank }, { total_ammonia_nitrogen: 0.5 }, 6 * HOUR);
    const result = await inputsAt({ kind: 'tank', id: tank }, 'TOXICITY');
    expect(result.verdict).toBe('INCOMPLETE');
    expect(result.problems).toEqual(['INPUTS_INCOMPLETE']);
    expect(byInput(result)).toEqual({
      pH: { problems: ['NO_VALUE'], value: null, from: null },
      tempC: { problems: [], value: expect.closeTo(15, 6), from: 'system' },
      salinity: { problems: [], value: 33.5, from: 'site' },
      tan: { problems: ['NO_VALUE'], value: null, from: null },
      h2sUgL: { problems: ['NO_VALUE'], value: null, from: null },
    });
    const tan = result.inputs.find((input) => input.engineInput === 'tan');
    expect(tan?.reading?.skipped).toEqual([
      expect.objectContaining({ sourceKind: 'MANUAL', readingProblems: ['OLDER_THAN_WINDOW'] }),
    ]);
  });

  it('resolves the dosing inputs at a system, and refuses a loop it cannot dose', async () => {
    await sample({ systemId: topology.systemId }, { alkalinity: 150 }, 2 * HOUR);
    await sample({ systemId: topology.systemId }, { calcium: 400 }, 30 * HOUR);
    const setLoop = (type: string, volume: number | null): Promise<unknown> =>
      ds().dataSource.query(
        `UPDATE "${ds().schema}".systems SET type = $2, "totalVolumeM3" = $3 WHERE id = $1`,
        [topology.systemId, type, volume],
      );

    await setLoop('ras', null);
    const unknownVolume = await inputsAt(systemPoint(), 'DOSING');
    expect(unknownVolume).toMatchObject({ verdict: 'REFUSED', problems: ['VOLUME_MISSING'] });
    expect(byInput(unknownVolume)).toEqual({
      pH: { problems: [], value: 7.6, from: null },
      alkalinityMg: { problems: [], value: 150, from: null },
      tempC: { problems: [], value: expect.closeTo(15, 6), from: null },
      salinity: { problems: [], value: 33.5, from: 'site' },
      caMgL: { problems: [], value: 400, from: null },
    });

    // Two tanks of π·2.5²·2 m³ each hold ≈ 78.5 m³.
    await setLoop('ras', 30);
    const small = await inputsAt(systemPoint(), 'DOSING');
    expect(small).toMatchObject({ verdict: 'REFUSED', problems: ['VOLUME_BELOW_TANK_WATER'] });
    expect(small.tankWaterM3).toBeCloseTo(78.54, 1);

    await setLoop('ras', 120);
    expect(await inputsAt(systemPoint(), 'DOSING')).toMatchObject({
      verdict: 'READY',
      problems: [],
      systemType: 'ras',
      volumeM3: 120,
    });

    await setLoop('flow_through', 120);
    expect(await inputsAt(systemPoint(), 'DOSING')).toMatchObject({
      verdict: 'REFUSED',
      problems: ['SYSTEM_NOT_RECIRCULATING'],
    });
    await setLoop('ras', 120);
  });

  it('fails closed with SENSOR_DIRECTORY_UNAVAILABLE when the sensor service cannot describe', async () => {
    const down = stub<SensorChannelDirectory>({
      describe: async () => {
        throw new ParameterSourceError(
          PARAMETER_SOURCE_ERROR.SENSOR_DIRECTORY_UNAVAILABLE,
          HttpStatus.SERVICE_UNAVAILABLE,
          'The sensor service cannot describe channels right now',
        );
      },
    });
    const read = (): Promise<ParameterReading> =>
      inTenant(() =>
        new ResolveParameterValueHandler(
          ds().dataSource,
          new SiteAuthorizationService(),
          new ParameterReadingResolver(ds().dataSource, down),
        ).execute(
          new ResolveParameterValueQuery(
            TENANT,
            topology.configs.temperature,
            { point: tankPoint(), position: MeasurementPosition.REPRESENTATIVE, depthM: null },
            null,
            MANAGER,
          ),
        ),
      );
    // A bound channel exists (inherited from the loop): no value is guessed without it.
    await expect(read()).rejects.toMatchObject({
      code: PARAMETER_SOURCE_ERROR.SENSOR_DIRECTORY_UNAVAILABLE,
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });

  it('reads a set only at its kind of point, an active parameter only, and a MODULE_USER only at an assigned site', async () => {
    await expect(inputsAt(tankPoint(), 'DOSING')).rejects.toBeInstanceOf(BadRequestException);
    await expect(inputsAt(systemPoint(), 'TOXICITY')).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      resolve(topology.configs.ammonia, { kind: 'tank', id: OTHER_TANK }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      resolve('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', tankPoint()),
    ).rejects.toBeInstanceOf(NotFoundException);

    const elsewhere: SourceReader = {
      sub: USER,
      roles: [Role.MODULE_USER],
      assignedSiteIds: ['1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a'],
    };
    await expect(resolve(topology.configs.ph, tankPoint(), elsewhere)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(inputsAt(systemPoint(), 'DOSING', elsewhere)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const here: SourceReader = { ...elsewhere, assignedSiteIds: [topology.siteId] };
    expect(await resolve(topology.configs.ph, tankPoint(), here)).toMatchObject({ value: 7.4 });
  });
});
