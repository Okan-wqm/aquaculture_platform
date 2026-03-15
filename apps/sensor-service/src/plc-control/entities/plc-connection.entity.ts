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
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  siteId!: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  tankId?: string;

  @Field()
  @Column()
  name!: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  description?: string;

  @Field()
  @Column()
  endpointUrl!: string;

  @Field(() => PlcSecurityMode)
  @Column({ type: 'varchar', default: PlcSecurityMode.NONE })
  securityMode!: PlcSecurityMode;

  @Field({ nullable: true })
  @Column({ type: 'varchar', nullable: true, default: 'None' })
  securityPolicy?: string;

  @Field(() => PlcAuthMode)
  @Column({ type: 'varchar', default: PlcAuthMode.ANONYMOUS })
  authMode!: PlcAuthMode;

  @Field({ nullable: true })
  @Column({ nullable: true })
  username?: string;

  @Column({ nullable: true })
  password?: string; // Not exposed in GraphQL

  // Certificate authentication
  @Column({ type: 'text', nullable: true })
  clientCertificate?: string; // PEM format client certificate

  @Column({ type: 'text', nullable: true })
  clientPrivateKey?: string; // PEM format private key (encrypted at rest)

  @Column({ type: 'text', nullable: true })
  serverCertificate?: string; // PEM format trusted server certificate

  @Field(() => PlcConnectionStatus)
  @Column({ type: 'varchar', default: PlcConnectionStatus.OFFLINE })
  status!: PlcConnectionStatus;

  @Field({ nullable: true })
  @Column({ nullable: true })
  lastConnectedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  lastError?: string;

  @Field()
  @Column({ default: 1000 })
  publishingIntervalMs!: number;

  @Field()
  @Column({ default: 500 })
  samplingIntervalMs!: number;

  @Field()
  @Column({ default: 60000 })
  sessionTimeoutMs!: number;

  // Connection timeouts
  @Field()
  @Column({ default: 5000 })
  connectTimeoutMs!: number;

  @Field()
  @Column({ default: 60000 })
  requestTimeoutMs!: number;

  // Reconnection settings
  @Field()
  @Column({ default: true })
  autoReconnect!: boolean;

  @Field()
  @Column({ default: -1 })
  maxReconnectAttempts!: number; // -1 = infinite

  @Field()
  @Column({ default: 1000 })
  reconnectDelayMs!: number;

  @Field()
  @Column({ default: 30000 })
  maxReconnectDelayMs!: number;

  @Field()
  @Column({ default: 5000 })
  keepAliveIntervalMs!: number;

  // Failover
  @Field({ nullable: true })
  @Column({ nullable: true })
  failoverEndpointUrl?: string;

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
  isActive!: boolean;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;
}
