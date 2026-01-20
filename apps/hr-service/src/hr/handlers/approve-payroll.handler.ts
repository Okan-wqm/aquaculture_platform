import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ApprovePayrollCommand } from '../commands/approve-payroll.command';
import { Payroll, PayrollStatus } from '../entities/payroll.entity';

@Injectable()
@CommandHandler(ApprovePayrollCommand)
export class ApprovePayrollHandler implements ICommandHandler<ApprovePayrollCommand, Payroll> {
  private readonly logger = new Logger(ApprovePayrollHandler.name);

  constructor(
    @InjectRepository(Payroll)
    private readonly payrollRepository: Repository<Payroll>,
  ) {}

  async execute(command: ApprovePayrollCommand): Promise<Payroll> {
    const { tenantId, payrollId, userId } = command;

    const payroll = await this.payrollRepository.findOne({
      where: { id: payrollId, tenantId },
    });

    if (!payroll) {
      throw new NotFoundException(`Payroll with id ${payrollId} not found`);
    }

    // Validate status transition
    const validStatuses = [PayrollStatus.DRAFT, PayrollStatus.PENDING_APPROVAL];
    if (!validStatuses.includes(payroll.status)) {
      throw new BadRequestException(
        `Cannot approve payroll with status ${payroll.status}. Must be in DRAFT or PENDING_APPROVAL status.`,
      );
    }

    payroll.status = PayrollStatus.APPROVED;
    payroll.approvedBy = userId;
    payroll.approvedAt = new Date();
    payroll.updatedBy = userId;

    const savedPayroll = await this.payrollRepository.save(payroll);

    this.logger.log(
      `Payroll approved: ${savedPayroll.id} (${savedPayroll.payrollNumber}) by user ${userId}`,
    );

    return savedPayroll;
  }
}
