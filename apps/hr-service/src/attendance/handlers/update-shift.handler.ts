import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { UpdateShiftCommand } from '../commands/update-shift.command';
import { Shift } from '../entities/shift.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { parseTimeString } from './create-shift.handler';

/**
 * UpdateShiftHandler — partial update of an existing Shift, mirroring
 * CreateShiftHandler's tenant-scoping + time-validation discipline:
 *
 *  - Same transactional QueryRunner lifecycle (connect → startTransaction →
 *    commit/rollback → release-in-finally).
 *  - Same `tenantManagerRepo(queryRunner.manager, Shift, tenantId)` so the
 *    load + save are tenant-scoped (never a raw getRepository).
 *  - Same `parseTimeString` HH:mm validation (imported from create handler) so
 *    the time contract is a single source of truth.
 *
 * Only fields actually present on the command (non-undefined) are applied —
 * `undefined` means "leave unchanged". `code` is intentionally absent because
 * UpdateShiftInput does not expose it, so there is no duplicate-code race to
 * guard (the unique [tenantId, code] index is unaffected by updates here).
 */
@CommandHandler(UpdateShiftCommand)
export class UpdateShiftHandler implements ICommandHandler<UpdateShiftCommand> {
  private readonly logger = new Logger(UpdateShiftHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdateShiftCommand): Promise<Shift> {
    const {
      tenantId,
      userId,
      id,
      name,
      description,
      shiftType,
      startTime,
      endTime,
      totalMinutes,
      breakMinutes,
      breakPeriods,
      workDays,
      crossesMidnight,
      graceMinutes,
      isActive,
      colorCode,
      displayOrder,
    } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const shiftRepo = tenantManagerRepo(queryRunner.manager, Shift, tenantId);

      // Tenant-scoped load: TenantScopedRepository.findOne AND-s tenantId into
      // the WHERE clause, so a shift belonging to another tenant is invisible
      // here and correctly surfaces as NotFound (not a cross-tenant leak).
      const shift = await shiftRepo.findOne({
        where: { id, isDeleted: false },
      });

      if (!shift) {
        throw new NotFoundException(`Shift with id ${id} not found`);
      }

      // Validate time format up-front (same rule as create) before they are
      // applied, so an invalid HH:mm rejects the whole update transaction.
      if (startTime !== undefined) {
        parseTimeString(startTime, 'startTime');
      }
      if (endTime !== undefined) {
        parseTimeString(endTime, 'endTime');
      }

      // Apply ONLY provided fields (undefined === unchanged).
      if (name !== undefined) shift.name = name;
      if (description !== undefined) shift.description = description;
      if (shiftType !== undefined) shift.shiftType = shiftType;
      if (startTime !== undefined) shift.startTime = startTime;
      if (endTime !== undefined) shift.endTime = endTime;
      if (breakMinutes !== undefined) shift.breakMinutes = breakMinutes;
      if (breakPeriods !== undefined) shift.breakPeriods = breakPeriods;
      if (workDays !== undefined) shift.workDays = workDays;
      if (crossesMidnight !== undefined) shift.crossesMidnight = crossesMidnight;
      if (graceMinutes !== undefined) shift.graceMinutes = graceMinutes;
      if (isActive !== undefined) shift.isActive = isActive;
      if (colorCode !== undefined) shift.colorCode = colorCode;
      if (displayOrder !== undefined) shift.displayOrder = displayOrder;

      // totalMinutes resolution mirrors create: an explicit value wins;
      // otherwise, when any time-affecting field changed, recompute from the
      // shift's effective (post-apply) start/end + crossesMidnight so the
      // stored duration never drifts from the times shown to the user.
      if (totalMinutes !== undefined) {
        shift.totalMinutes = totalMinutes;
      } else if (startTime !== undefined || endTime !== undefined || crossesMidnight !== undefined) {
        const [startHours, startMins] = parseTimeString(shift.startTime, 'startTime');
        const [endHours, endMins] = parseTimeString(shift.endTime, 'endTime');

        const startMinutes = startHours * 60 + startMins;
        let endMinutes = endHours * 60 + endMins;

        if (shift.crossesMidnight && endMinutes < startMinutes) {
          endMinutes += 24 * 60;
        }

        shift.totalMinutes = endMinutes - startMinutes;
      }

      shift.updatedBy = userId;

      const savedShift = await shiftRepo.save(shift);

      await queryRunner.commitTransaction();

      return savedShift;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to update shift ${id} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to update shift');
    } finally {
      await queryRunner.release();
    }
  }
}
