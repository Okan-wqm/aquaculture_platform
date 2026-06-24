import { BadRequestException } from '@nestjs/common';

const MINUTES_PER_DAY = 24 * 60;
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface PlanEntryTimeOfDay {
  hours: number;
  minutes: number;
  totalMinutes: number;
}

export interface PlanEntryCustomTimeRange {
  plannedStartTime: Date;
  plannedEndTime: Date;
  plannedMinutes: number;
}

export function parsePlanEntryTimeOfDay(value: string): PlanEntryTimeOfDay {
  const match = TIME_OF_DAY_PATTERN.exec(value);
  if (!match) {
    throw new BadRequestException(
      `Invalid plan entry time "${value}". Expected HH:mm in 24-hour format.`,
    );
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return {
    hours,
    minutes,
    totalMinutes: hours * 60 + minutes,
  };
}

export function calculatePlanEntryMinutes(
  startTime: string,
  endTime: string,
): number {
  const start = parsePlanEntryTimeOfDay(startTime);
  const end = parsePlanEntryTimeOfDay(endTime);
  let totalMinutes = end.totalMinutes - start.totalMinutes;

  if (totalMinutes < 0) {
    totalMinutes += MINUTES_PER_DAY;
  }

  return totalMinutes;
}

export function resolvePlanEntryCustomTimeRange(
  entryDate: Date,
  startTime: string,
  endTime: string,
): PlanEntryCustomTimeRange {
  const start = parsePlanEntryTimeOfDay(startTime);
  const end = parsePlanEntryTimeOfDay(endTime);
  const endDayOffset = end.totalMinutes < start.totalMinutes ? 1 : 0;

  return {
    plannedStartTime: timeOfDayOnEntryDate(entryDate, start),
    plannedEndTime: timeOfDayOnEntryDate(entryDate, end, endDayOffset),
    plannedMinutes: calculatePlanEntryMinutes(startTime, endTime),
  };
}

function timeOfDayOnEntryDate(
  entryDate: Date,
  time: PlanEntryTimeOfDay,
  dayOffset = 0,
): Date {
  return new Date(
    Date.UTC(
      entryDate.getUTCFullYear(),
      entryDate.getUTCMonth(),
      entryDate.getUTCDate() + dayOffset,
      time.hours,
      time.minutes,
      0,
      0,
    ),
  );
}
