/**
 * Öğün mutasyonlarının tipli GraphQL yanıtı (Faz 5 — P-25 duruşu:
 * opak blob değil, mobil registry'nin tipleyeceği alanlar).
 *
 * @module FeedingProtocol/DTO
 */
import { Field, Float, ID, ObjectType } from '@nestjs/graphql';

import { FeedingMealStatus } from '../entities/feeding-meal.entity';

@ObjectType('MealFeedingResult')
export class MealFeedingResultView {
  @Field(() => ID)
  id!: string;

  @Field(() => FeedingMealStatus)
  status!: FeedingMealStatus;

  @Field(() => Float)
  actualKg!: number;

  @Field(() => Float, { nullable: true })
  varianceKg!: number | null;

  @Field(() => Float, { nullable: true })
  variancePercent!: number | null;
}
