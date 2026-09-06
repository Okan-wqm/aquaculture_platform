/**
 * protocolFeedForecast tipli tel şekilleri (Faz 7, plan §5).
 *
 * Snapshot jsonb'sinin (feeding_forecast_snapshots) GraphQL aynası — sorgu
 * MAKS ufuklu materyalize satırı istenen `horizonDays`'e DİLER (K-10);
 * `computedAt` tazelik göstergesi, `mortalityAssumption` açık varsayım
 * işareti (K-17). Seriler grafik-hazırdır (P-16 — cap yok).
 *
 * GraphQL adları 'ProtocolFeedForecast*' önekini taşır: bu önek, v1 forecast
 * yığını süpergrafta önek'siz adları işgal ettiği için gerekliydi (tip adları
 * benzersiz olmak zorunda). v1 yığını Faz 8'de silindi; önek KORUNUYOR çünkü
 * artık FE operasyonlarının ve generated istemci tiplerinin sözleşmesidir —
 * onu kaldırmak kırıcı bir şema değişikliği olurdu, kazanç ise kozmetik.
 *
 * @module FeedingProtocol/DTO
 */
import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

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
  /** Ünitenin BUGÜNKÜ yemi (gün-0 bandı) — FARM-LOW-265. */
  @Field(() => ID, { nullable: true }) currentFeedId!: string | null;
  /** Ufuk sonunda ulaşılan yem (simülasyonun SON bandı). */
  @Field(() => ID, { nullable: true }) terminalFeedId!: string | null;
  @Field(() => [FeedForecastTransitionView]) transitions!: FeedForecastTransitionView[];
}

@ObjectType('ProtocolFeedForecastAlert')
export class FeedForecastAlertView {
  /** STOCKOUT_FORECAST | TRANSITION_COVERAGE_GAP | REORDER_NOW | SITE_TRANSFER_NEEDED */
  @Field() type!: string;
  @Field(() => ID) feedId!: string;
  @Field(() => ID, { nullable: true }) unitId?: string;
  /** Tipe özgü büyüklük (kapsama günü / eksik gün / yerel kapsama). */
  @Field(() => Int) days!: number;
  /** Alarmın işaret ettiği gün indeksi — dilimleme birimi (FARM-LOW-266). */
  @Field(() => Int) atDay!: number;
}

@ObjectType('ProtocolFeedForecastMortalityAssumption')
export class FeedForecastMortalityAssumptionView {
  @Field() applied!: boolean;
  /** 'species_survival_rate' | 'none' */
  @Field() source!: string;
}

@ObjectType('ProtocolFeedForecast')
export class ProtocolFeedForecastView {
  /** Site UUID'si ya da belgeli tenant-geneli fallback için 'tenant' (D-9). */
  @Field() siteScopeKey!: string;
  /**
   * 'TENANT' = kapsama/alarm OTORİTESİ (havuz kararı, kullanıcı kararı 1);
   * 'SITE' = bilgilendirici kapsam, yalnız SITE_TRANSFER_NEEDED üretir.
   */
  @Field() poolScope!: string;
  /** Snapshot 26 saatten eskiyse true — UI bayatlığı gizlemez (W6). */
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
