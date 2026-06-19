import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateWorkRotationCommand } from '../commands/create-work-rotation.command';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import { WorkArea } from '../entities/work-area.entity';
import { CertificationValidationService } from '../certification-validation.service';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@Injectable()
@CommandHandler(CreateWorkRotationCommand)
export class CreateWorkRotationHandler implements ICommandHandler<CreateWorkRotationCommand, WorkRotation> {
  private readonly logger = new Logger(CreateWorkRotationHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly certificationValidation: CertificationValidationService,
  ) {}

  async execute(command: CreateWorkRotationCommand): Promise<WorkRotation> {
    const { tenantId, input, userId } = command;

    // Validate dates
    const startDate = new Date(input.startDate);
    const endDate = new Date(input.endDate);

    if (isNaN(startDate.getTime())) {
      throw new BadRequestException('Invalid start date');
    }
    if (isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid end date');
    }
    if (endDate <= startDate) {
      throw new BadRequestException('End date must be after start date');
    }

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const rotationRepo = tenantManagerRepo(queryRunner.manager, WorkRotation, tenantId);
      const workAreaRepo = tenantManagerRepo(queryRunner.manager, WorkArea, tenantId);

      // Verify work area exists and belongs to tenant
      const workArea = await workAreaRepo.findOne({
        where: { id: input.workAreaId, tenantId, isDeleted: false, isActive: true },
      });

      if (!workArea) {
        throw new NotFoundException(`Work area not found or inactive: ${input.workAreaId}`);
      }

      // LIFE-SAFETY: Validate employee holds all required certifications for this
      // work area, and that none expire before the rotation ends. Uncertified workers
      // performing hazardous aquaculture tasks (diving, chemical handling) risk injury
      // or death. This gate runs inside the SERIALIZABLE transaction so no concurrent
      // certification revocation can slip through.
      await this.certificationValidation.validateEmployeeCertifications(
        queryRunner.manager,
        tenantId,
        input.employeeId,
        input.workAreaId,
        endDate,
      );

      // Check for overlapping rotations for the same employee
      const overlapping = await rotationRepo
        .createQueryBuilder('wr')
        .andWhere('wr.employeeId = :employeeId', { employeeId: input.employeeId })
        .andWhere('wr.isDeleted = false')
        .andWhere('wr.status NOT IN (:...excludeStatuses)', {
          excludeStatuses: [RotationStatus.CANCELLED, RotationStatus.COMPLETED],
        })
        .andWhere('wr.startDate < :endDate', { endDate: input.endDate })
        .andWhere('wr.endDate > :startDate', { startDate: input.startDate })
        .getCount();

      if (overlapping > 0) {
        throw new ConflictException(
          'Employee already has an active or scheduled rotation overlapping this date range',
        );
      }

      const rotation = rotationRepo.create({
        ...input,
        tenantId,
        status: RotationStatus.SCHEDULED,
        createdBy: userId,
        updatedBy: userId,
      });

      const saved = await rotationRepo.save(rotation);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Work rotation created: ${saved.id} for employee ${input.employeeId}, tenant ${tenantId} by user ${userId}`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      this.logger.error(
        `Failed to create work rotation for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to create work rotation');
    } finally {
      await queryRunner.release();
    }
  }
}
