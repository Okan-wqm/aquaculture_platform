import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3';

import { createMessagingS3 } from '../../shared/messaging-s3-client.factory';

/** Outcome of a best-effort object purge, for the caller's audit/log. */
export interface AttachmentPurgeResult {
  /** Distinct non-empty keys requested. */
  readonly requested: number;
  /** Objects the store confirmed deleted. */
  readonly deleted: number;
  /** Keys refused because they are not under the caller's tenant prefix. */
  readonly skipped: number;
  /** Keys the store failed to delete (require reaper/manual cleanup). */
  readonly failed: number;
}

/** S3 DeleteObjects accepts at most 1000 keys per request. */
const DELETE_BATCH_SIZE = 1000;

/**
 * Deletes attachment binary objects from MinIO/S3 for erasure + retention paths.
 *
 * MSG-CRITICAL-058: every messaging erasure path (GDPR anonymize, UserDeleted
 * cascade, retention sweep) previously deleted only the message_attachments DB
 * ROWS — the actual image/voice/document objects (plus their stripped re-encode
 * and _thumb derivative) survived indefinitely in the bucket, fully retrievable,
 * so a GDPR Art 17 erasure left the PII in place. This service is the object-store
 * arm of erasure: the caller collects the storage + thumbnail keys of the rows it
 * is about to delete and hands them here so the binaries are actually removed.
 *
 * Lives in ComplianceModule (not the message module) to keep the GDPR/retention
 * consumers free of a module cycle with MessageModule.
 */
@Injectable()
export class AttachmentObjectPurgeService {
  private readonly logger = new Logger(AttachmentObjectPurgeService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    const { client, bucket } = createMessagingS3(configService);
    this.s3 = client;
    this.bucket = bucket;
  }

  /**
   * Best-effort delete of the given object keys for one tenant.
   *
   * Tenant isolation is enforced structurally: every key MUST start with
   * `messaging/{tenantId}/`. A key outside that prefix is REFUSED (counted as
   * skipped, logged at error) and never sent to the store — an erasure can never
   * be steered into deleting another tenant's objects. Null/empty keys and
   * duplicates are dropped. Deletion is post-commit and best-effort: a store
   * failure is logged with the offending key (so a reaper / manual step can
   * finish the erasure) and surfaced in the returned counts, but does not throw —
   * the DB rows are already gone, so the object is no longer referenceable and
   * the residue is a storage leak, not a still-live reference.
   */
  async purgeObjects(
    tenantId: string,
    storageKeys: ReadonlyArray<string | null | undefined>,
  ): Promise<AttachmentPurgeResult> {
    const prefix = `messaging/${tenantId}/`;
    const distinct = [...new Set(storageKeys.filter((k): k is string => Boolean(k)))];
    const own = distinct.filter((k) => k.startsWith(prefix));
    const foreign = distinct.filter((k) => !k.startsWith(prefix));

    for (const key of foreign) {
      this.logger.error(
        `purgeObjects tenant isolation: refusing to delete key outside tenant prefix ` +
          `(tenant=${tenantId}, key=${key})`,
      );
    }

    if (own.length === 0) {
      return { requested: distinct.length, deleted: 0, skipped: foreign.length, failed: 0 };
    }

    let deleted = 0;
    let failed = 0;

    for (let i = 0; i < own.length; i += DELETE_BATCH_SIZE) {
      const batch = own.slice(i, i + DELETE_BATCH_SIZE);
      try {
        const result = await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        const errors = result.Errors ?? [];
        failed += errors.length;
        deleted += batch.length - errors.length;
        for (const err of errors) {
          this.logger.error(
            `purgeObjects failed to delete object (tenant=${tenantId}, key=${err.Key ?? '?'}): ` +
              `${err.Code ?? ''} ${err.Message ?? ''}`.trim(),
          );
        }
      } catch (err: unknown) {
        failed += batch.length;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `purgeObjects batch failed (tenant=${tenantId}, ${batch.length} keys): ${message}. ` +
            `Objects orphaned — require reaper/manual cleanup to complete erasure.`,
        );
      }
    }

    return { requested: distinct.length, deleted, skipped: foreign.length, failed };
  }
}
