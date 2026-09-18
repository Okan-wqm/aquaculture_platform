/**
 * Projection spec for the equipment farm-AI responder (PR-5): PII deep ban
 * (serialNumber + purchasePrice included), ISO dates, cap/truncated.
 */
import { projectEquipment, projectFeederCalibration } from '../projections';
import { Equipment } from '../../entities/equipment.entity';
import { FeederCalibration } from '../../entities/feeder-calibration.entity';

/** The PII ban list — none of these keys may appear anywhere in a reply. */
const BANNED_KEYS = [
  'reportedBy',
  'assignedTo',
  'createdBy',
  'completedBy',
  'approvedBy',
  'verifiedBy',
  'userId',
  'userName',
  'notes',
  'attachments',
  'specifications',
  'checklist',
  'serialNumber',
  'purchasePrice',
  'purchaseDate',
  'warrantyEndDate',
  'tenantId',
  'createdAt',
  'updatedAt',
];

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

const EQUIPMENT = {
  id: 'eq1',
  tenantId: 't',
  departmentId: null,
  subSystemId: null,
  equipmentTypeId: 'et1',
  equipmentType: { id: 'et1', code: 'feeder', name: 'Feeder', category: 'feeder' },
  name: 'Feeder 1',
  code: 'FEED-001',
  description: 'desc',
  manufacturer: 'AKVA',
  model: 'F-3000',
  serialNumber: 'SN-SECRET-123',
  purchaseDate: new Date('2025-01-01T00:00:00.000Z'),
  installationDate: new Date('2025-01-15T00:00:00.000Z'),
  warrantyEndDate: new Date('2027-01-01T00:00:00.000Z'),
  purchasePrice: 45000,
  currency: 'NOK',
  status: 'operational',
  location: { building: 'A', notes: 'operator note' },
  specifications: { power: '3kW' },
  maintenanceSchedule: { customDays: 30 },
  subEquipmentCount: 0,
  operatingHours: 1200,
  notes: 'operator note',
  isTank: false,
  isVisibleInSensor: false,
  volume: null,
  currentBiomass: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Equipment;

const CALIBRATION = {
  id: 'fc1',
  tenantId: 't',
  equipmentId: 'eq1',
  feedSizeMm: 3,
  feedSizeLabel: '3mm',
  gramsPerDispensing: 12.5,
  siloCapacityKg: 500,
  notes: 'operator note',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as FeederCalibration;

describe('equipment farm-AI projections (PR-5 read-only namespace)', () => {
  it('strips serialNumber, purchasePrice, specifications, location and PII — deep key scan', () => {
    for (const projection of [projectEquipment(EQUIPMENT), projectFeederCalibration(CALIBRATION)]) {
      const keys = collectKeys(projection);
      for (const banned of BANNED_KEYS) {
        expect({ banned, present: keys.has(banned) }).toEqual({ banned, present: false });
      }
      expect(keys.has('location')).toBe(false);
      expect(keys.has('maintenanceSchedule')).toBe(false);
    }
    const serialized = JSON.stringify(projectEquipment(EQUIPMENT));
    expect(serialized).not.toContain('SN-SECRET-123');
    expect(serialized).not.toContain('operator note');
  });

  it('keeps identity, type and operational state', () => {
    const dto = projectEquipment(EQUIPMENT);
    expect(dto).toMatchObject({
      code: 'FEED-001',
      equipmentTypeCode: 'feeder',
      equipmentCategory: 'feeder',
      status: 'operational',
      isTank: false,
    });
    const calibration = projectFeederCalibration(CALIBRATION);
    expect(calibration.gramsPerDispensing).toBe(12.5);
    expect(calibration.siloCapacityKg).toBe(500);
  });
});
