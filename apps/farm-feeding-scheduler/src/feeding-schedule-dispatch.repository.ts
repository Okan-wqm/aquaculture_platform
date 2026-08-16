import type { FeedingScheduledDispatchEnvelopeV1 } from '@aquaculture/feeding-contracts';
import {
  canonicalJsonStringify,
  createCanonicalJsonDocumentV1,
} from '@aquaculture/shared-contracts';
import { Injectable, type ClassProvider } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  FEEDING_SCHEDULE_DISPATCH_PORT,
  type FeedingScheduleDispatchPort,
  type FeedingScheduleDispatchResult,
} from './feeding-schedule-dispatch.port';

const DISPOSITIONS = new Set<FeedingScheduleDispatchResult['disposition']>([
  'enqueued',
  'idempotent',
  'business_slot_preserved',
  'already_completed',
  'already_running',
  'quarantined',
]);

interface DispatchResultRow {
  readonly disposition: string;
  readonly coordinateKind: string;
  readonly coordinateId: string;
}

@Injectable()
export class FeedingScheduleDispatchRepository implements FeedingScheduleDispatchPort {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async enqueue(
    envelope: FeedingScheduledDispatchEnvelopeV1,
  ): Promise<FeedingScheduleDispatchResult> {
    const rows: DispatchResultRow[] = await this.dataSource.query(
      `SELECT disposition, "coordinateKind", "coordinateId"
         FROM farm.enqueue_feeding_schedule_dispatch($1::jsonb)`,
      [canonicalJsonStringify(createCanonicalJsonDocumentV1(envelope))],
    );
    const row = rows[0];
    if (
      !row ||
      !DISPOSITIONS.has(row.disposition as FeedingScheduleDispatchResult['disposition'])
    ) {
      throw new Error('Feeding dispatch kernel returned an unknown disposition');
    }
    if (row.coordinateKind === 'dispatch' && row.coordinateId) {
      if (
        row.disposition !== 'enqueued' &&
        row.disposition !== 'idempotent' &&
        row.disposition !== 'business_slot_preserved' &&
        row.disposition !== 'quarantined'
      ) {
        throw new Error('Feeding dispatch kernel mismatched a dispatch coordinate');
      }
      return {
        disposition: row.disposition,
        coordinate: { kind: 'dispatch', dispatchId: row.coordinateId },
      };
    }
    if (
      row.coordinateKind === 'operation' &&
      row.coordinateId &&
      (row.disposition === 'already_completed' || row.disposition === 'already_running')
    ) {
      return {
        disposition: row.disposition,
        coordinate: { kind: 'operation', operationId: row.coordinateId },
      };
    }
    throw new Error('Feeding dispatch kernel omitted its typed durable coordinate');
  }
}

export const FEEDING_SCHEDULE_DISPATCH_PROVIDER: ClassProvider = {
  provide: FEEDING_SCHEDULE_DISPATCH_PORT,
  useClass: FeedingScheduleDispatchRepository,
};
