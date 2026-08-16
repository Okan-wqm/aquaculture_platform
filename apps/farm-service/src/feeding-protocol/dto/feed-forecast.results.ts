/**
 * protocolFeedForecast tipli tel şekilleri (Faz 7, plan §5).
 *
 * Snapshot jsonb'sinin (feeding_forecast_snapshots) GraphQL aynası — sorgu
 * MAKS ufuklu materyalize satırı istenen `horizonDays`'e DİLER (K-10);
 * `computedAt` tazelik göstergesi, `mortalityAssumption` açık varsayım
 * işareti (K-17). Seriler grafik-hazırdır (P-16 — cap yok).
 *
 * GraphQL adları 'ProtocolFeedForecast*' önekiyle ayrışır: legacy forecast
 * yığını (feeding.resolver.ts, Faz 8'de emekli) 'FeedForecastAlert' adını
 * hâlâ taşıyor — süpergraf tip adları benzersiz olmak zorunda.
 *
 * @module FeedingProtocol/DTO
 */
import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import type {
  FeedingForecastAlertType,
  FeedingForecastMortalityCoverageV1,
  FeedingForecastMortalitySourceV1,
  FeedingForecastPoolScope,
} from '@aquaculture/feeding-contracts';

@ObjectType('ProtocolFeedForecastPerFeed')
export class FeedForecastPerFeedView {
  @Field(() => ID) feedId!: string;
  @Field() feedCode!: string;
  @Field() feedName!: string;
  @Field(() => Float) currentStockKg!: number;
  @Field(() => [Float]) dailyConsumptionSeries!: number[];
  @Field(() => [Float]) remainingStockSeries!: number[];
  @Field(() => String, { nullable: true }) stockoutDate!: string | null;
  @Field(() => Int, { nullable: true }) daysOfCover!: number | null;
  @Field(() => String, { nullable: true }) firstConsumptionDate!: string | null;
  /** "B 6 gün yeter" — ilk tüketim gününden tükenişe gün. */
  @Field(() => Int, { nullable: true }) coverageFromAdoptionDays!: number | null;
  @Field(() => String, { nullable: true }) reorderDate!: string | null;
  @Field(() => Float, { nullable: true }) reorderQuantityKg!: number | null;
  @Field(() => Int) procurementLeadTimeDays!: number;
  /** 'feed' | 'default' — sessiz default yok (K-17). */
  @Field() leadTimeSource!: string;
}

@ObjectType('ProtocolFeedForecastTransition')
export class FeedForecastTransitionView {
  @Field(() => ID) fromFeedId!: string;
  @Field(() => ID) toFeedId!: string;
  @Field() estimatedDate!: string;
  @Field(() => Int) daysFromNow!: number;
}

@ObjectType('ProtocolFeedForecastPerUnit')
export class FeedForecastPerUnitView {
  @Field(() => ID) unitId!: string;
  @Field() unitName!: string;
  @Field() unitCode!: string;
  @Field(() => ID, { nullable: true }) currentFeedId!: string | null;
  @Field(() => ID, { nullable: true }) terminalFeedId!: string | null;
  @Field(() => [FeedForecastTransitionView]) transitions!: FeedForecastTransitionView[];
}

@ObjectType('ProtocolFeedForecastAlert')
export class FeedForecastAlertView {
  /** STOCKOUT_FORECAST | TRANSITION_COVERAGE_GAP | REORDER_NOW | SITE_TRANSFER_NEEDED */
  @Field(() => String) type!: FeedingForecastAlertType;
  @Field(() => ID) feedId!: string;
  @Field(() => ID, { nullable: true }) unitId?: string;
  @Field(() => Int) days!: number;
  @Field(() => Int) atDay!: number;
}

@ObjectType('ProtocolFeedForecastMortalityUnitProvenance')
export class FeedForecastMortalityUnitProvenanceView {
  @Field(() => ID) unitId!: string;
  @Field(() => String) source!: FeedingForecastMortalitySourceV1;
  @Field(() => Float) dailySurvivalRate!: number;
}

@ObjectType('ProtocolFeedForecastMortalityAssumption')
export class FeedForecastMortalityAssumptionView {
  @Field() schemaVersion!: string;
  @Field(() => String) coverage!: FeedingForecastMortalityCoverageV1;
  @Field(() => Int) unitCount!: number;
  @Field(() => Int) speciesRateUnitCount!: number;
  @Field(() => Int) conservativeDefaultUnitCount!: number;
  @Field(() => [FeedForecastMortalityUnitProvenanceView])
  units!: readonly FeedForecastMortalityUnitProvenanceView[];
}

@ObjectType('ProtocolFeedForecast')
export class ProtocolFeedForecastView {
  /** Site UUID'si ya da belgeli tenant-geneli fallback için 'tenant' (D-9). */
  @Field() siteScopeKey!: string;
  /** TENANT = purchase authority; SITE = informational transfer projection. */
  @Field(() => String) poolScope!: FeedingForecastPoolScope;
  @Field() stale!: boolean;
  @Field(() => Int) horizonDays!: number;
  /** Snapshot tazeliği — UI'da "şu an itibarıyla" damgası (D-6). */
  @Field() computedAt!: Date;
  @Field(() => [FeedForecastPerFeedView]) perFeed!: FeedForecastPerFeedView[];
  @Field(() => [FeedForecastPerUnitView]) perUnit!: FeedForecastPerUnitView[];
  @Field(() => [FeedForecastAlertView]) alerts!: FeedForecastAlertView[];
  @Field(() => FeedForecastMortalityAssumptionView)
  mortalityAssumption!: FeedForecastMortalityAssumptionView;
}

/** Stable projection of the idempotent refresh operation result. */
@ObjectType('ProtocolFeedForecastRefreshResult')
export class ProtocolFeedForecastRefreshResultView {
  @Field(() => ID)
  operationRequestId!: string;

  @Field(() => Int)
  refreshedScopeCount!: number;
}
