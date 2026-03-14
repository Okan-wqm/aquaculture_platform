import { Injectable, NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ApprovePayrollCommand } from '../commands/approve-payroll.command';
import { Payroll, PayrollStatus } from '../entities/payroll.entity';

@Injectable()
@CommandHandler(ApprovePayrollCommand)
export class ApprovePayrollHandler implements ICommandHandler<ApprovePayrollCommand, Payroll> {
  private readonly logger = new Logger(ApprovePayrollHandler.name);

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: ApprovePayrollCommand): Promise<Payroll> {
    const { tenantId, payrollId, userId } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const payrollRepo = queryRunner.manager.getRepository(Payroll);

      const payroll = await payrollRepo.findOne({
        where: { id: payrollId, tenantId },
      });

      if (!payroll) {
        throw new NotFoundException(`Payroll with id ${payrollId} not found`);
      }

      // Prevent self-approval: the user who created the payroll cannot approve it
      if (payroll.createdBy === userId) {
        throw new BadRequestException('Cannot approve your own payroll entry');
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

      const savedPayroll = await payrollRepo.save(payroll);

      await queryRunner.commitTransaction();

      this.logger.log(
        `Payroll approved: ${savedPayroll.id} (${savedPayroll.payrollNumber}) by user ${userId}`,
      );

      return savedPayroll;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to approve payroll ${payrollId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to approve payroll');
    } finally {
      await queryRunner.release();
    }
  }
}
