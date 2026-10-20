/**
 * Temperature scenario — the production plan's forward-looking water
 * temperature curve for a site (PLAT design record, 2026-10-19).
 *
 * The operator enters dated points ("1 Oct 13 °C, 1 Nov 15 °C") and the
 * simulation interpolates piecewise-linearly between them: rising rises,
 * falling falls, equal stays flat; before the first / after the last point
 * the curve is clamped.
 *
 * `source` marks where the points came from. MANUAL is the primary path —
 * land-based farms have no satellite water temperature to pull, so hand
 * entry is the contract, not a stopgap. For sea sites a COPERNICUS fill
 * may later write points from the weather domain's MarineObservation
 * (CMEMS sea_surface_temperature, apps/farm-service/src/weather/) — the
 * fetch stays THERE; this table only ever stores the resolved curve, so
 * no parallel ingestion pipeline grows beside it.
 */
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Field, ID, Float, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum TemperatureScenarioSource {
  MANUAL = 'manual',
  COPERNICUS = 'copernicus',
}

registerEnumType(TemperatureScenarioSource, {
  name: 'TemperatureScenarioSource',
  description: 'Sıcaklık senaryo noktalarının kaynağı (elle girildi / Copernicus).',
});

@Index(['tenantId', 'siteId'])
@Index(['tenantId', 'isDeleted'])
@Entity('temperature_scenarios')
export class TemperatureScenario {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  tenantId!: string;

  /** Sahınkapsamı — su sıcaklığı site bazlıdır. */
  @Field(() => ID)
  @Column('uuid')
  siteId!: string;

  @Field()
  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Field(() => TemperatureScenarioSource)
  @Column({
    type: 'enum',
    enum: TemperatureScenarioSource,
    default: TemperatureScenarioSource.MANUAL,
  })
  source!: TemperatureScenarioSource;

  @Field()
  @Column({ type: 'boolean', default: false })
  isDeleted!: boolean;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}

@ObjectType()
export class TemperatureScenarioResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  siteId!: string;

  @Field()
  name!: string;

  @Field(() => TemperatureScenarioSource)
  source!: TemperatureScenarioSource;

  @Field(() => [TemperatureScenarioPointResponse])
  points!: TemperatureScenarioPointResponse[];

  @Field()
  createdAt!: Date;
}

@ObjectType()
export class TemperatureScenarioPointResponse {
  @Field()
  date!: string;

  @Field(() => Float)
  celsius!: number;
}
