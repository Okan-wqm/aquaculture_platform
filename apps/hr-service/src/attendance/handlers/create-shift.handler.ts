import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import { CreateShiftCommand } from '../commands/create-shift.command';
import { Shift, WeekDay } from '../entities/shift.entity';

@CommandHandler(CreateShiftCommand)
export class CreateShiftHandler implements ICommandHandler<CreateShiftCommand> {
  constructor(
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
  ) {}

  async execute(command: CreateShiftCommand): Promise<Shift> {
    const {
      tenantId,
      userId,
      code,
      name,
      startTime,
      endTime,
      shiftType,
      description,
      totalMinutes,
      breakMinutes,
      breakPeriods,
      workDays,
      crossesMidnight,
      graceMinutes,
      earlyClockInMinutes,
      lateClockOutMinutes,
      colorCode,
      displayOrder,
    } = command;

    // Check for duplicate code
    const existingShift = await this.shiftRepository.findOne({
      where: { tenantId, code, isDeleted: false },
    });

    if (existingShift) {
      throw new ConflictException(`Shift with code ${code} already exists`);
    }

    // Calculate total minutes if not provided
    let calculatedTotalMinutes = totalMinutes;
    if (!calculatedTotalMinutes) {
      const [startHours, startMins] = startTime.split(':').map(Number);
      const [endHours, endMins] = endTime.split(':').map(Number);

      let startMinutes = startHours * 60 + startMins;
      let endMinutes = endHours * 60 + endMins;

      if (crossesMidnight && endMinutes < startMinutes) {
        endMinutes += 24 * 60;
      }

      calculatedTotalMinutes = endMinutes - startMinutes;
    }

    const defaultWorkDays = workDays || [
      WeekDay.MONDAY,
      WeekDay.TUESDAY,
      WeekDay.WEDNESDAY,
      WeekDay.THURSDAY,
      WeekDay.FRIDAY,
    ];

    const shift = this.shiftRepository.create({
      tenantId,
      code,
      name,
      description,
      shiftType,
      startTime,
      endTime,
      totalMinutes: calculatedTotalMinutes,
      breakMinutes,
      breakPeriods,
      workDays: defaultWorkDays,
      crossesMidnight,
      graceMinutes,
      earlyClockInMinutes,
      lateClockOutMinutes,
      colorCode,
      displayOrder,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    return this.shiftRepository.save(shift);
  }
}
