import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  ) {}

  async execute(command: CreatePayrollCommand): Promise<Payroll> {
    const { tenantId, input, userId } = command;

    // Verify employee exists
    const employee = await this.employeeRepository.findOne({
      where: { id: input.employeeId, tenantId },
    });

    if (!employee) {
      throw new NotFoundException(`Employee with id ${input.employeeId} not found`);
    }

    // Check for duplicate payroll for same period
    const existingPayroll = await this.payrollRepository.findOne({
      where: {
        tenantId,
        employeeId: input.employeeId,
        payPeriodStart: new Date(input.payPeriodStart),
        payPeriodEnd: new Date(input.payPeriodEnd),
      },
    });

    if (existingPayroll) {
      throw new ConflictException(
        `Payroll already exists for employee ${input.employeeId} for period ${input.payPeriodStart} - ${input.payPeriodEnd}`,
      );
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

    // Calculate net pay
    const netPay = earnings.grossPay - deductions.totalDeductions;

    // Generate payroll number
    const payrollNumber = await this.generatePayrollNumber(tenantId);

    const payroll = this.payrollRepository.create({
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

    const savedPayroll = await this.payrollRepository.save(payroll);

    this.logger.log(
      `Payroll created: ${savedPayroll.id} (${savedPayroll.payrollNumber}) for employee ${input.employeeId}`,
    );

    return savedPayroll;
  }

  private async generatePayrollNumber(tenantId: string): Promise<string> {
    const count = await this.payrollRepository.count({ where: { tenantId } });
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const sequence = String(count + 1).padStart(6, '0');
    return `PAY-${year}${month}-${sequence}`;
  }
}
