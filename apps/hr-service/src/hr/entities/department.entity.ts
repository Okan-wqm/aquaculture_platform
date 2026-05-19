import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

@ObjectType()
@Entity('departments_hr')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'isDeleted'])
@Index(['tenantId', 'siteId'])
export class DepartmentHR {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid' })
  @Index()
  tenantId!: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  siteId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  parentDepartmentId?: string;

  @Field()
  @Column({ length: 150 })
  name!: string;

  @Field()
  @Column({ length: 20 })
  code!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  managerId?: string;

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  budgetCode?: string;

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  costCenter?: string;

  @Field()
  @Column({ default: true })
  isActive!: boolean;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;

  @Field()
  @Column({ default: false })
  isDeleted!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedBy?: string;
}
