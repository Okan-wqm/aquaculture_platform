import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ConflictDetectionService,
  ConflictType,
  ConflictSeverity,
} from '../services/conflict-detection.service';
import { LeaveRequest, LeaveRequestStatus } from '../../leave/entities/leave-request.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { Shift } from '../../attendance/entities/shift.entity';

describe('ConflictDetectionService', () => {
  let service: ConflictDetectionService;
  let leaveRequestRepository: jest.Mocked<Repository<LeaveRequest>>;
  let settingsRepository: jest.Mocked<Repository<SchedulingSettings>>;

  const mockSettings: Partial<SchedulingSettings> = {
    tenantId: 'tenant-1',
    standardWeeklyMinutes: 2700,
    maxOvertimeMinutesPerWeek: 720,
    maxConsecutiveWorkDays: 6,
    minRestMinutesBetweenShifts: 660, // 11 hours
  };

  const createEntry = (
    date: string,
    entryType: WeeklyPlanEntryType,
    plannedMinutes = 480,
    shift?: Partial<Shift>,
    plannedStartTime?: string,
    plannedEndTime?: string,
  ): Partial<WeeklyPlanEntry> => ({
    id: `entry-${date}`,
    date: new Date(date),
    entryType,
    plannedMinutes,
    shift: shift as Shift,
    shiftId: shift?.id,
    // WeeklyPlanEntry.plannedStart/EndTime narrowed from string to Date
    // (data-layer normalization). The factory accepts string params for
    // ergonomic test setup but converts at the boundary.
    plannedStartTime: plannedStartTime ? new Date(plannedStartTime) : undefined,
    plannedEndTime: plannedEndTime ? new Date(plannedEndTime) : undefined,
  });

  beforeEach(async () => {
    const mockQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConflictDetectionService,
        {
          provide: getRepositoryToken(LeaveRequest),
          useValue: {
            createQueryBuilder: jest.fn(() => mockQueryBuilder),
          },
        },
        {
          provide: getRepositoryToken(SchedulingSettings),
          useValue: {
            findOne: jest.fn().mockResolvedValue(mockSettings),
          },
        },
      ],
    }).compile();

    service = module.get<ConflictDetectionService>(ConflictDetectionService);
    leaveRequestRepository = module.get(getRepositoryToken(LeaveRequest));
    settingsRepository = module.get(getRepositoryToken(SchedulingSettings));
  });

  describe('checkMaxHours', () => {
    it('should return no conflict when below standard hours', () => {
      const entries = [
        createEntry('2026-01-12', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-13', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-14', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-15', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-16', WeeklyPlanEntryType.WORK),
      ];

      const conflicts = service.checkMaxHours(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(conflicts).toHaveLength(0);
    });

    it('should return WARNING when overtime but within limit', () => {
      const entries = [
        createEntry('2026-01-12', WeeklyPlanEntryType.WORK, 540), // 9h each
        createEntry('2026-01-13', WeeklyPlanEntryType.WORK, 540),
        createEntry('2026-01-14', WeeklyPlanEntryType.WORK, 540),
        createEntry('2026-01-15', WeeklyPlanEntryType.WORK, 540),
        createEntry('2026-01-16', WeeklyPlanEntryType.WORK, 540),
        createEntry('2026-01-17', WeeklyPlanEntryType.WORK, 300), // Saturday 5h
      ];

      const conflicts = service.checkMaxHours(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.type).toBe(ConflictType.MAX_HOURS_EXCEEDED);
      expect(conflicts[0]!.severity).toBe(ConflictSeverity.WARNING);
    });

    it('should return ERROR when exceeding max total hours', () => {
      const entries = [
        createEntry('2026-01-12', WeeklyPlanEntryType.WORK, 720), // 12h each - extreme
        createEntry('2026-01-13', WeeklyPlanEntryType.WORK, 720),
        createEntry('2026-01-14', WeeklyPlanEntryType.WORK, 720),
        createEntry('2026-01-15', WeeklyPlanEntryType.WORK, 720),
        createEntry('2026-01-16', WeeklyPlanEntryType.WORK, 720),
      ];

      const conflicts = service.checkMaxHours(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.type).toBe(ConflictType.MAX_HOURS_EXCEEDED);
      expect(conflicts[0]!.severity).toBe(ConflictSeverity.ERROR);
    });

    it('should use default values when settings are null', () => {
      const entries = [
        createEntry('2026-01-12', WeeklyPlanEntryType.WORK),
      ];

      const conflicts = service.checkMaxHours(entries as WeeklyPlanEntry[], null);

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('checkConsecutiveDays', () => {
    it('should not flag when within consecutive days limit', () => {
      const entries = [
        createEntry('2026-01-12', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-13', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-14', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-15', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-16', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-17', WeeklyPlanEntryType.OFF, 0),
        createEntry('2026-01-18', WeeklyPlanEntryType.OFF, 0),
      ];

      const conflicts = service.checkConsecutiveDays(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(conflicts).toHaveLength(0);
    });

    it('should flag when exceeding consecutive days limit', () => {
      const entries = [
        createEntry('2026-01-12', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-13', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-14', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-15', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-16', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-17', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-18', WeeklyPlanEntryType.WORK), // 7 consecutive
      ];

      const conflicts = service.checkConsecutiveDays(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.type).toBe(ConflictType.MAX_CONSECUTIVE_DAYS);
    });

    it('should reset count after off day', () => {
      const entries = [
        createEntry('2026-01-12', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-13', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-14', WeeklyPlanEntryType.OFF, 0), // Break
        createEntry('2026-01-15', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-16', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-17', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-18', WeeklyPlanEntryType.WORK),
      ];

      const conflicts = service.checkConsecutiveDays(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(conflicts).toHaveLength(0);
    });

    it('should use default value (6) when settings are null', () => {
      const entries = [
        createEntry('2026-01-12', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-13', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-14', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-15', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-16', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-17', WeeklyPlanEntryType.WORK),
        createEntry('2026-01-18', WeeklyPlanEntryType.WORK), // 7 consecutive
      ];

      const conflicts = service.checkConsecutiveDays(entries as WeeklyPlanEntry[], null);

      expect(conflicts).toHaveLength(1);
    });
  });

  describe('checkMinimumRest', () => {
    it('should not flag when rest period is sufficient', () => {
      const entries = [
        createEntry(
          '2026-01-12',
          WeeklyPlanEntryType.WORK,
          480,
          { id: 'shift-1', endTime: '15:00' } as Shift,
          '07:00',
          '15:00',
        ),
        createEntry(
          '2026-01-13',
          WeeklyPlanEntryType.WORK,
          480,
          { id: 'shift-1', startTime: '07:00' } as Shift,
          '07:00',
          '15:00',
        ),
      ];

      const conflicts = service.checkMinimumRest(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      // 16 hours rest (15:00 to 07:00 = 16h) > 11h minimum
      expect(conflicts).toHaveLength(0);
    });

    it('should flag when rest period is insufficient', () => {
      const entries = [
        createEntry(
          '2026-01-12',
          WeeklyPlanEntryType.WORK,
          540,
          { id: 'shift-1', endTime: '22:00' } as Shift,
          '13:00',
          '22:00',
        ),
        createEntry(
          '2026-01-13',
          WeeklyPlanEntryType.WORK,
          540,
          { id: 'shift-2', startTime: '06:00' } as Shift,
          '06:00',
          '15:00',
        ),
      ];

      const conflicts = service.checkMinimumRest(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      // 8 hours rest (22:00 to 06:00 = 8h) < 11h minimum
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.type).toBe(ConflictType.INSUFFICIENT_REST);
    });

    it('should skip entries without shift info', () => {
      const entries = [
        createEntry('2026-01-12', WeeklyPlanEntryType.WORK, 480),
        createEntry('2026-01-13', WeeklyPlanEntryType.WORK, 480),
      ];

      const conflicts = service.checkMinimumRest(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('detectConflicts - integration', () => {
    it('should detect multiple conflict types', async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      leaveRequestRepository.createQueryBuilder = jest.fn(() => mockQueryBuilder) as any;

      const entries = [
        createEntry('2026-01-12', WeeklyPlanEntryType.WORK, 720), // Excessive hours
        createEntry('2026-01-13', WeeklyPlanEntryType.WORK, 720),
        createEntry('2026-01-14', WeeklyPlanEntryType.WORK, 720),
        createEntry('2026-01-15', WeeklyPlanEntryType.WORK, 720),
        createEntry('2026-01-16', WeeklyPlanEntryType.WORK, 720),
        createEntry('2026-01-17', WeeklyPlanEntryType.WORK, 720),
        createEntry('2026-01-18', WeeklyPlanEntryType.WORK, 720), // 7 consecutive
      ];

      const conflicts = await service.detectConflicts(
        'tenant-1',
        'employee-1',
        entries as WeeklyPlanEntry[],
        new Date('2026-01-12'),
        new Date('2026-01-18'),
      );

      // Should have both max hours exceeded and consecutive days warnings
      expect(conflicts.length).toBeGreaterThanOrEqual(2);
      expect(conflicts.some(c => c.type === ConflictType.MAX_HOURS_EXCEEDED)).toBe(true);
      expect(conflicts.some(c => c.type === ConflictType.MAX_CONSECUTIVE_DAYS)).toBe(true);
    });
  });
});
