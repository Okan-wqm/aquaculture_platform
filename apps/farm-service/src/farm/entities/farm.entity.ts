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
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
// Note: Pond is referenced via string to avoid circular dependency
// Type-only import for TypeScript type checking
import type { Pond } from './pond.entity';

/**
 * Geographic location value object
 */
@ObjectType('Location')
export class Location {
  @Field(() => Float)
  lat: number;

  @Field(() => Float)
  lng: number;
}

/**
 * Farm entity - represents an aquaculture farm
 * Multi-tenant with tenant isolation
 */
@ObjectType()
@Entity('farms')
@Index(['tenantId', 'name'], { unique: true })
@Index(['tenantId', 'isActive'])
export class Farm {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  name: string;

  @Field(() => Location)
  @Column('jsonb')
  location: Location;

  @Field()
  @Column()
  @Index()
  tenantId: string;

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

  // Note: ponds relation available via TypeORM but not exposed in GraphQL
  // Use farm.ponds query in resolver instead to avoid circular type issues
  @OneToMany('Pond', 'farm', { cascade: true })
  ponds?: Pond[];

  @Field()
  @Column({ default: true })
  isActive: boolean;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;

  @VersionColumn()
  version: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  updatedBy?: string;
}
