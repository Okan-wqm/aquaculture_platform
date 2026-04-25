import { ObjectType, Field, ID, Float, Directive, GraphQLISODateTime } from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common';

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
 *
 * Apollo Federation v2 entity (Scope B Phase S1.2): the
 * `@key(fields: "id")` directive lets farm-service's upcoming
 * `Tank.sensorReadings` field resolver (S1.3) return reference
 * stubs `{ __typename: 'SensorReading', id }`, which the gateway
 * then resolves by calling
 * `SensorReadingResolver.resolveReference` in this service.
 *
 * Why this entity needed federation but Sensor was already there:
 *   - Sensor was wired (mostly) in an earlier phase — the
 *     resolveReference at sensor.resolver.ts:58 existed but the
 *     `@Directive('@key…')` was missing, meaning the supergraph
 *     could not actually compose extensions to it.
 *   - SensorReading had NO entity-level resolver class at all —
 *     queries like `latestReading` lived inside SensorResolver as
 *     operation-level handlers, not as a type owner. This PR adds
 *     the dedicated `SensorReadingResolver` class so the type has
 *     a proper home.
 *
 * Why `id`-only key (not `id + tenantId`): same rationale as the
 * Sensor entity — see that docblock for the architectural note.
 */
@ObjectType()
@Directive('@key(fields: "id")')
@Entity('sensor_readings', { schema: 'sensor' })
@Index(['sensorId', 'timestamp'])
@Index(['tenantId', 'timestamp'])
@Index(['pondId', 'timestamp'])
export class SensorReading {
  @Field(() => ID)
  @PrimaryColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'sensor_id' })
  @Index()
  sensorId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
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
  @Column({ name: 'pond_id', nullable: true })
  pondId?: string;

  @Field({ nullable: true })
  @Column({ name: 'farm_id', nullable: true })
  farmId?: string;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  quality?: number; // Data quality score 0-100

  @Field({ nullable: true })
  @Column({ name: 'source', nullable: true })
  source?: string; // mqtt, http, batch

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
