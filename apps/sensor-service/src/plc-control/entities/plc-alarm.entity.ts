import { ObjectType, Field, ID, Float, registerEnumType } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum AlarmSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
  EMERGENCY = 'EMERGENCY',
}

export enum AlarmSource {
  OXYGEN_SENSOR = 'OXYGEN_SENSOR',
  TEMPERATURE_SENSOR = 'TEMPERATURE_SENSOR',
  PH_SENSOR = 'PH_SENSOR',
  FLOW_SENSOR = 'FLOW_SENSOR',
  BLOWER_VFD = 'BLOWER_VFD',
  DOSER_VFD = 'DOSER_VFD',
  FEEDING_SYSTEM = 'FEEDING_SYSTEM',
  PLC_SYSTEM = 'PLC_SYSTEM',
  COMMUNICATION = 'COMMUNICATION',
}

registerEnumType(AlarmSeverity, { name: 'AlarmSeverity' });
registerEnumType(AlarmSource, { name: 'AlarmSource' });

@ObjectType()
@Entity('plc_alarms')
@Index(['tenantId', 'plcConnectionId', 'timestamp'])
@Index(['tenantId', 'acknowledged'])
export class PlcAlarm {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  plcConnectionId!: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  tankId?: string;

  @Field()
  @Column()
  alarmCode!: string; // e.g., "ALM-2026-001"

  @Field(() => AlarmSeverity)
  @Column({ type: 'varchar' })
  severity!: AlarmSeverity;

  @Field(() => AlarmSource)
  @Column({ type: 'varchar' })
  source!: AlarmSource;

  @Field()
  @Column()
  message!: string;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  value?: number; // Current value that triggered the alarm

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  threshold?: number; // Threshold that was exceeded

  @Field({ nullable: true })
  @Column({ nullable: true })
  action?: string; // Action taken by PLC (e.g., "Besleme durduruldu")

  @Field()
  @Column()
  @Index()
  timestamp!: Date;

  @Field()
  @Column({ default: false })
  acknowledged!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  acknowledgedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  acknowledgedBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  clearedAt?: Date; // When the alarm condition was cleared

  @Field({ nullable: true })
  @Column({ nullable: true })
  notes?: string; // Operator notes

  @Field()
  @CreateDateColumn()
  createdAt!: Date;
}
