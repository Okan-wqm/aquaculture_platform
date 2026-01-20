/**
 * Upload Batch Document DTO
 * @module Upload/DTO
 */
import { IsNotEmpty, IsString, IsOptional, IsEnum, IsUUID } from 'class-validator';

/**
 * Category for batch documents during upload
 */
export enum BatchDocumentCategory {
  HEALTH_CERTIFICATE = 'health_certificate',
  IMPORT_DOCUMENT = 'import_document',
  ORIGIN_CERTIFICATE = 'origin_certificate',
  QUARANTINE_PERMIT = 'quarantine_permit',
  TRANSPORT_DOCUMENT = 'transport_document',
  VETERINARY_CERTIFICATE = 'veterinary_certificate',
  CUSTOMS_DECLARATION = 'customs_declaration',
  OTHER = 'other',
}

export class UploadBatchDocumentDto {
  @IsNotEmpty()
  @IsString()
  documentName: string;

  @IsNotEmpty()
  @IsEnum(BatchDocumentCategory)
  documentCategory: BatchDocumentCategory;

  @IsOptional()
  @IsString()
  documentNumber?: string;

  @IsOptional()
  @IsUUID()
  batchId?: string; // Optional - can upload before batch is created (temp storage)
}
