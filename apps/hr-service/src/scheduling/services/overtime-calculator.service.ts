import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';
import { AttendanceRecord } from '../../attendance/entities/attendance-record.entity';
import { getJurisdictionPolicy } from './jurisdiction-policy';

export interface OvertimeCalculationResult {
  plannedMinutes: number;
  standardMinutes: number;
  overtimeMinutes: number;
  isOverLimit: boolean;
  weeklyLimit: number;
}

export interface ActualOvertimeResult {
  totalWorkedMinutes: number;
  standardMinutes: number;
  overtimeMinutes: number;
  recordCount: number;
}

@Injectable()
export class OvertimeCalculatorService {
  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
    @InjectRepository(SchedulingSettings)
    private readonly settingsRepository: Repository<SchedulingSettings>,
  ) {}

  /**
   * Calculate planned overtime from weekly plan entries
   */
  calculatePlannedOvertime(
    entries: WeeklyPlanEntry[],
    settings: SchedulingSettings,
  ): OvertimeCalculationResult {
    let plannedMinutes = 0;

    for (const entry of entries) {
      if (
        entry.entryType === WeeklyPlanEntryType.WORK ||
        entry.entryType === WeeklyPlanEntryType.TRAINING
      ) {
        plannedMinutes += entry.plannedMinutes;
      }
    }

    const standardMinutes = settings.standardWeeklyMinutes;
    const overtimeMinutes = Math.max(0, plannedMinutes - standardMinutes);
    const isOverLimit = overtimeMinutes > settings.maxOvertimeMinutesPerWeek;

    return {
      plannedMinutes,
      standardMinutes,
      overtimeMinutes,
      isOverLimit,
      weeklyLimit: settings.maxOvertimeMinutesPerWeek,
    };
  }

  /**
   * Calculate actual overtime from attendance records
   */
  async calculateActualOvertime(
    tenantId: string,
    employeeId: string,
    weekStart: Date,
    weekEnd: Date,
  ): Promise<ActualOvertimeResult> {
    const records = await this.attendanceRepository.find({
      where: {
        tenantId,
        employeeId,
        date: Between(weekStart, weekEnd),
        isDeleted: false,
      },
    });

    let totalWorkedMinutes = 0;
    let totalOvertimeMinutes = 0;

    for (const record of records) {
      totalWorkedMinutes += record.workedMinutes ?? 0;
      totalOvertimeMinutes += record.overtimeMinutes ?? 0;
    }

    const settings = await this.settingsRepository.findOne({ where: { tenantId } });
    // HR-HIGH-009: Use jurisdiction policy for configurable thresholds.
    // Falls back to tenant settings, then to jurisdiction default (TR = 2700).
    const policy = getJurisdictionPolicy(settings?.jurisdictionCode);
    const standardMinutes = settings?.standardWeeklyMinutes ?? policy.standardWeeklyMinutes;

    return {
      totalWorkedMinutes,
      standardMinutes,
      overtimeMinutes: totalOvertimeMinutes,
      recordCount: records.length,
    };
  }

  /**
   * Check monthly overtime limits
   */
  async checkMonthlyOvertimeLimits(
    tenantId: string,
    employeeId: string,
    month: number,
    year: number,
    additionalPlannedMinutes: number = 0,
  ): Promise<{
    currentMonthlyOvertime: number;
    monthlyLimit: number;
    remainingAllowance: number;
    wouldExceedLimit: boolean;
  }> {
    const settings = await this.settingsRepository.findOne({ where: { tenantId } });
    // HR-HIGH-009: Use jurisdiction policy for monthly overtime limit.
    const policy = getJurisdictionPolicy(settings?.jurisdictionCode);
    const monthlyLimit = settings?.maxOvertimeMinutesPerMonth ?? policy.maxOvertimeMinutesPerMonth;

    // Calculate first and last day of month
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);

    const records = await this.attendanceRepository.find({
      where: {
        tenantId,
        employeeId,
        date: Between(firstDay, lastDay),
        isDeleted: false,
      },
    });

    const currentMonthlyOvertime = records.reduce(
      (sum, r) => sum + (r.overtimeMinutes || 0),
      0,
    );

    const remainingAllowance = Math.max(0, monthlyLimit - currentMonthlyOvertime);
    const wouldExceedLimit =
      currentMonthlyOvertime + additionalPlannedMinutes > monthlyLimit;

    return {
      currentMonthlyOvertime,
      monthlyLimit,
      remainingAllowance,
      wouldExceedLimit,
    };
  }

  /**
   * Format minutes as hours string
   */
  formatMinutesAsHours(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
}
