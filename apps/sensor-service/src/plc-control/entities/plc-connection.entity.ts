import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum PlcConnectionStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  CONNECTING = 'CONNECTING',
  ERROR = 'ERROR',
}

export enum PlcSecurityMode {
  NONE = 'None',
  SIGN = 'Sign',
  SIGN_AND_ENCRYPT = 'SignAndEncrypt',
}

export enum PlcAuthMode {
  ANONYMOUS = 'Anonymous',
  USERNAME = 'Username',
  CERTIFICATE = 'Certificate',
}

registerEnumType(PlcConnectionStatus, { name: 'PlcConnectionStatus' });
registerEnumType(PlcSecurityMode, { name: 'PlcSecurityMode' });
registerEnumType(PlcAuthMode, { name: 'PlcAuthMode' });

@ObjectType()
@Entity('plc_connections')
@Index(['tenantId', 'siteId'])
export class PlcConnection {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  @Index()
  tenantId: string;

  @Field()
  @Column()
  siteId: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  tankId?: string;

  @Field()
  @Column()
  name: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  description?: string;

  @Field()
  @Column()
  endpointUrl: string;

  @Field(() => PlcSecurityMode)
  @Column({ type: 'varchar', default: PlcSecurityMode.NONE })
  securityMode: PlcSecurityMode;

  @Field({ nullable: true })
  @Column({ nullable: true })
  securityPolicy?: string;

  @Field(() => PlcAuthMode)
  @Column({ type: 'varchar', default: PlcAuthMode.ANONYMOUS })
  authMode: PlcAuthMode;

  @Field({ nullable: true })
  @Column({ nullable: true })
  username?: string;

  @Column({ nullable: true })
  password?: string; // Not exposed in GraphQL

  @Field(() => PlcConnectionStatus)
  @Column({ type: 'varchar', default: PlcConnectionStatus.OFFLINE })
  status: PlcConnectionStatus;

  @Field({ nullable: true })
  @Column({ nullable: true })
  lastConnectedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  lastError?: string;

  @Field()
  @Column({ default: 1000 })
  publishingIntervalMs: number;

  @Field()
  @Column({ default: 500 })
  samplingIntervalMs: number;

  @Field()
  @Column({ default: 60000 })
  sessionTimeoutMs: number;

  // OPC UA Node IDs for different data types
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  parametersNodeId?: string; // Node ID for writing parameters

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  telemetryNodeId?: string; // Node ID for reading telemetry

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  alarmsNodeId?: string; // Node ID for reading alarms

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  statusNodeId?: string; // Node ID for reading PLC status

  @Field()
  @Column({ default: true })
  isActive: boolean;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;
}
