import { ObjectType, Field, Int } from '@nestjs/graphql';

/**
 * One day's mortality total (all sites) — the health page N-day chart point.
 */
@ObjectType()
export class DailyMortalityPointResponse {
  /** ISO date (yyyy-mm-dd) of the mortality records. */
  @Field()
  date!: string;

  @Field(() => Int)
  count!: number;
}
