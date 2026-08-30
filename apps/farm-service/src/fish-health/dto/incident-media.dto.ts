/**
 * Incident-media upload DTOs — the presigned-upload request/response pair for
 * incident photos (escape / welfare / lice).
 *
 * The request is the FIRST validation gate: incidentType, filename, mimeType and
 * fileSize are checked before a presigned PUT URL is minted. The mimeType and
 * fileSize bounds here are advisory (the presigned PUT cannot bind them), so the
 * real enforcement is re-run on finalize against the stored object.
 *
 * @module FishHealth
 */
import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsEnum, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

import { IncidentMediaType } from '../entities/farm-incident-media.entity';
import { INCIDENT_MEDIA_MAX_BYTES } from '../constants/incident-media.constants';

@InputType()
export class RequestIncidentMediaUploadInput {
  @Field(() => IncidentMediaType)
  @IsEnum(IncidentMediaType)
  incidentType!: IncidentMediaType;

  @Field()
  @IsString()
  @MaxLength(255)
  filename!: string;

  @Field()
  @IsString()
  @MaxLength(127)
  mimeType!: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(INCIDENT_MEDIA_MAX_BYTES)
  fileSize!: number;
}

@ObjectType()
export class IncidentMediaUploadResponse {
  @Field()
  uploadUrl!: string;

  @Field()
  storageKey!: string;

  @Field()
  expiresAt!: Date;
}
