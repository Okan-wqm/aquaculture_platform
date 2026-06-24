import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner, EntityManager, UpdateResult } from 'typeorm';
import { NotFoundException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { UpdatePlanEntryHandler } from '../handlers/update-plan-entry.handler';
import { UpdatePlanEntryCommand } from '../commands/update-plan-entry.command';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { WeeklyPlan, WeeklyPlanStatus } from '../entities/weekly-plan.entity';
import { Shift, WeekDay } from '../../attendance/entities/shift.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';
import { calculatePlanEntryMinutes } from '../plan-entry-time';

describe('UpdatePlanEntryHandler', () => {
  let handler: UpdatePlanEntryHandler;
  let entryRepository: jest.Mocked<Repository<WeeklyPlanEntry>>;
  let planRepository: jest.Mocked<Repository<WeeklyPlan>>;
  let shiftRepository: jest.Mocked<Repository<Shift>>;
  let settingsRepository: jest.Mocked<Repository<SchedulingSettings>>;
  let dataSource: jest.Mocked<DataSource>;
  let queryRunner: jest.Mocked<QueryRunner>;
  let manager: jest.Mocked<EntityManager>;

  const mockTenantId = 'tenant-123';
  const mockUserId = 'user-456';
  const mockEntryId = 'entry-789';
  const mockPlanId = 'plan-001';
  const mockShiftId = 'shift-002';

  const mockShift: Partial<Shift> = {
    id: mockShiftId,
    tenantId: mockTenantId,
    name: 'Morning Shift',
    code: 'MS',
    startTime: '07:00',
    endTime: '15:00',
    totalMinutes: 480,
    isActive: true,
    isDeleted: false,
  };

  const mockPlan: Partial<WeeklyPlan> = {
    id: mockPlanId,
    tenantId: mockTenantId,
    status: WeeklyPlanStatus.DRAFT,
  };

  const mockEntry: Partial<WeeklyPlanEntry> = {
    id: mockEntryId,
    tenantId: mockTenantId,
    weeklyPlanId: mockPlanId,
    weeklyPlan: mockPlan as WeeklyPlan,
    employeeId: 'emp-001',
    date: new Date('2026-01-19'),
    dayOfWeek: WeekDay.MONDAY,
    entryType: WeeklyPlanEntryType.OFF,
    isOffDay: true,
    isLeaveDay: false,
    plannedMinutes: 0,
    displayOrder: 0,
  };

  beforeEach(async () => {
    // Create mock manager
    manager = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<EntityManager>;

    // Create mock query runner
    queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager,
    } as unknown as jest.Mocked<QueryRunner>;

    // Create mock data source
    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    } as unknown as jest.Mocked<DataSource>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdatePlanEntryHandler,
        {
          provide: getRepositoryToken(WeeklyPlanEntry),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(WeeklyPlan),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Shift),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(SchedulingSettings),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
      ],
    }).compile();

    handler = module.get<UpdatePlanEntryHandler>(UpdatePlanEntryHandler);
    entryRepository = module.get(getRepositoryToken(WeeklyPlanEntry));
    planRepository = module.get(getRepositoryToken(WeeklyPlan));
    shiftRepository = module.get(getRepositoryToken(Shift));
    settingsRepository = module.get(getRepositoryToken(SchedulingSettings));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('execute', () => {
    it('should update entry with new shift', async () => {
      const command = new UpdatePlanEntryCommand(
        mockTenantId,
        mockUserId,
        mockEntryId,
        mockShiftId,
        false,
        undefined,
        undefined,
        WeeklyPlanEntryType.WORK,
      );

      manager.findOne
        .mockResolvedValueOnce(mockEntry) // Find entry
        .mockResolvedValueOnce(mockShift) // Find shift
        .mockResolvedValueOnce(null); // Find settings

      manager.save.mockResolvedValue(mockEntry);
      manager.find.mockResolvedValue([mockEntry]); // For recalculation
      manager.update.mockResolvedValue({ affected: 1 } as UpdateResult);

      entryRepository.findOne.mockResolvedValue({
        ...mockEntry,
        shiftId: mockShiftId,
        shift: mockShift,
        entryType: WeeklyPlanEntryType.WORK,
      } as WeeklyPlanEntry);

      const result = await handler.execute(command);

      expect(queryRunner.connect).toHaveBeenCalled();
      expect(queryRunner.startTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should throw NotFoundException when entry not found', async () => {
      const command = new UpdatePlanEntryCommand(
        mockTenantId,
        mockUserId,
        'non-existent-entry',
        mockShiftId,
      );

      manager.findOne.mockResolvedValue(null);

      await expect(handler.execute(command)).rejects.toThrow(NotFoundException);
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should throw BadRequestException when plan is published', async () => {
      const publishedPlan = { ...mockPlan, status: WeeklyPlanStatus.PUBLISHED };
      const entryWithPublishedPlan = {
        ...mockEntry,
        weeklyPlan: publishedPlan,
      };

      const command = new UpdatePlanEntryCommand(
        mockTenantId,
        mockUserId,
        mockEntryId,
        mockShiftId,
      );

      manager.findOne.mockResolvedValueOnce(entryWithPublishedPlan);

      await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should throw BadRequestException when modifying leave day without entryType', async () => {
      const leaveDayEntry = {
        ...mockEntry,
        isLeaveDay: true,
      };

      const command = new UpdatePlanEntryCommand(
        mockTenantId,
        mockUserId,
        mockEntryId,
        mockShiftId,
      );

      manager.findOne.mockResolvedValueOnce(leaveDayEntry);

      await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should throw NotFoundException when shift not found', async () => {
      const command = new UpdatePlanEntryCommand(
        mockTenantId,
        mockUserId,
        mockEntryId,
        'non-existent-shift',
      );

      manager.findOne
        .mockResolvedValueOnce(mockEntry) // Find entry
        .mockResolvedValueOnce(null); // Shift not found

      await expect(handler.execute(command)).rejects.toThrow(NotFoundException);
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should mark entry as off day when shiftId is null', async () => {
      const workEntry = {
        ...mockEntry,
        shiftId: mockShiftId,
        entryType: WeeklyPlanEntryType.WORK,
        isOffDay: false,
      };

      const command = new UpdatePlanEntryCommand(
        mockTenantId,
        mockUserId,
        mockEntryId,
        undefined,
        true,
      );

      manager.findOne.mockResolvedValueOnce(workEntry);
      manager.save.mockResolvedValue(workEntry);
      manager.find.mockResolvedValue([workEntry]);
      manager.update.mockResolvedValue({ affected: 1 } as UpdateResult);

      entryRepository.findOne.mockResolvedValue({
        ...workEntry,
        shiftId: undefined,
        isOffDay: true,
        entryType: WeeklyPlanEntryType.OFF,
      } as WeeklyPlanEntry);

      await handler.execute(command);

      expect(manager.save).toHaveBeenCalled();
      const savedEntry = (manager.save as jest.Mock).mock.calls[0][1];
      expect(savedEntry.isOffDay).toBe(true);
      expect(savedEntry.plannedMinutes).toBe(0);
    });

    it('should update custom times when provided', async () => {
      const command = new UpdatePlanEntryCommand(
        mockTenantId,
        mockUserId,
        mockEntryId,
        mockShiftId,
        false,
        '08:00',
        '17:00',
      );

      manager.findOne
        .mockResolvedValueOnce(mockEntry)
        .mockResolvedValueOnce(mockShift)
        .mockResolvedValueOnce(null);

      manager.save.mockResolvedValue(mockEntry);
      manager.find.mockResolvedValue([mockEntry]);
      manager.update.mockResolvedValue({ affected: 1 } as UpdateResult);

      entryRepository.findOne.mockResolvedValue(mockEntry as WeeklyPlanEntry);

      await handler.execute(command);

      expect(manager.save).toHaveBeenCalled();
      const savedEntry = (manager.save as jest.Mock).mock.calls[0][1];
      expect(savedEntry.plannedStartTime).toEqual(new Date('2026-01-19T08:00:00.000Z'));
      expect(savedEntry.plannedEndTime).toEqual(new Date('2026-01-19T17:00:00.000Z'));
      expect(savedEntry.plannedMinutes).toBe(540); // 9 hours
    });

    it('should rollback transaction and wrap unknown errors', async () => {
      const command = new UpdatePlanEntryCommand(
        mockTenantId,
        mockUserId,
        mockEntryId,
        mockShiftId,
      );

      manager.findOne.mockRejectedValue(new Error('Database connection error'));

      await expect(handler.execute(command)).rejects.toThrow(InternalServerErrorException);
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });
  });

  describe('calculateMinutes', () => {
    it('should calculate minutes correctly for same-day shifts', () => {
      expect(calculatePlanEntryMinutes('07:00', '15:00')).toBe(480); // 8 hours
      expect(calculatePlanEntryMinutes('08:30', '17:00')).toBe(510); // 8.5 hours
      expect(calculatePlanEntryMinutes('00:00', '08:00')).toBe(480); // 8 hours
    });

    it('should handle cross-midnight shifts', () => {
      expect(calculatePlanEntryMinutes('22:00', '06:00')).toBe(480); // 8 hours
      expect(calculatePlanEntryMinutes('23:00', '07:00')).toBe(480); // 8 hours
    });
  });
});
