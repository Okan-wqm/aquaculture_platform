/**
 * Add Chemical Document Input DTO
 * @module Farm/Chemical
 */
import { InputType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { IsUUID, IsNotEmpty, IsString, IsEnum, MaxLength, IsUrl, IsOptional } from 'class-validator';

export enum ChemicalDocumentType {
  MSDS = 'msds',
  LABEL = 'label',
  PROTOCOL = 'protocol',
  CERTIFICATE = 'certificate',
  OTHER = 'other',
}

registerEnumType(ChemicalDocumentType, {
  name: 'ChemicalDocumentType',
  description: 'Type of chemical document',
});

@InputType()
export class AddChemicalDocumentInput {
  @Field(() => ID)
  @IsUUID()
  @IsNotEmpty()
  chemicalId: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(36)
  documentId: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  documentName: string;

  @Field(() => ChemicalDocumentType)
  @IsEnum(ChemicalDocumentType)
  documentType: ChemicalDocumentType;

  @Field()
  @IsString()
  @IsNotEmpty()
  url: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  uploadedAt: string;
}
