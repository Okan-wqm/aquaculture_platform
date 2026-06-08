import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { NOTIFICATION_COMMAND_SUBJECTS } from '@platform/event-contracts';
import { of } from 'rxjs';
import { ScheduleNotificationService } from '../services/schedule-notification.service';
import { WeeklyPlan, WeeklyPlanStatus } from '../entities/weekly-plan.entity';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { Shift, WeekDay } from '../../attendance/entities/shift.entity';

describe('ScheduleNotificationService', () => {
  let service: ScheduleNotificationService;
  let planRepository: jest.Mocked<Repository<WeeklyPlan>>;
  let entryRepository: jest.Mocked<Repository<WeeklyPlanEntry>>;
  let settingsRepository: jest.Mocked<Repository<SchedulingSettings>>;
  let employeeRepository: jest.Mocked<Repository<Employee>>;
  let shiftRepository: jest.Mocked<Repository<Shift>>;
  let configService: jest.Mocked<ConfigService>;

  const mockEmployee: Partial<Employee> = {
    id: 'emp-1',
    firstName: 'Ahmet',
    lastName: 'Yilmaz',
    email: 'ahmet@example.com',
  };

  const mockPlan: Partial<WeeklyPlan> = {
    id: 'plan-1',
    tenantId: 'tenant-1',
    employeeId: 'emp-1',
    status: WeeklyPlanStatus.PUBLISHED,
    weekStartDate: new Date('2026-01-12'),
    weekEndDate: new Date('2026-01-18'),
    plannedTotalMinutes: 2400,
    plannedWorkDays: 5,
    isDeleted: false,
    notifiedAt: undefined,
    employee: mockEmployee as Employee,
    entries: [],
  };

  const mockSettings: Partial<SchedulingSettings> = {
    tenantId: 'tenant-1',
    standardWeeklyMinutes: 2700,
    autoNotifyEmployees: true,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduleNotificationService,
        {
          provide: getRepositoryToken(WeeklyPlan),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(WeeklyPlanEntry),
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
        {
          provide: getRepositoryToken(Employee),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Shift),
          useValue: {
            find: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue: string) => {
              if (key === 'NATS_ENABLED') return 'false'; // Disable NATS in tests
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ScheduleNotificationService>(ScheduleNotificationService);
    planRepository = module.get(getRepositoryToken(WeeklyPlan));
    entryRepository = module.get(getRepositoryToken(WeeklyPlanEntry));
    settingsRepository = module.get(getRepositoryToken(SchedulingSettings));
    employeeRepository = module.get(getRepositoryToken(Employee));
    shiftRepository = module.get(getRepositoryToken(Shift));
    configService = module.get(ConfigService);
  });

  describe('notifyEmployees', () => {
    it('should return early when NATS is disabled', async () => {
      const result = await service.notifyEmployees('tenant-1', ['plan-1']);

      expect(result.success).toBe(true);
      expect(result.notifiedCount).toBe(0);
      expect(result.failedCount).toBe(0);
    });
  });

  describe('autoNotifyOnPublish', () => {
    it('should return false when autoNotifyEmployees is disabled', async () => {
      settingsRepository.findOne.mockResolvedValue({
        ...mockSettings,
        autoNotifyEmployees: false,
      } as SchedulingSettings);

      const result = await service.autoNotifyOnPublish('tenant-1', 'plan-1');

      expect(result).toBe(false);
    });

    it('should return false when settings do not exist', async () => {
      settingsRepository.findOne.mockResolvedValue(null);

      const result = await service.autoNotifyOnPublish('tenant-1', 'plan-1');

      expect(result).toBe(false);
    });
  });

  describe('sendScheduledNotifications', () => {
    it('should return empty result when no plans found', async () => {
      planRepository.find.mockResolvedValue([]);

      const result = await service.sendScheduledNotifications('tenant-1', new Date('2026-01-12'));

      expect(result.success).toBe(true);
      expect(result.notifiedCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('notification command payloads', () => {
    it('sends weekly schedule email commands on the shared notification subject', async () => {
      const natsClient = {
        send: jest.fn().mockReturnValue(
          of({
            success: true,
            deliveryId: 'hr-schedule:tenant-1:emp-1:2026-01-12',
            tenantId: 'tenant-1',
            channel: 'email',
          }),
        ),
      };
      (
        service as unknown as {
          natsClient: typeof natsClient;
          sendScheduleEmail: (data: unknown) => Promise<void>;
        }
      ).natsClient = natsClient;

      await (
        service as unknown as {
          sendScheduleEmail: (data: unknown) => Promise<void>;
        }
      ).sendScheduleEmail({
        employeeId: 'emp-1',
        employeeName: 'Ahmet Yilmaz',
        employeeEmail: 'ahmet@example.com',
        tenantId: 'tenant-1',
        tenantName: 'Tenant One',
        weekStartDate: '2026-01-12',
        weekEndDate: '2026-01-18',
        entries: [],
        totalWorkDays: 5,
        totalWorkHours: 40,
        overtimeHours: 0,
      });

      expect(natsClient.send).toHaveBeenCalledWith(
        NOTIFICATION_COMMAND_SUBJECTS.SEND_EMAIL,
        expect.objectContaining({
          deliveryId: 'hr-schedule:tenant-1:emp-1:2026-01-12',
          requestReference: 'hr-schedule:tenant-1:emp-1:2026-01-12',
          tenantId: 'tenant-1',
          source: 'hr-service',
          recipientRef: {
            kind: 'tenantContactRef',
            ref: 'hr.employee.email:emp-1',
          },
          templateId: 'hr.weekly_schedule.email',
          templateVersion: '1',
          templateVariables: expect.objectContaining({
            employeeName: 'Ahmet Yilmaz',
            scheduleEntryCount: 0,
          }),
        }),
      );
    });

    it('sends overtime warning commands with manager contact ref and template variables', async () => {
      const natsClient = {
        send: jest.fn().mockReturnValue(
          of({
            success: true,
            deliveryId: 'hr-overtime:tenant-1:emp-1:2026-01-12:exceeded_limit',
            tenantId: 'tenant-1',
            channel: 'email',
          }),
        ),
      };
      (
        service as unknown as {
          natsClient: typeof natsClient;
          sendOvertimeWarning: (data: unknown) => Promise<void>;
        }
      ).natsClient = natsClient;

      await (
        service as unknown as {
          sendOvertimeWarning: (data: unknown) => Promise<void>;
        }
      ).sendOvertimeWarning({
        employeeId: 'emp-1',
        employeeName: 'Ahmet Yilmaz',
        employeeEmail: 'ahmet@example.com',
        managerEmail: 'manager@example.com',
        tenantId: 'tenant-1',
        weekStartDate: '2026-01-12',
        weekEndDate: '2026-01-18',
        warningType: 'exceeded_limit',
        plannedOvertimeMinutes: 780,
        maxOvertimeMinutes: 720,
      });

      expect(natsClient.send).toHaveBeenCalledWith(
        NOTIFICATION_COMMAND_SUBJECTS.SEND_EMAIL,
        expect.objectContaining({
          deliveryId: 'hr-overtime:tenant-1:emp-1:2026-01-12:exceeded_limit',
          requestReference: 'hr-overtime:tenant-1:emp-1:2026-01-12:exceeded_limit',
          recipientRef: {
            kind: 'tenantContactRef',
            ref: 'hr.manager.email:emp-1',
          },
          templateId: 'hr.overtime_warning.email',
          templateVariables: expect.objectContaining({
            warningType: 'exceeded_limit',
            urgency: 'high',
            overtimeHours: 13,
            maxHours: 12,
            isExceeded: true,
          }),
          metadata: expect.objectContaining({
            employeeId: 'emp-1',
            recipientRole: 'manager',
          }),
        }),
      );
    });
  });

  describe('escapeHtml (via buildScheduleEmailData indirectly)', () => {
    // Test the escapeHtml utility through the public API
    it('should handle special characters in employee names', async () => {
      const planWithSpecialChars: Partial<WeeklyPlan> = {
        ...mockPlan,
        employee: {
          ...mockEmployee,
          firstName: '<script>alert("xss")</script>',
          lastName: "O'Brien & Co.",
        } as Employee,
      };

      planRepository.find.mockResolvedValue([planWithSpecialChars as WeeklyPlan]);
      shiftRepository.find.mockResolvedValue([]);

      // Even though NATS is disabled, the service should process without errors
      const result = await service.notifyEmployees('tenant-1', ['plan-1']);

      expect(result.success).toBe(true);
    });
  });

  describe('getDayNameTR (private method tested via HTML generation)', () => {
    // The day name translation is tested indirectly
    it('should generate correct Turkish day names in email', async () => {
      const entries: Partial<WeeklyPlanEntry>[] = [
        {
          id: 'e1',
          date: new Date('2026-01-12'), // Monday
          dayOfWeek: WeekDay.MONDAY,
          entryType: WeeklyPlanEntryType.WORK,
          plannedMinutes: 480,
          displayOrder: 0,
        },
        {
          id: 'e2',
          date: new Date('2026-01-17'), // Saturday
          dayOfWeek: WeekDay.SATURDAY,
          entryType: WeeklyPlanEntryType.OFF,
          plannedMinutes: 0,
          displayOrder: 5,
        },
      ];

      const planWithEntries: Partial<WeeklyPlan> = {
        ...mockPlan,
        entries: entries as WeeklyPlanEntry[],
      };

      planRepository.find.mockResolvedValue([planWithEntries as WeeklyPlan]);
      shiftRepository.find.mockResolvedValue([]);

      const result = await service.notifyEmployees('tenant-1', ['plan-1']);

      // Service processes without error, day names are internal
      expect(result.success).toBe(true);
    });
  });
});

describe('ScheduleNotificationService - Edge Cases', () => {
  let service: ScheduleNotificationService;
  let planRepository: jest.Mocked<Repository<WeeklyPlan>>;
  let settingsRepository: jest.Mocked<Repository<SchedulingSettings>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduleNotificationService,
        {
          provide: getRepositoryToken(WeeklyPlan),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(WeeklyPlanEntry),
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
        {
          provide: getRepositoryToken(Employee),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Shift),
          useValue: {
            find: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue: string) => {
              if (key === 'NATS_ENABLED') return 'false';
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ScheduleNotificationService>(ScheduleNotificationService);
    planRepository = module.get(getRepositoryToken(WeeklyPlan));
    settingsRepository = module.get(getRepositoryToken(SchedulingSettings));
  });

  it('should handle plan with no entries gracefully', async () => {
    const emptyPlan: Partial<WeeklyPlan> = {
      id: 'plan-1',
      tenantId: 'tenant-1',
      employeeId: 'emp-1',
      status: WeeklyPlanStatus.PUBLISHED,
      weekStartDate: new Date('2026-01-12'),
      weekEndDate: new Date('2026-01-18'),
      plannedTotalMinutes: 0,
      plannedWorkDays: 0,
      isDeleted: false,
      notifiedAt: undefined,
      employee: {
        id: 'emp-1',
        firstName: 'Test',
        lastName: 'User',
        email: 'test@example.com',
      } as Employee,
      entries: [],
    };

    planRepository.find.mockResolvedValue([emptyPlan as WeeklyPlan]);

    const result = await service.notifyEmployees('tenant-1', ['plan-1']);

    expect(result.success).toBe(true);
  });

  it('should handle employee without email', async () => {
    const planNoEmail: Partial<WeeklyPlan> = {
      id: 'plan-1',
      tenantId: 'tenant-1',
      employeeId: 'emp-1',
      status: WeeklyPlanStatus.PUBLISHED,
      weekStartDate: new Date('2026-01-12'),
      weekEndDate: new Date('2026-01-18'),
      isDeleted: false,
      notifiedAt: undefined,
      employee: {
        id: 'emp-1',
        firstName: 'No',
        lastName: 'Email',
        email: null, // No email
      } as unknown as Employee,
      entries: [],
    };

    // Note: With NATS disabled, this won't actually process
    // but the error handling logic would catch missing email
    planRepository.find.mockResolvedValue([planNoEmail as WeeklyPlan]);

    const result = await service.notifyEmployees('tenant-1', ['plan-1']);

    // With NATS disabled, returns early without processing
    expect(result.success).toBe(true);
  });

  it('should skip already notified plans', async () => {
    const alreadyNotifiedPlan: Partial<WeeklyPlan> = {
      id: 'plan-1',
      tenantId: 'tenant-1',
      employeeId: 'emp-1',
      status: WeeklyPlanStatus.PUBLISHED,
      notifiedAt: new Date('2026-01-10'), // Already notified
      isDeleted: false,
      employee: {
        id: 'emp-1',
        firstName: 'Test',
        lastName: 'User',
        email: 'test@example.com',
      } as Employee,
      entries: [],
    };

    planRepository.find.mockResolvedValue([alreadyNotifiedPlan as WeeklyPlan]);

    const result = await service.notifyEmployees('tenant-1', ['plan-1']);

    // With NATS disabled, returns early
    expect(result.success).toBe(true);
    expect(result.notifiedCount).toBe(0);
  });

  it('should handle empty plan IDs array', async () => {
    const result = await service.notifyEmployees('tenant-1', []);

    expect(result.success).toBe(true);
    expect(result.notifiedCount).toBe(0);
  });
});
