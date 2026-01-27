import { ObjectType, Field, ID, Float, GraphQLISODateTime } from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * Sensor readings JSONB structure
 */
@ObjectType('SensorReadings')
export class SensorReadings {
  @Field(() => Float, { nullable: true })
  temperature?: number;

  @Field(() => Float, { nullable: true })
  ph?: number;

  @Field(() => Float, { nullable: true })
  dissolvedOxygen?: number;

  @Field(() => Float, { nullable: true })
  salinity?: number;

  @Field(() => Float, { nullable: true })
  ammonia?: number;

  @Field(() => Float, { nullable: true })
  nitrite?: number;

  @Field(() => Float, { nullable: true })
  nitrate?: number;

  @Field(() => Float, { nullable: true })
  turbidity?: number;

  @Field(() => Float, { nullable: true })
  waterLevel?: number;
}

/**
 * Sensor Reading Entity
 * Designed for TimescaleDB hypertable - high-performance time-series storage
 * Optimized for ingestion rates of 10K+ readings per second across all tenants
 */
@ObjectType()
@Entity('sensor_readings') // Schema comes from search_path (tenant-specific)
@Index(['sensorId', 'timestamp'])
@Index(['tenantId', 'timestamp'])
@Index(['pondId', 'timestamp'])
export class SensorReading {
  @Field(() => ID)
  @PrimaryColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  sensorId!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field(() => GraphQLISODateTime)
  @Column({ type: 'timestamptz' })
  @Index()
  timestamp!: Date;

  @Field(() => SensorReadings)
  @Column('jsonb')
  readings!: SensorReadings;

  @Field({ nullable: true })
  @Column({ nullable: true })
  pondId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  farmId?: string;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  quality?: number; // Data quality score 0-100

  @Field({ nullable: true })
  @Column({ nullable: true })
  source?: string; // mqtt, http, batch

  @CreateDateColumn()
  createdAt!: Date;
}
