import { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';

/** A constructed messaging S3/MinIO client paired with its target bucket. */
export interface MessagingS3 {
  readonly client: S3Client;
  readonly bucket: string;
}

/**
 * Single construction site for the messaging MinIO/S3 client + bucket.
 *
 * MediaService (presign/upload/download) and AttachmentObjectPurgeService
 * (GDPR/retention object deletion, MSG-CRITICAL-058) both build their client
 * here, so the endpoint/region/credentials/bucket come from ONE MINIO_* config
 * read and cannot drift between the write path and the erasure path — an erasure
 * pointed at a different bucket than uploads would silently leave PII behind.
 */
export function createMessagingS3(configService: ConfigService): MessagingS3 {
  const client = new S3Client({
    endpoint: configService.get<string>('MINIO_ENDPOINT', 'http://localhost:9000'),
    region: configService.get<string>('MINIO_REGION', 'us-east-1'),
    credentials: {
      accessKeyId: configService.get<string>('MINIO_ACCESS_KEY', 'minioadmin'),
      secretAccessKey: configService.get<string>('MINIO_SECRET_KEY', 'minioadmin'),
    },
    forcePathStyle: true, // Required for MinIO
  });
  const bucket = configService.get<string>('MINIO_BUCKET', 'messaging');
  return { client, bucket };
}
