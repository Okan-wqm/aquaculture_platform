import { createHash } from 'crypto';

import { isValidUUID } from '@aquaculture/backend-common/database';

import {
  telemetryArchiveBucketName,
  type TelemetryArchiveClock,
  type TelemetryPresignRegistryPort,
} from './telemetry-archive-coordinator.service';

const PRESIGN_TTL_SECONDS = 900;

export interface TelemetryArchiveGetSignerPort {
  signGet(
    bucket: string,
    objectKey: string,
    objectVersionId: string,
    expiresInSeconds: number,
  ): Promise<string>;
}

export interface TelemetryArchivePresignLedgerPort extends TelemetryPresignRegistryPort {
  record(entry: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly urlSha256: string;
    readonly expiresAt: string;
  }): Promise<void>;
}

export class TelemetryArchivePresignService implements TelemetryPresignRegistryPort {
  constructor(
    private readonly signer: TelemetryArchiveGetSignerPort,
    private readonly registry: TelemetryArchivePresignLedgerPort,
    private readonly clock: TelemetryArchiveClock,
  ) {}

  async createDownload(request: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly bucket: string;
    readonly objectKey: string;
    readonly objectVersionId: string;
  }): Promise<{ readonly url: string; readonly expiresAt: string }> {
    if (!isValidUUID(request.tenantId) || !isValidUUID(request.operationId)) {
      throw new Error('Archive presign tenantId and operationId must be UUIDs');
    }
    if (request.bucket !== telemetryArchiveBucketName(request.tenantId)) {
      throw new Error('Archive presign bucket is not isolated to its tenant');
    }
    if (request.objectKey !== `${request.operationId}.parquet`) {
      throw new Error('Archive presign object key is not canonical');
    }
    if (request.objectVersionId.length === 0 || request.objectVersionId.length > 1_024) {
      throw new Error('Archive presign object version ID is invalid');
    }
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + PRESIGN_TTL_SECONDS * 1_000).toISOString();
    const url = await this.signer.signGet(
      request.bucket,
      request.objectKey,
      request.objectVersionId,
      PRESIGN_TTL_SECONDS,
    );
    await this.registry.record({
      tenantId: request.tenantId,
      operationId: request.operationId,
      urlSha256: createHash('sha256').update(url).digest('hex'),
      expiresAt,
    });
    return { url, expiresAt };
  }

  async revokeTenant(tenantId: string): Promise<void> {
    if (!isValidUUID(tenantId)) throw new Error('Archive presign tenantId must be a UUID');
    await this.registry.revokeTenant(tenantId);
  }
}
