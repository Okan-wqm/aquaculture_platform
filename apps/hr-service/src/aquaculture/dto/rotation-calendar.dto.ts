import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { RotationType } from '../entities/work-rotation.entity';
import { RotationStatus } from '../entities/work-rotation.entity';

/**
 * Flattened calendar row for one rotation within a queried date window.
 * Joins employee + work-area display fields onto the rotation so the calendar
 * grid does not need extra round-trips.
 */
@ObjectType()
export class RotationCalendarEntry {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  employeeId!: string;

  @Field()
  employeeName!: string;

  @Field()
  workAreaName!: string;

  @Field(() => RotationType)
  rotationType!: RotationType;

  @Field()
  startDate!: string;

  @Field()
  endDate!: string;

  @Field(() => RotationStatus)
  status!: RotationStatus;

  @Field()
  isOffshore!: boolean;

  @Field(() => Int)
  daysOn!: number;

  @Field(() => Int)
  daysOff!: number;
}
