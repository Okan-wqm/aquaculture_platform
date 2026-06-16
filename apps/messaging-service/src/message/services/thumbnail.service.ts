import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { Readable } from 'stream';

/** Thumbnail dimensions */
const THUMB_WIDTH = 256;
const THUMB_HEIGHT = 256;

/** MIME types supported for thumbnail generation */
const THUMBNABLE_MIME_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** Map input MIME to sharp output format */
const OUTPUT_FORMAT_MAP: Record<string, keyof sharp.FormatEnum> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Service for generating image thumbnails using Sharp.js.
 *
 * Triggered after upload confirmation; fetches the original from S3/MinIO,
 * generates a 256x256 thumbnail, and stores it at {key}_thumb.{ext}.
 */
@Injectable()
export class ThumbnailService {
  private readonly logger = new Logger(ThumbnailService.name);
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
      forcePathStyle: true,
    });
    this.bucket = configService.get<string>('MINIO_BUCKET', 'messaging');
  }

  /**
   * Check if a given MIME type supports thumbnail generation.
   */
  canGenerateThumbnail(mimeType: string): boolean {
    return THUMBNABLE_MIME_TYPES.has(mimeType.toLowerCase());
  }

  /**
   * Probe an image buffer for its intrinsic pixel dimensions (MSG-HIGH-056).
   *
   * Extends this existing Sharp service rather than introducing a second Sharp
   * decode path: the finalization pass calls probeImage on the SAME bytes it
   * strips + thumbnails, so dimensions, EXIF-strip, and thumbnail share one
   * decode. Returns null on any decode failure (best-effort, nullable columns);
   * dimensions never gate the send.
   *
   * @param buffer - Raw image bytes
   * @returns `{ width, height }` in pixels, or null if Sharp cannot read them
   */
  async probeImage(buffer: Buffer): Promise<{ width: number; height: number } | null> {
    try {
      const metadata = await sharp(buffer).metadata();
      if (typeof metadata.width === 'number' && typeof metadata.height === 'number') {
        return { width: metadata.width, height: metadata.height };
      }
      return null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Image probe failed: ${message}`);
      return null;
    }
  }

  /**
   * Generate a 256x256 thumbnail for an uploaded image.
   *
   * @param storageKey - S3/MinIO key of the original image
   * @param mimeType - MIME type of the original
   * @returns The storage key of the generated thumbnail, or null if generation failed
   */
  async generateThumbnail(
    storageKey: string,
    mimeType: string,
  ): Promise<string | null> {
    if (!this.canGenerateThumbnail(mimeType)) {
      this.logger.debug(`Skipping thumbnail for unsupported MIME: ${mimeType}`);
      return null;
    }

    try {
      // 1. Fetch original image from S3
      const originalData = await this.fetchObject(storageKey);
      if (!originalData) {
        this.logger.warn(`Could not fetch original for thumbnail: ${storageKey}`);
        return null;
      }

      // 2. Generate thumbnail with sharp
      const format = OUTPUT_FORMAT_MAP[mimeType.toLowerCase()] ?? 'jpeg';
      const thumbnailBuffer = await sharp(originalData)
        .resize(THUMB_WIDTH, THUMB_HEIGHT, {
          fit: 'cover',
          position: 'centre',
          withoutEnlargement: true,
        })
        .toFormat(format)
        .toBuffer();

      // 3. Compute thumbnail key: insert _thumb before the extension
      const thumbKey = this.buildThumbnailKey(storageKey);

      // 4. Upload thumbnail to S3
      const putCommand = new PutObjectCommand({
        Bucket: this.bucket,
        Key: thumbKey,
        Body: thumbnailBuffer,
        ContentType: mimeType,
        CacheControl: 'public, max-age=31536000, immutable',
      });
      await this.s3Client.send(putCommand);

      this.logger.debug(`Thumbnail generated: ${thumbKey} (${thumbnailBuffer.length} bytes)`);
      return thumbKey;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Thumbnail generation failed for ${storageKey}: ${message}`);
      return null;
    }
  }

  /**
   * Build the thumbnail storage key from the original key.
   * Example: messaging/t1/ch1/2026/03/abc.jpg -> messaging/t1/ch1/2026/03/abc_thumb.jpg
   */
  private buildThumbnailKey(originalKey: string): string {
    const lastDot = originalKey.lastIndexOf('.');
    if (lastDot === -1) {
      return `${originalKey}_thumb`;
    }
    const base = originalKey.substring(0, lastDot);
    const ext = originalKey.substring(lastDot);
    return `${base}_thumb${ext}`;
  }

  /**
   * Fetch an object from S3 and return its contents as a Buffer.
   */
  private async fetchObject(key: string): Promise<Buffer | null> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      const response = await this.s3Client.send(command);

      if (!response.Body) {
        return null;
      }

      // Convert readable stream to buffer
      const stream = response.Body as Readable;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }

      return Buffer.concat(chunks);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to fetch S3 object ${key}: ${message}`);
      return null;
    }
  }
}
