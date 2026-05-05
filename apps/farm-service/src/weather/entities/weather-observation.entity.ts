/**
 * Weather Observation Entity
 * Open-Meteo Weather API verilerini saklayan tablo
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
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { ObjectType, Field, ID, Float, registerEnumType } from '@nestjs/graphql';

export enum WeatherDataType {
  FORECAST = 'forecast',
  HISTORICAL = 'historical',
}

registerEnumType(WeatherDataType, {
  name: 'WeatherDataType',
  description: 'Tahmin mi geçmiş veri mi',
});

@ObjectType()
@Entity('weather_observations')
@Unique('uq_weather_obs', ['tenantId', 'siteId', 'observedAt', 'dataType'])
@Index(['tenantId'])
@Index(['tenantId', 'siteId', 'observedAt'])
export class WeatherObservation {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'site_id' })
  siteId!: string;

  @Field()
  @Column({ type: 'timestamptz', name: 'observed_at' })
  observedAt!: Date;

  @Field(() => WeatherDataType)
  @Column({
    type: 'varchar',
    length: 20,
    name: 'data_type',
    default: WeatherDataType.FORECAST,
  })
  dataType!: WeatherDataType;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  temperature?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true, name: 'wind_speed', transformer: new DecimalTransformer() })
  windSpeed?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, name: 'wind_direction', transformer: new DecimalTransformer() })
  windDirection?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true, name: 'wind_gusts', transformer: new DecimalTransformer() })
  windGusts?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  precipitation?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, name: 'cloud_cover', transformer: new DecimalTransformer() })
  cloudCover?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 7, scale: 2, nullable: true, name: 'pressure_msl', transformer: new DecimalTransformer() })
  pressureMsl?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, name: 'relative_humidity', transformer: new DecimalTransformer() })
  relativeHumidity?: number;

  @Field()
  @Column({ type: 'timestamptz', name: 'fetched_at', default: () => 'NOW()' })
  fetchedAt!: Date;

  @Field()
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
