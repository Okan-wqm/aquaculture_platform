import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';
import { WorkArea } from './work-area.entity';

export enum RotationType {
  OFFSHORE = 'offshore',
  ONSHORE = 'onshore',
  FIELD = 'field',
  VESSEL = 'vessel',
  MIXED = 'mixed',
}

export enum RotationStatus {
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  EXTENDED = 'extended',
}

export enum TransportMethod {
  BOAT = 'boat',
  HELICOPTER = 'helicopter',
  VEHICLE = 'vehicle',
  OTHER = 'other',
}

registerEnumType(RotationType, { name: 'RotationType' });
registerEnumType(RotationStatus, { name: 'RotationStatus' });
registerEnumType(TransportMethod, { name: 'TransportMethod' });

@ObjectType()
export class TransportInfo {
  @Field(() => TransportMethod)
  method!: TransportMethod;

  @Field({ nullable: true })
  vehicleId?: string;

  @Field({ nullable: true })
  departurePoint?: string;

  @Field({ nullable: true })
  arrivalPoint?: string;

  @Field({ nullable: true })
  scheduledTime?: Date;

  @Field({ nullable: true })
  actualTime?: Date;

  @Field({ nullable: true })
  notes?: string;
}

@ObjectType()
@Entity('work_rotations', { schema: 'hr' })
@Index(['tenantId', 'employeeId', 'startDate'])
@Index(['tenantId', 'status', 'startDate'])
@Index(['tenantId', 'workAreaId', 'startDate'])
@Index(['tenantId', 'rotationType'])
export class WorkRotation {
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

  @Field()
  @Column()
  workAreaId!: string;

  @ManyToOne(() => WorkArea)
  @JoinColumn({ name: 'workAreaId' })
  workArea?: WorkArea;

  @Field(() => RotationType)
  @Column({ type: 'enum', enum: RotationType })
  rotationType!: RotationType;

  @Field(() => RotationStatus)
  @Column({ type: 'enum', enum: RotationStatus, default: RotationStatus.SCHEDULED })
  status!: RotationStatus;

  @Field()
  @Column({ type: 'date' })
  startDate!: Date;

  @Field()
  @Column({ type: 'date' })
  endDate!: Date;

  @Field(() => Int)
  @Column({ type: 'int' })
  daysOn!: number;

  @Field(() => Int)
  @Column({ type: 'int' })
  daysOff!: number;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  actualStartTime?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  actualEndTime?: Date;

  @Field(() => TransportInfo, { nullable: true })
  @Column('jsonb', { nullable: true })
  outboundTransport?: TransportInfo;

  @Field(() => TransportInfo, { nullable: true })
  @Column('jsonb', { nullable: true })
  inboundTransport?: TransportInfo;

  @Field({ nullable: true })
  @Column({ nullable: true })
  accommodationInfo?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  supervisorId?: string; // Supervisor during rotation

  @Field({ nullable: true })
  @Column({ nullable: true })
  reliefEmployeeId?: string; // Who covers when employee is off

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // Extension tracking
  @Field()
  @Column({ default: false })
  isExtended!: boolean;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  extensionDays?: number;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  extensionReason?: string;

  // Safety check-in
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastCheckInTime?: Date;

  @Field({ nullable: true })
  @Column('jsonb', { nullable: true })
  checkInHistory?: {
    time: Date;
    location?: { lat: number; lng: number };
    method: string;
  }[];

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
