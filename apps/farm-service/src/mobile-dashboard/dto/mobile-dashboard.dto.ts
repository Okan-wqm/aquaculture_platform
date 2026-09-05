import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

@ObjectType()
export class TodaysDailyOpsCounts {
  @Field(() => Int)
  mortalityCount!: number;

  // FARM-MEDIUM-053: culls were entirely excluded from the removal counts, so
  // "today's removals" under-counted. cullCount is a DISTINCT metric (mortality
  // and cull are different welfare events) summed from today's CULL operations.
  @Field(() => Int)
  cullCount!: number;

  @Field(() => Int)
  wqReadingsCount!: number;

  @Field(() => Int)
  feedingCompletedCount!: number;

  @Field(() => Int)
  feedingTotalCount!: number;
}

/**
 * The stock-event vocabulary the mobile Stock Events hub renders. Declared as
 * a GraphQL enum (FARM-HIGH-317) so the wire value set is part of the schema
 * the AquaMobil codegen consumes — a hand-written client union can no longer
 * drift from what the handler emits. TRANSFER_OUT is the only transfer half a
 * tank ever "loses" fish through, so it is the sole source of TRANSFER.
 */
export enum MobileStockEventType {
  MORTALITY = 'MORTALITY',
  CULL = 'CULL',
  TRANSFER = 'TRANSFER',
  HARVEST = 'HARVEST',
}

registerEnumType(MobileStockEventType, {
  name: 'MobileStockEventType',
  description: 'Stock event kind shown on the AquaMobil Stock Events hub',
});

@ObjectType()
export class MobileStockEvent {
  @Field(() => ID)
  id!: string;

  @Field(() => MobileStockEventType)
  type!: MobileStockEventType;

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

  // FARM-HIGH-055: pendingTransferCount was hardcoded 0 and could ONLY ever be 0
  // — TransferBatchHandler writes the TRANSFER_OUT + TRANSFER_IN rows in ONE
  // transaction, so a transfer is never in a pending half-state. A field that is
  // structurally always 0 is a lying KPI, so it is removed (make-it-impossible)
  // rather than faked. Mobile consumers derive transfer activity from
  // recentEvents (type === 'TRANSFER') instead.

  @Field(() => [MobileStockEvent])
  recentEvents!: MobileStockEvent[];
}
