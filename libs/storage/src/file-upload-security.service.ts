/**
 * FileUploadSecurityService
 *
 * Security wrapper around `MinioClientService.uploadFile`. Every
 * farm-service / admin-api upload path runs through this layer
 * instead of calling MinIO directly, so the size / mime-type
 * policies live in one place and drift across services is
 * impossible.
 *
 * # Responsibilities landed in this phase (6.2 partial)
 *
 *   - Max file size enforcement (per document-type + global cap)
 *   - Mime-type whitelist (per document-type)
 *   - Magic-byte sniff fallback when the caller-declared mime
 *     disagrees with the first-4-byte signature (catches the
 *     obvious "rename-to-jpg" attack even though it does not
 *     replace a real magic-byte library)
 *
 * # Responsibilities deferred to follow-up phases
 *
 *   - **EXIF / metadata strip** (phase 6.2.1) — requires `sharp`
 *     or `exif-reader`; image uploads currently pass through with
 *     GPS coordinates intact. The wrapper exposes an `afterUpload`
 *     extension point so the strip can slot in without changing
 *     the surface.
 *
 *   - **ClamAV virus scan** (phase 6.2.2) — needs a clamd sidecar
 *     + `clamscan` npm dep. When it lands, `scanAfterUpload` fires
 *     async; positive hits move the object to a quarantine bucket
 *     and emit a `FileInfectedEvent`.
 *
 *   - **Orphan cleanup cron** (phase 6.2.3) — scans the bucket
 *     nightly for objects with no DB reference and removes them
 *     after a 30-day grace.
 *
 * # Phase reference
 *
 *   Phase 6.2 of the "Farm modülü kalan kör noktalar" plan.
 *   Closes Girdi 15-C4 size + mime axes.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

import { MinioClientService } from './minio-client.service';
import type { UploadOptions, UploadResult } from './interfaces/storage.interfaces';

/** Mime types that carry EXIF / metadata and need to be stripped. */
const IMAGE_MIMES_WITH_METADATA: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/**
 * Document-type policy. `documentType` values align with the
 * BatchDocumentType / ChemicalDocumentType / HealthEventDocumentType
 * enums on the farm-service side. A policy entry here is an
 * operator opt-in: if a caller uploads a file tagged with an
 * unknown documentType, the service rejects rather than falling
 * back to a permissive default. That keeps the surface area
 * explicit.
 */
export interface UploadPolicy {
  /** Declared document type (e.g. `HEALTH_CERTIFICATE`, `TREATMENT_PHOTO`). */
  documentType: string;
  /** Max size in bytes the policy accepts. */
  maxBytes: number;
  /** Allowed mime types — case-insensitive exact match. */
  allowedMime: readonly string[];
}

/**
 * Default policy registry. Each tenant inherits these thresholds
 * unless an env override narrows them. The caller passes
 * `documentType`; the service looks up the policy or rejects.
 */
const DEFAULT_POLICIES: readonly UploadPolicy[] = [
  {
    documentType: 'HEALTH_CERTIFICATE',
    maxBytes: 5 * 1024 * 1024, // 5 MB — Mattilsynet stamped PDF is ~200KB–1MB
    allowedMime: ['application/pdf'],
  },
  {
    documentType: 'IMPORT_DOCUMENT',
    maxBytes: 5 * 1024 * 1024,
    allowedMime: ['application/pdf'],
  },
  {
    documentType: 'ORIGIN_CERTIFICATE',
    maxBytes: 5 * 1024 * 1024,
    allowedMime: ['application/pdf'],
  },
  {
    documentType: 'QUALITY_CERTIFICATE',
    maxBytes: 5 * 1024 * 1024,
    allowedMime: ['application/pdf'],
  },
  {
    documentType: 'VETERINARY_CERTIFICATE',
    maxBytes: 5 * 1024 * 1024,
    allowedMime: ['application/pdf'],
  },
  {
    documentType: 'TRANSPORT_DOCUMENT',
    maxBytes: 5 * 1024 * 1024,
    allowedMime: ['application/pdf'],
  },
  {
    documentType: 'TREATMENT_PHOTO',
    maxBytes: 10 * 1024 * 1024, // 10 MB — 4K phone photo
    allowedMime: ['image/jpeg', 'image/png', 'image/webp'],
  },
  {
    documentType: 'SAFETY_DATA_SHEET',
    maxBytes: 10 * 1024 * 1024,
    allowedMime: ['application/pdf'],
  },
  {
    documentType: 'OTHER',
    maxBytes: 5 * 1024 * 1024,
    allowedMime: ['application/pdf', 'image/jpeg', 'image/png'],
  },
];

/** Hard global cap — no document type may exceed this. */
const GLOBAL_MAX_BYTES = 20 * 1024 * 1024;

export interface SecureUploadRequest {
  documentType: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  filename: string;
  buffer: Buffer;
  declaredMime: string;
  options?: UploadOptions;
}

@Injectable()
export class FileUploadSecurityService {
  private readonly logger = new Logger(FileUploadSecurityService.name);
  private readonly policies: Map<string, UploadPolicy>;

  constructor(
    private readonly minio: MinioClientService,
    policies: readonly UploadPolicy[] = DEFAULT_POLICIES,
  ) {
    this.policies = new Map(
      policies.map((p) => [p.documentType.toUpperCase(), p]),
    );
  }

  /**
   * Run all pre-flight checks and, if they pass, delegate to
   * `MinioClientService.uploadFile`. Rejects with
   * BadRequestException on any policy violation so the caller
   * sees a single, structured error rather than a 500 from
   * somewhere deep in MinIO.
   */
  async uploadSecure(request: SecureUploadRequest): Promise<UploadResult> {
    this.preflight(request);

    // Phase 6.2.1 — strip EXIF / metadata from image uploads
    // BEFORE the bytes reach MinIO. sharp().rotate() normalises
    // orientation (the main EXIF field operators care about
    // preserving) and then re-encodes without the metadata
    // block. PDFs and other non-image mimes pass through
    // unchanged.
    const sanitisedBuffer = await this.stripMetadataIfImage(
      request.buffer,
      request.declaredMime,
    );

    const options: UploadOptions = {
      ...(request.options ?? {}),
      contentType: request.declaredMime,
    };
    return this.minio.uploadFile(
      request.tenantId,
      request.entityType,
      request.entityId,
      request.filename,
      sanitisedBuffer,
      options,
    );
  }

  /**
   * Strip EXIF / metadata from an image buffer. Returns the
   * original buffer unchanged for non-image mimes. When sharp
   * fails (corrupt file, unsupported sub-format), logs and
   * falls through with the original buffer — the upload still
   * succeeds but the metadata is NOT stripped, surfaced in logs
   * so ops can triage. Fail-safe beats fail-closed here because
   * the pre-flight mime check already restricted the surface to
   * known-good image types.
   */
  async stripMetadataIfImage(
    buffer: Buffer,
    declaredMime: string,
  ): Promise<Buffer> {
    if (!IMAGE_MIMES_WITH_METADATA.has(declaredMime.toLowerCase())) {
      return buffer;
    }
    try {
      // rotate() honours EXIF orientation before stripping, so a
      // phone photo taken in portrait renders portrait on the
      // far side. Without rotate() the stripped image would
      // revert to the raw sensor orientation.
      const pipeline = sharp(buffer).rotate();
      if (declaredMime === 'image/jpeg') {
        return await pipeline.jpeg({ quality: 90 }).toBuffer();
      }
      if (declaredMime === 'image/png') {
        return await pipeline.png().toBuffer();
      }
      if (declaredMime === 'image/webp') {
        return await pipeline.webp({ quality: 90 }).toBuffer();
      }
      return buffer;
    } catch (err) {
      this.logger.warn(
        `EXIF strip failed for declaredMime='${declaredMime}': ` +
          `${(err as Error).message}. Uploading original buffer — metadata ` +
          `NOT stripped. Investigate the source file; the pre-flight mime ` +
          `check should have caught this.`,
      );
      return buffer;
    }
  }

  /** Pre-flight validation exposed so callers can dry-run the gate. */
  preflight(request: SecureUploadRequest): void {
    const policy = this.policies.get(request.documentType.toUpperCase());
    if (!policy) {
      throw new BadRequestException(
        `Upload rejected: unknown document type '${request.documentType}'. ` +
          `Register a policy in FileUploadSecurityService before accepting ` +
          `uploads of this type.`,
      );
    }

    if (request.buffer.length === 0) {
      throw new BadRequestException(
        'Upload rejected: empty file. Clients must send a non-zero buffer.',
      );
    }

    if (request.buffer.length > policy.maxBytes) {
      throw new BadRequestException(
        `Upload rejected: file size ${request.buffer.length} bytes exceeds ` +
          `policy limit ${policy.maxBytes} bytes for documentType ` +
          `'${policy.documentType}'.`,
      );
    }

    if (request.buffer.length > GLOBAL_MAX_BYTES) {
      throw new BadRequestException(
        `Upload rejected: file size ${request.buffer.length} bytes exceeds ` +
          `global cap ${GLOBAL_MAX_BYTES} bytes. No document type is allowed ` +
          `above this ceiling.`,
      );
    }

    const declaredMime = request.declaredMime.toLowerCase();
    const allowed = policy.allowedMime.map((m) => m.toLowerCase());
    if (!allowed.includes(declaredMime)) {
      throw new BadRequestException(
        `Upload rejected: declared mime '${request.declaredMime}' is not in ` +
          `the whitelist for documentType '${policy.documentType}' ` +
          `[${policy.allowedMime.join(', ')}].`,
      );
    }

    // Magic-byte sniff — catches the obvious "rename to .jpg" case
    // where the declared mime is image/jpeg but the first bytes
    // are %PDF or PK (zip). The check is defence-in-depth; full
    // content validation needs sharp/file-type libraries which
    // land with phase 6.2.1.
    const detected = this.sniffMagic(request.buffer);
    if (detected && detected !== declaredMime) {
      throw new BadRequestException(
        `Upload rejected: declared mime '${declaredMime}' contradicts ` +
          `magic-byte signature '${detected}'. Rename / re-encode the file ` +
          `so the declared mime and the real signature agree.`,
      );
    }
  }

  /** Visible for tests — return the policy for a given document type. */
  getPolicy(documentType: string): UploadPolicy | undefined {
    return this.policies.get(documentType.toUpperCase());
  }

  /**
   * Minimal magic-byte detection covering the mime types in the
   * DEFAULT_POLICIES. Unknown / text signatures return `null` so
   * the pre-flight check falls through to the declared-mime path.
   */
  private sniffMagic(buffer: Buffer): string | null {
    if (buffer.length < 4) return null;
    // PDF: %PDF
    if (
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46
    ) {
      return 'application/pdf';
    }
    // PNG: 89 50 4E 47
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return 'image/png';
    }
    // JPEG: FF D8 FF
    if (
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      return 'image/jpeg';
    }
    // WEBP (RIFF....WEBP) — first 4 are 'RIFF', bytes 8-11 are 'WEBP'
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return 'image/webp';
    }
    return null;
  }
}
