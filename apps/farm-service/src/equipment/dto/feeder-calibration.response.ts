/**
 * Feeder setup response types for GraphQL.
 *
 * `feederSetup` returns the machine and its per-feed calibrations TOGETHER,
 * because reading either alone is misleading: a grams-per-minute number means
 * nothing without the speed band it is valid on, and a capability row means
 * nothing without knowing which feeds it can actually dose.
 */
import { ObjectType, Field, Float, ID } from '@nestjs/graphql';

import { FeederDispenseControl, FeederDosingMode } from '../entities/feeder-capability.entity';

@ObjectType()
export class FeederCalibrationResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  equipmentId!: string;

  /** `feeds.id` — the identity a protocol band selects. */
  @Field(() => ID)
  feedId!: string;

  @Field(() => FeederDosingMode)
  dosingMode!: FeederDosingMode;

  /** Present exactly when `dosingMode` is DISCRETE. */
  @Field(() => Float, { nullable: true })
  gramsPerDispensing?: number;

  /** Present exactly when `dosingMode` is CONTINUOUS. */
  @Field(() => Float, { nullable: true })
  gramsPerMinute?: number;

  /** The speed the rate above was measured at. Present with `gramsPerMinute`. */
  @Field(() => Float, { nullable: true })
  referenceSpeedHz?: number;

  @Field({ nullable: true })
  notes?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class FeederCapabilityResponse {
  @Field(() => ID)
  equipmentId!: string;

  @Field(() => FeederDosingMode)
  dosingMode!: FeederDosingMode;

  /** Stated once per feeder — never per feed. */
  @Field(() => Float, { nullable: true })
  siloCapacityKg?: number;

  /** Validated speed band; present exactly when `dosingMode` is CONTINUOUS. */
  @Field(() => Float, { nullable: true })
  minSpeedHz?: number;

  @Field(() => Float, { nullable: true })
  maxSpeedHz?: number;

  @Field(() => FeederDispenseControl)
  dispenseControl!: FeederDispenseControl;

  /** Present exactly when `dispenseControl` is WEIGHT_BASED. */
  @Field(() => ID, { nullable: true })
  weightSensorId?: string;

  @Field({ nullable: true })
  notes?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class FeederSetupResponse {
  /**
   * Null when the equipment has never been commissioned as a feeder. That is a
   * real and distinct state from "commissioned with no calibrations yet", and
   * collapsing the two would hide the reason a dose gets refused.
   */
  @Field(() => FeederCapabilityResponse, { nullable: true })
  capability?: FeederCapabilityResponse;

  @Field(() => [FeederCalibrationResponse])
  calibrations!: FeederCalibrationResponse[];
}
