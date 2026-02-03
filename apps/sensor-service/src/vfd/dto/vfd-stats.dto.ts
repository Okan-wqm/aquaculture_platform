import { ObjectType, Field, Float, Int } from '@nestjs/graphql';

/**
 * VFD Reading Statistics DTO
 * Used for aggregated statistics queries
 */
@ObjectType()
export class VfdReadingStats {
  @Field(() => Float, { nullable: true })
  avgOutputFrequency?: number;

  @Field(() => Float, { nullable: true })
  maxOutputFrequency?: number;

  @Field(() => Float, { nullable: true })
  minOutputFrequency?: number;

  @Field(() => Float, { nullable: true })
  avgMotorCurrent?: number;

  @Field(() => Float, { nullable: true })
  maxMotorCurrent?: number;

  @Field(() => Float, { nullable: true })
  avgOutputPower?: number;

  @Field(() => Float, { nullable: true })
  maxOutputPower?: number;

  @Field(() => Int)
  readingCount!: number;

  @Field(() => Int)
  faultCount!: number;

  @Field(() => Int)
  warningCount!: number;
}
