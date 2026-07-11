/**
 * Feeder Calibration Response Types for GraphQL
 */
import { ObjectType, Field, Float, ID } from '@nestjs/graphql';

@ObjectType()
export class FeederCalibrationResponse {
  @Field(() => ID)
  id!: string;

  @Field()
  equipmentId!: string;

  @Field(() => Float)
  feedSizeMm!: number;

  @Field({ nullable: true })
  feedSizeLabel?: string;

  @Field(() => Float)
  gramsPerDispensing!: number;

  @Field(() => Float)
  siloCapacityKg!: number;

  @Field({ nullable: true })
  notes?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}
