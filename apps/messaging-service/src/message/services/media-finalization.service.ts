import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { Readable } from 'stream';
import { MAX_IMAGE_PIXELS, ThumbnailService } from './thumbnail.service';

/**
 * Raster image MIME types eligible for server-side EXIF/GPS stripping and
 * dimension probing (MSG-MEDIUM-056 / MSG-HIGH-056). Only true raster images are
 * re-encoded — never pdf/audio/video/documents. `image/svg+xml` is NOT here (it
 * is rejected at the allowlist boundary entirely; SVG is an XSS vector).
 */
const STRIPPABLE_IMAGE_MIME_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/**
 * Result of finalizing a single attachment. Every field is best-effort and
 * nullable — finalization NEVER gates the send. The handler INSERTs these onto
 * the MessageAttachment row after a successful finalization pass.
 */
export interface AttachmentFinalization {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  thumbnailKey: string | null;
}

/**
 * MediaFinalizationService — the make-it-automatic (Tier-2) post-upload
 * finalization pass for messaging media.
 *
 * MSG-HIGH-056 (dead media columns) + MSG-MEDIUM-056 (server-side EXIF/GPS
 * strip): for every raster image attachment this service, in ONE Sharp decode,
 *   1. probes intrinsic width/height,
 *   2. bakes EXIF orientation via `.rotate()` then re-encodes WITHOUT
 *      `.withMetadata()` (Sharp's default strips all EXIF/IPTC/XMP/GPS), and
 *   3. writes the cleaned bytes back over the SAME storage key,
 * then delegates the 256x256 thumbnail to the EXISTING ThumbnailService (Sharp).
 *
 * WHY a dedicated service (Plan A) and not inflating the handler (Plan B): the
 * handler already owns idempotency + transaction orchestration; it should not
 * also own Sharp/S3 mechanics. The handler calls finalizeAttachment for each key
 * in the pre-transaction validation phase (alongside validateAttachmentKey's
 * HeadObject) and only INSERTs the returned columns — so the DB transaction does
 * INSERTs only, never a Sharp fetch+resize+re-upload.
 *
 * FAIL-CLOSED on strip: if the strip pass throws, finalizeAttachment rethrows so
 * the send is NOT shipped referencing the leaky original. The thumbnail step is
 * fail-SOFT (returns null) because a missing thumbnail is cosmetic, not a
 * security leak.
 */
@Injectable()
export class MediaFinalizationService {
  private readonly logger = new Logger(MediaFinalizationService.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;

  constructor(
    configService: ConfigService,
    private readonly thumbnailService: ThumbnailService,
  ) {
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
   * Whether a MIME type is a raster image we strip + probe + thumbnail.
   */
  isStrippableImage(mimeType: string): boolean {
    return STRIPPABLE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
  }

  /**
   * Finalize one uploaded attachment BEFORE it is referenced by a message row.
   *
   * For a raster image: strip EXIF/GPS (re-PUT over the same key), probe
   * dimensions, and generate the thumbnail. For any other MIME (pdf/audio/video/
   * docs): a no-op returning all-null columns plus the caller-supplied
   * durationSeconds (audio/video duration comes from the client metadata, not
   * Sharp).
   *
   * @param storageKey - The verified, tenant-scoped object key
   * @param mimeType - The confirmed MIME type (from MinIO HeadObject)
   * @param durationSeconds - Voice/video duration in seconds (null for images)
   * @returns The finalized, persistable attachment columns
   * @throws if the EXIF strip pass fails for a raster image (fail-closed — the
   *   send must not reference the un-stripped original)
   */
  async finalizeAttachment(
    storageKey: string,
    mimeType: string,
    durationSeconds: number | null,
  ): Promise<AttachmentFinalization> {
    if (!this.isStrippableImage(mimeType)) {
      // Non-image: no strip, no dimensions, no thumbnail. Duration (if any)
      // flows through from the client metadata unchanged.
      return { width: null, height: null, durationSeconds, thumbnailKey: null };
    }

    // ── 1. Fetch the original bytes ONCE (shared decode for probe + strip) ──
    const original = await this.fetchObject(storageKey);
    if (!original) {
      // Could not read the just-uploaded object. This is the same fail-closed
      // posture as the strip throwing: we must not ship a message referencing an
      // object whose metadata we could not clean.
      throw new Error(`MediaFinalization: original object unreadable: ${storageKey}`);
    }

    // ── 2. Probe dimensions + strip EXIF/GPS, then re-PUT the cleaned bytes ──
    // A strip failure THROWS (fail-closed): the caller aborts the send rather
    // than persist a row pointing at EXIF-laden bytes.
    const dimensions = await this.thumbnailService.probeImage(original);
    // SEC-MEDIUM-074: fail-closed pixel cap — dimensions now gate the send.
    if (dimensions && dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
      throw new Error(
        `MediaFinalization: image exceeds pixel cap ` +
          `(${dimensions.width}x${dimensions.height}); refusing decode`,
      );
    }
    const cleaned = await this.stripImageMetadata(original, mimeType);
    await this.putObject(storageKey, cleaned, mimeType);

    // ── 3. Thumbnail (fail-SOFT) — reuse the EXISTING ThumbnailService. It
    // re-fetches the now-CLEAN object and writes {key}_thumb. A null result
    // (unsupported format e.g. gif, or transient error) leaves thumbnailKey null
    // and the message still sends. ──
    const thumbnailKey = await this.thumbnailService.generateThumbnail(storageKey, mimeType);

    return {
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      durationSeconds,
      thumbnailKey,
    };
  }

  /**
   * Re-encode a raster image WITHOUT metadata, baking EXIF orientation first.
   *
   * Sharp strips ALL EXIF/IPTC/XMP/GPS by default (we never call
   * `.withMetadata()`). `.rotate()` (no arg) reads the EXIF orientation tag and
   * physically rotates pixels so the visual orientation survives the strip.
   * Animated GIFs are decoded with `{ animated: true }` so frames are preserved;
   * png/webp re-encode losslessly.
   */
  private async stripImageMetadata(buffer: Buffer, mimeType: string): Promise<Buffer> {
    const normalized = mimeType.toLowerCase();
    if (normalized === 'image/gif') {
      // Preserve all frames of an animated GIF while dropping metadata.
      return sharp(buffer, { animated: true }).gif().toBuffer();
    }
    const pipeline = sharp(buffer).rotate();
    switch (normalized) {
      case 'image/png':
        return pipeline.png().toBuffer();
      case 'image/webp':
        // lossless preserves the original pixels while re-encoding cleanly.
        return pipeline.webp({ lossless: true }).toBuffer();
      case 'image/jpeg':
      default:
        return pipeline.jpeg().toBuffer();
    }
  }

  /**
   * Fetch an object from S3/MinIO as a Buffer, or null if it cannot be read.
   */
  private async fetchObject(key: string): Promise<Buffer | null> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) {
        return null;
      }
      const stream = response.Body as Readable;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to fetch object for finalization ${key}: ${message}`);
      return null;
    }
  }

  /**
   * Overwrite the object at `key` with the cleaned bytes, preserving the MIME.
   */
  private async putObject(key: string, body: Buffer, mimeType: string): Promise<void> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
      }),
    );
  }
}
