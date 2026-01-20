import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';

export enum CertificationCategory {
  DIVING = 'diving',
  SAFETY = 'safety',
  VESSEL = 'vessel',
  EQUIPMENT = 'equipment',
  FIRST_AID = 'first_aid',
  FOOD_HANDLING = 'food_handling',
  ENVIRONMENTAL = 'environmental',
  MANAGEMENT = 'management',
  TECHNICAL = 'technical',
  OTHER = 'other',
}

export enum CertificationRequirement {
  MANDATORY = 'mandatory',
  RECOMMENDED = 'recommended',
  OPTIONAL = 'optional',
}

registerEnumType(CertificationCategory, { name: 'CertificationCategory' });
registerEnumType(CertificationRequirement, { name: 'CertificationRequirement' });

@ObjectType()
@Entity('certification_types', { schema: 'hr' })
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'category'])
@Index(['tenantId', 'isActive'])
export class CertificationType {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 30 })
  code!: string;

  @Field()
  @Column({ length: 150 })
  name!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => CertificationCategory)
  @Column({ type: 'enum', enum: CertificationCategory, default: CertificationCategory.OTHER })
  category!: CertificationCategory;

  @Field(() => CertificationRequirement)
  @Column({ type: 'enum', enum: CertificationRequirement, default: CertificationRequirement.OPTIONAL })
  requirement!: CertificationRequirement;

  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  issuingAuthority?: string;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  validityMonths?: number; // Duration before expiry

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  renewalReminderDays?: number; // Days before expiry to send reminder

  @Field()
  @Column({ default: false })
  requiresRenewal!: boolean;

  @Field()
  @Column({ default: false })
  requiresPhysicalAssessment!: boolean;

  @Field()
  @Column({ default: false })
  isOffshoreRequired!: boolean; // Required for offshore work

  @Field()
  @Column({ default: false })
  isDivingRequired!: boolean; // Required for diving work

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  applicableWorkAreas?: string[]; // Work areas where this cert is required

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  prerequisiteCertifications?: string[]; // Other certs required first

  @Field({ nullable: true })
  @Column({ length: 7, nullable: true })
  colorCode?: string;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  displayOrder!: number;

  @Field()
  @Column({ default: true })
  isActive!: boolean;

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
