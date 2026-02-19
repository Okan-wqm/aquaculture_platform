import { Injectable, NotFoundException, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CreatePayrollCommand } from '../commands/create-payroll.command';
import { Payroll, PayrollStatus, EarningsBreakdown, DeductionsBreakdown } from '../entities/payroll.entity';
import { Employee } from '../entities/employee.entity';

@Injectable()
@CommandHandler(CreatePayrollCommand)
export class CreatePayrollHandler implements ICommandHandler<CreatePayrollCommand, Payroll> {
  private readonly logger = new Logger(CreatePayrollHandler.name);

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

      // Calculate earnings breakdown
      const earnings: EarningsBreakdown = {
        baseSalary: input.earnings.baseSalary,
        overtime: input.earnings.overtime || 0,
        bonus: input.earnings.bonus || 0,
        commission: input.earnings.commission || 0,
        allowances: input.earnings.allowances || 0,
        grossPay:
          input.earnings.baseSalary +
          (input.earnings.overtime || 0) +
          (input.earnings.bonus || 0) +
          (input.earnings.commission || 0) +
          (input.earnings.allowances || 0),
      };

      // Calculate deductions breakdown
      const deductionInput = input.deductions || {};
      const deductions: DeductionsBreakdown = {
        tax: deductionInput.tax || 0,
        socialSecurity: deductionInput.socialSecurity || 0,
        healthInsurance: deductionInput.healthInsurance || 0,
        retirement: deductionInput.retirement || 0,
        otherDeductions: deductionInput.otherDeductions || 0,
        totalDeductions:
          (deductionInput.tax || 0) +
          (deductionInput.socialSecurity || 0) +
          (deductionInput.healthInsurance || 0) +
          (deductionInput.retirement || 0) +
          (deductionInput.otherDeductions || 0),
      };

      // Validate deductions don't exceed gross pay
      if (deductions.totalDeductions > earnings.grossPay) {
        throw new BadRequestException('Total deductions cannot exceed gross pay');
      }

      // Calculate net pay
      const netPay = earnings.grossPay - deductions.totalDeductions;

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
          regularHours: input.workHours.regularHours,
          overtimeHours: input.workHours.overtimeHours || 0,
          holidayHours: input.workHours.holidayHours || 0,
          sickLeaveHours: input.workHours.sickLeaveHours || 0,
          vacationHours: input.workHours.vacationHours || 0,
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
   * Generate a collision-safe payroll number.
   * Uses the pay period start date (not creation date) so the number correctly
   * reflects the pay period (e.g. PAY-202501-... for a January period).
   * A cryptographically random 8-character suffix prevents collisions even under
   * concurrent load; the unique DB index on (tenantId, payrollNumber) is the
   * definitive safety net.
   */
  private generatePayrollNumber(payPeriodStart: Date): string {
    const year = payPeriodStart.getFullYear();
    const month = String(payPeriodStart.getMonth() + 1).padStart(2, '0');
    // 4 random bytes → 8 hex chars → very low collision probability
    const randomHex = require('crypto').randomBytes(4).toString('hex').toUpperCase();
    return `PAY-${year}${month}-${randomHex}`;
  }
}
