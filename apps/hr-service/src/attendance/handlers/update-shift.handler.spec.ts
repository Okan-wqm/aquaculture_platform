/**
 * WHY THIS FILE EXISTS:
 * UpdateShiftHandler is the backend for the FE `UpdateShift` mutation
 * (SchedulingSettingsPage → useUpdateShift). Before this handler existed the
 * mutation 400'd (GraphQL FE↔backend drift). These tests pin the handler's
 * contract:
 *  - applies ONLY the provided (non-undefined) fields, leaves the rest untouched
 *  - throws NotFoundException when the shift does not exist (or belongs to
 *    another tenant — the tenant-scoped findOne hides it)
 *  - validates startTime/endTime with the same HH:mm rule as create
 *  - recomputes totalMinutes from effective times when a time field changes,
 *    unless an explicit totalMinutes is supplied
 *  - always commits on success / rolls back + releases the QueryRunner on error
 *
 * Mocking idiom mirrors create-employee.handler.spec.ts: the mock
 * EntityManager.getRepository returns a mock repo, which tenantManagerRepo
 * wraps in a real TenantScopedRepository (so the test exercises the actual
 * tenant-scoping wrapper, not a stub of it).
 */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner, EntityManager } from 'typeorm';

import { UpdateShiftCommand } from '../commands/update-shift.command';
import { UpdateShiftHandler } from './update-shift.handler';
import { Shift, ShiftType, WeekDay } from '../entities/shift.entity';

const tenantId = 'tenant-uuid-001';
const userId = 'admin-user-001';

const buildMockShift = (overrides: Partial<Shift> = {}): Shift => {
  const s = new Shift();
  Object.assign(s, {
    id: 'shift-uuid-001',
    tenantId,
    code: 'DAY',
    name: 'Day Shift',
    description: 'Standard day shift',
    shiftType: ShiftType.REGULAR,
    startTime: '09:00',
    endTime: '17:00',
    totalMinutes: 480,
    breakMinutes: 60,
    breakPeriods: undefined,
    workDays: [WeekDay.MONDAY, WeekDay.TUESDAY, WeekDay.WEDNESDAY, WeekDay.THURSDAY, WeekDay.FRIDAY],
    crossesMidnight: false,
    graceMinutes: 0,
    earlyClockInMinutes: 60,
    lateClockOutMinutes: 300,
    isActive: true,
    colorCode: '#00AAFF',
    displayOrder: 0,
    createdBy: userId,
    updatedBy: userId,
    isDeleted: false,
    version: 1,
    ...overrides,
  });
  return s;
};

const buildMockQueryRunner = (overrides?: {
  findOneResult?: Shift | null;
  shouldFailSave?: boolean;
}) => {
  // The repo's create() returns its input (TenantScopedRepository.save calls
  // repository.create({...entity, tenantId}) then repository.save()).
  // Use property presence (not ??) so an explicit `null` (shift-not-found case)
  // is honored instead of falling back to a default shift.
  const findOneResult = overrides && 'findOneResult' in overrides ? overrides.findOneResult : buildMockShift();
  const mockShiftRepo = {
    findOne: jest.fn().mockResolvedValue(findOneResult),
    create: jest.fn().mockImplementation((data: Partial<Shift>) => Object.assign(new Shift(), data)),
    save: overrides?.shouldFailSave
      ? jest.fn().mockRejectedValue(new Error('DB error'))
      : jest.fn().mockImplementation((entity: Shift) => Promise.resolve(entity)),
  };

  const mockManager: Partial<EntityManager> = {
    getRepository: jest.fn().mockReturnValue(mockShiftRepo),
  };

  const mockQR: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: mockManager as EntityManager,
  };

  return { mockQR, mockShiftRepo };
};

describe('UpdateShiftHandler', () => {
  let handler: UpdateShiftHandler;
  let mockDataSource: Partial<DataSource>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates ONLY the provided fields and leaves the rest unchanged', async () => {
    const existing = buildMockShift();
    const { mockQR, mockShiftRepo } = buildMockQueryRunner({ findOneResult: existing });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };
    handler = new UpdateShiftHandler(mockDataSource as DataSource);

    // Only name + colorCode are sent; everything else is undefined.
    const command = new UpdateShiftCommand(
      tenantId,
      userId,
      'shift-uuid-001',
      'Renamed Day Shift', // name
      undefined, // description
      undefined, // shiftType
      undefined, // startTime
      undefined, // endTime
      undefined, // totalMinutes
      undefined, // breakMinutes
      undefined, // breakPeriods
      undefined, // workDays
      undefined, // crossesMidnight
      undefined, // graceMinutes
      undefined, // isActive
      '#FF0000', // colorCode
      undefined, // displayOrder
    );

    const result = await handler.execute(command);

    expect(result.name).toBe('Renamed Day Shift');
    expect(result.colorCode).toBe('#FF0000');
    // Untouched fields preserved
    expect(result.description).toBe('Standard day shift');
    expect(result.startTime).toBe('09:00');
    expect(result.endTime).toBe('17:00');
    expect(result.totalMinutes).toBe(480);
    expect(result.shiftType).toBe(ShiftType.REGULAR);
    // updatedBy stamped, save + commit happened
    expect(result.updatedBy).toBe(userId);
    expect(mockShiftRepo.save).toHaveBeenCalled();
    expect(mockQR.commitTransaction).toHaveBeenCalled();
  });

  it('recomputes totalMinutes from effective times when a time field changes', async () => {
    const existing = buildMockShift({ startTime: '09:00', endTime: '17:00', totalMinutes: 480 });
    const { mockQR } = buildMockQueryRunner({ findOneResult: existing });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };
    handler = new UpdateShiftHandler(mockDataSource as DataSource);

    // endTime 19:00 -> 10h = 600 min, no explicit totalMinutes
    const command = new UpdateShiftCommand(
      tenantId,
      userId,
      'shift-uuid-001',
      undefined,
      undefined,
      undefined,
      undefined, // startTime unchanged
      '19:00', // endTime changed
    );

    const result = await handler.execute(command);

    expect(result.endTime).toBe('19:00');
    expect(result.totalMinutes).toBe(600);
  });

  it('honors an explicit totalMinutes over time-based recomputation', async () => {
    const existing = buildMockShift();
    const { mockQR } = buildMockQueryRunner({ findOneResult: existing });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };
    handler = new UpdateShiftHandler(mockDataSource as DataSource);

    const command = new UpdateShiftCommand(
      tenantId,
      userId,
      'shift-uuid-001',
      undefined,
      undefined,
      undefined,
      undefined,
      '19:00', // endTime changed (would imply 600)
      420, // but explicit totalMinutes wins
    );

    const result = await handler.execute(command);

    expect(result.totalMinutes).toBe(420);
  });

  it('throws NotFoundException when the shift does not exist for the tenant', async () => {
    const { mockQR } = buildMockQueryRunner({ findOneResult: null });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };
    handler = new UpdateShiftHandler(mockDataSource as DataSource);

    const command = new UpdateShiftCommand(tenantId, userId, 'missing-uuid', 'X');

    await expect(handler.execute(command)).rejects.toThrow(NotFoundException);
    expect(mockQR.rollbackTransaction).toHaveBeenCalled();
    expect(mockQR.release).toHaveBeenCalled();
  });

  it('throws BadRequestException for an invalid startTime', async () => {
    const { mockQR, mockShiftRepo } = buildMockQueryRunner();
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };
    handler = new UpdateShiftHandler(mockDataSource as DataSource);

    const command = new UpdateShiftCommand(
      tenantId,
      userId,
      'shift-uuid-001',
      undefined,
      undefined,
      undefined,
      '99:99', // invalid HH:mm
    );

    await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
    expect(mockShiftRepo.save).not.toHaveBeenCalled();
    expect(mockQR.rollbackTransaction).toHaveBeenCalled();
  });

  it('always releases the QueryRunner even when save throws', async () => {
    const { mockQR } = buildMockQueryRunner({ shouldFailSave: true });
    mockDataSource = { createQueryRunner: jest.fn().mockReturnValue(mockQR) };
    handler = new UpdateShiftHandler(mockDataSource as DataSource);

    const command = new UpdateShiftCommand(tenantId, userId, 'shift-uuid-001', 'X');

    await expect(handler.execute(command)).rejects.toThrow();
    expect(mockQR.rollbackTransaction).toHaveBeenCalled();
    expect(mockQR.release).toHaveBeenCalled();
  });
});
