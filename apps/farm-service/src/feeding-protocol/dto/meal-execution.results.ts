/**
 * Öğün mutasyonlarının tipli GraphQL yanıtı (Faz 5 — P-25 duruşu:
 * opak blob değil, mobil registry'nin tipleyeceği alanlar).
 *
 * @module FeedingProtocol/DTO
 */
import { Field, Float, ID, ObjectType, registerEnumType } from '@nestjs/graphql';

import { FeedingMealStatus } from '../entities/feeding-meal.entity';
import { DayPlanAdminOutcome } from '../services/day-plan-admin.service';

registerEnumType(DayPlanAdminOutcome, {
  name: 'DayPlanAdminOutcome',
  description:
    'K-9 operatör aksiyonlarının sonucu — telde enum ADI (RECALCULATED | GENERATED | TRANSITIONED) taşınır.',
});

/** K-9 operatör aksiyonlarının (regenerate / manuel geçiş) tipli yanıtı. */
@ObjectType('DayPlanAdminResult')
export class DayPlanAdminResultView {
  @Field(() => DayPlanAdminOutcome)
  outcome!: DayPlanAdminOutcome;

  @Field(() => ID, { nullable: true })
  dayPlanId?: string;
}

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
