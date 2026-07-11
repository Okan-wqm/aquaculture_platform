import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
  VersionColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Float, Directive } from '@nestjs/graphql';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
// Note: Pond is referenced via string to avoid circular dependency
// Type-only import for TypeScript type checking
import type { Pond } from './pond.entity';

/**
 * Geographic location value object
 */
@ObjectType('Location')
export class Location {
  @Field(() => Float)
  lat!: number;

  @Field(() => Float)
  lng!: number;
}

/**
 * Farm entity - represents an aquaculture farm
 * Multi-tenant with tenant isolation
 */
@ObjectType()
@Directive('@key(fields: "id")')
@Entity('farms')
@Index(['tenantId', 'name'], { unique: true })
@Index(['tenantId', 'isActive'])
export class Farm {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  name!: string;

  @Field(() => Location)
  @Column('jsonb')
  location!: Location;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  address?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  contactPerson?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  contactPhone?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  contactEmail?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  totalArea?: number; // in hectares

  // READ-ONLY LEGACY — the OneToMany relation stays for the GraphQL
  // `pond` query that read legacy data. Writes on this surface are
  // disabled: `createPond` / `createFarm` mutations are @deprecated and
  // throw BadRequestException (see farm.resolver.ts), and the
  // corresponding command handlers were removed in phase 1.2 of the
  // "kalan kör noktalar" plan.
  //
  // Intentionally not exposed as a GraphQL field to avoid the circular
  // type issue between Farm and Pond; clients use the top-level `pond`
  // query to resolve individual ponds.
  @OneToMany('Pond', 'farm', { cascade: true })
  ponds?: Pond[];

  @Field()
  @Column({ default: true })
  isActive!: boolean;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  @VersionColumn()
  version!: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  updatedBy?: string;
}
