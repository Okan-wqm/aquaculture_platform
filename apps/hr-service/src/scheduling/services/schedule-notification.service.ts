import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import {
  NOTIFICATION_COMMAND_SUBJECTS,
  type NotificationSendEmailCommand,
  type NotificationSendResult,
} from '@platform/event-contracts';
import { firstValueFrom, timeout } from 'rxjs';
import { Repository, In, IsNull } from 'typeorm';

import { Shift } from '../../attendance/entities/shift.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';
import { WeeklyPlanEntry } from '../entities/weekly-plan-entry.entity';
import { WeeklyPlan, WeeklyPlanStatus } from '../entities/weekly-plan.entity';

/**
 * Data structure for schedule email notification
 */
export interface ScheduleEmailData {
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  tenantId: string;
  tenantName?: string;
  weekStartDate: string;
  weekEndDate: string;
  entries: ScheduleEntryData[];
  totalWorkDays: number;
  totalWorkHours: number;
  overtimeHours: number;
  notes?: string;
}

export interface ScheduleEntryData {
  date: string;
  dayOfWeek: string;
  dayNameTR: string;
  entryType: string;
  shiftName?: string;
  shiftCode?: string;
  startTime?: string;
  endTime?: string;
  totalHours?: number;
}

/**
 * Result of notification operation
 */
export interface NotificationResult {
  success: boolean;
  notifiedCount: number;
  failedCount: number;
  errors: NotificationError[];
  notifiedAt?: Date;
}

export interface NotificationError {
  employeeId: string;
  employeeName: string;
  error: string;
}

/**
 * Overtime warning notification data
 */
export interface OvertimeWarningData {
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  managerEmail?: string;
  tenantId: string;
  weekStartDate: string;
  weekEndDate: string;
  warningType: 'approaching_limit' | 'exceeded_limit' | 'monthly_limit';
  plannedOvertimeMinutes: number;
  maxOvertimeMinutes: number;
  currentMonthlyMinutes?: number;
  maxMonthlyMinutes?: number;
}

/**
 * Schedule Notification Service
 *
 * Handles sending weekly schedule notifications to employees via email.
 * Integrates with the notification-service microservice via NATS messaging.
 *
 * Workflow:
 * 1. Plan is published (status: DRAFT -> PUBLISHED)
 * 2. If autoNotifyEmployees is enabled in settings, notification is triggered
 * 3. Employee receives email with their weekly schedule
 * 4. Plan's notifiedAt timestamp is updated
 */
@Injectable()
export class ScheduleNotificationService {
  private readonly logger = new Logger(ScheduleNotificationService.name);
  private readonly isEnabled: boolean;
  private readonly notificationCommandTimeoutMs: number;

  constructor(
    @InjectRepository(WeeklyPlan)
    private readonly planRepository: Repository<WeeklyPlan>,
    @InjectRepository(WeeklyPlanEntry)
    private readonly entryRepository: Repository<WeeklyPlanEntry>,
    @InjectRepository(SchedulingSettings)
    private readonly settingsRepository: Repository<SchedulingSettings>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
    private readonly configService: ConfigService,
    @Optional()
    @Inject('NATS_SERVICE')
    private readonly natsClient?: ClientProxy,
  ) {
    this.isEnabled = this.configService.get('NATS_ENABLED', 'true') === 'true';
    const configuredTimeout = Number.parseInt(
      this.configService.get<string>('NOTIFICATION_COMMAND_TIMEOUT_MS', '10000'),
      10,
    );
    this.notificationCommandTimeoutMs = Number.isFinite(configuredTimeout)
      ? configuredTimeout
      : 10_000;

    if (!this.isEnabled) {
      this.logger.warn('Schedule notification service disabled (NATS not enabled)');
    } else if (!this.natsClient) {
      this.logger.error(
        'Schedule notification service enabled but NATS_SERVICE client is not registered',
      );
    }
  }

  /**
   * Notify employees about their published weekly schedules
   *
   * @param tenantId - Tenant ID
   * @param weeklyPlanIds - Array of plan IDs to notify
   * @returns NotificationResult with success/failure details
   */
  async notifyEmployees(tenantId: string, weeklyPlanIds: string[]): Promise<NotificationResult> {
    const result: NotificationResult = {
      success: true,
      notifiedCount: 0,
      failedCount: 0,
      errors: [],
    };

    if (!this.isEnabled || !this.natsClient) {
      this.logger.warn('Notification service disabled, skipping notifications');
      return result;
    }

    // Fetch all plans with related data
    const plans = await this.planRepository.find({
      where: {
        id: In(weeklyPlanIds),
        tenantId,
        status: WeeklyPlanStatus.PUBLISHED,
        isDeleted: false,
      },
      relations: ['entries', 'employee'],
    });

    if (plans.length === 0) {
      this.logger.warn('No published plans found for notification');
      return result;
    }

    // Get settings for tenant
    const settings = await this.settingsRepository.findOne({ where: { tenantId } });

    // Process each plan
    for (const plan of plans) {
      try {
        // Skip if already notified
        if (plan.notifiedAt) {
          this.logger.debug(`Plan ${plan.id} already notified at ${plan.notifiedAt}`);
          continue;
        }

        // Skip if employee has no email
        const employee = plan.employee;
        if (!employee?.email) {
          result.errors.push({
            employeeId: plan.employeeId,
            employeeName:
              `${employee?.firstName || ''} ${employee?.lastName || ''}`.trim() || 'Unknown',
            error: 'Employee email not found',
          });
          result.failedCount++;
          continue;
        }

        // Build notification data
        const emailData = await this.buildScheduleEmailData(plan, employee, settings);

        // Send notification via NATS
        await this.sendScheduleEmail(emailData);

        // Update plan's notifiedAt
        await this.planRepository.update({ id: plan.id, tenantId }, { notifiedAt: new Date() });

        result.notifiedCount++;
        this.logger.log(`Schedule notification sent for plan ${plan.id} to ${employee.email}`);
      } catch (error) {
        const errorMessage = (error as Error).message;
        this.logger.error(`Failed to notify for plan ${plan.id}: ${errorMessage}`);

        result.errors.push({
          employeeId: plan.employeeId,
          employeeName: `${plan.employee?.firstName || ''} ${plan.employee?.lastName || ''}`.trim(),
          error: errorMessage,
        });
        result.failedCount++;
        result.success = false;
      }
    }

    result.notifiedAt = new Date();
    return result;
  }

  /**
   * Auto-notify on plan publish if settings allow
   * Called from PublishWeeklyPlanHandler after successful publish
   */
  async autoNotifyOnPublish(tenantId: string, planId: string): Promise<boolean> {
    const settings = await this.settingsRepository.findOne({ where: { tenantId } });

    if (!settings?.autoNotifyEmployees) {
      this.logger.debug('Auto-notify disabled for tenant');
      return false;
    }

    const result = await this.notifyEmployees(tenantId, [planId]);
    return result.notifiedCount > 0;
  }

  /**
   * Send scheduled batch notifications
   * Called by a cron job based on notifyDaysBefore setting
   */
  async sendScheduledNotifications(
    tenantId: string,
    weekStartDate: Date,
  ): Promise<NotificationResult> {
    // Find all published but not yet notified plans for the given week
    const plans = await this.planRepository.find({
      where: {
        tenantId,
        weekStartDate,
        status: WeeklyPlanStatus.PUBLISHED,
        notifiedAt: IsNull(),
        isDeleted: false,
      },
    });

    if (plans.length === 0) {
      return {
        success: true,
        notifiedCount: 0,
        failedCount: 0,
        errors: [],
      };
    }

    return this.notifyEmployees(
      tenantId,
      plans.map((p) => p.id),
    );
  }

  /**
   * Build the email data structure for a schedule notification
   */
  private async buildScheduleEmailData(
    plan: WeeklyPlan,
    employee: Employee,
    settings?: SchedulingSettings | null,
  ): Promise<ScheduleEmailData> {
    // Load shift details for entries
    const shiftIds = plan.entries?.filter((e) => e.shiftId).map((e) => e.shiftId!) || [];

    const shifts =
      shiftIds.length > 0
        ? await this.shiftRepository.find({
            where: { id: In(shiftIds) },
          })
        : [];

    const shiftMap = new Map(shifts.map((s) => [s.id, s]));

    // Build entry data
    const entries: ScheduleEntryData[] = (plan.entries || [])
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((entry) => {
        const shift = entry.shiftId ? shiftMap.get(entry.shiftId) : undefined;

        return {
          date: entry.date.toISOString().split('T')[0]!,
          dayOfWeek: entry.dayOfWeek,
          dayNameTR: this.getDayNameTR(entry.dayOfWeek),
          entryType: entry.entryType,
          shiftName: shift?.name,
          shiftCode: shift?.code,
          startTime:
            (entry.plannedStartTime instanceof Date
              ? entry.plannedStartTime.toISOString()
              : entry.plannedStartTime) || shift?.startTime?.toString().slice(0, 5),
          endTime:
            (entry.plannedEndTime instanceof Date
              ? entry.plannedEndTime.toISOString()
              : entry.plannedEndTime) || shift?.endTime?.toString().slice(0, 5),
          totalHours: entry.plannedMinutes > 0 ? entry.plannedMinutes / 60 : undefined,
        };
      });

    // Calculate totals
    const standardMinutes = settings?.standardWeeklyMinutes ?? 2700;
    const overtimeMinutes = Math.max(0, plan.plannedTotalMinutes - standardMinutes);

    return {
      employeeId: employee.id,
      employeeName: `${employee.firstName} ${employee.lastName}`,
      employeeEmail: employee.email!,
      tenantId: plan.tenantId,
      weekStartDate: plan.weekStartDate.toISOString().split('T')[0],
      weekEndDate: plan.weekEndDate.toISOString().split('T')[0],
      entries,
      totalWorkDays: plan.plannedWorkDays,
      totalWorkHours: Math.round((plan.plannedTotalMinutes / 60) * 10) / 10,
      overtimeHours: Math.round((overtimeMinutes / 60) * 10) / 10,
      notes: plan.notes || undefined,
    };
  }

  /**
   * Send schedule email via NATS to notification service
   */
  private async sendScheduleEmail(data: ScheduleEmailData): Promise<void> {
    if (!this.natsClient) {
      throw new Error('NATS client not initialized');
    }

    const requestReference = `hr-schedule:${data.tenantId}:${data.employeeId}:${data.weekStartDate}`;
    const emailPayload: NotificationSendEmailCommand = {
      deliveryId: requestReference,
      requestReference,
      tenantId: data.tenantId,
      source: 'hr-service',
      recipientRef: {
        kind: 'tenantContactRef',
        ref: `hr.employee.email:${data.employeeId}`,
      },
      templateId: 'hr.weekly_schedule.email',
      templateVersion: '1',
      templateVariables: {
        employeeName: data.employeeName,
        tenantName: data.tenantName ?? null,
        weekStartDate: data.weekStartDate,
        weekEndDate: data.weekEndDate,
        totalWorkDays: data.totalWorkDays,
        totalWorkHours: data.totalWorkHours,
        overtimeHours: data.overtimeHours,
        notes: data.notes ?? null,
        scheduleEntryCount: data.entries.length,
      },
      metadata: {
        type: 'schedule_notification',
        employeeId: data.employeeId,
      },
    };

    try {
      const result = await this.sendNotificationCommand(emailPayload);
      if (!result.success) {
        throw new Error(result.error ?? 'Notification command failed');
      }
      this.logger.debug(`Schedule email command accepted for employee ${data.employeeId}`);
    } catch (error) {
      this.logger.error(`Failed to send notification command: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Get Turkish day name
   */
  private getDayNameTR(day: string): string {
    const names: Record<string, string> = {
      monday: 'Pazartesi',
      tuesday: 'Sali',
      wednesday: 'Carsamba',
      thursday: 'Persembe',
      friday: 'Cuma',
      saturday: 'Cumartesi',
      sunday: 'Pazar',
    };
    return names[day.toLowerCase()] || day;
  }

  /**
   * Format date in Turkish locale
   */
  private formatDateTR(date: Date): string {
    return date.toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'long',
    });
  }

  // =====================
  // Overtime Warnings
  // =====================

  /**
   * Check and send overtime warning if plan exceeds thresholds
   * Called after plan updates or bulk assignments
   *
   * @param tenantId - Tenant ID
   * @param planId - Weekly plan ID to check
   * @param warningThreshold - Percentage of max overtime to trigger warning (default 80%)
   */
  async checkAndSendOvertimeWarning(
    tenantId: string,
    planId: string,
    warningThreshold: number = 0.8,
  ): Promise<boolean> {
    if (!this.isEnabled) {
      return false;
    }

    const plan = await this.planRepository.findOne({
      where: { id: planId, tenantId, isDeleted: false },
      relations: ['employee'],
    });

    if (!plan || !plan.employee) {
      return false;
    }

    const settings = await this.settingsRepository.findOne({ where: { tenantId } });
    const maxWeeklyOvertimeMinutes = settings?.maxOvertimeMinutesPerWeek ?? 720; // 12 hours default
    const standardMinutes = settings?.standardWeeklyMinutes ?? 2700; // 45 hours default

    const overtimeMinutes = Math.max(0, plan.plannedTotalMinutes - standardMinutes);

    // Check if overtime exceeds or approaches limit
    let warningType: OvertimeWarningData['warningType'] | null = null;

    if (overtimeMinutes > maxWeeklyOvertimeMinutes) {
      warningType = 'exceeded_limit';
    } else if (overtimeMinutes >= maxWeeklyOvertimeMinutes * warningThreshold) {
      warningType = 'approaching_limit';
    }

    if (!warningType) {
      return false;
    }

    const warningData: OvertimeWarningData = {
      employeeId: plan.employee.id,
      employeeName: `${plan.employee.firstName} ${plan.employee.lastName}`,
      employeeEmail: plan.employee.email || '',
      tenantId,
      weekStartDate: plan.weekStartDate.toISOString().split('T')[0]!,
      weekEndDate: plan.weekEndDate.toISOString().split('T')[0]!,
      warningType,
      plannedOvertimeMinutes: overtimeMinutes,
      maxOvertimeMinutes: maxWeeklyOvertimeMinutes,
    };

    try {
      await this.sendOvertimeWarning(warningData);
      this.logger.warn(
        `Overtime warning sent: ${warningType} for employee ${plan.employee.id} ` +
          `(${overtimeMinutes}/${maxWeeklyOvertimeMinutes} minutes)`,
      );
      return true;
    } catch (error) {
      this.logger.error(`Failed to send overtime warning: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Send overtime warning notification via NATS
   */
  private async sendOvertimeWarning(data: OvertimeWarningData): Promise<void> {
    if (!this.natsClient) {
      this.logger.warn('NATS client not available, overtime warning not sent');
      return;
    }

    const overtimeHours = Math.round((data.plannedOvertimeMinutes / 60) * 10) / 10;
    const maxHours = Math.round((data.maxOvertimeMinutes / 60) * 10) / 10;

    let urgency: 'low' | 'medium' | 'high';

    switch (data.warningType) {
      case 'exceeded_limit':
        urgency = 'high';
        break;
      case 'monthly_limit':
        urgency = 'high';
        break;
      case 'approaching_limit':
      default:
        urgency = 'medium';
    }

    const requestReference = `hr-overtime:${data.tenantId}:${data.employeeId}:${data.weekStartDate}:${data.warningType}`;
    const emailPayload: NotificationSendEmailCommand = {
      deliveryId: requestReference,
      requestReference,
      tenantId: data.tenantId,
      source: 'hr-service',
      recipientRef: {
        kind: 'tenantContactRef',
        ref: data.managerEmail
          ? `hr.manager.email:${data.employeeId}`
          : `hr.employee.email:${data.employeeId}`,
      },
      templateId: 'hr.overtime_warning.email',
      templateVersion: '1',
      templateVariables: {
        employeeName: data.employeeName,
        weekStartDate: data.weekStartDate,
        weekEndDate: data.weekEndDate,
        warningType: data.warningType,
        plannedOvertimeMinutes: data.plannedOvertimeMinutes,
        maxOvertimeMinutes: data.maxOvertimeMinutes,
        currentMonthlyMinutes: data.currentMonthlyMinutes ?? null,
        maxMonthlyMinutes: data.maxMonthlyMinutes ?? null,
        urgency,
        overtimeHours,
        maxHours,
        weekStartFormatted: this.formatDateTR(new Date(data.weekStartDate)),
        weekEndFormatted: this.formatDateTR(new Date(data.weekEndDate)),
        isExceeded: data.warningType === 'exceeded_limit',
        warningMessage: this.getOvertimeWarningMessage(data.warningType, overtimeHours, maxHours),
      },
      metadata: {
        type: 'overtime_warning',
        urgency,
        employeeId: data.employeeId,
        recipientRole: data.managerEmail ? 'manager' : 'employee',
      },
    };

    try {
      const result = await this.sendNotificationCommand(emailPayload);
      if (!result.success) {
        throw new Error(result.error ?? 'Notification command failed');
      }
      this.logger.debug(`Overtime warning command accepted for employee ${data.employeeId}`);
    } catch (error) {
      throw new Error(`Failed to send overtime warning: ${(error as Error).message}`);
    }
  }

  private async sendNotificationCommand(
    command: NotificationSendEmailCommand,
  ): Promise<NotificationSendResult> {
    if (!this.natsClient) {
      throw new Error('NATS client not initialized');
    }
    return firstValueFrom(
      this.natsClient
        .send<
          NotificationSendResult,
          NotificationSendEmailCommand
        >(NOTIFICATION_COMMAND_SUBJECTS.SEND_EMAIL, command)
        .pipe(timeout(this.notificationCommandTimeoutMs)),
    ) as Promise<NotificationSendResult>;
  }

  /**
   * Get localized overtime warning message
   */
  private getOvertimeWarningMessage(
    warningType: OvertimeWarningData['warningType'],
    overtimeHours: number,
    maxHours: number,
  ): string {
    switch (warningType) {
      case 'exceeded_limit':
        return (
          `Planlanan fazla mesai suresi (${overtimeHours} saat), haftalik limit olan ${maxHours} saati asti. ` +
          `Lutfen planlamayı gozden gecirin veya onay alin.`
        );
      case 'monthly_limit':
        return `Aylik fazla mesai limiti yaklasiliyor. Lutfen aylik toplami kontrol edin.`;
      case 'approaching_limit':
      default:
        return (
          `Planlanan fazla mesai suresi (${overtimeHours} saat), haftalik limitin %80'ine (${maxHours} saat) ulasti. ` +
          `Ek mesai planlamasi dikkatli yapin.`
        );
    }
  }

  /**
   * Batch check overtime warnings for multiple plans
   * Useful for bulk operations
   */
  async batchCheckOvertimeWarnings(
    tenantId: string,
    planIds: string[],
  ): Promise<{ warned: number; skipped: number }> {
    let warned = 0;
    let skipped = 0;

    for (const planId of planIds) {
      const wasSent = await this.checkAndSendOvertimeWarning(tenantId, planId);
      if (wasSent) {
        warned++;
      } else {
        skipped++;
      }
    }

    return { warned, skipped };
  }
}
