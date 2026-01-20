import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';

export enum SafetyTrainingType {
  INDUCTION = 'induction',
  FIRE_SAFETY = 'fire_safety',
  SEA_SURVIVAL = 'sea_survival',
  FIRST_AID = 'first_aid',
  HELICOPTER_SAFETY = 'helicopter_safety',
  VESSEL_SAFETY = 'vessel_safety',
  DIVING_SAFETY = 'diving_safety',
  CHEMICAL_HANDLING = 'chemical_handling',
  FALL_PROTECTION = 'fall_protection',
  CONFINED_SPACE = 'confined_space',
  EMERGENCY_RESPONSE = 'emergency_response',
  BIOSECURITY = 'biosecurity',
}

export enum SafetyTrainingStatus {
  NOT_STARTED = 'not_started',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  EXPIRED = 'expired',
  OVERDUE = 'overdue',
}

registerEnumType(SafetyTrainingType, { name: 'SafetyTrainingType' });
registerEnumType(SafetyTrainingStatus, { name: 'SafetyTrainingStatus' });

@ObjectType()
@Entity('safety_training_records', { schema: 'hr' })
@Index(['tenantId', 'employeeId', 'trainingType'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'expiryDate'])
export class SafetyTrainingRecord {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  @Index()
  employeeId!: string;

  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employeeId' })
  employee?: Employee;

  @Field(() => SafetyTrainingType)
  @Column({ type: 'enum', enum: SafetyTrainingType })
  trainingType!: SafetyTrainingType;

  @Field(() => SafetyTrainingStatus)
  @Column({ type: 'enum', enum: SafetyTrainingStatus, default: SafetyTrainingStatus.NOT_STARTED })
  status!: SafetyTrainingStatus;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  completedDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  expiryDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  nextDueDate?: Date;

  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  instructor?: string;

  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  location?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  certificateNumber?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field()
  @Column({ default: false })
  isMandatoryForOffshore!: boolean;

  @Field()
  @Column({ default: false })
  reminderSent!: boolean;

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
}
