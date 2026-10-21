/**
 * One dated point of a temperature scenario's curve (one entity per file —
 * the tenant-fanout parity scanner reads the first @Entity per file).
 *
 * Kept as rows (not JSON) so the interpolation reads a range query and the
 * Copernicus provider can upsert points by date without rewriting a blob.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { Field, Float, ID } from '@nestjs/graphql';

@Index(['tenantId', 'scenarioId', 'date'])
@Entity('temperature_scenario_points')
export class TemperatureScenarioPoint {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  tenantId!: string;

  @Field(() => ID)
  @Column('uuid')
  scenarioId!: string;

  /** Yerel site günü (date, saat yok — interpolasyon gün çözünürlüklü). */
  @Field()
  @Column({ type: 'date' })
  date!: string;

  @Field(() => Float)
  @Column({ type: 'real' })
  celsius!: number;
}
