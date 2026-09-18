import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { EquipmentAiQueryResponder } from '../equipment-ai-query.responder';
import { ListEquipmentQuery } from '../../queries/list-equipment.query';
import { ListFeederCalibrationsQuery } from '../../queries/list-feeder-calibrations.query';
import { Equipment } from '../../entities/equipment.entity';
import { FeederCalibration } from '../../entities/feeder-calibration.entity';

const TENANT = '33333333-3333-4333-8333-333333333333';
const EQUIPMENT = '55555555-5555-4555-8555-555555555555';

function equipment(id: string): Equipment {
  return {
    id,
    tenantId: TENANT,
    departmentId: null,
    equipmentTypeId: '66666666-6666-4666-8666-666666666666',
    equipmentType: {
      id: 'et1',
      code: 'feeder',
      name: 'Feeder',
      category: 'feeder' as never,
    } as unknown as Equipment['equipmentType'],
    name: 'Feeder 1',
    code: 'FEED-001',
    description: 'desc',
    manufacturer: 'AKVA',
    model: 'F-3000',
    serialNumber: 'SN-SECRET-123', // PII-adjacent — must never cross the wire
    purchasePrice: 45000, // must never cross the wire
    specifications: { power: '3kW' }, // must never cross the wire
    status: 'operational' as Equipment['status'],
    isTank: false,
    notes: 'operator note',
    subEquipmentCount: 0,
  } as unknown as Equipment;
}

function calibration(id: string): FeederCalibration {
  return {
    id,
    tenantId: TENANT,
    equipmentId: EQUIPMENT,
    feedSizeMm: 3,
    feedSizeLabel: '3mm',
    gramsPerDispensing: 12.5,
    siloCapacityKg: 500,
    notes: 'operator note',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as FeederCalibration;
}

const PAGE = (rows: Equipment[], total: number) => ({
  data: rows,
  pagination: { page: 1, limit: 50, total, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
});

describe('EquipmentAiQueryResponder (PR-5 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: EquipmentAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new EquipmentAiQueryResponder({ execute } as unknown as QueryBus);
  });

  // ---------------------------------------------------------------- EQUIPMENT_LIST
  it('EQUIPMENT_LIST: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      { tenantId: TENANT, status: 'broken' },
      { tenantId: TENANT, equipmentTypeId: 'type-1' },
      { tenantId: TENANT, isTank: 'yes' },
      { tenantId: TENANT, limit: 51 },
    ]) {
      expect(await responder.list(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('EQUIPMENT_LIST: happy path passes ONLY contract filters and strips procurement data', async () => {
    execute.mockResolvedValue(PAGE(Array.from({ length: 60 }, (_, i) => equipment(`eq${i}`)), 60));

    const reply = await responder.list({
      tenantId: TENANT,
      equipmentTypeId: '66666666-6666-4666-8666-666666666666',
      status: 'operational',
      isTank: false,
      limit: 50,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(ListEquipmentQuery));
    const query = execute.mock.calls[0][0] as ListEquipmentQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.filter?.equipmentTypeId).toBe('66666666-6666-4666-8666-666666666666');
    expect(query.filter?.status).toBe('operational');
    expect(query.filter?.isTank).toBe(false);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(50);
      expect(reply.data.truncated).toBe(true);
      expect(reply.data.items[0]?.equipmentTypeName).toBe('Feeder');
      const serialized = JSON.stringify(reply.data);
      expect(serialized).not.toContain('SN-SECRET-123');
      expect(serialized).not.toContain('purchasePrice');
      expect(serialized).not.toContain('specifications');
      expect(serialized).not.toContain('operator note');
    }
  });

  it('EQUIPMENT_LIST: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.list({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // ------------------------------------------------- EQUIPMENT_FEEDER_CALIBRATIONS
  it('EQUIPMENT_FEEDER_CALIBRATIONS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      { tenantId: TENANT },
      { tenantId: TENANT, equipmentId: 'feeder-1' },
      { tenantId: TENANT, equipmentId: EQUIPMENT, limit: 0 },
    ]) {
      expect(await responder.feederCalibrations(bad)).toEqual({
        ok: false,
        error: 'INVALID_REQUEST',
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('EQUIPMENT_FEEDER_CALIBRATIONS: happy path builds the query equipmentId-FIRST', async () => {
    execute.mockResolvedValue([calibration('fc1'), calibration('fc2')]);

    const reply = await responder.feederCalibrations({
      tenantId: TENANT,
      equipmentId: EQUIPMENT,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(ListFeederCalibrationsQuery));
    const query = execute.mock.calls[0][0] as ListFeederCalibrationsQuery;
    // The constructor is (equipmentId, tenantId) — NOT tenantId first.
    expect(query.equipmentId).toBe(EQUIPMENT);
    expect(query.tenantId).toBe(TENANT);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(2);
      expect(reply.data.items[0]?.gramsPerDispensing).toBe(12.5);
      const serialized = JSON.stringify(reply.data);
      expect(serialized).not.toContain('operator note');
      expect(serialized).not.toContain('createdAt');
    }
  });

  it('EQUIPMENT_FEEDER_CALIBRATIONS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.feederCalibrations({ tenantId: TENANT, equipmentId: EQUIPMENT }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });
});
