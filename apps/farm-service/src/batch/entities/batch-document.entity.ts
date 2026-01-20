/**
 * BatchDocument Entity - Batch Documents (Health Certificates, Import Documents)
 *
 * Stores metadata for documents associated with batches such as:
 * - Health certificates
 * - Import documents
 * - Origin certificates
 * - Transport documents
 *
 * Files are stored in MinIO, this entity tracks the metadata and storage location.
 *
 * @module Batch
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import { Batch } from './batch.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Document types for batch-related documents
 */
export enum BatchDocumentType {
  HEALTH_CERTIFICATE = 'health_certificate',
  IMPORT_DOCUMENT = 'import_document',
  ORIGIN_CERTIFICATE = 'origin_certificate',
  QUARANTINE_PERMIT = 'quarantine_permit',
  TRANSPORT_DOCUMENT = 'transport_document',
  VETERINARY_CERTIFICATE = 'veterinary_certificate',
  CUSTOMS_DECLARATION = 'customs_declaration',
  OTHER = 'other',
}

registerEnumType(BatchDocumentType, {
  name: 'BatchDocumentType',
  description: 'Type of batch document',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('batch_documents')
@Index(['tenantId', 'batchId'])
@Index(['tenantId', 'documentType'])
export class BatchDocument {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  @Field()
  @Column('uuid')
  @Index()
  batchId: string;

  @ManyToOne(() => Batch, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'batchId' })
  batch: Batch;

  // -------------------------------------------------------------------------
  // DOCUMENT INFO
  // -------------------------------------------------------------------------

  @Field(() => BatchDocumentType)
  @Column({
    type: 'enum',
    enum: BatchDocumentType,
  })
  documentType: BatchDocumentType;

  @Field()
  @Column({ length: 255 })
  documentName: string;

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  documentNumber?: string;

  // -------------------------------------------------------------------------
  // FILE STORAGE INFO
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 500 })
  storagePath: string;

  @Field()
  @Column({ length: 500 })
  storageUrl: string;

  @Field()
  @Column({ length: 255 })
  originalFilename: string;

  @Field()
  @Column({ length: 100 })
  mimeType: string;

  @Field(() => Int)
  @Column({ type: 'int' })
  fileSize: number;

  // -------------------------------------------------------------------------
  // DOCUMENT METADATA
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  issueDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  expiryDate?: Date;

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  issuingAuthority?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // STATUS
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: true })
  isActive: boolean;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Check if document is expired
   */
  isExpired(): boolean {
    if (!this.expiryDate) return false;
    return new Date(this.expiryDate) < new Date();
  }

  /**
   * Check if document will expire within given days
   */
  willExpireWithinDays(days: number): boolean {
    if (!this.expiryDate) return false;
    const expiryDate = new Date(this.expiryDate);
    const checkDate = new Date();
    checkDate.setDate(checkDate.getDate() + days);
    return expiryDate <= checkDate;
  }

  /**
   * Get file extension from original filename
   */
  getFileExtension(): string {
    const parts = this.originalFilename.split('.');
    const ext = parts[parts.length - 1];
    return parts.length > 1 && ext ? ext.toLowerCase() : '';
  }

  /**
   * Format file size for display
   */
  getFormattedFileSize(): string {
    if (this.fileSize < 1024) return `${this.fileSize} B`;
    if (this.fileSize < 1024 * 1024) return `${(this.fileSize / 1024).toFixed(1)} KB`;
    return `${(this.fileSize / (1024 * 1024)).toFixed(1)} MB`;
  }
}
