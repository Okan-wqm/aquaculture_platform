import { ObjectType, Field, ID, Float, Directive, GraphQLISODateTime } from '@nestjs/graphql';

/**
 * Sensor readings structure — the nine-parameter reading vocabulary as a
 * GraphQL object. No longer a persisted JSONB column: it is assembled at read
 * time from the per-channel sensor.sensor_metrics store (SENSOR-HIGH-085).
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

  /**
   * Mass in KILOGRAMS (`SensorType.MASS` — load cells).
   *
   * Added with the mass parameter itself: the platform previously had no way to
   * express a weight, so a `SensorReadingParameter` of `'mass'` would have had
   * no field here to index and the projection would have silently produced
   * nothing. The consumer is farm-service's feeder silo-mass read model, which
   * is what makes "this feeder dispenses by measured weight" a checkable claim
   * rather than a configuration flag.
   */
  @Field(() => Float, { nullable: true })
  mass?: number;
}

/**
 * SensorReading — Apollo Federation read-model (NOT a persistence entity).
 *
 * SENSOR-HIGH-085: a sensor reading is no longer a stored row. It is a CQRS
 * as-of PROJECTION over the single per-channel source of truth
 * `sensor.sensor_metrics`: the last-known value of each of a sensor's channels
 * at an anchor instant, assembled into the nine-parameter shape. This class
 * therefore carries ONLY GraphQL/federation decorators — no TypeORM `@Entity`,
 * `@Column`, or `@PrimaryColumn`. ORM decorators do not belong on a derived
 * read-model (CLAUDE.md: domain/persistence separation), and there is no
 * `sensor_readings` table for them to map to any more.
 *
 * Federation identity (`@key(fields: "id")`): the `id` is an OPAQUE codec of the
 * projection's anchor `(sensorId, as-of instant)` — see SensorReadingIdCodec —
 * not a database key. SensorReadingResolver.resolveReference decodes it and
 * re-runs the as-of reconstruction, so farm-service's future
 * `Tank.sensorReadings` extension (S1.3) resolves references produced by any of
 * this service's per-reading reads.
 */
@ObjectType()
@Directive('@key(fields: "id")')
export class SensorReading {
  /** Opaque as-of anchor codec (sensorId + full-precision instant). */
  @Field(() => ID)
  id!: string;

  @Field()
  sensorId!: string;

  @Field()
  tenantId!: string;

  /** The as-of instant this projection was reconstructed at. */
  @Field(() => GraphQLISODateTime)
  timestamp!: Date;

  @Field(() => SensorReadings)
  readings!: SensorReadings;

  @Field({ nullable: true })
  pondId?: string;

  @Field({ nullable: true })
  farmId?: string;

  /** Data quality score 0-100, recomputed from the projected readings. */
  @Field(() => Float, { nullable: true })
  quality?: number;

  /** Modal source protocol across the contributing channels. */
  @Field({ nullable: true })
  source?: string;
}
