/**
 * The many-unit reading costs a fixed number of statements whatever the
 * number of units, and answers each unit exactly as reading it alone does
 * (FARM-MEDIUM-447) — on real PostgreSQL, through the real tenant reads.
 *
 * Every statement the resolver sends is counted where it leaves the process
 * (a TypeORM logger, StatementLog). A site's units come in six arrangements —
 * a tank in a recirculating loop, a tank in no loop, a tank in an open loop,
 * a tank kept as equipment in two loops, water equipment in the loop, a tank
 * in a hatchery loop — each with its own dissolved-oxygen source (a live
 * channel, a person's fresh sample, a sample older than the window, nothing)
 * and its own way to a temperature (its loop's channel, the site's, its own
 * sample, its loop's sample, none). Reading one of each and four of each must
 * cost the same statements, and every answer must equal the one-unit read.
 */
import 'reflect-metadata';

import { withTenantContext } from '@aquaculture/backend-common/context';
import { stub } from '@aquaculture/testing';
import type { SensorChannelDescription, SensorChannelKey } from '@platform/event-contracts';

import { createFixtureAuditLogService } from '../../__tests__/e2e/helpers/farm-tenant-fixture';
import type { AuditLogService } from '../../database/services/audit-log.service';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { BindParameterChannelCommand } from '../commands/bind-parameter-channel.command';
import { ChannelSourcePriority } from '../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { BindParameterChannelHandler } from '../handlers/bind-parameter-channel.handler';
import { ParameterReadingResolver } from '../services/parameter-reading-resolver.service';
import { type MeasurementPoint, representativeLocation } from '../services/parameter-sources';
import type { ParameterReadAsk } from '../services/reading-facts';
import type { ResolvedReading } from '../services/reading-resolution';
import type { SensorChannelDirectory } from '../services/sensor-channel-directory.service';

import {
  bootSourceDatabase,
  shutdownSourceDatabase,
  type SourceDatabase,
} from './helpers/source-database';
import {
  seedEquipmentTank,
  seedLoop,
  seedSourceTopology,
  seedTank,
  type SourceTopology,
} from './helpers/source-topology';
import { StatementLog } from './helpers/statement-log';

jest.setTimeout(240_000);

const TENANT = '6e7f8091-ab1c-4d2e-9f30-4b5c6d7e8f90';
const USER = 'e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4';
const SITE_SENSOR = '8d8d8d8d-8d8d-4d8d-8d8d-8d8d8d8d8d8d';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const COPIES = 4;

/** A statement that reads a table (the transaction and tenant-context framing reads none). */
const readsTable = (sql: string): boolean => /\bFROM\b/i.test(sql);

/** The six arrangements, in the order each copy lists them. */
const ARRANGEMENTS = ['loop', 'loose', 'open', 'shared', 'equipment', 'hatchery'] as const;
type Arrangement = (typeof ARRANGEMENTS)[number];

describe('reading one parameter at many units — statements and answers, real Postgres', () => {
  const log = new StatementLog();
  let database: SourceDatabase | undefined;
  let topology: SourceTopology;
  let auditLog: AuditLogService;
  let oxygen: WaterQualityParameterConfig;
  let temperature: WaterQualityParameterConfig;
  let ph: WaterQualityParameterConfig;
  /** COPIES rows of one point per arrangement. */
  const copies: MeasurementPoint[][] = [];
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
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
  const resolver = (): ParameterReadingResolver =>
    new ParameterReadingResolver(ds().dataSource, directory);
  const askOf = (parameter: WaterQualityParameterConfig): ParameterReadAsk => ({
    parameter,
    unit: parameter.unit,
    maxAgeMs: 24 * HOUR,
  });

  function describedChannel(key: SensorChannelKey): SensorChannelDescription {
    const found = described.get(`${key.sensorId}|${key.channelKey}`);
    if (found === undefined) throw new Error(`undescribed channel ${key.channelKey}`);
    return found;
  }

  function channel(
    sensorId: string,
    channelKey: string,
    facts: Partial<SensorChannelDescription>,
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
      channelId: '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d',
      enabled: true,
      quantity: null,
      quantityFamily: null,
      unit: null,
      calibrationDueAt: null,
      configuredAt: null,
      latestValue: null,
      latestAt: ago(2 * MINUTE),
      latestQuality: 'GOOD',
      ...facts,
    });
    return { sensorId, channelKey };
  }

  async function bind(
    parameterConfigId: string,
    point: MeasurementPoint,
    key: SensorChannelKey,
  ): Promise<void> {
    await withTenantContext(TENANT, () =>
      new BindParameterChannelHandler(ds().dataSource, directory, auditLog).execute(
        new BindParameterChannelCommand(
          TENANT,
          {
            parameterConfigId,
            location: representativeLocation(point),
            channel: key,
            priority: ChannelSourcePriority.PRIMARY,
          },
          USER,
        ),
      ),
    );
  }

  /** A sample taken at a unit or a loop, `msAgo` ago. */
  async function sample(
    point: { tankId?: string; equipmentId?: string; systemId?: string },
    parameters: Record<string, number>,
    msAgo: number,
    source = 'manual',
  ): Promise<void> {
    await ds().dataSource.query(
      `INSERT INTO "${ds().schema}".water_quality_measurements
         ("tenantId", "tankId", "equipmentId", "systemId", "measuredAt", source, parameters,
          "overallStatus", "hasAlarm")
       VALUES ($1, $2, $3, $4, now() - make_interval(secs => $5), $6, $7::jsonb, 'optimal', false)`,
      [
        TENANT,
        point.tankId ?? null,
        point.equipmentId ?? null,
        point.systemId ?? null,
        msAgo / 1000,
        source,
        JSON.stringify(parameters),
      ],
    );
  }

  async function seedWaterEquipment(code: string, systemId: string): Promise<string> {
    const manager = ds().dataSource.manager;
    return withTenantContext(TENANT, async () => {
      const equipment = await manager.save(
        manager.create(Equipment, {
          tenantId: TENANT,
          equipmentTypeId: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
          name: code,
          code,
          departmentId: topology.departmentId,
          isTank: false,
          isActive: true,
          isDeleted: false,
        }),
      );
      await manager.save(
        manager.create(EquipmentSystem, { tenantId: TENANT, equipmentId: equipment.id, systemId }),
      );
      return equipment.id;
    });
  }

  const setLoopType = (systemId: string, type: string): Promise<unknown> =>
    ds().dataSource.query(`UPDATE "${ds().schema}".systems SET type = $2 WHERE id = $1`, [
      systemId,
      type,
    ]);

  /** One arrangement's unit, with its oxygen source and its own temperature facts. */
  async function seedUnit(
    arrangement: Arrangement,
    copy: number,
    loops: { open: string; hatchery: string },
  ): Promise<MeasurementPoint> {
    const code = `${arrangement}-${copy}`;
    switch (arrangement) {
      case 'loop': {
        // In the recirculating loop; a live oxygen channel on the tank.
        const id = await seedTank(ds().dataSource, TENANT, topology, code, USER, topology.systemId);
        await bind(
          oxygen.id,
          { kind: 'tank', id },
          channel(topology.sensorId, `do-${code}`, {
            tankId: id,
            quantity: 'dissolvedOxygen',
            unit: 'mg/L',
            latestValue: 6 + copy / 10,
          }),
        );
        return { kind: 'tank', id };
      }
      case 'loose': {
        // In no loop: the site's water. A person's fresh sample (oxygen and
        // temperature), and a newer machine row that is never the person's.
        const id = await seedTank(ds().dataSource, TENANT, topology, code, USER);
        await sample({ tankId: id }, { dissolved_oxygen: 5 + copy / 10, temperature: 11 }, HOUR);
        await sample(
          { tankId: id },
          { dissolved_oxygen: 1, temperature: 30 },
          MINUTE,
          'sensor_auto',
        );
        return { kind: 'tank', id };
      }
      case 'open': {
        // In an open loop: its loop's temperature; an oxygen sample older than the window.
        const id = await seedTank(ds().dataSource, TENANT, topology, code, USER, loops.open);
        await sample({ tankId: id }, { dissolved_oxygen: 4 }, 30 * HOUR);
        return { kind: 'tank', id };
      }
      case 'shared': {
        // A tank kept as equipment in two loops: whose water it holds is unknown.
        const id = await seedEquipmentTank(ds().dataSource, TENANT, topology, code, [
          topology.systemId,
          loops.open,
        ]);
        return { kind: 'tank', id };
      }
      case 'equipment': {
        // Water equipment in the loop, sampled as equipment; a live oxygen channel on it.
        const id = await seedWaterEquipment(code, topology.systemId);
        await bind(
          oxygen.id,
          { kind: 'equipment', id },
          channel(topology.sensorId, `do-${code}`, {
            equipmentId: id,
            quantity: 'dissolvedOxygen',
            unit: 'mg/L',
            latestValue: 7,
          }),
        );
        await sample({ equipmentId: id }, { dissolved_oxygen: 3 }, 2 * HOUR);
        return { kind: 'equipment', id };
      }
      case 'hatchery': {
        // A hatchery loop holds its own water; its temperature is the loop's sample.
        const id = await seedTank(ds().dataSource, TENANT, topology, code, USER, loops.hatchery);
        await sample({ tankId: id }, { dissolved_oxygen: 8 }, 3 * HOUR);
        return { kind: 'tank', id };
      }
    }
  }

  beforeAll(async () => {
    database = await bootSourceDatabase(TENANT, { logger: log });
    topology = await seedSourceTopology(database.dataSource, database.schema, TENANT, USER);
    auditLog = createFixtureAuditLogService(database.dataSource);
    const manager = database.dataSource.manager;
    await withTenantContext(TENANT, async () => {
      await manager.save(
        manager.create(WaterQualityParameterConfig, {
          tenantId: TENANT,
          code: 'dissolved_oxygen',
          name: 'dissolved oxygen',
          unit: 'mg/L',
        }),
      );
      const configs = await manager.find(WaterQualityParameterConfig, {
        where: { tenantId: TENANT },
      });
      const byCode = (code: string): WaterQualityParameterConfig => {
        const config = configs.find((candidate) => candidate.code === code);
        if (config === undefined) throw new Error(`no ${code} config`);
        return config;
      };
      oxygen = byCode('dissolved_oxygen');
      temperature = byCode('temperature');
      ph = byCode('ph');
    });

    const open = await seedLoop(database.dataSource, TENANT, topology, 'OPEN-1');
    await setLoopType(open.systemId, 'flow_through');
    const hatchery = await seedLoop(database.dataSource, TENANT, topology, 'HATCH-1');
    await setLoopType(hatchery.systemId, 'hatchery');
    // Temperature: the recirculating loop's probe (on its biofilter), the open
    // loop's (on its filter), the site's intake, and the hatchery loop's sample.
    await bind(
      temperature.id,
      { kind: 'system', id: topology.systemId },
      channel(topology.sensorId, 'loop-temp', {
        equipmentId: topology.biofilterId,
        quantity: 'temperature',
        unit: '°C',
        latestValue: 15,
      }),
    );
    await bind(
      temperature.id,
      { kind: 'system', id: open.systemId },
      channel(topology.sensorId, 'open-temp', {
        equipmentId: open.equipmentId,
        quantity: 'temperature',
        unit: '°C',
        latestValue: 9,
      }),
    );
    await bind(
      temperature.id,
      { kind: 'site', id: topology.siteId },
      channel(SITE_SENSOR, 'intake-temp', { quantity: 'temperature', unit: '°C', latestValue: 8 }),
    );
    await sample({ systemId: hatchery.systemId }, { temperature: 12 }, HOUR);

    for (let copy = 0; copy < COPIES; copy += 1) {
      const row: MeasurementPoint[] = [];
      for (const arrangement of ARRANGEMENTS) {
        row.push(
          await seedUnit(arrangement, copy, { open: open.systemId, hatchery: hatchery.systemId }),
        );
      }
      copies.push(row);
    }
  });

  afterAll(async () => {
    await shutdownSourceDatabase(database);
  });

  const firstCopy = (): MeasurementPoint[] => copies[0] ?? [];
  const everyCopy = (): MeasurementPoint[] => copies.flat();

  /** The statements one many-unit read sends, with its answers. */
  async function readAcross(
    points: readonly MeasurementPoint[],
    parameter: WaterQualityParameterConfig,
    asOf: Date,
  ): Promise<{ readings: ResolvedReading[]; statements: string[] }> {
    const { result, statements } = await log.record(() =>
      resolver().resolveAcross(TENANT, points.map(representativeLocation), askOf(parameter), asOf),
    );
    return { readings: result, statements };
  }

  it.each([
    ['dissolved oxygen (read at the unit only)', (): WaterQualityParameterConfig => oxygen],
    [
      'temperature (inherited from the loop or the site)',
      (): WaterQualityParameterConfig => temperature,
    ],
  ])('costs the same statements for %s at 6 units as at 24', async (_name, parameterOf) => {
    const asOf = new Date();
    const one = await readAcross(firstCopy(), parameterOf(), asOf);
    const four = await readAcross(everyCopy(), parameterOf(), asOf);
    expect(four.readings).toHaveLength(ARRANGEMENTS.length * COPIES);
    expect({ units: 24, statements: four.statements.length }).toEqual({
      units: 24,
      statements: one.statements.length,
    });
    // Two tenant reads — the facts, then the described sensors' placement —
    // each framed by the same transaction and tenant-context statements. The
    // statements that read tables: at most four for the inheritance chains
    // (the units' tanks, loop links and sites, then the loops), one for the
    // channel sources, one for the manual samples, three for the placement.
    expect(four.statements.filter(readsTable).length).toBeLessThanOrEqual(9);
  });

  it.each([
    ['dissolved oxygen', (): WaterQualityParameterConfig => oxygen],
    ['temperature', (): WaterQualityParameterConfig => temperature],
  ])(
    'answers every unit of a many-unit %s read as reading it alone does',
    async (_name, parameterOf) => {
      const asOf = new Date();
      const points = everyCopy();
      const { readings } = await readAcross(points, parameterOf(), asOf);
      for (const [index, point] of points.entries()) {
        const alone = await resolver().resolveOne(
          TENANT,
          representativeLocation(point),
          askOf(parameterOf()),
          asOf,
        );
        expect({ point, reading: readings[index] }).toEqual({ point, reading: alone });
      }
    },
  );

  it('reads each arrangement from its own source', async () => {
    const asOf = new Date();
    const row = firstCopy();
    const summary = (reading: ResolvedReading | undefined): unknown =>
      reading === undefined
        ? undefined
        : {
            value: reading.value,
            kind: reading.chosen === null ? null : reading.chosen.kind,
            from: reading.chosen === null ? null : reading.chosen.point.kind,
            unresolved: reading.unresolved,
          };
    const oxygenRead = (await readAcross(row, oxygen, asOf)).readings.map(summary);
    const temperatureRead = (await readAcross(row, temperature, asOf)).readings.map(summary);
    expect(
      Object.fromEntries(ARRANGEMENTS.map((name, index) => [name, oxygenRead[index]])),
    ).toEqual({
      loop: { value: 6, kind: 'CHANNEL_PRIMARY', from: 'tank', unresolved: null },
      loose: { value: 5, kind: 'MANUAL', from: 'tank', unresolved: null },
      open: { value: null, kind: null, from: null, unresolved: 'NO_USABLE_SOURCE' },
      shared: { value: null, kind: null, from: null, unresolved: 'NO_SOURCE' },
      equipment: { value: 7, kind: 'CHANNEL_PRIMARY', from: 'equipment', unresolved: null },
      hatchery: { value: 8, kind: 'MANUAL', from: 'tank', unresolved: null },
    });
    expect(
      Object.fromEntries(ARRANGEMENTS.map((name, index) => [name, temperatureRead[index]])),
    ).toEqual({
      loop: { value: 15, kind: 'CHANNEL_PRIMARY', from: 'system', unresolved: null },
      loose: { value: 11, kind: 'MANUAL', from: 'tank', unresolved: null },
      open: { value: 9, kind: 'CHANNEL_PRIMARY', from: 'system', unresolved: null },
      shared: { value: null, kind: null, from: null, unresolved: 'NO_SOURCE' },
      equipment: { value: 15, kind: 'CHANNEL_PRIMARY', from: 'system', unresolved: null },
      hatchery: { value: 12, kind: 'MANUAL', from: 'system', unresolved: null },
    });
  });

  it('answers several parameters at one point as each read alone, in the statements of one', async () => {
    const asOf = new Date();
    const asks = [askOf(temperature), askOf(oxygen), askOf(ph)];
    for (const point of firstCopy()) {
      const location = representativeLocation(point);
      const { result, statements } = await log.record(() =>
        resolver().resolveAt(TENANT, location, asks, asOf),
      );
      const single = await log.record(() =>
        resolver().resolveOne(TENANT, location, askOf(temperature), asOf),
      );
      expect(statements.length).toBeLessThanOrEqual(single.statements.length);
      for (const { ask, reading } of result) {
        expect({ point, code: ask.parameter.code, reading }).toEqual({
          point,
          code: ask.parameter.code,
          reading: await resolver().resolveOne(TENANT, location, ask, asOf),
        });
      }
    }
  });
});
