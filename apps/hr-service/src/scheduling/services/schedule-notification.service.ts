import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';

// Optional microservices support - stub interface when module not available
interface ClientProxy {
  emit(pattern: string, data: unknown): void;
}
import { WeeklyPlan, WeeklyPlanStatus } from '../entities/weekly-plan.entity';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { Shift } from '../../attendance/entities/shift.entity';

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
  private natsClient: ClientProxy | null = null;
  private readonly isEnabled: boolean;

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
  ) {
    this.isEnabled = this.configService.get('NATS_ENABLED', 'true') === 'true';

    if (this.isEnabled) {
      this.initializeNatsClient();
    } else {
      this.logger.warn('Schedule notification service disabled (NATS not enabled)');
    }
  }

  /**
   * Initialize NATS client for microservice communication
   * Note: Notifications are disabled when @nestjs/microservices is not available
   */
  private initializeNatsClient(): void {
    // NATS notifications are disabled - @nestjs/microservices not available
    // To enable, add @nestjs/microservices to dependencies and implement client creation
    this.logger.warn('Schedule notifications disabled - microservices module not configured');
    this.natsClient = null;
  }

  /**
   * Notify employees about their published weekly schedules
   *
   * @param tenantId - Tenant ID
   * @param weeklyPlanIds - Array of plan IDs to notify
   * @returns NotificationResult with success/failure details
   */
  async notifyEmployees(
    tenantId: string,
    weeklyPlanIds: string[],
  ): Promise<NotificationResult> {
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
            employeeName: `${employee?.firstName || ''} ${employee?.lastName || ''}`.trim() || 'Unknown',
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
        await this.planRepository.update(
          { id: plan.id, tenantId },
          { notifiedAt: new Date() },
        );

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
  async autoNotifyOnPublish(
    tenantId: string,
    planId: string,
  ): Promise<boolean> {
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
    const shiftIds = plan.entries
      ?.filter((e) => e.shiftId)
      .map((e) => e.shiftId!) || [];

    const shifts = shiftIds.length > 0
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
          startTime: (entry.plannedStartTime instanceof Date ? entry.plannedStartTime.toISOString() : entry.plannedStartTime) || shift?.startTime?.toString().slice(0, 5),
          endTime: (entry.plannedEndTime instanceof Date ? entry.plannedEndTime.toISOString() : entry.plannedEndTime) || shift?.endTime?.toString().slice(0, 5),
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
      weekStartDate: plan.weekStartDate.toISOString().split('T')[0]!,
      weekEndDate: plan.weekEndDate.toISOString().split('T')[0]!,
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

    const emailPayload = {
      type: 'schedule_notification',
      to: data.employeeEmail,
      subject: this.buildEmailSubject(data),
      template: 'weekly_schedule',
      data: {
        ...data,
        // Add formatted schedule table for template
        scheduleTableHtml: this.generateScheduleTableHtml(data.entries),
      },
    };

    try {
      // Emit async notification event
      this.natsClient.emit('notification.email.send', emailPayload);
      this.logger.debug(`Schedule email event emitted for ${data.employeeEmail}`);
    } catch (error) {
      this.logger.error(`Failed to emit notification event: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Build email subject line
   */
  private buildEmailSubject(data: ScheduleEmailData): string {
    const weekStartFormatted = this.formatDateTR(new Date(data.weekStartDate));
    const weekEndFormatted = this.formatDateTR(new Date(data.weekEndDate));
    return `Haftalik Calisma Programiniz: ${weekStartFormatted} - ${weekEndFormatted}`;
  }

  /**
   * Generate HTML table for schedule entries
   */
  private generateScheduleTableHtml(entries: ScheduleEntryData[]): string {
    const rows = entries
      .map((entry) => {
        let cellContent: string;
        let cellClass: string;

        switch (entry.entryType) {
          case 'off':
            cellContent = 'TATIL';
            cellClass = 'off';
            break;
          case 'leave':
            cellContent = 'IZIN';
            cellClass = 'leave';
            break;
          case 'holiday':
            cellContent = 'RESMI TATIL';
            cellClass = 'holiday';
            break;
          case 'training':
            cellContent = `EGITIM${entry.startTime ? ` (${entry.startTime}-${entry.endTime})` : ''}`;
            cellClass = 'training';
            break;
          case 'work':
          default:
            cellContent = entry.startTime && entry.endTime
              ? `${entry.startTime} - ${entry.endTime}`
              : entry.shiftCode || 'MESAI';
            cellClass = 'work';
        }

        return `
          <tr>
            <td class="day-name">${this.escapeHtml(entry.dayNameTR)}</td>
            <td class="date">${this.escapeHtml(this.formatDateShort(new Date(entry.date)))}</td>
            <td class="schedule ${cellClass}">${this.escapeHtml(cellContent)}</td>
          </tr>
        `;
      })
      .join('');

    return `
      <table class="schedule-table">
        <thead>
          <tr>
            <th>Gun</th>
            <th>Tarih</th>
            <th>Program</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
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

  /**
   * Format date as short string (e.g., "13 Oca")
   */
  private formatDateShort(date: Date): string {
    return date.toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'short',
    });
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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

    let subject: string;
    let urgency: 'low' | 'medium' | 'high';

    switch (data.warningType) {
      case 'exceeded_limit':
        subject = `UYARI: Haftalik Fazla Mesai Limiti Asildi (${overtimeHours}/${maxHours} saat)`;
        urgency = 'high';
        break;
      case 'monthly_limit':
        subject = `UYARI: Aylik Fazla Mesai Limitine Yaklasiliyor`;
        urgency = 'high';
        break;
      case 'approaching_limit':
      default:
        subject = `Bilgi: Haftalik Fazla Mesai Limitine Yaklasiliyor (${overtimeHours}/${maxHours} saat)`;
        urgency = 'medium';
    }

    const emailPayload = {
      type: 'overtime_warning',
      to: data.managerEmail || data.employeeEmail, // Send to manager if available
      cc: data.managerEmail ? data.employeeEmail : undefined,
      subject,
      template: 'overtime_warning',
      urgency,
      data: {
        ...data,
        overtimeHours,
        maxHours,
        weekStartFormatted: this.formatDateTR(new Date(data.weekStartDate)),
        weekEndFormatted: this.formatDateTR(new Date(data.weekEndDate)),
        isExceeded: data.warningType === 'exceeded_limit',
        warningMessage: this.getOvertimeWarningMessage(data.warningType, overtimeHours, maxHours),
      },
    };

    try {
      this.natsClient.emit('notification.email.send', emailPayload);
      this.logger.debug(`Overtime warning event emitted for ${data.employeeName}`);
    } catch (error) {
      throw new Error(`Failed to emit overtime warning: ${(error as Error).message}`);
    }
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
        return `Planlanan fazla mesai suresi (${overtimeHours} saat), haftalik limit olan ${maxHours} saati asti. ` +
          `Lutfen planlamayı gozden gecirin veya onay alin.`;
      case 'monthly_limit':
        return `Aylik fazla mesai limiti yaklasiliyor. Lutfen aylik toplami kontrol edin.`;
      case 'approaching_limit':
      default:
        return `Planlanan fazla mesai suresi (${overtimeHours} saat), haftalik limitin %80'ine (${maxHours} saat) ulasti. ` +
          `Ek mesai planlamasi dikkatli yapin.`;
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
