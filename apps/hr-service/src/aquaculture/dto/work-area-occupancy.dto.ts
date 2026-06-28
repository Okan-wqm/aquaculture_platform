import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';
import { RotationStatus } from '../entities/work-rotation.entity';
import { WorkArea } from '../entities/work-area.entity';

/**
 * One employee occupying a work area on the report date, with the status of the
 * rotation that places them there.
 */
@ObjectType()
export class OccupancyEmployee {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => RotationStatus)
  rotationStatus!: RotationStatus;
}

/**
 * Occupancy snapshot for a single work area on a given date.
 *
 * `scheduledCount` counts every non-cancelled rotation whose date range covers
 * the report date; `actualCount` counts only those that are IN_PROGRESS (crew
 * physically on station). `occupancyRate` is actualCount / maxCapacity * 100,
 * rounded to two decimals (0 when the area has no declared capacity).
 */
@ObjectType()
export class WorkAreaOccupancyReport {
  @Field(() => WorkArea)
  workArea!: WorkArea;

  @Field()
  date!: string;

  @Field(() => Int)
  scheduledCount!: number;

  @Field(() => Int)
  actualCount!: number;

  @Field(() => Float)
  occupancyRate!: number;

  @Field(() => [OccupancyEmployee])
  employees!: OccupancyEmployee[];
}
