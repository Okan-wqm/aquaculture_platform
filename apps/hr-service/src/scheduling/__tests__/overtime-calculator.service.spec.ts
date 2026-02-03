import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OvertimeCalculatorService, OvertimeCalculationResult } from '../services/overtime-calculator.service';
import { AttendanceRecord } from '../../attendance/entities/attendance-record.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';

describe('OvertimeCalculatorService', () => {
  let service: OvertimeCalculatorService;
  let attendanceRepository: jest.Mocked<Repository<AttendanceRecord>>;
  let settingsRepository: jest.Mocked<Repository<SchedulingSettings>>;

  const mockSettings: Partial<SchedulingSettings> = {
    tenantId: 'tenant-1',
    standardWeeklyMinutes: 2700, // 45 hours
    maxOvertimeMinutesPerWeek: 720, // 12 hours
    maxOvertimeMinutesPerMonth: 2880, // 48 hours
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimeCalculatorService,
        {
          provide: getRepositoryToken(AttendanceRecord),
          useValue: {
            find: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(SchedulingSettings),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<OvertimeCalculatorService>(OvertimeCalculatorService);
    attendanceRepository = module.get(getRepositoryToken(AttendanceRecord));
    settingsRepository = module.get(getRepositoryToken(SchedulingSettings));
  });

  describe('calculatePlannedOvertime', () => {
    it('should calculate zero overtime when below standard hours', () => {
      const entries: Partial<WeeklyPlanEntry>[] = [
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 }, // 8h
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 }, // 40h total
        { entryType: WeeklyPlanEntryType.OFF, plannedMinutes: 0 },
        { entryType: WeeklyPlanEntryType.OFF, plannedMinutes: 0 },
      ];

      const result = service.calculatePlannedOvertime(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(result.plannedMinutes).toBe(2400); // 40 hours
      expect(result.overtimeMinutes).toBe(0);
      expect(result.isOverLimit).toBe(false);
    });

    it('should calculate overtime correctly when exceeding standard hours', () => {
      const entries: Partial<WeeklyPlanEntry>[] = [
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 540 }, // 9h
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 540 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 540 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 540 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 540 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 300 }, // 5h on Saturday
        { entryType: WeeklyPlanEntryType.OFF, plannedMinutes: 0 },
      ];

      const result = service.calculatePlannedOvertime(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(result.plannedMinutes).toBe(3000); // 50 hours
      expect(result.overtimeMinutes).toBe(300); // 5 hours overtime (3000 - 2700)
      expect(result.isOverLimit).toBe(false); // 300 < 720 weekly limit
    });

    it('should flag when overtime exceeds weekly limit', () => {
      const entries: Partial<WeeklyPlanEntry>[] = [
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 600 }, // 10h
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 600 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 600 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 600 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 600 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 600 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 600 }, // 70h total
      ];

      const result = service.calculatePlannedOvertime(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(result.plannedMinutes).toBe(4200); // 70 hours
      expect(result.overtimeMinutes).toBe(1500); // 25 hours overtime
      expect(result.isOverLimit).toBe(true); // 1500 > 720 weekly limit
    });

    it('should include TRAINING entries in calculation', () => {
      const entries: Partial<WeeklyPlanEntry>[] = [
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 },
        { entryType: WeeklyPlanEntryType.TRAINING, plannedMinutes: 480 }, // Training counts
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 },
        { entryType: WeeklyPlanEntryType.OFF, plannedMinutes: 0 },
        { entryType: WeeklyPlanEntryType.OFF, plannedMinutes: 0 },
      ];

      const result = service.calculatePlannedOvertime(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(result.plannedMinutes).toBe(2400);
    });

    it('should exclude LEAVE and HOLIDAY entries from calculation', () => {
      const entries: Partial<WeeklyPlanEntry>[] = [
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 },
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 },
        { entryType: WeeklyPlanEntryType.LEAVE, plannedMinutes: 480 }, // Not counted
        { entryType: WeeklyPlanEntryType.HOLIDAY, plannedMinutes: 480 }, // Not counted
        { entryType: WeeklyPlanEntryType.WORK, plannedMinutes: 480 },
        { entryType: WeeklyPlanEntryType.OFF, plannedMinutes: 0 },
        { entryType: WeeklyPlanEntryType.OFF, plannedMinutes: 0 },
      ];

      const result = service.calculatePlannedOvertime(
        entries as WeeklyPlanEntry[],
        mockSettings as SchedulingSettings,
      );

      expect(result.plannedMinutes).toBe(1440); // Only 3 work days = 24h
    });

    it('should handle empty entries array', () => {
      const result = service.calculatePlannedOvertime(
        [],
        mockSettings as SchedulingSettings,
      );

      expect(result.plannedMinutes).toBe(0);
      expect(result.overtimeMinutes).toBe(0);
      expect(result.isOverLimit).toBe(false);
    });
  });

  describe('checkMonthlyOvertimeLimits', () => {
    it('should handle January (month=1) correctly', async () => {
      settingsRepository.findOne.mockResolvedValue(mockSettings as SchedulingSettings);
      attendanceRepository.find.mockResolvedValue([
        { overtimeMinutes: 120 } as AttendanceRecord,
        { overtimeMinutes: 60 } as AttendanceRecord,
      ]);

      const result = await service.checkMonthlyOvertimeLimits(
        'tenant-1',
        'employee-1',
        1, // January
        2026,
        0,
      );

      expect(result.currentMonthlyOvertime).toBe(180);
      expect(result.monthlyLimit).toBe(2880);
      expect(result.remainingAllowance).toBe(2700);
      expect(result.wouldExceedLimit).toBe(false);
    });

    it('should handle December (month=12) correctly', async () => {
      settingsRepository.findOne.mockResolvedValue(mockSettings as SchedulingSettings);
      attendanceRepository.find.mockResolvedValue([]);

      const result = await service.checkMonthlyOvertimeLimits(
        'tenant-1',
        'employee-1',
        12, // December
        2026,
        0,
      );

      expect(result.currentMonthlyOvertime).toBe(0);
    });

    it('should correctly predict if additional overtime would exceed limit', async () => {
      settingsRepository.findOne.mockResolvedValue(mockSettings as SchedulingSettings);
      attendanceRepository.find.mockResolvedValue([
        { overtimeMinutes: 2800 } as AttendanceRecord, // Already near limit
      ]);

      const result = await service.checkMonthlyOvertimeLimits(
        'tenant-1',
        'employee-1',
        6,
        2026,
        100, // Additional 100 minutes planned
      );

      expect(result.currentMonthlyOvertime).toBe(2800);
      expect(result.wouldExceedLimit).toBe(true); // 2800 + 100 > 2880
    });

    it('should use default monthly limit when settings not found', async () => {
      settingsRepository.findOne.mockResolvedValue(null);
      attendanceRepository.find.mockResolvedValue([]);

      const result = await service.checkMonthlyOvertimeLimits(
        'tenant-1',
        'employee-1',
        6,
        2026,
        0,
      );

      expect(result.monthlyLimit).toBe(2880); // Default value
    });
  });

  describe('formatMinutesAsHours', () => {
    it('should format whole hours correctly', () => {
      expect(service.formatMinutesAsHours(60)).toBe('1h');
      expect(service.formatMinutesAsHours(120)).toBe('2h');
      expect(service.formatMinutesAsHours(480)).toBe('8h');
    });

    it('should format hours with minutes correctly', () => {
      expect(service.formatMinutesAsHours(90)).toBe('1h 30m');
      expect(service.formatMinutesAsHours(145)).toBe('2h 25m');
    });

    it('should handle zero minutes', () => {
      expect(service.formatMinutesAsHours(0)).toBe('0h');
    });

    it('should handle minutes less than an hour', () => {
      expect(service.formatMinutesAsHours(45)).toBe('0h 45m');
    });
  });
});
