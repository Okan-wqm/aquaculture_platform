/**
 * DailyFeedingExecutionService — SEC-HIGH-051 sink-level site authorization.
 *
 * The site assertion was moved INTO recordActualFeeding / skipDailyFeeding (the
 * shared sinks) so EVERY feeding-write caller — recordDailyFeeding,
 * recordBulkFeeding, skipDailyFeeding, and any future caller — enforces it
 * identically and the resolver can never again be the sole, forgettable point.
 *
 * These tests prove, at the sink:
 *   - a MODULE_USER NOT assigned to the execution's tank site is DENIED;
 *   - a MODULE_USER ASSIGNED to that site is allowed (proceeds past the check);
 *   - a MODULE_MANAGER bypasses via the role hierarchy regardless of sites;
 *   - an unresolved site (no department / no site) fail-closes for a non-manager.
 */
import { ForbiddenException } from '@nestjs/common';
import { Repository, DataSource, EntityManager } from 'typeorm';

import { Role } from '@aquaculture/backend-common/decorators';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';

import { Batch } from '../../../batch/entities/batch.entity';
import { Department } from '../../../department/entities/department.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import { Feed } from '../../../feed/entities/feed.entity';
import { BatchDomainService } from '../../../batch/services/batch-domain.service';
import { StockMovementService } from '../../../storage/services/stock-movement.service';
import { BilinearInterpolationService } from '../../services/bilinear-interpolation.service';
import { WaterTemperatureService } from '../../../water-quality/services/water-temperature.service';
import { DailyFeedingExecution } from '../../entities/daily-feeding-execution.entity';
import { FeedingProgram } from '../../entities/feeding-program.entity';
import { FeedingProgramTank } from '../../entities/feeding-program-tank.entity';
import { DailyFeedingExecutionService } from '../../services/daily-feeding-execution.service';

const TENANT = 'tenant-1';
const USER = 'user-1';
const EQUIPMENT_ID = 'equip-1';
const DEPARTMENT_ID = 'dept-1';
const SITE_A = 'site-a';
const SITE_B = 'site-b';

function repoStub(): Repository<object> {
  return {} as Repository<object>;
}

/**
 * A managed `manager.findOne` mock that answers each entity the sink consults:
 *   - DailyFeedingExecution → a PLANNED execution on EQUIPMENT_ID (recordActual)
 *   - Equipment            → carries departmentId = DEPARTMENT_ID
 *   - Department           → carries siteId = the tank's site
 *   - Tank                 → null (equipment path wins)
 * This lets resolveTankSiteId() resolve EQUIPMENT_ID → SITE_A deterministically.
 */
function buildManagerFindOne(tankSiteId: string | null): jest.Mock {
  return jest.fn((entity: unknown, _opts: unknown) => {
    if (entity === DailyFeedingExecution) {
      return Promise.resolve({
        id: 'exec-1',
        tenantId: TENANT,
        equipmentId: EQUIPMENT_ID,
        canRecordFeeding: () => true,
      });
    }
    if (entity === Equipment) {
      return Promise.resolve({
        id: EQUIPMENT_ID,
        tenantId: TENANT,
        departmentId: DEPARTMENT_ID,
        isActive: true,
        isDeleted: false,
      });
    }
    if (entity === Tank) {
      return Promise.resolve(null);
    }
    if (entity === Department) {
      return Promise.resolve(
        tankSiteId ? { id: DEPARTMENT_ID, tenantId: TENANT, siteId: tankSiteId } : null,
      );
    }
    return Promise.resolve(null);
  });
}

function makeService(siteIdOnManager: string | null): {
  service: DailyFeedingExecutionService;
  queryRunner: { commitTransaction: jest.Mock; rollbackTransaction: jest.Mock; release: jest.Mock };
} {
  const managerFindOne = buildManagerFindOne(siteIdOnManager);
  const manager = {
    findOne: managerFindOne,
    save: jest.fn(),
  } as Partial<EntityManager> as EntityManager;
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager,
  };
  const dataSource = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    manager,
  } as Partial<DataSource> as DataSource;

  const receipts = new MobileCommandReceiptService();
  // No envelope is passed → legacy mode, so the sink proceeds straight to the
  // execution load + the SEC-HIGH-051 assertion (the path under test).
  jest.spyOn(receipts, 'begin').mockResolvedValue({ mode: 'legacy' });

  // skipDailyFeeding loads via the injected executionRepo (not the tx manager).
  const executionRepoMock: Partial<Repository<DailyFeedingExecution>> = {
    findOne: jest.fn().mockResolvedValue({
      id: 'exec-1',
      tenantId: TENANT,
      equipmentId: EQUIPMENT_ID,
      isCompleted: () => false,
      isSkipped: () => false,
      skip: jest.fn(),
    }),
    save: jest.fn(),
  };
  const executionRepo = executionRepoMock as Repository<DailyFeedingExecution>;

  const service = new DailyFeedingExecutionService(
    executionRepo,
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
    {} as StockMovementService,
    receipts,
    new SiteAuthorizationService(),
  );
  return { service, queryRunner };
}

describe('DailyFeedingExecutionService — SEC-HIGH-051 site authorization at the sink', () => {
  it('DENIES a MODULE_USER not assigned to the execution tank site (rolls back)', async () => {
    const { service, queryRunner } = makeService(SITE_A);
    const caller = { sub: USER, roles: [Role.MODULE_USER], assignedSiteIds: [SITE_B] };

    await expect(
      service.recordActualFeeding('exec-1', 10, USER, TENANT, caller),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('DENIES a MODULE_USER when the tank site is unresolved (fail-closed)', async () => {
    const { service, queryRunner } = makeService(null);
    const caller = { sub: USER, roles: [Role.MODULE_USER], assignedSiteIds: [SITE_A] };

    await expect(
      service.recordActualFeeding('exec-1', 10, USER, TENANT, caller),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('ALLOWS a MODULE_USER assigned to the execution tank site (passes the check)', async () => {
    const { service } = makeService(SITE_A);
    const caller = { sub: USER, roles: [Role.MODULE_USER], assignedSiteIds: [SITE_A] };

    // The site check passes; a later (post-authz) step throws because the
    // execution stub lacks full calculation data. We only assert it is NOT a
    // ForbiddenException — i.e. the site gate did not deny.
    await expect(
      service.recordActualFeeding('exec-1', 10, USER, TENANT, caller),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it('ALLOWS a MODULE_MANAGER regardless of assigned sites (role-hierarchy bypass)', async () => {
    const { service } = makeService(SITE_A);
    const caller = { sub: USER, roles: [Role.MODULE_MANAGER], assignedSiteIds: [] };

    await expect(
      service.recordActualFeeding('exec-1', 10, USER, TENANT, caller),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it('skipDailyFeeding DENIES a MODULE_USER not assigned to the tank site', async () => {
    const { service } = makeService(SITE_A);
    const caller = { sub: USER, roles: [Role.MODULE_USER], assignedSiteIds: [SITE_B] };

    await expect(
      service.skipDailyFeeding('exec-1', 'sick fish', USER, TENANT, caller),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
