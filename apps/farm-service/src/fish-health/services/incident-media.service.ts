/**
 * Incident Media Service — mints presigned upload URLs for incident photos and
 * finalizes them into the per-tenant `farm_incident_media` table.
 *
 * Security posture (this is a presigned-upload + tenant-isolation surface):
 *  - MIME allowlist is enforced TWICE: at request time (before a URL is signed)
 *    and again on finalize against the object's real Content-Type. The presigned
 *    PUT cannot bind Content-Type, so the request-time check is advisory and the
 *    finalize check is the real gate (defence in depth).
 *  - Every storage key is tenant-first (`incident-media/<tenantId>/…`) and every
 *    key presented on finalize is verified to carry THIS tenant's prefix — a
 *    cross-tenant key is rejected, closing the key-injection vector.
 *  - finalize also verifies the object EXISTS (upload actually completed) and is
 *    within the size bound before a row is written.
 *
 * @module FishHealth
 */
import { randomUUID as uuidv4 } from 'crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { MinioClientService } from '@platform/storage';

import { FarmIncidentMedia, IncidentMediaType } from '../entities/farm-incident-media.entity';
import { RequestIncidentMediaUploadInput, IncidentMediaUploadResponse } from '../dto/incident-media.dto';
import {
  INCIDENT_MEDIA_MAX_BYTES,
  INCIDENT_MEDIA_MAX_KEYS,
  isAllowedIncidentMediaMime,
} from '../constants/incident-media.constants';

/** Presigned upload URL validity window (15 minutes). */
const UPLOAD_URL_TTL_SECONDS = 900;

/** Canonical fallback extension when the filename carries none. */
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class IncidentMediaService {
  private readonly logger = new Logger(IncidentMediaService.name);

  constructor(private readonly minio: MinioClientService) {}

  /**
   * Mint a tenant-scoped presigned PUT URL for a single incident photo. Rejects
   * a non-image MIME BEFORE signing — the shared getPresignedUploadUrl does not
   * enforce Content-Type, so this is the request-time gate.
   */
  async requestUpload(
    tenantId: string,
    input: RequestIncidentMediaUploadInput,
  ): Promise<IncidentMediaUploadResponse> {
    if (!isAllowedIncidentMediaMime(input.mimeType)) {
      throw new BadRequestException(
        `Unsupported incident media type: ${input.mimeType}. Allowed: JPEG, PNG, WebP`,
      );
    }

    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const ext = this.resolveExtension(input.filename, input.mimeType);
    // Tenant-first prefix — the finalize check relies on this exact shape.
    const storageKey = `incident-media/${tenantId}/${input.incidentType}/${yyyy}/${mm}/${uuidv4()}.${ext}`;

    const uploadUrl = await this.minio.getPresignedUploadUrl(
      storageKey,
      UPLOAD_URL_TTL_SECONDS,
      input.mimeType,
    );
    const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000);

    this.logger.log(
      `Signed incident-media upload for tenant (key=${storageKey}, type=${input.incidentType})`,
    );
    return { uploadUrl, storageKey, expiresAt };
  }

  /**
   * Finalize previously-uploaded media into the incident record, inside the
   * caller's transaction. Every key is re-validated against the tenant prefix,
   * object existence, real Content-Type and size before a row is written.
   */
  async attach(
    manager: EntityManager,
    tenantId: string,
    incidentType: IncidentMediaType,
    referenceId: string,
    mediaKeys: string[] | undefined,
    userId: string | undefined,
  ): Promise<void> {
    if (!mediaKeys || mediaKeys.length === 0) {
      return;
    }
    if (mediaKeys.length > INCIDENT_MEDIA_MAX_KEYS) {
      throw new BadRequestException(
        `Too many media keys for one incident: ${mediaKeys.length} (max ${INCIDENT_MEDIA_MAX_KEYS})`,
      );
    }

    const expectedPrefix = `incident-media/${tenantId}/`;
    const repo = tenantManagerRepo(manager, FarmIncidentMedia, tenantId);

    for (const key of mediaKeys) {
      if (!key.startsWith(expectedPrefix)) {
        throw new BadRequestException(`Media key does not belong to this tenant: ${key}`);
      }

      const stats = await this.minio.getFileStats(key);
      if (stats === null) {
        throw new BadRequestException(`Media not found or upload incomplete: ${key}`);
      }
      if (!isAllowedIncidentMediaMime(stats.contentType)) {
        throw new BadRequestException(
          `Uploaded media has a disallowed content type: ${stats.contentType} (${key})`,
        );
      }
      if (stats.size > INCIDENT_MEDIA_MAX_BYTES) {
        throw new BadRequestException(
          `Uploaded media exceeds the ${INCIDENT_MEDIA_MAX_BYTES}-byte limit: ${stats.size} (${key})`,
        );
      }

      await repo.save(
        repo.create({
          tenantId,
          incidentType,
          referenceId,
          storageKey: key,
          mimeType: stats.contentType,
          fileSizeBytes: String(stats.size),
          createdBy: userId,
        }),
      );
    }

    this.logger.log(
      `Attached ${mediaKeys.length} media item(s) to ${incidentType} incident ${referenceId}`,
    );
  }

  /**
   * Extension from the filename when present, else the canonical extension for
   * the (already-validated) MIME type.
   */
  private resolveExtension(filename: string, mimeType: string): string {
    const dotIndex = filename.lastIndexOf('.');
    const fromName =
      dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    return fromName || MIME_TO_EXTENSION[mimeType.toLowerCase()] || 'bin';
  }
}
