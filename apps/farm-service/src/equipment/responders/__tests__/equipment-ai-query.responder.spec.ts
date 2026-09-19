import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { EquipmentStatus } from '../../entities/equipment.entity';
import { ListEquipmentQuery } from '../../queries/list-equipment.query';
import { ListFeederCalibrationsQuery } from '../../queries/list-feeder-calibrations.query';
import { EquipmentAiQueryResponder } from '../equipment-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

describe('EquipmentAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: EquipmentAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new EquipmentAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('maps the status code onto the enum, pages by limit and strips serial / price / specifications', async () => {
    execute.mockResolvedValue({
      data: [
        {
          id: ID,
          code: 'AER-3',
          name: 'Aerator 3',
          equipmentType: { name: 'Aerator' },
          status: 'operational',
          manufacturer: 'Acme',
          model: 'X1',
          serialNumber: 'SN-SECRET',
          purchasePrice: 9999,
          specifications: { hp: 5 },
          installationDate: new Date('2025-01-01T00:00:00Z'),
          warrantyEndDate: undefined,
          maintenanceSchedule: { nextMaintenanceDate: '2026-10-01' },
          operatingHours: '1200',
          isTank: false,
          isActive: true,
        },
      ],
      pagination: {
        page: 1,
        limit: 5,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    const reply = await responder.listEquipment({
      tenantId: TENANT,
      status: 'operational',
      limit: 5,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(ListEquipmentQuery));
    const query = execute.mock.calls[0][0] as ListEquipmentQuery;
    expect(query.filter).toEqual({ isActive: true, status: EquipmentStatus.OPERATIONAL });
    expect(query.pagination).toEqual({ page: 1, limit: 5, sortBy: 'code', sortOrder: 'ASC' });
    expect(reply).toMatchObject({
      ok: true,
      data: {
        total: 1,
        items: [
          {
            code: 'AER-3',
            equipmentTypeName: 'Aerator',
            warrantyEndDate: null,
            nextMaintenanceDate: '2026-10-01T00:00:00.000Z',
            operatingHours: 1200,
          },
        ],
      },
    });
    for (const secret of ['SN-SECRET', '9999', 'hp'])
      expect(JSON.stringify(reply)).not.toContain(secret);
  });

  it('rejects a status outside the contract vocabulary as INVALID_REQUEST (never a silently dropped filter)', async () => {
    const reply = await responder.listEquipment({ tenantId: TENANT, status: 'flying', limit: 5 });
    expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('feeder calibrations: respects the (equipmentId, tenantId) constructor order', async () => {
    execute.mockResolvedValue([
      {
        id: ID,
        feedSizeMm: '4.5',
        feedSizeLabel: '4.5 mm',
        gramsPerDispensing: 250,
        siloCapacityKg: 500,
        notes: 'n',
        updatedAt: new Date('2026-09-01T00:00:00Z'),
      },
    ]);
    const reply = await responder.listFeederCalibrations({
      tenantId: TENANT,
      equipmentId: ID,
      limit: 10,
    });
    expect(execute).toHaveBeenCalledWith(expect.any(ListFeederCalibrationsQuery));
    const query = execute.mock.calls[0][0] as ListFeederCalibrationsQuery;
    expect(query.equipmentId).toBe(ID);
    expect(query.tenantId).toBe(TENANT);
    expect(reply).toMatchObject({
      ok: true,
      data: {
        items: [
          { feedSizeMm: 4.5, gramsPerDispensing: 250, updatedAt: '2026-09-01T00:00:00.000Z' },
        ],
      },
    });
  });
});
