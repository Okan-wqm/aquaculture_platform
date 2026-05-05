import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  StorageObjectMetadata,
  StorageObjectVerifier,
} from './storage-object-verifier.port';

@Injectable()
export class S3StorageObjectVerifier implements StorageObjectVerifier {
  private readonly logger = new Logger(S3StorageObjectVerifier.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    this.s3Client = new S3Client({
      endpoint: configService.get<string>('MINIO_ENDPOINT', 'http://localhost:9000'),
      region: configService.get<string>('MINIO_REGION', 'us-east-1'),
      credentials: {
        accessKeyId: configService.get<string>('MINIO_ACCESS_KEY', 'minioadmin'),
        secretAccessKey: configService.get<string>('MINIO_SECRET_KEY', 'minioadmin'),
      },
      forcePathStyle: true,
    });
    this.bucket = configService.get<string>('MINIO_BUCKET', 'messaging');
  }

  async verifyObject(storageKey: string): Promise<StorageObjectMetadata> {
    try {
      const head = await this.s3Client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType ?? 'application/octet-stream',
      };
    } catch (err) {
      const code = (err as { Code?: string; name?: string }).Code ?? (err as Error).name;
      if (code === 'NotFound' || code === 'NoSuchKey') {
        throw new BadRequestException(
          `Attachment not found or upload incomplete: ${storageKey}`,
        );
      }
      this.logger.error(`HeadObject failed for ${storageKey}: ${(err as Error).message}`);
      throw new BadRequestException(`Could not verify attachment: ${storageKey}`);
    }
  }
}
