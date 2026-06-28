import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { toEventIso, createBaseEvent } from '@platform/event-contracts';
import type { EmployeeRotationEndedEvent } from '@platform/event-contracts';
import { DataSource, QueryRunner } from 'typeorm';
import { EndRotationCommand } from '../commands/end-rotation.command';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@Injectable()
@CommandHandler(EndRotationCommand)
export class EndRotationHandler implements ICommandHandler<EndRotationCommand, WorkRotation> {
  private readonly logger = new Logger(EndRotationHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: EndRotationCommand): Promise<WorkRotation> {
    const { tenantId, rotationId, userId, actualEndDate, notes } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = tenantManagerRepo(queryRunner.manager, WorkRotation, tenantId);

      const rotation = await repo.findOne({
        where: { id: rotationId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });

      if (!rotation) {
        throw new NotFoundException(`Work rotation not found: ${rotationId}`);
      }

      if (rotation.status !== RotationStatus.IN_PROGRESS && rotation.status !== RotationStatus.EXTENDED) {
        throw new BadRequestException(
          `Cannot end a rotation with status "${rotation.status}". Only in-progress or extended rotations can be ended.`,
        );
      }

      const wasExtended = rotation.status === RotationStatus.EXTENDED;
      rotation.status = RotationStatus.COMPLETED;
      rotation.actualEndTime = actualEndDate ? new Date(actualEndDate) : new Date();
      if (notes) {
        rotation.notes = rotation.notes ? `${rotation.notes}\n---\n${notes}` : notes;
      }
      rotation.updatedBy = userId;

      const saved = await repo.save(rotation);

      // Clear currentRotationId on Employee when rotation ends.
      // BEFORE this fix: currentRotationId was never cleared, causing "ghost rotations"
      // where the system continued to show employees as offshore after they had returned.
      // This corrupts muster lists and prevents new rotations from being assigned correctly.
      await queryRunner.manager.update(Employee,
        { id: rotation.employeeId, tenantId },
        { currentRotationId: null },
      );

      await queryRunner.commitTransaction();

      this.logger.log(
        `Rotation ended: ${saved.id} for tenant ${tenantId} by user ${userId}`,
      );

      try {
        const event: EmployeeRotationEndedEvent = {
          ...createBaseEvent<EmployeeRotationEndedEvent>('EmployeeRotationEnded', tenantId, { userId }),
          aggregateId: saved.id,
          aggregateType: 'WorkRotation',
          eventType: 'EmployeeRotationEnded' as const,
          rotationId: saved.id,
          employeeId: saved.employeeId,
          workAreaId: saved.workAreaId,
          actualEndTime: toEventIso(saved.actualEndTime ?? new Date()),
          wasExtended,
        };
        this.eventBus.publish(event);
      } catch (eventError) {
        this.logger.error(`Failed to publish EmployeeRotationEndedEvent for ${saved.id}: ${(eventError as Error).message}`);
      }

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to end rotation ${rotationId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to end rotation');
    } finally {
      await queryRunner.release();
    }
  }
}
