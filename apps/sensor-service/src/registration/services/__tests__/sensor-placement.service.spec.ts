const runInTenantTransaction = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual<typeof import('@aquaculture/backend-common/database')>(
    '@aquaculture/backend-common/database',
  ),
  runInTenantTransaction: (...args: unknown[]): unknown => runInTenantTransaction(...args),
}));

import type { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { SENSOR_PLACEMENT_ERROR } from '@aquaculture/shared-contracts';
import { collaborator } from '@aquaculture/testing';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import type { NatsRequestReply } from '@platform/event-bus';
import { FARM_DEVICE_PLACEMENT_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { OutboxPublisher } from '@platform/outbox';
import type { DataSource, EntityManager } from 'typeorm';

import { SensorProtocol } from '../../../database/entities/sensor-protocol.entity';
import { Sensor } from '../../../database/entities/sensor.entity';
import {
  placementRequestOf,
  SensorPlacementService,
  UNPLACED,
  type PlacementRequest,
} from '../sensor-placement.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const DEPARTMENT = '33333333-3333-4333-8333-333333333333';
const SYSTEM = '44444444-4444-4444-8444-444444444444';
const UNIT = '55555555-5555-4555-8555-555555555555';

const AT_TANK: PlacementRequest = {
  siteId: SITE,
  departmentId: DEPARTMENT,
  systemId: SYSTEM,
  unitId: UNIT,
};

function sensorRow(fields: Partial<Sensor>): Sensor {
  return Object.assign(new Sensor(), {
    id: 'sensor-1',
    tenantId: TENANT,
    isParentDevice: false,
    parentId: undefined,
    protocolId: 'protocol-1',
    siteId: SITE,
    departmentId: DEPARTMENT,
    systemId: null,
    tankId: null,
    equipmentId: null,
    farmId: null,
    pondId: null,
    ...fields,
  });
}

/** The domain code an HttpException carries for the client (SENSOR_PLACEMENT_ERROR). */
function codeOf(error: unknown): unknown {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined;
}

describe('placementRequestOf', () => {
  it('names no place when the input names none', () => {
    expect(placementRequestOf({})).toBeNull();
  });

  it('passes the unit on as named: farm, not the caller, says whether it is a tank', () => {
    expect(placementRequestOf({ siteId: SITE, departmentId: DEPARTMENT, unitId: UNIT })).toEqual({
      siteId: SITE,
      departmentId: DEPARTMENT,
      systemId: null,
      unitId: UNIT,
    });
  });

  it('refuses a level below the site without the site, and a system or unit without its department', () => {
    for (const named of [
      { unitId: UNIT },
      { departmentId: DEPARTMENT },
      { siteId: SITE, unitId: UNIT },
      { siteId: SITE, systemId: SYSTEM },
    ]) {
      let thrown: unknown;
      try {
        placementRequestOf(named);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
      expect(codeOf(thrown)).toBe(SENSOR_PLACEMENT_ERROR.INCOMPLETE);
    }
  });
});

describe('SensorPlacementService', () => {
  const requestTyped = jest.fn();
  const execute = jest.fn();
  const enqueue = jest.fn();
  const findOne = jest.fn();
  const findOneOrFail = jest.fn();
  const find = jest.fn();
  const query = jest.fn();
  const manager = collaborator<EntityManager>(
    { findOne, findOneOrFail, find, query },
    'EntityManager',
  );
  let service: SensorPlacementService;

  /** The locked row the move reads, and the protocol row its event names. */
  function stands(sensor: Sensor): void {
    findOne.mockImplementation(async (entity: unknown) =>
      entity === SensorProtocol ? { id: 'protocol-1', code: 'MQTT' } : sensor,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    execute.mockImplementation(({ fn }: { fn: () => Promise<unknown> }) => fn());
    runInTenantTransaction.mockImplementation(
      (
        _ds: unknown,
        _schema: unknown,
        _tenant: unknown,
        work: (qr: { manager: EntityManager }) => unknown,
      ) => work({ manager }),
    );
    enqueue.mockResolvedValue(undefined);
    query.mockResolvedValue([]);
    findOneOrFail.mockImplementation(async () => sensorRow({ systemId: SYSTEM, tankId: UNIT }));
    service = new SensorPlacementService(
      collaborator<DataSource>({}, 'DataSource'),
      collaborator<NatsRequestReply>({ requestTyped }, 'NatsRequestReply'),
      collaborator<CircuitBreakerService>({ execute }, 'CircuitBreakerService'),
      collaborator<OutboxPublisher>({ enqueue }, 'OutboxPublisher'),
    );
  });

  describe('resolve', () => {
    it('stores no placement without asking farm when none is named', async () => {
      await expect(service.resolve(TENANT, null)).resolves.toEqual(UNPLACED);
      expect(requestTyped).not.toHaveBeenCalled();
    });

    it('asks farm on the shared subject and stores the unit as farm classifies it', async () => {
      requestTyped.mockResolvedValueOnce({ placeable: true, unitKind: 'TANK' });
      await expect(service.resolve(TENANT, AT_TANK)).resolves.toMatchObject({
        siteId: SITE,
        departmentId: DEPARTMENT,
        systemId: SYSTEM,
        tankId: UNIT,
        equipmentId: null,
        placedAt: expect.any(Date),
      });
      expect(requestTyped).toHaveBeenCalledWith(
        FARM_DEVICE_PLACEMENT_QUERY_SUBJECTS.RESOLVE,
        { tenantId: TENANT, ...AT_TANK },
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );

      requestTyped.mockResolvedValueOnce({ placeable: true, unitKind: 'EQUIPMENT' });
      await expect(service.resolve(TENANT, AT_TANK)).resolves.toMatchObject({
        tankId: null,
        equipmentId: UNIT,
      });
    });

    it('refuses with the level farm refused, as a code the UI can word', async () => {
      requestTyped.mockResolvedValueOnce({ placeable: false, refusedAt: 'UNIT' });
      const refused = await service.resolve(TENANT, AT_TANK).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(BadRequestException);
      expect(codeOf(refused)).toBe(SENSOR_PLACEMENT_ERROR.REFUSED_UNIT);
    });

    it('fails closed when farm cannot answer or answers outside the contract', async () => {
      requestTyped.mockRejectedValueOnce(new Error('timeout'));
      expect(codeOf(await service.resolve(TENANT, AT_TANK).catch((e: unknown) => e))).toBe(
        SENSOR_PLACEMENT_ERROR.UNAVAILABLE,
      );
      requestTyped.mockResolvedValueOnce({ placeable: true });
      expect(codeOf(await service.resolve(TENANT, AT_TANK).catch((e: unknown) => e))).toBe(
        SENSOR_PLACEMENT_ERROR.UNAVAILABLE,
      );
    });
  });

  describe('relocate', () => {
    beforeEach(() => {
      requestTyped.mockResolvedValue({ placeable: true, unitKind: 'TANK' });
    });

    it('checks the place with farm before it opens a transaction', async () => {
      requestTyped.mockResolvedValueOnce({ placeable: false, refusedAt: 'SITE' });
      await expect(
        service.relocate(TENANT, 'sensor-1', AT_TANK, 'operator-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runInTenantTransaction).not.toHaveBeenCalled();
    });

    it('refuses a sensor that is not the tenant’s, reading it under the row lock', async () => {
      findOne.mockResolvedValueOnce(null);
      await expect(
        service.relocate(TENANT, 'sensor-1', AT_TANK, 'operator-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(runInTenantTransaction).toHaveBeenCalledWith(
        expect.anything(),
        'sensor',
        TENANT,
        expect.any(Function),
      );
      findOne.mockResolvedValueOnce(null);
      await expect(
        service.relocate(TENANT, 'sensor-1', AT_TANK, 'operator-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(findOne).toHaveBeenCalledWith(Sensor, {
        where: { id: 'sensor-1', tenantId: TENANT },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('never moves a child sensor alone: it stands where its parent device stands', async () => {
      stands(sensorRow({ parentId: 'parent' }));
      const refused = await service
        .relocate(TENANT, 'sensor-1', AT_TANK, 'operator-1')
        .catch((e: unknown) => e);
      expect(codeOf(refused)).toBe(SENSOR_PLACEMENT_ERROR.FOLLOWS_PARENT);
      expect(query).not.toHaveBeenCalled();
    });

    it('moves the sensor in one UPDATE, stamping placed_at and ending the legacy farm and pond', async () => {
      stands(sensorRow({ pondId: 'old-pond' }));
      const moved = await service.relocate(TENANT, 'sensor-1', AT_TANK, 'operator-1');

      expect(moved).toMatchObject({ systemId: SYSTEM, tankId: UNIT });
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/UPDATE sensors/);
      expect(sql).toMatch(/farm_id = NULL, pond_id = NULL, placed_at = \$8/);
      expect(sql).toMatch(/WHERE tenant_id = \$1 AND id = ANY\(\$2::uuid\[\]\)/);
      expect(params).toEqual([
        TENANT,
        ['sensor-1'],
        SITE,
        DEPARTMENT,
        SYSTEM,
        UNIT,
        null,
        expect.any(Date),
      ]);
      // Its audit row records from where to where, and who moved it.
      const [auditSql, auditParams] = query.mock.calls[1] as [string, unknown[]];
      expect(auditSql).toMatch(/INSERT INTO sensor_audit_logs/);
      expect(auditParams[6]).toBe('operator-1');
      expect(JSON.parse(String(auditParams[3]))).toMatchObject({ pondId: 'old-pond' });
      expect(JSON.parse(String(auditParams[4]))).toMatchObject({ tankId: UNIT, pondId: null });
    });

    it('announces the move through the outbox in the same transaction, so cached places drop', async () => {
      stands(sensorRow({}));
      await service.relocate(TENANT, 'sensor-1', AT_TANK, 'operator-1');
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'SensorConfigurationUpdated',
          tenantId: TENANT,
          sensorId: 'sensor-1',
          protocolCode: 'MQTT',
          changedFields: ['systemId', 'tankId', 'placedAt'],
        }),
        manager,
      );
    });

    it('moves a parent device with its child sensors', async () => {
      stands(sensorRow({ id: 'parent', isParentDevice: true }));
      find.mockResolvedValueOnce([sensorRow({ id: 'child', parentId: 'parent' })]);
      await service.relocate(TENANT, 'parent', AT_TANK, 'operator-1');
      expect(find).toHaveBeenCalledWith(Sensor, {
        where: { parentId: 'parent', tenantId: TENANT },
        lock: { mode: 'pessimistic_write' },
      });
      const [, params] = query.mock.calls[0] as [string, unknown[]];
      expect(params[1]).toEqual(['parent', 'child']);
      // One audit row per moved sensor.
      expect(
        query.mock.calls.filter(([sql]) => String(sql).includes('sensor_audit_logs')),
      ).toHaveLength(2);
      expect(enqueue).toHaveBeenCalledTimes(2);
    });

    it('changes nothing when the sensor already stands there, whichever column held the tank', async () => {
      stands(sensorRow({ systemId: SYSTEM, equipmentId: UNIT }));
      await service.relocate(TENANT, 'sensor-1', AT_TANK, 'operator-1');
      expect(query).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });
  });
});
