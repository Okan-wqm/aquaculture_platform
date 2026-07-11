/**
 * Treatment Application — one row per applied treatment (medicinal or
 * non-medicinal), the operational record behind the lakselus report's
 * behandlinger arrays.
 *
 * Application FACTS (what/where/how much/when) live ONLY here, referencing
 * the chemicals catalog; HealthEvent keeps the clinical narrative
 * (diagnosis, quarantine, vet consultation). Method/virkestoff values use
 * the official Mattilsynet enums so the assembler emits them verbatim.
 *
 * Per-tenant table (schema-per-tenant): NO `schema:` (ADR-011).
 */
import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

export enum TreatmentCategory {
  MEDICINAL = 'medicinal',
  NON_MEDICINAL = 'non_medicinal',
}

registerEnumType(TreatmentCategory, {
  name: 'TreatmentCategory',
  description: 'Medicinal (virkestoff-based) vs non-medicinal (thermal/mechanical/freshwater)',
});

@ObjectType()
@Entity('treatment_applications')
@Index(['tenantId', 'siteId', 'appliedAt'])
@Index(['tenantId', 'batchId'])
export class TreatmentApplication {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field(() => ID)
  @Column('uuid')
  siteId!: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  tankId?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  batchId?: string;

  /** Clinical narrative link (diagnosis/quarantine live on the health event). */
  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  healthEventId?: string;

  @Field(() => TreatmentCategory)
  @Column({ type: 'enum', enum: TreatmentCategory })
  category!: TreatmentCategory;

  /**
   * Official Mattilsynet method value:
   * non-medicinal → TERMISK_BEHANDLING | MEKANISK_BEHANDLING |
   *                 FERSKVANNSBEHANDLING | ANNEN_BEHANDLING
   * medicinal     → FORBEHANDLING | BADEBEHANDLING | ANNEN_BEHANDLING
   */
  @Field()
  @Column({ length: 40 })
  method!: string;

  /** Chemicals-catalog reference — required for MEDICINAL applications. */
  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  chemicalId?: string;

  /** Official virkestoff enum value (AZAMETHIPHOS … ANNET_VIRKESTOFF). */
  @Field({ nullable: true })
  @Column({ length: 30, nullable: true })
  virkestoffType?: string;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 3,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  styrkeVerdi?: number;

  @Field({ nullable: true })
  @Column({ length: 30, nullable: true })
  styrkeEnhet?: string;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 3,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  mengdeVerdi?: number;

  @Field({ nullable: true })
  @Column({ length: 10, nullable: true })
  mengdeEnhet?: string;

  /** Whether the whole locality was treated (heleLokaliteten). */
  @Field()
  @Column({ type: 'boolean', default: false })
  wholeSite!: boolean;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  pensCount?: number;

  @Field()
  @Column({ type: 'timestamptz' })
  appliedAt!: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  /** Internal worker acting as veterinarian (external vets: name below). */
  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  veterinarianWorkerId?: string;

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  externalVetName?: string;

  /** Free text — only meaningful for ANNEN_BEHANDLING / ANNET_VIRKESTOFF. */
  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  beskrivelse?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  recordedBy?: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
