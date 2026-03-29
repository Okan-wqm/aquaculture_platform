import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

/** Result of generating a presigned upload URL */
export interface MediaUploadResult {
  uploadUrl: string;
  storageKey: string;
  expiresAt: Date;
}

/**
 * Allowed MIME types for media uploads.
 * Extensible — add more as requirements grow.
 */
const ALLOWED_MIME_TYPES = new Set<string>([
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Archives
  'application/zip',
  'application/x-7z-compressed',
  // Audio
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  // Video
  'video/mp4',
  'video/webm',
  // Text
  'text/plain',
  'text/csv',
]);

/** Presigned URL expiry in seconds (15 minutes) */
const PRESIGNED_UPLOAD_EXPIRY = 900;
/** Download URL expiry in seconds (1 hour) */
const PRESIGNED_DOWNLOAD_EXPIRY = 3600;

/**
 * Service for MinIO/S3-compatible media storage operations.
 *
 * Handles presigned URL generation for upload and download,
 * MIME type validation, and storage key generation.
 *
 * Storage key pattern: messaging/{tenantId}/{channelId}/{year}/{month}/{uuid}.{ext}
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;

  constructor(private readonly configService: ConfigService) {
    this.s3Client = new S3Client({
      endpoint: configService.get<string>('MINIO_ENDPOINT', 'http://localhost:9000'),
      region: configService.get<string>('MINIO_REGION', 'us-east-1'),
      credentials: {
        accessKeyId: configService.get<string>('MINIO_ACCESS_KEY', 'minioadmin'),
        secretAccessKey: configService.get<string>('MINIO_SECRET_KEY', 'minioadmin'),
      },
      forcePathStyle: true, // Required for MinIO
    });
    this.bucket = configService.get<string>('MINIO_BUCKET', 'messaging');
  }

  /**
   * Generate a presigned PUT URL for uploading a media file.
   *
   * @param tenantId - Tenant UUID
   * @param channelId - Channel UUID
   * @param filename - Original filename
   * @param mimeType - MIME type of the file
   * @returns Upload URL, storage key, and expiration timestamp
   * @throws BadRequestException if MIME type is not allowed
   */
  async generateUploadUrl(
    tenantId: string,
    channelId: string,
    filename: string,
    mimeType: string,
  ): Promise<MediaUploadResult> {
    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.has(mimeType.toLowerCase())) {
      throw new BadRequestException(
        `MIME type '${mimeType}' is not allowed. Supported types: images, documents, audio, video, text.`,
      );
    }

    // TODO: Check tenant storage quota before generating URL.
    //       Query tenant's current usage from a quota tracking table/cache,
    //       and reject if fileSize would exceed the allocated storage.

    const ext = this.extractExtension(filename);
    const storageKey = this.buildStorageKey(tenantId, channelId, ext);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      ContentType: mimeType,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: PRESIGNED_UPLOAD_EXPIRY,
    });

    const expiresAt = new Date(Date.now() + PRESIGNED_UPLOAD_EXPIRY * 1000);

    this.logger.debug(
      `Upload URL generated: key=${storageKey}, mime=${mimeType}, expires=${expiresAt.toISOString()}`,
    );

    return { uploadUrl, storageKey, expiresAt };
  }

  /**
   * Generate a presigned GET URL for downloading a media file.
   *
   * @param storageKey - S3/MinIO object key
   * @returns Presigned download URL
   */
  async generateDownloadUrl(storageKey: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
    });

    const downloadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: PRESIGNED_DOWNLOAD_EXPIRY,
    });

    return downloadUrl;
  }

  /**
   * Build a storage key following the convention:
   * messaging/{tenantId}/{channelId}/{year}/{month}/{uuid}.{ext}
   */
  private buildStorageKey(tenantId: string, channelId: string, ext: string): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const fileId = uuidv4();

    return `messaging/${tenantId}/${channelId}/${year}/${month}/${fileId}.${ext}`;
  }

  /**
   * Extract file extension from filename, defaulting to 'bin' if none found.
   */
  private extractExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1 || lastDot === filename.length - 1) {
      return 'bin';
    }
    // Sanitize extension to alphanumeric only
    const ext = filename.substring(lastDot + 1).replace(/[^a-zA-Z0-9]/g, '');
    return ext || 'bin';
  }
}
