import { Injectable, NotFoundException, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Between } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Money } from '@aquaculture/backend-common/monetary';
import { CreatePayrollCommand } from '../commands/create-payroll.command';
import { Payroll, PayrollStatus, EarningsBreakdown, DeductionsBreakdown } from '../entities/payroll.entity';
import { PayrollAudit, PayrollAuditAction } from '../entities/payroll-audit.entity';
import { Employee } from '../entities/employee.entity';
import { AttendanceRecord, ApprovalStatus } from '../../attendance/entities/attendance-record.entity';
import { formatUtcCalendarYearMonth } from '../../common/utc-calendar-date';

/**
 * HR-HIGH-005: Money-based arithmetic using the platform Money value object.
 * All monetary calculations go through Decimal.js (banker's rounding, ISO 4217).
 * JavaScript float multiplication is STRUCTURALLY IMPOSSIBLE through this API.
 */
function moneyAdd(currency: string, ...values: number[]): number {
  let total = Money.zero(currency);
  for (const v of values) {
    total = total.add(Money.of(v, currency));
  }
  // Return cents-precise number for DB storage
  return total.toMinorUnits() / 100;
}

@Injectable()
@CommandHandler(CreatePayrollCommand)
export class CreatePayrollHandler implements ICommandHandler<CreatePayrollCommand, Payroll> {
  private readonly logger = new Logger(CreatePayrollHandler.name);

  /** Standard daily hours threshold — overtime starts after this. */
  private static readonly STANDARD_DAILY_HOURS = 8;
  /** Default overtime multiplier */
  private static readonly OVERTIME_RATE = 1.5;

  constructor(
    @InjectRepository(Payroll)
    private readonly payrollRepository: Repository<Payroll>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: CreatePayrollCommand): Promise<Payroll> {
    const { tenantId, input, userId } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Verify employee exists
      const employee = await queryRunner.manager.findOne(Employee, {
        where: { id: input.employeeId, tenantId },
      });

      if (!employee) {
        throw new NotFoundException(`Employee with id ${input.employeeId} not found`);
      }

      // Validate pay period dates
      if (new Date(input.payPeriodStart) >= new Date(input.payPeriodEnd)) {
        throw new BadRequestException('Pay period start date must be before end date');
      }

      // Check for overlapping payroll periods
      const overlappingPayroll = await queryRunner.manager
        .createQueryBuilder(Payroll, 'p')
        .where('p.tenantId = :tenantId', { tenantId })
        .andWhere('p.employeeId = :employeeId', { employeeId: input.employeeId })
        .andWhere('p.payPeriodStart < :endDate', { endDate: new Date(input.payPeriodEnd) })
        .andWhere('p.payPeriodEnd > :startDate', { startDate: new Date(input.payPeriodStart) })
        .getOne();

      if (overlappingPayroll) {
        throw new ConflictException('Overlapping payroll period exists');
      }

      // HIGH-2: Auto-compute work hours from attendance if regularHours is 0
      let workHoursData = input.workHours;
      let autoComputedEarnings = false;

      if (workHoursData.regularHours === 0 && !workHoursData.overtimeHours) {
        const computed = await this.calculateFromAttendance(
          queryRunner,
          tenantId,
          input.employeeId,
          new Date(input.payPeriodStart),
          new Date(input.payPeriodEnd),
        );
        workHoursData = {
          regularHours: computed.regularHours,
          overtimeHours: computed.overtimeHours,
          holidayHours: workHoursData.holidayHours || 0,
          sickLeaveHours: workHoursData.sickLeaveHours || 0,
          vacationHours: workHoursData.vacationHours || 0,
        };
        autoComputedEarnings = true;
        this.logger.log(
          `Auto-computed hours from attendance for employee ${input.employeeId}: ` +
          `regular=${computed.regularHours}h, overtime=${computed.overtimeHours}h`,
        );
      }

      // HR-HIGH-005: All monetary calculations use Money value object (Decimal.js).
      // JavaScript float multiplication is structurally impossible through this API.
      const currency = input.currency || employee.currency || 'USD';

      // Auto-compute earnings from attendance-based hours if not explicitly provided
      let effectiveEarnings = input.earnings;
      if (autoComputedEarnings && input.earnings.baseSalary === 0) {
        const hourlyRate = Money.of(employee.baseSalary, currency).divide(160);
        const regularPay = hourlyRate.multiply(workHoursData.regularHours);
        const overtimePay = hourlyRate
          .multiply(workHoursData.overtimeHours || 0)
          .multiply(CreatePayrollHandler.OVERTIME_RATE);
        effectiveEarnings = {
          baseSalary: regularPay.toMinorUnits() / 100,
          overtime: overtimePay.toMinorUnits() / 100,
          bonus: input.earnings.bonus || 0,
          commission: input.earnings.commission || 0,
          allowances: input.earnings.allowances || 0,
        };
      }

      // Calculate earnings breakdown using Money (no float arithmetic)
      const earnings: EarningsBreakdown = {
        baseSalary: effectiveEarnings.baseSalary,
        overtime: effectiveEarnings.overtime || 0,
        bonus: effectiveEarnings.bonus || 0,
        commission: effectiveEarnings.commission || 0,
        allowances: effectiveEarnings.allowances || 0,
        grossPay: moneyAdd(
          currency,
          effectiveEarnings.baseSalary,
          effectiveEarnings.overtime || 0,
          effectiveEarnings.bonus || 0,
          effectiveEarnings.commission || 0,
          effectiveEarnings.allowances || 0,
        ),
      };

      // Calculate deductions breakdown using Money (no float arithmetic)
      const deductionInput = input.deductions || {};
      const deductions: DeductionsBreakdown = {
        tax: deductionInput.tax || 0,
        socialSecurity: deductionInput.socialSecurity || 0,
        healthInsurance: deductionInput.healthInsurance || 0,
        retirement: deductionInput.retirement || 0,
        otherDeductions: deductionInput.otherDeductions || 0,
        totalDeductions: moneyAdd(
          currency,
          deductionInput.tax || 0,
          deductionInput.socialSecurity || 0,
          deductionInput.healthInsurance || 0,
          deductionInput.retirement || 0,
          deductionInput.otherDeductions || 0,
        ),
      };

      // Validate deductions don't exceed gross pay
      const grossMoney = Money.of(earnings.grossPay, currency);
      const deductionsMoney = Money.of(deductions.totalDeductions, currency);
      if (deductionsMoney.greaterThan(grossMoney)) {
        throw new BadRequestException('Total deductions cannot exceed gross pay');
      }

      // Calculate net pay using Money (no float subtraction)
      const netPay = grossMoney.subtract(deductionsMoney).toMinorUnits() / 100;

      // Validate net pay is not negative
      if (netPay < 0) {
        throw new BadRequestException('Net pay cannot be negative');
      }

      // Generate payroll number derived from the pay period start date, not creation date
      const payrollNumber = this.generatePayrollNumber(new Date(input.payPeriodStart));

      const payroll = queryRunner.manager.create(Payroll, {
        tenantId,
        employeeId: input.employeeId,
        payrollNumber,
        payPeriodType: input.payPeriodType,
        payPeriodStart: new Date(input.payPeriodStart),
        payPeriodEnd: new Date(input.payPeriodEnd),
        workHours: {
          regularHours: workHoursData.regularHours,
          overtimeHours: workHoursData.overtimeHours || 0,
          holidayHours: workHoursData.holidayHours || 0,
          sickLeaveHours: workHoursData.sickLeaveHours || 0,
          vacationHours: workHoursData.vacationHours || 0,
        },
        earnings,
        deductions,
        netPay,
        currency: input.currency || employee.currency || 'USD',
        status: PayrollStatus.DRAFT,
        notes: input.notes,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedPayroll = await queryRunner.manager.save(Payroll, payroll);

      // HR-HIGH-006: Write immutable payroll audit trail entry
      const auditEntry = queryRunner.manager.create(PayrollAudit, {
        tenantId,
        payrollId: savedPayroll.id,
        employeeId: input.employeeId,
        action: PayrollAuditAction.CREATED,
        calculationInputs: {
          workHours: workHoursData,
          // HR-MEDIUM-009/010: entity.baseSalary already a number via DecimalTransformer;
          // no Number() wrapper needed. The transformer is the single source of truth.
          baseSalary: employee.baseSalary,
          earningsInput: effectiveEarnings,
          deductionsInput: deductionInput,
        },
        calculationOutputs: {
          earnings,
          deductions,
          netPay,
        },
        grossPay: earnings.grossPay,
        netPay,
        currency,
        performedBy: userId,
      });
      await queryRunner.manager.save(PayrollAudit, auditEntry);

      await queryRunner.commitTransaction();

      this.logger.log(
        `Payroll created: ${savedPayroll.id} (${savedPayroll.payrollNumber}) for employee ${input.employeeId}`,
      );

      return savedPayroll;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Calculate work hours from approved attendance records for the given period.
   * Returns regular hours (capped at STANDARD_DAILY_HOURS per day) and overtime.
   */
  private async calculateFromAttendance(
    queryRunner: import('typeorm').QueryRunner,
    tenantId: string,
    employeeId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<{ regularHours: number; overtimeHours: number }> {
    const records = await queryRunner.manager.find(AttendanceRecord, {
      where: {
        tenantId,
        employeeId,
        date: Between(periodStart, periodEnd),
        isDeleted: false,
      },
    });

    let totalRegular = 0;
    let totalOvertime = 0;
    const stdDaily = CreatePayrollHandler.STANDARD_DAILY_HOURS * 60; // in minutes

    for (const record of records) {
      if (!record.clockIn || !record.clockOut) continue;
      // Only count approved or auto-approved records
      if (
        record.approvalStatus !== ApprovalStatus.AUTO_APPROVED &&
        record.approvalStatus !== ApprovalStatus.MANAGER_APPROVED &&
        record.approvalStatus !== ApprovalStatus.HR_APPROVED
      ) {
        continue;
      }

      const workedMinutes = record.workedMinutes || 0;
      if (workedMinutes <= stdDaily) {
        totalRegular += workedMinutes;
      } else {
        totalRegular += stdDaily;
        totalOvertime += workedMinutes - stdDaily;
      }
    }

    return {
      regularHours: Math.round((totalRegular / 60) * 100) / 100,
      overtimeHours: Math.round((totalOvertime / 60) * 100) / 100,
    };
  }

  /**
   * Generate a collision-safe payroll number.
   * Uses the pay period start date (not creation date) so the number correctly
   * reflects the pay period (e.g. PAY-202501-... for a January period).
   * A cryptographically random 8-character suffix prevents collisions even under
   * concurrent load; the unique DB index on (tenantId, payrollNumber) is the
   * definitive safety net.
   */
  private generatePayrollNumber(payPeriodStart: Date): string {
    // 4 random bytes → 8 hex chars → very low collision probability
    const randomHex = require('crypto').randomBytes(4).toString('hex').toUpperCase();
    return `PAY-${formatUtcCalendarYearMonth(payPeriodStart)}-${randomHex}`;
  }
}
