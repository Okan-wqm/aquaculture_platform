import { isValidUUID } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export type TelemetryArchiveState =
  | 'EXPORT_STARTED'
  | 'EXPORTED'
  | 'VERIFIED'
  | 'DROPPED'
  | 'FAILED';

export interface AppendTelemetryArchiveEvent {
  readonly operationId: string;
  readonly tenantId: string;
  readonly state: TelemetryArchiveState;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly supersedesOperationId?: string;
  readonly objectKey?: string;
  readonly rowCount?: number;
  readonly sha256?: string;
  readonly schemaVersion?: number;
  readonly snapshotId?: string;
  readonly walLsn?: string;
  readonly errorMessage?: string;
}

@Injectable()
export class TelemetryArchiveLifecycleService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async append(event: AppendTelemetryArchiveEvent): Promise<string> {
    if (!isValidUUID(event.operationId) || !isValidUUID(event.tenantId)) {
      throw new Error('Archive operationId and tenantId must be UUIDs');
    }
    if (event.supersedesOperationId !== undefined && !isValidUUID(event.supersedesOperationId)) {
      throw new Error('Archive supersedesOperationId must be a UUID');
    }
    const rangeStart = new Date(event.rangeStart);
    const rangeEnd = new Date(event.rangeEnd);
    if (
      !Number.isFinite(rangeStart.getTime()) ||
      !Number.isFinite(rangeEnd.getTime()) ||
      rangeStart >= rangeEnd
    ) {
      throw new Error('Archive range must contain valid timestamps with rangeStart < rangeEnd');
    }
    if (event.state === 'DROPPED') {
      throw new Error('Raw telemetry drop is disabled until LEGAL-001 is approved');
    }

    const rows: Array<{ event_id: string }> = await this.dataSource.query(
      `SELECT sensor.append_telemetry_archive_event(
         $1::uuid, $2::uuid, $3::text, $4::timestamptz, $5::timestamptz,
         $6::uuid, $7::text, $8::bigint, $9::text, $10::integer,
         $11::text, $12::text, $13::text
       ) AS event_id`,
      [
        event.operationId,
        event.tenantId,
        event.state,
        rangeStart.toISOString(),
        rangeEnd.toISOString(),
        event.supersedesOperationId ?? null,
        event.objectKey ?? null,
        event.rowCount ?? null,
        event.sha256 ?? null,
        event.schemaVersion ?? null,
        event.snapshotId ?? null,
        event.walLsn ?? null,
        event.errorMessage ?? null,
      ],
    );
    const eventId = rows[0]?.event_id;
    if (!eventId) {
      throw new Error('Archive lifecycle function returned no event id');
    }
    return eventId;
  }
}
