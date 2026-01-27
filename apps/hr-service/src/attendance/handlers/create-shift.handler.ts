import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { CreateShiftCommand } from '../commands/create-shift.command';
import { Shift, WeekDay } from '../entities/shift.entity';

/**
 * Parse time string in HH:mm format with validation
 * Returns [hours, minutes] or throws BadRequestException for invalid format
 */
function parseTimeString(time: string, fieldName: string): [number, number] {
  if (!time || typeof time !== 'string') {
    throw new BadRequestException(`${fieldName} is required and must be a string`);
  }

  const parts = time.split(':');
  if (parts.length !== 2) {
    throw new BadRequestException(`${fieldName} must be in HH:mm format (e.g., "09:00")`);
  }

  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);

  if (isNaN(hours) || isNaN(minutes)) {
    throw new BadRequestException(`${fieldName} contains invalid numeric values`);
  }

  if (hours < 0 || hours > 23) {
    throw new BadRequestException(`${fieldName} hours must be between 0 and 23`);
  }

  if (minutes < 0 || minutes > 59) {
    throw new BadRequestException(`${fieldName} minutes must be between 0 and 59`);
  }

  return [hours, minutes];
}

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
      // Validate time format before parsing
      const [startHours, startMins] = parseTimeString(startTime, 'startTime');
      const [endHours, endMins] = parseTimeString(endTime, 'endTime');

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
