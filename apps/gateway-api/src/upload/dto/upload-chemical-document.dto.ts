/**
 * Upload Chemical Document DTO
 * @module Upload/DTO
 */
import { IsUUID, IsString, IsEnum, MaxLength, IsNotEmpty } from 'class-validator';

export enum ChemicalDocumentType {
  MSDS = 'msds',
  LABEL = 'label',
  PROTOCOL = 'protocol',
  CERTIFICATE = 'certificate',
  OTHER = 'other',
}

export class UploadChemicalDocumentDto {
  @IsUUID()
  @IsNotEmpty()
  chemicalId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  documentName!: string;

  @IsEnum(ChemicalDocumentType)
  documentType!: ChemicalDocumentType;
}

export class DeleteChemicalDocumentDto {
  @IsUUID()
  @IsNotEmpty()
  chemicalId!: string;

  @IsUUID()
  @IsNotEmpty()
  documentId!: string;
}
