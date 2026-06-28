import { ObjectType, Field, Int } from '@nestjs/graphql';
import { WorkRotation } from '../entities/work-rotation.entity';

/**
 * The employee's current (active-now) rotation, enriched with the two computed
 * progress fields the frontend "current rotation" widget selects:
 *  - `daysRemaining`: whole days from today until endDate (0 once past end).
 *  - `progressPercent`: elapsed fraction of the rotation window, clamped 0..100.
 *
 * Extends the persisted WorkRotation so the full WorkRotation fragment still
 * resolves against the same object.
 */
@ObjectType()
export class RotationDetail extends WorkRotation {
  @Field(() => Int)
  daysRemaining!: number;

  @Field(() => Int)
  progressPercent!: number;
}
