/**
 * BiomassReport Entity
 *
 * Monthly biomass report snapshot per site — the operational record
 * that backs the FDIR / Mattilsynet biomass reporting flow. Previously
 * the frontend form (`BiomassReportTab`) had no backend persistence at
 * all: its submit handler called `console.log` and a 1-second
 * setTimeout. Phase 2.1 of the "kalan kör noktalar" plan closes that
 * gap by persisting the report here and exposing a typed
 * createBiomassReport mutation.
 *
 * Storage strategy:
 *   - Fixed columns carry the routing + lifecycle fields (tenantId,
 *     siteId, reportMonth, reportYear, status, timestamps).
 *   - The large form payload (biomass breakdown by species, stocking
 *     records, mortality causes, feed types, transfers, slaughter
 *     records) lives in a JSONB column because the shape is wide and
 *     evolves with the regulatory requirement set. The JSONB is typed
 *     by `BiomassReportPayload` so no caller touches `any`.
 *
 * Uniqueness: (tenantId, siteId, reportMonth, reportYear).
 * Re-submitting the same period updates the existing DRAFT row
 * instead of duplicating. Once status=SUBMITTED the row is immutable.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

// ============================================================================
// ENUMS
// ============================================================================

export enum BiomassReportStatus {
  DRAFT = 'DRAFT',
  /** Reviewed, ready to export for the manual Altinn FD-0001 submission. */
  READY = 'READY',
  /** Operator confirmed the report was submitted via Altinn (altinnReference set). */
  CONFIRMED_SUBMITTED = 'CONFIRMED_SUBMITTED',
  /**
   * Legacy terminal state from before the Altinn honesty fix (RPT-001). No new
   * row reaches it; the immutability guard treats it as CONFIRMED_SUBMITTED.
   */
  SUBMITTED = 'SUBMITTED',
}

registerEnumType(BiomassReportStatus, {
  name: 'BiomassReportStatus',
  description: 'Lifecycle of a biomass report snapshot',
});

/** The terminal, immutable biomass states (confirmed Altinn submission + legacy). */
export const TERMINAL_BIOMASS_STATUSES: ReadonlySet<BiomassReportStatus> = new Set([
  BiomassReportStatus.CONFIRMED_SUBMITTED,
  BiomassReportStatus.SUBMITTED,
]);

// ============================================================================
// PAYLOAD SHAPES — mirror the BiomassReportTab.tsx BiomassFormData
// ============================================================================

export interface BiomassSpeciesBreakdown {
  speciesId: string;
  speciesName: string;
  fishCount: number;
  biomassKg: number;
  avgWeightG: number;
}

export interface BiomassStockingRecord {
  date: string; // ISO 8601
  speciesCode: string;
  supplier?: string;
  fishCount: number;
  avgWeightG: number;
  biomassKg: number;
  notes?: string;
}

export interface BiomassMortalityDetail {
  date: string;
  cause: string;
  speciesCode: string;
  count: number;
  biomassLossKg?: number;
  notes?: string;
}

export interface BiomassSlaughterRecord {
  date: string;
  speciesCode: string;
  quantity: number;
  biomassKg: number;
  buyer?: string;
  notes?: string;
}

export interface BiomassTransferRecord {
  date: string;
  direction: 'IN' | 'OUT';
  speciesCode: string;
  fishCount: number;
  biomassKg: number;
  counterparty?: string;
  notes?: string;
}

export interface BiomassFeedEntry {
  feedName: string;
  brandName?: string;
  quantityKg: number;
}

/**
 * Canonical payload persisted in biomass_reports.report_data.
 * Kept aligned with BiomassFormData in the frontend tab; any schema
 * change here must be reflected in the shared-contracts library and
 * the frontend's BiomassReportInput DTO in the same commit.
 */
export interface BiomassReportPayload {
  currentBiomass: {
    totalKg: number;
    bySpecies: BiomassSpeciesBreakdown[];
  };
  stockings: BiomassStockingRecord[];
  mortality: {
    totalCount: number;
    byCause: Array<{ cause: string; count: number }>;
    details: BiomassMortalityDetail[];
  };
  slaughter: {
    totalQuantity: number;
    totalBiomassKg: number;
    records: BiomassSlaughterRecord[];
  };
  transfers: BiomassTransferRecord[];
  feedConsumption: {
    totalKg: number;
    byFeedType: BiomassFeedEntry[];
  };
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('biomass_reports')
@Unique('UQ_biomass_report_period', [
  'tenantId',
  'siteId',
  'reportMonth',
  'reportYear',
])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'siteId', 'reportYear'])
export class BiomassReport {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  @Field()
  @Column('uuid')
  siteId: string;

  /** Calendar month, 1–12 (not zero-based — matches the frontend form). */
  @Field(() => Int)
  @Column('int')
  reportMonth: number;

  @Field(() => Int)
  @Column('int')
  reportYear: number;

  @Field(() => BiomassReportStatus)
  @Column({
    type: 'enum',
    enum: BiomassReportStatus,
    default: BiomassReportStatus.DRAFT,
  })
  status: BiomassReportStatus;

  /**
   * Full form snapshot. Typed as `BiomassReportPayload` at the
   * TypeScript layer; stored as JSONB. A runtime validator in the
   * command handler verifies every required sub-field so the DB never
   * carries a half-populated payload.
   */
  @Field(() => GraphQLJSON)
  @Column('jsonb')
  reportData: BiomassReportPayload;

  /** Denormalised for fast list queries (sum of bySpecies.biomassKg). */
  @Field()
  @Column('decimal', { precision: 14, scale: 2, default: 0 })
  totalBiomassKg: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  generatedBy?: string;

  @Field({ nullable: true })
  @Column('timestamptz', { nullable: true })
  submittedAt?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  submittedBy?: string;

  /** When the report was marked READY for the Altinn export (RPT-001). */
  @Field({ nullable: true })
  @Column('timestamptz', { nullable: true })
  readyAt?: Date;

  /** Altinn/Fiskeridirektoratet receipt reference the operator confirmed. */
  @Field(() => String, { nullable: true })
  @Column('varchar', { length: 64, nullable: true })
  altinnReference?: string | null;

  /** Operator who confirmed the Altinn submission. */
  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  confirmedBy?: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
