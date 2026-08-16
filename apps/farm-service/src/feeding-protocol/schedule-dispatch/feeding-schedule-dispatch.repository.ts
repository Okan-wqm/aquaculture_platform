import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  parseFeedingScheduledDispatchEnvelope,
  type FeedingScheduledDispatchEnvelopeV1,
} from '@aquaculture/feeding-contracts';
import { DataSource } from 'typeorm';

interface ClaimedDispatchRow {
  readonly dispatchId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly envelope: unknown;
}

export interface ClaimedFeedingScheduleDispatch {
  readonly dispatchId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly envelope: FeedingScheduledDispatchEnvelopeV1;
}

@Injectable()
export class FeedingScheduleDispatchRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async claim(workerId: string): Promise<ClaimedFeedingScheduleDispatch | undefined> {
    const rows: ClaimedDispatchRow[] = await this.dataSource.query(
      `SELECT "dispatchId", "leaseToken", "leaseExpiresAt", envelope
         FROM farm.claim_feeding_schedule_dispatch($1::varchar)`,
      [workerId],
    );
    const row = rows[0];
    if (!row) return undefined;
    if (!row.dispatchId || !row.leaseToken || !(row.leaseExpiresAt instanceof Date)) {
      throw new Error('Feeding schedule dispatch claim omitted its lease fence');
    }
    return {
      dispatchId: row.dispatchId,
      leaseToken: row.leaseToken,
      leaseExpiresAt: row.leaseExpiresAt,
      envelope: parseFeedingScheduledDispatchEnvelope(row.envelope),
    };
  }

  async complete(
    dispatch: Pick<ClaimedFeedingScheduleDispatch, 'dispatchId' | 'leaseToken'>,
    operationId: string,
  ): Promise<void> {
    const rows: Array<{ accepted: boolean }> = await this.dataSource.query(
      `SELECT farm.complete_feeding_schedule_dispatch(
         $1::uuid, $2::uuid, $3::uuid
       ) AS accepted`,
      [dispatch.dispatchId, dispatch.leaseToken, operationId],
    );
    if (rows[0]?.accepted !== true) {
      throw new Error('Feeding schedule dispatch completion was not accepted');
    }
  }

  async release(
    dispatch: Pick<ClaimedFeedingScheduleDispatch, 'dispatchId' | 'leaseToken'>,
    errorCode: string,
    errorDigest: string,
  ): Promise<void> {
    const rows: Array<{ accepted: boolean }> = await this.dataSource.query(
      `SELECT farm.release_feeding_schedule_dispatch(
         $1::uuid, $2::uuid, $3::varchar, $4::varchar
       ) AS accepted`,
      [dispatch.dispatchId, dispatch.leaseToken, errorCode, errorDigest],
    );
    if (rows[0]?.accepted !== true) {
      throw new Error('Feeding schedule dispatch release was not accepted');
    }
  }
}
