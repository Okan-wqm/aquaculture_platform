import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

export enum FarmDocumentState {
  PENDING_UPLOAD = 'PENDING_UPLOAD',
  UPLOADED_UNVERIFIED = 'UPLOADED_UNVERIFIED',
  ACTIVE = 'ACTIVE',
  QUARANTINED = 'QUARANTINED',
  DELETE_PENDING = 'DELETE_PENDING',
  DELETED = 'DELETED',
}

export enum FarmDocumentOwnerType {
  CHEMICAL = 'CHEMICAL',
  FEED = 'FEED',
  BATCH = 'BATCH',
  SITE = 'SITE',
  SUPPLIER = 'SUPPLIER',
  EQUIPMENT = 'EQUIPMENT',
  TANK = 'TANK',
  WORKER = 'WORKER',
  SENTINEL_SETTINGS = 'SENTINEL_SETTINGS',
  OTHER = 'OTHER',
}

export enum FarmDocumentScanState {
  NOT_REQUIRED = 'NOT_REQUIRED',
  PENDING = 'PENDING',
  PASSED = 'PASSED',
  FAILED = 'FAILED',
}

registerEnumType(FarmDocumentState, {
  name: 'FarmDocumentState',
  description: 'Canonical lifecycle state for farm document metadata.',
});

registerEnumType(FarmDocumentOwnerType, {
  name: 'FarmDocumentOwnerType',
  description: 'Canonical setup aggregate that owns a farm document.',
});

registerEnumType(FarmDocumentScanState, {
  name: 'FarmDocumentScanState',
  description: 'Malware/content scan state for a farm document object.',
});

@ObjectType()
@Entity('farm_documents')
@Index(['tenantId', 'ownerType', 'ownerId'])
@Index(['tenantId', 'state'])
@Index(['tenantId', 'scanState'])
@Index(['tenantId', 'documentType'])
@Index(['tenantId', 'bucket', 'objectKey'], { unique: true })
export class FarmDocument {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field(() => FarmDocumentOwnerType)
  @Column({
    type: 'enum',
    enum: FarmDocumentOwnerType,
    enumName: 'farm_documents_owner_type_enum',
  })
  ownerType!: FarmDocumentOwnerType;

  @Field()
  @Column('uuid')
  ownerId!: string;

  @Field()
  @Column({ length: 255 })
  documentName!: string;

  @Field()
  @Column({ length: 80 })
  documentType!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => FarmDocumentState)
  @Column({
    type: 'enum',
    enum: FarmDocumentState,
    enumName: 'farm_documents_state_enum',
    default: FarmDocumentState.PENDING_UPLOAD,
  })
  state!: FarmDocumentState;

  @Field(() => FarmDocumentScanState)
  @Column({
    type: 'enum',
    enum: FarmDocumentScanState,
    enumName: 'farm_documents_scan_state_enum',
    default: FarmDocumentScanState.PENDING,
  })
  scanState!: FarmDocumentScanState;

  @Field()
  @Column({ length: 120 })
  bucket!: string;

  @Field()
  @Column({ length: 1024 })
  objectKey!: string;

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  originalFilename?: string;

  @Field({ nullable: true })
  @Column({ length: 160, nullable: true })
  mimeType?: string;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  fileSizeBytes?: number;

  @Field({ nullable: true })
  @Column({ length: 128, nullable: true })
  checksumSha256?: string;

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  etag?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  uploadExpiresAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  uploadedAt?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  uploadedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  stateChangedAt?: Date;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  retentionUntil?: Date;

  @Field()
  @Column({ default: false })
  legalHold!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  legalHoldReason?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  deleteRequestedAt?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  deleteRequestedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  deletedBy?: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;
}
