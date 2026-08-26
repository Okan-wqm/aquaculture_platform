import { isValidUUID } from '@aquaculture/backend-common/database';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  NatsRequestReply,
  type IRequestReply,
  type RequestReplyResponderHandle,
} from '@platform/event-bus';

import { TelemetryArchiveBucketProvisionerService } from './telemetry-archive-bucket-provisioner.service';
import {
  TelemetryArchiveCoordinatorService,
  type TelemetryArchiveRangeRequest,
} from './telemetry-archive-coordinator.service';
import { TelemetryArchiveLifecycleService } from './telemetry-archive-lifecycle.service';
import { TelemetryArchivePresignService } from './telemetry-archive-presign.service';

export const TELEMETRY_ARCHIVE_OPERATION_SUBJECTS = {
  export: 'request.sensor.telemetryArchive.export',
  verify: 'request.sensor.telemetryArchive.verify',
  restore: 'request.sensor.telemetryArchive.restore',
  provision: 'request.sensor.telemetryArchive.provision',
  presign: 'request.sensor.telemetryArchive.presign',
  erase: 'request.sensor.telemetryArchive.erase',
} as const;

@Injectable()
export class TelemetryArchiveOperationsResponder implements OnModuleInit, OnModuleDestroy {
  private readonly handles: RequestReplyResponderHandle[] = [];

  constructor(
    @Inject(NatsRequestReply)
    private readonly requestReply: Pick<IRequestReply, 'respond'>,
    private readonly coordinator: TelemetryArchiveCoordinatorService,
    private readonly lifecycle: TelemetryArchiveLifecycleService,
    private readonly buckets: TelemetryArchiveBucketProvisionerService,
    private readonly presigns: TelemetryArchivePresignService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.handles.push(
        await this.requestReply.respond<unknown, unknown>(
          TELEMETRY_ARCHIVE_OPERATION_SUBJECTS.export,
          (request) => this.exportRange(request),
          { queue: 'sensor-service-telemetry-archive' },
        ),
      );
      this.handles.push(
        await this.requestReply.respond<unknown, unknown>(
          TELEMETRY_ARCHIVE_OPERATION_SUBJECTS.verify,
          (request) => this.verify(request),
          { queue: 'sensor-service-telemetry-archive' },
        ),
      );
      this.handles.push(
        await this.requestReply.respond<unknown, unknown>(
          TELEMETRY_ARCHIVE_OPERATION_SUBJECTS.restore,
          (request) => this.restore(request),
          { queue: 'sensor-service-telemetry-archive' },
        ),
      );
      this.handles.push(
        await this.requestReply.respond<unknown, unknown>(
          TELEMETRY_ARCHIVE_OPERATION_SUBJECTS.provision,
          (request) => this.provision(request),
          { queue: 'sensor-service-telemetry-archive' },
        ),
      );
      this.handles.push(
        await this.requestReply.respond<unknown, unknown>(
          TELEMETRY_ARCHIVE_OPERATION_SUBJECTS.presign,
          (request) => this.presign(request),
          { queue: 'sensor-service-telemetry-archive' },
        ),
      );
      this.handles.push(
        await this.requestReply.respond<unknown, unknown>(
          TELEMETRY_ARCHIVE_OPERATION_SUBJECTS.erase,
          (request) => this.erase(request),
          { queue: 'sensor-service-telemetry-archive' },
        ),
      );
    } catch (error: unknown) {
      await this.drainHandles();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.drainHandles();
  }

  private async exportRange(value: unknown): Promise<unknown> {
    const request = this.rangeRequest(value);
    return this.coordinator.exportRange(request);
  }

  private async verify(value: unknown): Promise<{ readonly verified: true }> {
    const operationId = operationIdRequest(value);
    await this.coordinator.verify(operationId);
    return { verified: true };
  }

  private async restore(value: unknown): Promise<unknown> {
    const request = record(value);
    const operationId = requiredUuid(request, 'operationId');
    const ttlSeconds = requiredInteger(request, 'ttlSeconds');
    return this.coordinator.restore({ operationId, ttlSeconds });
  }

  private async provision(value: unknown): Promise<{ readonly bucket: string }> {
    const tenantId = requiredUuid(record(value), 'tenantId');
    return { bucket: await this.buckets.provisionTenant(tenantId) };
  }

  private async presign(value: unknown): Promise<unknown> {
    const operationId = operationIdRequest(value);
    const manifest = await this.lifecycle.getManifest(operationId, 'VERIFIED');
    return this.presigns.createDownload({
      tenantId: manifest.tenantId,
      operationId,
      bucket: manifest.bucket,
      objectKey: manifest.objectKey,
      objectVersionId: manifest.objectVersionId,
    });
  }

  private async erase(value: unknown): Promise<unknown> {
    const request = record(value);
    return this.coordinator.eraseTenantArchive({
      tenantId: requiredUuid(request, 'tenantId'),
      erasureOperationId: requiredUuid(request, 'erasureOperationId'),
    });
  }

  private rangeRequest(value: unknown): TelemetryArchiveRangeRequest {
    const request = record(value);
    const schemaVersion = requiredInteger(request, 'schemaVersion');
    const supersedes = request['supersedesOperationId'];
    if (supersedes !== undefined && (typeof supersedes !== 'string' || !isValidUUID(supersedes))) {
      throw new Error('Archive supersedesOperationId must be a UUID');
    }
    return {
      operationId: requiredUuid(request, 'operationId'),
      tenantId: requiredUuid(request, 'tenantId'),
      rangeStart: requiredString(request, 'rangeStart'),
      rangeEnd: requiredString(request, 'rangeEnd'),
      schemaVersion,
      supersedesOperationId: supersedes,
    };
  }

  private async drainHandles(): Promise<void> {
    for (const handle of this.handles.splice(0)) await handle.drain();
  }
}

function operationIdRequest(value: unknown): string {
  return requiredUuid(record(value), 'operationId');
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Telemetry archive operation request must be an object');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredInteger(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  if (typeof result !== 'number' || !Number.isInteger(result)) {
    throw new Error(`Telemetry archive ${field} must be an integer`);
  }
  return result;
}

function requiredUuid(value: Record<string, unknown>, field: string): string {
  const result = requiredString(value, field);
  if (!isValidUUID(result)) throw new Error(`Telemetry archive ${field} must be a UUID`);
  return result;
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string' || result.length === 0) {
    throw new Error(`Telemetry archive ${field} must be a non-empty string`);
  }
  return result;
}
