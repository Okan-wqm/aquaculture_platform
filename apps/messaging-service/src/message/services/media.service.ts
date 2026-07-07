import { Inject, Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID as uuidv4 } from 'crypto';
import { MESSAGING_MEDIA_MIME_ALLOWLIST } from '@aquaculture/shared-contracts';
import {
  STORAGE_OBJECT_VERIFIER,
  StorageObjectVerifier,
} from './storage-object-verifier.port';
import { createMessagingS3 } from '../../shared/messaging-s3-client.factory';

/**
 * Voice-note duration metadata key — single source of truth (MSG-HIGH-055).
 *
 * The client (ChatRoomPage) sends `metadata: { durationSeconds }` and the typed
 * `MessageAttachment.durationSeconds` column persists it. The server previously
 * read a DIFFERENT key (`voiceDurationSeconds`) the client never sent, so the
 * duration was always dropped. This const is the one literal both the read
 * (extractVoiceDuration) and the handler write align on, so a future rename is a
 * single compile-time site.
 */
export const VOICE_DURATION_METADATA_KEY = 'durationSeconds';

/** Result of generating a presigned upload URL */
export interface MediaUploadResult {
  uploadUrl: string;
  storageKey: string;
  expiresAt: Date;
}

/**
 * Allowed MIME types for media uploads — the server-side TRUST BOUNDARY check.
 *
 * MSG-MEDIUM-057: this Set is built from the single shared allowlist SSoT
 * (`MESSAGING_MEDIA_MIME_ALLOWLIST` in @aquaculture/shared-contracts), the SAME
 * list the client (useMediaUpload.ts / AttachmentPicker.tsx) uses for pre-flight
 * UX validation. There is no longer a second hand-maintained list to drift from.
 * `image/svg+xml` remains excluded (stored-XSS vector) at the SSoT level.
 */
const ALLOWED_MIME_TYPES = new Set<string>(MESSAGING_MEDIA_MIME_ALLOWLIST);

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

  constructor(
    configService: ConfigService,
    @Inject(STORAGE_OBJECT_VERIFIER)
    private readonly storageObjectVerifier: StorageObjectVerifier,
  ) {
    const { client, bucket } = createMessagingS3(configService);
    this.s3Client = client;
    this.bucket = bucket;
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
   * SECURITY (H-12): Validates that the storage key belongs to the requesting tenant
   * by checking the tenant-scoped path prefix `messaging/{tenantId}/`. This prevents
   * a user in tenant A from generating download URLs for media belonging to tenant B
   * by manipulating the storageKey parameter. All media objects follow the convention
   * `messaging/{tenantId}/{channelId}/{year}/{month}/{uuid}.{ext}`, so any key that
   * does not start with the expected tenant prefix is a cross-tenant access attempt.
   *
   * @param tenantId - Tenant UUID of the requesting user, used for path-based isolation validation
   * @param storageKey - S3/MinIO object key (must follow the convention messaging/{tenantId}/...)
   * @returns Presigned download URL
   * @throws ForbiddenException if the storage key does not belong to the requesting tenant
   */
  async generateDownloadUrl(tenantId: string, storageKey: string): Promise<string> {
    const expectedPrefix = `messaging/${tenantId}/`;
    if (!storageKey.startsWith(expectedPrefix)) {
      this.logger.warn(
        `Tenant isolation violation: tenant=${tenantId} attempted to access storageKey=${storageKey}`,
      );
      throw new ForbiddenException(
        'Access denied: the requested media does not belong to your tenant',
      );
    }

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
   * Validate an attachment storage key before persisting it in a message.
   *
   * Checks two things:
   * 1. Tenant isolation: the key must start with `messaging/{tenantId}/` —
   *    rejects cross-tenant references where tenant A supplies tenant B's key.
   * 2. Upload completion: HeadObject confirms the file exists in MinIO/S3 and
   *    returns actual ContentLength and ContentType to replace the placeholders
   *    ('application/octet-stream', fileSize: 0) currently stored at send time.
   *
   * @throws BadRequestException if the key is invalid, cross-tenant, or missing.
   */
  async validateAttachmentKey(
    tenantId: string,
    storageKey: string,
  ): Promise<{ contentLength: number; contentType: string }> {
    const expectedPrefix = `messaging/${tenantId}/`;
    if (!storageKey.startsWith(expectedPrefix)) {
      throw new BadRequestException(
        `Attachment key does not belong to this tenant: ${storageKey}`,
      );
    }

    return this.storageObjectVerifier.verifyObject(storageKey);
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
   * Check whether a MIME type represents an audio file (voice notes, audio messages).
   * Used by thumbnail service to skip thumbnail generation for audio uploads.
   *
   * @param mimeType - MIME type string to check
   * @returns true if the MIME type is an audio type
   */
  isAudioMimeType(mimeType: string): boolean {
    return mimeType.toLowerCase().startsWith('audio/');
  }

  /**
   * Extract voice note duration from the metadata field of a SendMessage command.
   *
   * MSG-HIGH-055: the client records the duration in seconds and sends it under
   * the SSoT key `metadata.durationSeconds` (see VOICE_DURATION_METADATA_KEY).
   * The previous read used `voiceDurationSeconds` — a key the client never sent,
   * so the duration was silently dropped on every voice note. Reading via the
   * shared const aligns server + client + the typed
   * MessageAttachment.durationSeconds column on one name.
   *
   * @param metadata - Arbitrary metadata from the message command
   * @returns Duration in seconds, or null if not present/invalid
   */
  extractVoiceDuration(metadata: Record<string, unknown> | null): number | null {
    if (!metadata) return null;
    const duration = metadata[VOICE_DURATION_METADATA_KEY];
    if (typeof duration === 'number' && isFinite(duration) && duration >= 0) {
      return Math.round(duration * 100) / 100; // 2 decimal places
    }
    return null;
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
