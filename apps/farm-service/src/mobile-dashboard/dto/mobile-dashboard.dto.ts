import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class TodaysDailyOpsCounts {
  @Field(() => Int)
  mortalityCount!: number;

  @Field(() => Int)
  wqReadingsCount!: number;

  @Field(() => Int)
  feedingCompletedCount!: number;

  @Field(() => Int)
  feedingTotalCount!: number;
}

@ObjectType()
export class MobileStockEvent {
  @Field(() => ID)
  id!: string;

  @Field()
  type!: string;

  @Field()
  tankName!: string;

  @Field(() => Int)
  quantity!: number;

  @Field()
  createdAt!: Date;

  @Field({ nullable: true })
  note?: string;
}

@ObjectType()
export class StockEventsSummary {
  @Field(() => Int)
  thisWeekEventsCount!: number;

  @Field(() => Int)
  pendingTransferCount!: number;

  @Field(() => [MobileStockEvent])
  recentEvents!: MobileStockEvent[];
}
