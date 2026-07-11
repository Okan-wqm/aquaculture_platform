import { InputType, Field, ID, Int } from '@nestjs/graphql';
import { IsUUID, IsString, MaxLength, IsInt, Min, Max } from 'class-validator';

/** Maximum file size: 25 MB */
const MAX_FILE_SIZE = 26_214_400;

/**
 * Input for requesting a presigned upload URL for media attachments.
 */
@InputType()
export class RequestMediaUploadInput {
  @Field(() => ID, { description: 'Channel the file belongs to' })
  @IsUUID()
  channelId!: string;

  @Field(() => String, { description: 'Original filename' })
  @IsString()
  @MaxLength(255)
  filename!: string;

  @Field(() => String, { description: 'MIME type of the file' })
  @IsString()
  @MaxLength(127)
  mimeType!: string;

  @Field(() => Int, {
    description: 'File size in bytes (max 25 MB = 26214400)',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_FILE_SIZE)
  fileSize!: number;
}
