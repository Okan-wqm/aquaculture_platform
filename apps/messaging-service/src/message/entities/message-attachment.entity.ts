/**
 * @module MessageAttachment
 * @description Entity for message file attachments with storage key,
 * metadata (filename, MIME, size), and optional thumbnail/media dimensions.
 * @see ADR-012 section 4.3 (Attachments)
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { Message } from './message.entity';

@ObjectType()
@Entity('message_attachments')
@Index('idx_attachments_message', ['messageId'])
@Index('idx_attachments_tenant', ['tenantId'])
export class MessageAttachment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Tenant identifier — backfilled from parent message in
   * migration 1782300000000-AddTenantIdToMessageChildren. Required
   * for the tenant_isolation_policy RLS predicate (ADR-011).
   */
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid' })
  messageId!: string;

  @Column({ type: 'timestamptz' })
  messageCreatedAt!: Date;

  @Column({ type: 'varchar', length: 512 })
  storageKey!: string;

  @Field()
  @Column({ type: 'varchar', length: 255 })
  originalFilename!: string;

  @Field()
  @Column({ type: 'varchar', length: 127 })
  mimeType!: string;

  @Field()
  @Column({ type: 'bigint' })
  fileSize!: number;

  @Field(() => Number, { nullable: true })
  @Column({ type: 'integer', nullable: true })
  width!: number | null;

  @Field(() => Number, { nullable: true })
  @Column({ type: 'integer', nullable: true })
  height!: number | null;

  @Field(() => Float, { nullable: true })
  // DecimalTransformer: durationSeconds for audio/video attachments displayed in UI and used in
  // media processing time estimates. String arithmetic corrupts duration calculations.
  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  durationSeconds!: number | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnailKey!: string | null;

  // `downloadUrl` and `thumbnailUrl` are NOT declared here (tier-1 make-it-impossible,
  // MSG-CRITICAL-052). They are computed presigned URLs with no backing column; they
  // exist in the schema ONLY via MessageAttachmentResolver.@ResolveField, so the field
  // cannot ship without the resolver that signs it. The previous bare @Field declarations
  // had no resolver and silently returned null for every attachment.

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  // Soft-delete: attachment records must align with message soft-delete lifecycle.
  // When a message is soft-deleted, its attachments should also be soft-deleted (not physically removed)
  // to preserve file reference integrity for legal hold and eDiscovery purposes.
  // BEFORE: no soft-delete on attachment — message.isDeleted=true but attachment rows remained
  // physically accessible, creating an inconsistent deletion state.
  @Column({ type: 'boolean', default: false, name: 'is_deleted' })
  @Index()
  isDeleted: boolean = false;

  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt: Date | null = null;

  softDelete(): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
  }

  @ManyToOne(() => Message, (msg) => msg.attachments, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'messageId', referencedColumnName: 'id' },
    { name: 'messageCreatedAt', referencedColumnName: 'createdAt' },
  ])
  message!: Message;
}
