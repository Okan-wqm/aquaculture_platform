import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { toEventIso, createBaseEvent } from '@platform/event-contracts';
import type { EmployeeRotationStartedEvent } from '@platform/event-contracts';
import { DataSource, QueryRunner } from 'typeorm';
import { StartRotationCommand } from '../commands/start-rotation.command';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import { Employee, PersonnelCategory } from '../../hr/entities/employee.entity';
import { CertificationValidationService } from '../certification-validation.service';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@Injectable()
@CommandHandler(StartRotationCommand)
export class StartRotationHandler implements ICommandHandler<StartRotationCommand, WorkRotation> {
  private readonly logger = new Logger(StartRotationHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly eventBus: EventBus,
    private readonly certificationValidation: CertificationValidationService,
  ) {}

  async execute(command: StartRotationCommand): Promise<WorkRotation> {
    const { tenantId, rotationId, userId, actualStartDate } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = tenantManagerRepo(queryRunner.manager, WorkRotation, tenantId);

      const rotation = await repo.findOne({
        where: { id: rotationId, tenantId, isDeleted: false },
        relations: ['workArea'],
        lock: { mode: 'pessimistic_write' },
      });

      if (!rotation) {
        throw new NotFoundException(`Work rotation not found: ${rotationId}`);
      }

      if (rotation.status !== RotationStatus.SCHEDULED) {
        throw new BadRequestException(
          `Cannot start a rotation with status "${rotation.status}". Only scheduled rotations can be started.`,
        );
      }

      // LIFE-SAFETY: Verify employee seaWorthy status before offshore deployment.
      // CertificationExpiryService (daily cron) sets seaWorthy=false when any mandatory
      // offshore certification expires. Without this check, employees with expired certs
      // can be deployed offshore — violating safety regulations and risking lives.
      // Reading inside the transaction ensures we see the committed seaWorthy state.
      const employee = await queryRunner.manager.findOne(Employee, {
        where: { id: rotation.employeeId, tenantId },
        select: ['id', 'seaWorthy', 'personnelCategory'],
      });

      if (!employee) {
        throw new NotFoundException(`Employee not found for rotation: ${rotation.employeeId}`);
      }

      // Only OFFSHORE and HYBRID personnel require the seaWorthy check.
      // ONSHORE employees do not hold offshore certifications.
      if (
        employee.personnelCategory !== PersonnelCategory.ONSHORE &&
        !employee.seaWorthy
      ) {
        throw new ForbiddenException(
          `Employee ${rotation.employeeId} is not seaWorthy. ` +
          `Offshore rotation cannot start until all mandatory certifications are valid and current.`,
        );
      }

      // LIFE-SAFETY: Re-validate certifications at start time. A certification
      // may have been revoked or expired between scheduling and actual start.
      // This is the last safety gate before the employee is deployed.
      await this.certificationValidation.validateEmployeeCertifications(
        queryRunner.manager,
        tenantId,
        rotation.employeeId,
        rotation.workAreaId,
        new Date(rotation.endDate),
      );

      rotation.status = RotationStatus.IN_PROGRESS;
      rotation.actualStartTime = actualStartDate ? new Date(actualStartDate) : new Date();
      rotation.updatedBy = userId;

      const saved = await repo.save(rotation);

      // Track who is currently offshore: update currentRotationId on Employee.
      // BEFORE this fix: currentRotationId was never set, making it impossible to
      // generate an accurate muster list in emergency evacuation scenarios.
      await queryRunner.manager.update(Employee,
        { id: rotation.employeeId, tenantId },
        { currentRotationId: saved.id },
      );

      await queryRunner.commitTransaction();

      this.logger.log(
        `Rotation started: ${saved.id} for tenant ${tenantId} by user ${userId}`,
      );

      // Publish after commit — downstream consumers (notifications, vessel staffing)
      try {
        const event: EmployeeRotationStartedEvent = {
          ...createBaseEvent<EmployeeRotationStartedEvent>('EmployeeRotationStarted', tenantId, { userId }),
          aggregateId: saved.id,
          aggregateType: 'WorkRotation',
          eventType: 'EmployeeRotationStarted' as const,
          rotationId: saved.id,
          employeeId: saved.employeeId,
          workAreaId: saved.workAreaId,
          workAreaName: saved.workArea?.name ?? saved.workAreaId,
          rotationType: saved.rotationType ?? 'STANDARD',
          startDate: toEventIso(saved.startDate),
          endDate: toEventIso(saved.endDate),
          daysOn: saved.daysOn,
          daysOff: saved.daysOff,
        };
        this.eventBus.publish(event);
      } catch (eventError) {
        this.logger.error(`Failed to publish EmployeeRotationStartedEvent for ${saved.id}: ${(eventError as Error).message}`);
      }

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }

      this.logger.error(
        `Failed to start rotation ${rotationId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to start rotation');
    } finally {
      await queryRunner.release();
    }
  }
}
