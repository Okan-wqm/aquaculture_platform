/**
 * DailyFeedingExecutionService.recordActualFeeding idempotency (FARM-MEDIUM-051).
 *
 * Focused on the replay path: a retry of an already-COMMITTED feeding (same
 * clientCommandId) must replay the stored result as a no-op SUCCESS and must
 * NOT re-run the feeding side effects (no execution load / save / inventory
 * deduction). Without the receipt, that retry previously threw because
 * canRecordFeeding() is false once the execution is COMPLETED.
 */
import { Repository, DataSource, EntityManager } from 'typeorm';

import { Role } from '@aquaculture/backend-common/decorators';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';

import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { Batch } from '../../../batch/entities/batch.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import { Feed } from '../../../feed/entities/feed.entity';
import { BatchDomainService } from '../../../batch/services/batch-domain.service';
import { FeedingLedgerService } from '../../services/feeding-ledger.service';
import { BilinearInterpolationService } from '../../services/bilinear-interpolation.service';
import { WaterTemperatureService } from '../../../water-quality/services/water-temperature.service';
import { DailyFeedingExecution } from '../../entities/daily-feeding-execution.entity';
import { FeedingProgram } from '../../entities/feeding-program.entity';
import { FeedingProgramTank } from '../../entities/feeding-program-tank.entity';
import {
  DailyFeedingExecutionService,
  FeedingRecordResult,
} from '../../services/daily-feeding-execution.service';

const ENVELOPE = { clientCommandId: 'cmd-9', payloadHash: 'hash-9' };
// SEC-HIGH-051: the site-scope caller threaded into recordActualFeeding. A
// TENANT_ADMIN bypasses the site check via the role hierarchy, so the replay
// path (which returns before site resolution) is unaffected either way.
const CALLER = { sub: 'user-1', roles: [Role.TENANT_ADMIN], assignedSiteIds: [] };

function repoStub(): Repository<object> {
  return {} as Repository<object>;
}

describe('DailyFeedingExecutionService — feeding idempotency (FARM-MEDIUM-051)', () => {
  const TENANT = 'tenant-1';
  const USER = 'user-1';

  const committedResult: FeedingRecordResult = {
    executionId: 'exec-1',
    actualKg: 10,
    growthKg: 0.4,
    newBiomassKg: 100.4,
    newAvgWeightG: 200,
    feedTransitioned: false,
  };

  let manager: { findOne: jest.Mock; save: jest.Mock };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: EntityManager;
  };
  let service: DailyFeedingExecutionService;

  beforeEach(() => {
    manager = { findOne: jest.fn(), save: jest.fn() };
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: manager as Partial<EntityManager> as EntityManager,
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    } as Partial<DataSource> as DataSource;

    const receipts = new MobileCommandReceiptService();
    // begin: INSERT conflicts → SELECT returns a COMPLETED row → replay mode.
    jest.spyOn(receipts, 'begin').mockResolvedValue({
      mode: 'replay',
      responseType: 'DailyFeedingExecution',
      responseId: 'exec-1',
      responsePayload: committedResult,
    });

    service = new DailyFeedingExecutionService(
      repoStub() as Repository<DailyFeedingExecution>,
      repoStub() as Repository<FeedingProgram>,
      repoStub() as Repository<FeedingProgramTank>,
      repoStub() as Repository<TankBatch>,
      repoStub() as Repository<Batch>,
      repoStub() as Repository<Tank>,
      repoStub() as Repository<Feed>,
      {} as BilinearInterpolationService,
      {} as WaterTemperatureService,
      dataSource,
      {} as BatchDomainService,
      {} as FeedingLedgerService,
      receipts,
      new SiteAuthorizationService(),
    );
  });

  it('replays the committed result without re-running feeding side effects', async () => {
    const result = await service.recordActualFeeding(
      'exec-1',
      10,
      USER,
      TENANT,
      CALLER,
      undefined,
      ENVELOPE,
    );

    expect(result).toEqual(committedResult);
    // No execution was loaded or saved — the side effects did not re-run.
    expect(manager.findOne).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });
});
