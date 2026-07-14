/**
 * Farm Incident Media — a persisted photo attached to one of the three
 * field-capture incident records (escape incident, welfare assessment, lice
 * count). Rows are written in the SAME transaction as the incident they back,
 * so a media row can never outlive-or-precede its incident.
 *
 * The (incidentType, referenceId) pair is a polymorphic reference into the
 * owning record; it is NOT an FK because it spans three parent tables. Tenant
 * isolation is carried explicitly by tenantId (per-tenant clone + RLS predicate).
 *
 * Per-tenant table (schema-per-tenant): NO `schema:` (ADR-011) — it is cloned
 * into each tenant_<uuid> and routed by search_path at runtime.
 *
 * @module FishHealth
 */
import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum IncidentMediaType {
  ESCAPE = 'ESCAPE',
  WELFARE = 'WELFARE',
  LICE = 'LICE',
}

registerEnumType(IncidentMediaType, {
  name: 'IncidentMediaType',
  description: 'Which field-capture incident record a media row belongs to',
});

@ObjectType()
@Entity('farm_incident_media')
@Index(['tenantId', 'incidentType', 'referenceId'])
export class FarmIncidentMedia {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field(() => IncidentMediaType)
  @Column({ type: 'enum', enum: IncidentMediaType })
  incidentType!: IncidentMediaType;

  @Field(() => ID)
  @Column('uuid')
  referenceId!: string;

  @Field()
  @Column({ type: 'varchar', length: 512 })
  storageKey!: string;

  @Field()
  @Column({ type: 'varchar', length: 127 })
  mimeType!: string;

  /**
   * TypeORM returns bigint as a string (values may exceed the JS safe-integer
   * range), so the field is typed `string` and exposed as a GraphQL String —
   * mirrors the `message-attachment.entity.ts` bigint column intent without the
   * lossy number coercion.
   */
  @Field()
  @Column({ type: 'bigint' })
  fileSizeBytes!: string;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  originalFilename?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
