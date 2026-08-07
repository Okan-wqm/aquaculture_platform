/**
 * Site tenant isolation and read-after-write tests.
 *
 * WHY: This is the first Postgres-backed farm-service P0 contract test for
 * "DB has the row but the API/frontend cannot see the update". It proves the
 * handler/repository path writes to the active tenant schema, never to the
 * source `farm` schema, and immediate get/list queries see the committed edit.
 */
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { CommandBus } from '@platform/cqrs';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import 'reflect-metadata';
import { DataSource, ObjectLiteral, Repository } from 'typeorm';

import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { CodeSequence } from '../../database/entities/code-sequence.entity';
import type { AuditLogService } from '../../database/services/audit-log.service';
import { CodeGeneratorService } from '../../database/services/code-generator.service';
import { CreateDepartmentCommand } from '../../department/commands/create-department.command';
import { DeleteDepartmentCommand } from '../../department/commands/delete-department.command';
import { UpdateDepartmentCommand } from '../../department/commands/update-department.command';
import {
  Department,
  DepartmentStatus,
  DepartmentType,
} from '../../department/entities/department.entity';
import { CreateDepartmentHandler } from '../../department/handlers/create-department.handler';
import { DeleteDepartmentHandler } from '../../department/handlers/delete-department.handler';
import { GetDepartmentDeletePreviewHandler } from '../../department/handlers/get-department-delete-preview.handler';
import { GetDepartmentHandler } from '../../department/handlers/get-department.handler';
import { ListDepartmentsHandler } from '../../department/handlers/list-departments.handler';
import { UpdateDepartmentHandler } from '../../department/handlers/update-department.handler';
import { GetDepartmentDeletePreviewQuery } from '../../department/queries/get-department-delete-preview.query';
import { GetDepartmentQuery } from '../../department/queries/get-department.query';
import { ListDepartmentsQuery } from '../../department/queries/list-departments.query';
import { CreateEquipmentCommand } from '../../equipment/commands/create-equipment.command';
import { DeleteEquipmentCommand } from '../../equipment/commands/delete-equipment.command';
import { SaveFeederCalibrationsCommand } from '../../equipment/commands/save-feeder-calibrations.command';
import { UpdateEquipmentCommand } from '../../equipment/commands/update-equipment.command';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { EquipmentType, EquipmentCategory } from '../../equipment/entities/equipment-type.entity';
import { FeederDispenseControl } from '../../equipment/entities/feeder-capability.entity';
import { Equipment, EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { FeederCalibration } from '../../equipment/entities/feeder-calibration.entity';
import { SubEquipmentType } from '../../equipment/entities/sub-equipment-type.entity';
import { SubEquipment } from '../../equipment/entities/sub-equipment.entity';
import { CreateEquipmentHandler } from '../../equipment/handlers/create-equipment.handler';
import { DeleteEquipmentHandler } from '../../equipment/handlers/delete-equipment.handler';
import { GetEquipmentHandler } from '../../equipment/handlers/get-equipment.handler';
import { ListEquipmentHandler } from '../../equipment/handlers/list-equipment.handler';
import { SaveFeederCalibrationsHandler } from '../../equipment/handlers/save-feeder-calibrations.handler';
import { UpdateEquipmentHandler } from '../../equipment/handlers/update-equipment.handler';
import { GetEquipmentQuery } from '../../equipment/queries/get-equipment.query';
import { ListEquipmentQuery } from '../../equipment/queries/list-equipment.query';
import { TankEquipmentAdapterService } from '../../equipment/services/tank-equipment-adapter.service';
import { FarmStockBatchSnapshot } from '../../farm-stock/entities/farm-stock-batch-snapshot.entity';
import { FarmStockContainerSnapshot } from '../../farm-stock/entities/farm-stock-container-snapshot.entity';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { CreateFeedCommand } from '../../feed/commands/create-feed.command';
import { DeleteFeedCommand } from '../../feed/commands/delete-feed.command';
import { UpdateFeedCommand } from '../../feed/commands/update-feed.command';
import { FeedSite } from '../../feed/entities/feed-site.entity';
import { FeedTypeSpecies } from '../../feed/entities/feed-type-species.entity';
import { Feed, FeedStatus, FeedType } from '../../feed/entities/feed.entity';
import { CreateFeedHandler } from '../../feed/handlers/create-feed.handler';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';
import { DeleteFeedHandler } from '../../feed/handlers/delete-feed.handler';
import { GetFeedHandler } from '../../feed/handlers/get-feed.handler';
import { ListFeedsHandler } from '../../feed/handlers/list-feeds.handler';
import { UpdateFeedHandler } from '../../feed/handlers/update-feed.handler';
import { GetFeedQuery } from '../../feed/queries/get-feed.query';
import { ListFeedsQuery } from '../../feed/queries/list-feeds.query';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { CreateSiteCommand } from '../../site/commands/create-site.command';
import { DeleteSiteCommand } from '../../site/commands/delete-site.command';
import { UpdateSiteCommand } from '../../site/commands/update-site.command';
import { Site, SiteStatus } from '../../site/entities/site.entity';
import { CreateSiteHandler } from '../../site/handlers/create-site.handler';
import { DeleteSiteHandler } from '../../site/handlers/delete-site.handler';
import { GetSiteHandler } from '../../site/handlers/get-site.handler';
import { ListSitesHandler } from '../../site/handlers/list-sites.handler';
import { UpdateSiteHandler } from '../../site/handlers/update-site.handler';
import { GetSiteQuery } from '../../site/queries/get-site.query';
import { ListSitesQuery } from '../../site/queries/list-sites.query';
import { Species } from '../../species/entities/species.entity';
import { SetSupplierApprovedSitesCommand } from '../../supplier/commands/set-supplier-approved-sites.command';
import { SupplierSite } from '../../supplier/entities/supplier-site.entity';
import { Supplier, SupplierStatus, SupplierType } from '../../supplier/entities/supplier.entity';
import { SetSupplierApprovedSitesHandler } from '../../supplier/handlers/set-supplier-approved-sites.handler';
import { CreateSystemCommand } from '../../system/commands/create-system.command';
import { DeleteSystemCommand } from '../../system/commands/delete-system.command';
import { UpdateSystemCommand } from '../../system/commands/update-system.command';
import { SubSystem } from '../../system/entities/sub-system.entity';
import { System } from '../../system/entities/system.entity';
import { SystemStatus, SystemType } from '../../system/entities/system.entity';
import { CreateSystemHandler } from '../../system/handlers/create-system.handler';
import { DeleteSystemHandler } from '../../system/handlers/delete-system.handler';
import { GetSystemDeletePreviewHandler } from '../../system/handlers/get-system-delete-preview.handler';
import { GetSystemHandler } from '../../system/handlers/get-system.handler';
import { ListSystemsHandler } from '../../system/handlers/list-systems.handler';
import { UpdateSystemHandler } from '../../system/handlers/update-system.handler';
import { GetSystemDeletePreviewQuery } from '../../system/queries/get-system-delete-preview.query';
import { GetSystemQuery } from '../../system/queries/get-system.query';
import { ListSystemsQuery } from '../../system/queries/list-systems.query';
import { CreateTankCommand } from '../../tank/commands/create-tank.command';
import { DeleteTankCommand } from '../../tank/commands/delete-tank.command';
import { UpdateTankStatusCommand } from '../../tank/commands/update-tank-status.command';
import { UpdateTankCommand } from '../../tank/commands/update-tank.command';
import {
  Tank,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../tank/entities/tank.entity';
import { CreateTankHandler } from '../../tank/handlers/create-tank.handler';
import { DeleteTankHandler } from '../../tank/handlers/delete-tank.handler';
import { GetTankHandler } from '../../tank/handlers/get-tank.handler';
import { ListTanksHandler } from '../../tank/handlers/list-tanks.handler';
import { UpdateTankStatusHandler } from '../../tank/handlers/update-tank-status.handler';
import { UpdateTankHandler } from '../../tank/handlers/update-tank.handler';
import { GetTankQuery } from '../../tank/queries/get-tank.query';
import { ListTanksQuery } from '../../tank/queries/list-tanks.query';
import { CreateParameterConfigCommand } from '../../water-quality/commands/create-parameter-config.command';
import { DeleteParameterConfigCommand } from '../../water-quality/commands/delete-parameter-config.command';
import { UpdateParameterConfigCommand } from '../../water-quality/commands/update-parameter-config.command';
import {
  ParameterDataType,
  ParameterGroup,
  WaterQualityParameterConfig,
} from '../../water-quality/entities/water-quality-parameter-config.entity';
import { CreateParameterConfigHandler } from '../../water-quality/handlers/create-parameter-config.handler';
import { DeleteParameterConfigHandler } from '../../water-quality/handlers/delete-parameter-config.handler';
import { UpdateParameterConfigHandler } from '../../water-quality/handlers/update-parameter-config.handler';
import { GetParameterConfigQuery } from '../../water-quality/queries/get-parameter-config.query';
import { ListParameterConfigsQuery } from '../../water-quality/queries/list-parameter-configs.query';
import { GetParameterConfigHandler } from '../../water-quality/query-handlers/get-parameter-config.handler';
import { ListParameterConfigsHandler } from '../../water-quality/query-handlers/list-parameter-configs.handler';
import { ParameterConfigCacheService } from '../../water-quality/services/parameter-config-cache.service';

import {
  createFarmOutboxTable,
  createSourceEquipmentTypesReferenceTable,
  createTenantSchemaFromSource,
} from './helpers/tenant-schema-harness';

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const TENANT_B = '7c2f4e10-3d2a-4b4e-9f18-f8b16f0d5a10';
const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';
const MANAGER_CALLER = {
  sub: USER_ID,
  roles: [Role.MODULE_MANAGER],
};
const PUMP_EQUIPMENT_TYPE_ID = '18d6e179-af77-45f3-b33b-9a2a5e61b751';
// Feeder calibration belongs to FEEDING-category equipment. This fixture used to
// calibrate a PUMP row, which the sink now refuses: a feeder is a specific kind
// of machine, not any equipment that happens to be named "Feeder Pump".
const FEEDER_EQUIPMENT_TYPE_ID = '2f0a1c65-9b3d-4a55-8f0e-1c4d7b2a6e39';
const TANK_EQUIPMENT_TYPE_ID = 'eae12d34-514b-4d1a-87c9-6d8626547cae';
const SETUP_TENANT_TABLES = [
  'sites',
  'departments',
  'code_sequences',
  'systems',
  'sub_systems',
  'equipment',
  'equipment_systems',
  'sub_equipment',
  'feeder_calibrations',
  'tanks',
  'tank_batches',
  'batches_v2',
  'farm_stock_container_snapshots',
  'farm_stock_batch_snapshots',
  'suppliers',
  'supplier_sites',
  'species',
  'feeds',
  'feed_sites',
  'feed_type_species',
  'water_quality_parameter_configs',
] as const;

interface SiteHarness {
  createSite: CreateSiteHandler;
  getSite: GetSiteHandler;
  listSites: ListSitesHandler;
  updateSite: UpdateSiteHandler;
  deleteSite: DeleteSiteHandler;
  createSystem: CreateSystemHandler;
  getSystem: GetSystemHandler;
  listSystems: ListSystemsHandler;
  updateSystem: UpdateSystemHandler;
  deleteSystem: DeleteSystemHandler;
  getSystemDeletePreview: GetSystemDeletePreviewHandler;
  createDepartment: CreateDepartmentHandler;
  getDepartment: GetDepartmentHandler;
  listDepartments: ListDepartmentsHandler;
  updateDepartment: UpdateDepartmentHandler;
  deleteDepartment: DeleteDepartmentHandler;
  getDepartmentDeletePreview: GetDepartmentDeletePreviewHandler;
  createEquipment: CreateEquipmentHandler;
  getEquipment: GetEquipmentHandler;
  listEquipment: ListEquipmentHandler;
  updateEquipment: UpdateEquipmentHandler;
  deleteEquipment: DeleteEquipmentHandler;
  saveFeederCalibrations: SaveFeederCalibrationsHandler;
  createTank: CreateTankHandler;
  getTank: GetTankHandler;
  listTanks: ListTanksHandler;
  updateTank: UpdateTankHandler;
  updateTankStatus: UpdateTankStatusHandler;
  deleteTank: DeleteTankHandler;
  createFeed: CreateFeedHandler;
  getFeed: GetFeedHandler;
  listFeeds: ListFeedsHandler;
  updateFeed: UpdateFeedHandler;
  deleteFeed: DeleteFeedHandler;
  parameterConfigCache: ParameterConfigCacheService;
  createParameterConfig: CreateParameterConfigHandler;
  getParameterConfig: GetParameterConfigHandler;
  listParameterConfigs: ListParameterConfigsHandler;
  updateParameterConfig: UpdateParameterConfigHandler;
  deleteParameterConfig: DeleteParameterConfigHandler;
  setSupplierApprovedSites: SetSupplierApprovedSitesHandler;
}

jest.setTimeout(120_000);

describe('Site tenant isolation on real Postgres', () => {
  let pg: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let siteRepository: Repository<Site>;
  let equipmentRepository: Repository<Equipment>;
  let equipmentTypeRepository: Repository<EquipmentType>;
  let tankRepository: Repository<Tank>;
  let feedRepository: Repository<Feed>;
  let parameterConfigRepository: Repository<WaterQualityParameterConfig>;
  let tankCodeGenerator: CodeGeneratorService;
  let harness: SiteHarness;

  function requireDataSource(): DataSource {
    if (!dataSource) {
      throw new Error('Postgres harness DataSource has not been initialised');
    }
    return dataSource;
  }

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    await createFarmOutboxTable(pg.dataSource);
    await createSourceEquipmentTypesReferenceTable(pg.dataSource);

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-tenant-isolation-${randomBytes(4).toString('hex')}`,
      entities: [
        Site,
        Department,
        System,
        SubSystem,
        Equipment,
        EquipmentSystem,
        EquipmentType,
        SubEquipment,
        SubEquipmentType,
        FeederCalibration,
        Tank,
        TankBatch,
        FarmStockContainerSnapshot,
        FarmStockBatchSnapshot,
        Batch,
        BatchDocument,
        Feed,
        FeedSite,
        FeedTypeSpecies,
        Species,
        Supplier,
        SupplierSite,
        WaterQualityParameterConfig,
        AuditLog,
        CodeSequence,
        FarmOutbox,
      ],
      synchronize: true,
      logging: false,
      extra: {
        options: '-c search_path=farm,public',
      },
    });

    await dataSource.initialize();
    equipmentTypeRepository = unusedRepository<EquipmentType>();
    await seedEquipmentTypesForSetupTest();

    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();

    await createTenantSchemaFromSource(
      dataSource,
      getTenantSchemaName(TENANT_A),
      SETUP_TENANT_TABLES,
    );
    await createTenantSchemaFromSource(
      dataSource,
      getTenantSchemaName(TENANT_B),
      SETUP_TENANT_TABLES,
    );

    siteRepository = dataSource.getRepository(Site);
    equipmentRepository = dataSource.getRepository(Equipment);
    tankRepository = dataSource.getRepository(Tank);
    feedRepository = dataSource.getRepository(Feed);
    parameterConfigRepository = dataSource.getRepository(WaterQualityParameterConfig);
    const auditLogService = createAuditLogService();
    tankCodeGenerator = new CodeGeneratorService(
      dataSource.getRepository(CodeSequence),
      dataSource,
    );
    const parameterConfigCache = new ParameterConfigCacheService(parameterConfigRepository);
    const tankOutboxPublisher = new OutboxPublisher(FarmOutbox);
    const farmStockProjection = new FarmStockProjectionService();
    const createTankHandler = new CreateTankHandler(
      dataSource,
      auditLogService,
      tankCodeGenerator,
      tankOutboxPublisher,
      farmStockProjection,
    );
    const updateTankHandler = new UpdateTankHandler(
      dataSource,
      auditLogService,
      tankOutboxPublisher,
      farmStockProjection,
    );
    const deleteTankHandler = new DeleteTankHandler(
      dataSource,
      auditLogService,
      tankOutboxPublisher,
      farmStockProjection,
    );
    const tankEquipmentAdapter = new TankEquipmentAdapterService(
      createTankCommandBus({
        createTank: createTankHandler,
        updateTank: updateTankHandler,
        deleteTank: deleteTankHandler,
      }),
      dataSource,
    );

    harness = {
      createSite: new CreateSiteHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
      ),
      getSite: new GetSiteHandler(dataSource, new SiteAuthorizationService()),
      listSites: new ListSitesHandler(dataSource, new SiteAuthorizationService()),
      updateSite: new UpdateSiteHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
      ),
      deleteSite: new DeleteSiteHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
      ),
      createSystem: new CreateSystemHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
      ),
      getSystem: new GetSystemHandler(dataSource),
      listSystems: new ListSystemsHandler(dataSource),
      updateSystem: new UpdateSystemHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
      ),
      deleteSystem: new DeleteSystemHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
      ),
      getSystemDeletePreview: new GetSystemDeletePreviewHandler(dataSource),
      createDepartment: new CreateDepartmentHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
      ),
      getDepartment: new GetDepartmentHandler(dataSource),
      listDepartments: new ListDepartmentsHandler(dataSource),
      updateDepartment: new UpdateDepartmentHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
      ),
      deleteDepartment: new DeleteDepartmentHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
      ),
      getDepartmentDeletePreview: new GetDepartmentDeletePreviewHandler(dataSource),
      createEquipment: new CreateEquipmentHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
        tankEquipmentAdapter,
        new FinanceSettingsService(dataSource),
      ),
      getEquipment: new GetEquipmentHandler(dataSource, tankEquipmentAdapter),
      listEquipment: new ListEquipmentHandler(dataSource),
      updateEquipment: new UpdateEquipmentHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
        tankEquipmentAdapter,
      ),
      deleteEquipment: new DeleteEquipmentHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
        tankEquipmentAdapter,
      ),
      saveFeederCalibrations: new SaveFeederCalibrationsHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
      ),
      createTank: createTankHandler,
      getTank: new GetTankHandler(dataSource),
      listTanks: new ListTanksHandler(dataSource),
      updateTank: updateTankHandler,
      updateTankStatus: new UpdateTankStatusHandler(
        dataSource,
        auditLogService,
        new OutboxPublisher(FarmOutbox),
        farmStockProjection,
      ),
      deleteTank: deleteTankHandler,
      createFeed: new CreateFeedHandler(dataSource, new FinanceSettingsService(dataSource)),
      getFeed: new GetFeedHandler(dataSource),
      listFeeds: new ListFeedsHandler(dataSource),
      updateFeed: new UpdateFeedHandler(dataSource),
      deleteFeed: new DeleteFeedHandler(dataSource),
      parameterConfigCache,
      createParameterConfig: new CreateParameterConfigHandler(
        parameterConfigRepository,
        parameterConfigCache,
      ),
      getParameterConfig: new GetParameterConfigHandler(dataSource),
      listParameterConfigs: new ListParameterConfigsHandler(dataSource),
      updateParameterConfig: new UpdateParameterConfigHandler(
        parameterConfigRepository,
        parameterConfigCache,
      ),
      deleteParameterConfig: new DeleteParameterConfigHandler(
        parameterConfigRepository,
        parameterConfigCache,
      ),
      setSupplierApprovedSites: new SetSupplierApprovedSitesHandler(
        dataSource,
        new OutboxPublisher(FarmOutbox),
        auditLogService,
      ),
    };
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await shutdownHarness(pg);
  });

  it('creates tenant data in the active tenant schema and never in the source schema', async () => {
    const siteA = await createSiteForTenant(TENANT_A, 'North Farm', 'NF-01');

    expect(await rowCount('farm', TENANT_A)).toBe(0);
    expect(await rowCount(getTenantSchemaName(TENANT_A), TENANT_A)).toBe(1);
    expect(await rowCount(getTenantSchemaName(TENANT_B), TENANT_A)).toBe(0);

    const tenantAList = await withTenantContext(TENANT_A, () =>
      harness.listSites.execute(
        new ListSitesQuery(TENANT_A, MANAGER_CALLER, { search: 'North' }, { page: 1, limit: 10 }),
      ),
    );
    const tenantBList = await withTenantContext(TENANT_B, () =>
      harness.listSites.execute(
        new ListSitesQuery(TENANT_B, MANAGER_CALLER, { search: 'North' }, { page: 1, limit: 10 }),
      ),
    );

    expect(tenantAList.data.map((site) => site.id)).toContain(siteA.id);
    expect(tenantBList.data).toHaveLength(0);
  });

  it('allows same business keys in different tenants without cross-tenant visibility', async () => {
    const siteA = await createSiteForTenant(TENANT_A, 'Shared Name Farm', 'SHARED-01');
    const siteB = await createSiteForTenant(TENANT_B, 'Shared Name Farm', 'SHARED-01');

    expect(siteA.id).not.toBe(siteB.id);

    const tenantAList = await withTenantContext(TENANT_A, () =>
      harness.listSites.execute(
        new ListSitesQuery(
          TENANT_A,
          MANAGER_CALLER,
          { search: 'Shared Name' },
          { page: 1, limit: 10 },
        ),
      ),
    );
    const tenantBList = await withTenantContext(TENANT_B, () =>
      harness.listSites.execute(
        new ListSitesQuery(
          TENANT_B,
          MANAGER_CALLER,
          { search: 'Shared Name' },
          { page: 1, limit: 10 },
        ),
      ),
    );

    expect(tenantAList.data.map((site) => site.id)).toEqual([siteA.id]);
    expect(tenantBList.data.map((site) => site.id)).toEqual([siteB.id]);
  });

  it('returns updated values immediately through get and list in the same tenant only', async () => {
    const tenantASite = await createSiteForTenant(TENANT_A, 'Editable Farm', 'EDIT-01');
    await createSiteForTenant(TENANT_B, 'Editable Farm', 'EDIT-01');

    const updated = await withTenantContext(TENANT_A, () =>
      harness.updateSite.execute(
        new UpdateSiteCommand(
          tenantASite.id,
          {
            id: tenantASite.id,
            name: 'Editable Farm Updated',
            status: SiteStatus.MAINTENANCE,
          },
          TENANT_A,
          USER_ID,
        ),
      ),
    );

    const getAfterUpdate = await withTenantContext(TENANT_A, () =>
      harness.getSite.execute(new GetSiteQuery(tenantASite.id, TENANT_A, MANAGER_CALLER)),
    );
    const listAfterUpdate = await withTenantContext(TENANT_A, () =>
      harness.listSites.execute(
        new ListSitesQuery(TENANT_A, MANAGER_CALLER, { search: 'Updated' }, { page: 1, limit: 10 }),
      ),
    );
    const tenantBList = await withTenantContext(TENANT_B, () =>
      harness.listSites.execute(
        new ListSitesQuery(TENANT_B, MANAGER_CALLER, { search: 'Updated' }, { page: 1, limit: 10 }),
      ),
    );

    expect(updated.name).toBe('Editable Farm Updated');
    expect(updated.status).toBe(SiteStatus.MAINTENANCE);
    expect(getAfterUpdate?.name).toBe('Editable Farm Updated');
    expect(getAfterUpdate?.status).toBe(SiteStatus.MAINTENANCE);
    expect(listAfterUpdate.data.map((site) => site.id)).toEqual([tenantASite.id]);
    expect(tenantBList.data).toHaveLength(0);
  });

  it('soft-deletes only the current tenant row and removes it from active lists immediately', async () => {
    const tenantASite = await createSiteForTenant(TENANT_A, 'Delete Candidate', 'DEL-01');
    const tenantBSite = await createSiteForTenant(TENANT_B, 'Delete Candidate', 'DEL-01');

    await withTenantContext(TENANT_A, () =>
      harness.deleteSite.execute(new DeleteSiteCommand(tenantASite.id, TENANT_A, USER_ID, false)),
    );

    const tenantAList = await withTenantContext(TENANT_A, () =>
      harness.listSites.execute(
        new ListSitesQuery(
          TENANT_A,
          MANAGER_CALLER,
          { search: 'Delete Candidate' },
          { page: 1, limit: 10 },
        ),
      ),
    );
    const tenantBList = await withTenantContext(TENANT_B, () =>
      harness.listSites.execute(
        new ListSitesQuery(
          TENANT_B,
          MANAGER_CALLER,
          { search: 'Delete Candidate' },
          { page: 1, limit: 10 },
        ),
      ),
    );

    expect(tenantAList.data).toHaveLength(0);
    expect(tenantBList.data.map((site) => site.id)).toEqual([tenantBSite.id]);
    expect(await rowCount('farm', TENANT_A)).toBe(0);
  });

  it('keeps system create/update/delete isolated and immediately visible per tenant', async () => {
    const siteA = await createSiteForTenant(TENANT_A, 'System Site A', 'SYS-SITE-A');
    const siteB = await createSiteForTenant(TENANT_B, 'System Site B', 'SYS-SITE-B');

    const systemA = await createSystemForTenant(TENANT_A, siteA.id, 'RAS Main', 'RAS-01');
    const systemB = await createSystemForTenant(TENANT_B, siteB.id, 'RAS Main', 'RAS-01');

    expect(systemA.id).not.toBe(systemB.id);
    expect(await systemRowCount('farm', TENANT_A)).toBe(0);
    expect(await systemRowCount(getTenantSchemaName(TENANT_A), TENANT_A)).toBe(1);
    expect(await systemRowCount(getTenantSchemaName(TENANT_B), TENANT_A)).toBe(0);

    const updated = await withTenantContext(TENANT_A, () =>
      harness.updateSystem.execute(
        new UpdateSystemCommand(
          {
            id: systemA.id,
            name: 'RAS Main Updated',
            status: SystemStatus.MAINTENANCE,
            tankCount: 8,
          },
          TENANT_A,
          USER_ID,
        ),
      ),
    );
    const getAfterUpdate = await withTenantContext(TENANT_A, () =>
      harness.getSystem.execute(new GetSystemQuery(systemA.id, TENANT_A, true)),
    );
    const tenantAList = await withTenantContext(TENANT_A, () =>
      harness.listSystems.execute(
        new ListSystemsQuery(TENANT_A, { search: 'Updated' }, { page: 1, limit: 10 }),
      ),
    );
    const tenantBList = await withTenantContext(TENANT_B, () =>
      harness.listSystems.execute(
        new ListSystemsQuery(TENANT_B, { search: 'Updated' }, { page: 1, limit: 10 }),
      ),
    );

    expect(updated.name).toBe('RAS Main Updated');
    expect(updated.status).toBe(SystemStatus.MAINTENANCE);
    expect(getAfterUpdate?.name).toBe('RAS Main Updated');
    expect(getAfterUpdate?.tankCount).toBe(8);
    expect(tenantAList.data.map((system: System) => system.id)).toEqual([systemA.id]);
    expect(tenantBList.data).toHaveLength(0);

    await withTenantContext(TENANT_A, () =>
      harness.deleteSystem.execute(new DeleteSystemCommand(systemA.id, TENANT_A, USER_ID, false)),
    );

    const tenantAAfterDelete = await withTenantContext(TENANT_A, () =>
      harness.listSystems.execute(
        new ListSystemsQuery(TENANT_A, { search: 'RAS Main' }, { page: 1, limit: 10 }),
      ),
    );
    const tenantBAfterDelete = await withTenantContext(TENANT_B, () =>
      harness.listSystems.execute(
        new ListSystemsQuery(TENANT_B, { search: 'RAS Main' }, { page: 1, limit: 10 }),
      ),
    );

    expect(tenantAAfterDelete.data).toHaveLength(0);
    expect(tenantBAfterDelete.data.map((system: System) => system.id)).toEqual([systemB.id]);
  });

  it('keeps department create/update/delete-preview/delete isolated and immediately visible per tenant', async () => {
    const siteA = await createSiteForTenant(TENANT_A, 'Department Site A', 'DEPT-SITE-A');
    const siteB = await createSiteForTenant(TENANT_B, 'Department Site B', 'DEPT-SITE-B');

    const departmentA = await createDepartmentForTenant(
      TENANT_A,
      siteA.id,
      'Growout Shared',
      'DEPT-01',
    );
    const departmentB = await createDepartmentForTenant(
      TENANT_B,
      siteB.id,
      'Growout Shared',
      'DEPT-01',
    );

    expect(departmentA.id).not.toBe(departmentB.id);
    expect(await tableTenantRowCount('farm', 'departments', TENANT_A)).toBe(0);
    expect(await tableTenantRowCount(getTenantSchemaName(TENANT_A), 'departments', TENANT_A)).toBe(
      1,
    );
    expect(await tableTenantRowCount(getTenantSchemaName(TENANT_B), 'departments', TENANT_A)).toBe(
      0,
    );

    const updated = await withTenantContext(TENANT_A, () =>
      harness.updateDepartment.execute(
        new UpdateDepartmentCommand(
          departmentA.id,
          {
            id: departmentA.id,
            name: 'Growout Shared Updated',
            status: DepartmentStatus.INACTIVE,
            capacity: 250,
          },
          TENANT_A,
          USER_ID,
        ),
      ),
    );
    const getAfterUpdate = await withTenantContext(TENANT_A, () =>
      harness.getDepartment.execute(new GetDepartmentQuery(departmentA.id, TENANT_A, true)),
    );
    const tenantAList = await withTenantContext(TENANT_A, () =>
      harness.listDepartments.execute(
        new ListDepartmentsQuery(TENANT_A, { search: 'Updated' }, { page: 1, limit: 10 }),
      ),
    );
    const tenantBList = await withTenantContext(TENANT_B, () =>
      harness.listDepartments.execute(
        new ListDepartmentsQuery(TENANT_B, { search: 'Updated' }, { page: 1, limit: 10 }),
      ),
    );
    const deletePreview = await withTenantContext(TENANT_A, () =>
      harness.getDepartmentDeletePreview.execute(
        new GetDepartmentDeletePreviewQuery(departmentA.id, TENANT_A),
      ),
    );

    expect(updated.name).toBe('Growout Shared Updated');
    expect(updated.status).toBe(DepartmentStatus.INACTIVE);
    expect(Number(updated.capacity)).toBe(250);
    expect(getAfterUpdate?.name).toBe('Growout Shared Updated');
    expect(tenantAList.data.map((department: Department) => department.id)).toEqual([
      departmentA.id,
    ]);
    expect(tenantBList.data).toHaveLength(0);
    expect(deletePreview.canDelete).toBe(true);
    expect(deletePreview.affectedItems.totalCount).toBe(0);

    await withTenantContext(TENANT_A, () =>
      harness.deleteDepartment.execute(
        new DeleteDepartmentCommand(departmentA.id, TENANT_A, USER_ID, false),
      ),
    );

    const tenantAAfterDelete = await withTenantContext(TENANT_A, () =>
      harness.listDepartments.execute(
        new ListDepartmentsQuery(TENANT_A, { search: 'Growout Shared' }, { page: 1, limit: 10 }),
      ),
    );
    const tenantBAfterDelete = await withTenantContext(TENANT_B, () =>
      harness.listDepartments.execute(
        new ListDepartmentsQuery(TENANT_B, { search: 'Growout Shared' }, { page: 1, limit: 10 }),
      ),
    );

    expect(tenantAAfterDelete.data).toHaveLength(0);
    expect(tenantBAfterDelete.data.map((department: Department) => department.id)).toEqual([
      departmentB.id,
    ]);
  });

  it('keeps sensor-visible equipment and system junctions tenant-local and immediately queryable', async () => {
    const siteA = await createSiteForTenant(TENANT_A, 'Equipment Site A', 'EQ-SITE-A');
    const siteB = await createSiteForTenant(TENANT_B, 'Equipment Site B', 'EQ-SITE-B');
    const departmentA = await createDepartmentForTenant(
      TENANT_A,
      siteA.id,
      'Equipment Dept A',
      'EQ-DEPT-A',
    );
    const departmentB = await createDepartmentForTenant(
      TENANT_B,
      siteB.id,
      'Equipment Dept B',
      'EQ-DEPT-B',
    );
    const systemA = await createSystemForTenant(TENANT_A, siteA.id, 'Equipment RAS A', 'EQ-RAS-A');
    const systemB = await createSystemForTenant(TENANT_B, siteB.id, 'Equipment RAS B', 'EQ-RAS-B');

    const equipmentA = await createEquipmentForTenant(
      TENANT_A,
      departmentA.id,
      systemA.id,
      PUMP_EQUIPMENT_TYPE_ID,
      'Sensor Pump',
      'PUMP-01',
      true,
    );
    const equipmentB = await createEquipmentForTenant(
      TENANT_B,
      departmentB.id,
      systemB.id,
      PUMP_EQUIPMENT_TYPE_ID,
      'Sensor Pump',
      'PUMP-01',
      true,
    );

    expect(equipmentA.id).not.toBe(equipmentB.id);
    expect(await tableTenantRowCount('farm', 'equipment', TENANT_A)).toBe(0);
    expect(await tableTenantRowCount('farm', 'equipment_systems', TENANT_A)).toBe(0);
    expect(
      await tableHasRowForTenantAndId(
        getTenantSchemaName(TENANT_A),
        'equipment',
        TENANT_A,
        equipmentA.id,
      ),
    ).toBe(true);
    expect(
      await tableHasRowForTenantAndId(
        getTenantSchemaName(TENANT_A),
        'equipment_systems',
        TENANT_A,
        equipmentA.id,
        'equipmentId',
      ),
    ).toBe(true);
    expect(
      await tableHasRowForTenantAndId(
        getTenantSchemaName(TENANT_B),
        'equipment',
        TENANT_A,
        equipmentA.id,
      ),
    ).toBe(false);

    const updated = await withTenantContext(TENANT_A, () =>
      harness.updateEquipment.execute(
        new UpdateEquipmentCommand(
          equipmentA.id,
          {
            id: equipmentA.id,
            name: 'Sensor Pump Updated',
            status: EquipmentStatus.MAINTENANCE,
            isVisibleInSensor: true,
            systemIds: [systemA.id],
          },
          TENANT_A,
          USER_ID,
        ),
      ),
    );
    const getAfterUpdate = await withTenantContext(TENANT_A, () =>
      harness.getEquipment.execute(new GetEquipmentQuery(equipmentA.id, TENANT_A, true)),
    );
    const tenantAList = await withTenantContext(TENANT_A, () =>
      harness.listEquipment.execute(
        new ListEquipmentQuery(
          TENANT_A,
          { search: 'Updated', systemId: systemA.id, isVisibleInSensor: true, isTank: false },
          { page: 1, limit: 10 },
        ),
      ),
    );
    const tenantBList = await withTenantContext(TENANT_B, () =>
      harness.listEquipment.execute(
        new ListEquipmentQuery(
          TENANT_B,
          { search: 'Updated', systemId: systemB.id, isVisibleInSensor: true, isTank: false },
          { page: 1, limit: 10 },
        ),
      ),
    );
    const systemPreview = await withTenantContext(TENANT_A, () =>
      harness.getSystemDeletePreview.execute(new GetSystemDeletePreviewQuery(systemA.id, TENANT_A)),
    );

    expect(updated.name).toBe('Sensor Pump Updated');
    expect(updated.status).toBe(EquipmentStatus.MAINTENANCE);
    expect(getAfterUpdate.name).toBe('Sensor Pump Updated');
    expect(getAfterUpdate.equipmentSystems?.map((link) => link.systemId)).toEqual([systemA.id]);
    expect(tenantAList.data.map((equipment: Equipment) => equipment.id)).toEqual([equipmentA.id]);
    expect(tenantBList.data).toHaveLength(0);
    expect(systemPreview.affectedItems.equipment.map((equipment) => equipment.id)).toEqual([
      equipmentA.id,
    ]);

    await withTenantContext(TENANT_A, () =>
      harness.deleteEquipment.execute(
        new DeleteEquipmentCommand(equipmentA.id, TENANT_A, USER_ID, false),
      ),
    );

    const tenantAAfterDelete = await withTenantContext(TENANT_A, () =>
      harness.listEquipment.execute(
        new ListEquipmentQuery(
          TENANT_A,
          { search: 'Sensor Pump', isTank: false },
          { page: 1, limit: 10 },
        ),
      ),
    );
    const tenantBAfterDelete = await withTenantContext(TENANT_B, () =>
      harness.listEquipment.execute(
        new ListEquipmentQuery(
          TENANT_B,
          { search: 'Sensor Pump', isTank: false },
          { page: 1, limit: 10 },
        ),
      ),
    );

    expect(tenantAAfterDelete.data).toHaveLength(0);
    expect(tenantBAfterDelete.data.map((equipment: Equipment) => equipment.id)).toEqual([
      equipmentB.id,
    ]);
  });

  it('keeps feeder calibration replacement tenant-local and rolls back on audit failure', async () => {
    const siteA = await createSiteForTenant(TENANT_A, 'Feeder Calibration Site A', 'FC-SITE-A');
    const siteB = await createSiteForTenant(TENANT_B, 'Feeder Calibration Site B', 'FC-SITE-B');
    const departmentA = await createDepartmentForTenant(
      TENANT_A,
      siteA.id,
      'Feeder Calibration Dept A',
      'FC-DEPT-A',
    );
    const departmentB = await createDepartmentForTenant(
      TENANT_B,
      siteB.id,
      'Feeder Calibration Dept B',
      'FC-DEPT-B',
    );
    const systemA = await createSystemForTenant(
      TENANT_A,
      siteA.id,
      'Feeder Calibration RAS A',
      'FC-RAS-A',
    );
    const systemB = await createSystemForTenant(
      TENANT_B,
      siteB.id,
      'Feeder Calibration RAS B',
      'FC-RAS-B',
    );
    const equipmentA = await createEquipmentForTenant(
      TENANT_A,
      departmentA.id,
      systemA.id,
      FEEDER_EQUIPMENT_TYPE_ID,
      'Automatic Feeder',
      'FEEDER-AUTO-01',
      true,
    );
    const equipmentB = await createEquipmentForTenant(
      TENANT_B,
      departmentB.id,
      systemB.id,
      FEEDER_EQUIPMENT_TYPE_ID,
      'Automatic Feeder',
      'FEEDER-AUTO-01',
      true,
    );

    // Calibration is keyed on FEED IDENTITY now, so the feeds have to exist —
    // the FK is what makes a pellet diameter or a typo unstorable in that column.
    const feedSlowA = (await createFeedForTenant(TENANT_A, siteA.id, 'Slow Feed A', 'FC-SLOW-A'))
      .id;
    const feedFastA = (await createFeedForTenant(TENANT_A, siteA.id, 'Fast Feed A', 'FC-FAST-A'))
      .id;
    const feedSlowB = (await createFeedForTenant(TENANT_B, siteB.id, 'Slow Feed B', 'FC-SLOW-B'))
      .id;

    const savedA = await withTenantContext(TENANT_A, () =>
      harness.saveFeederCalibrations.execute(
        new SaveFeederCalibrationsCommand(
          {
            equipmentId: equipmentA.id,
            dispense: { mode: FeederDispenseControl.TIME_BASED },
            continuous: {
              siloCapacityKg: 50,
              minSpeedHz: 10,
              maxSpeedHz: 50,
              calibrations: [
                { feedId: feedSlowA, gramsPerMinute: 10, referenceSpeedHz: 25 },
                { feedId: feedFastA, gramsPerMinute: 40, referenceSpeedHz: 25 },
              ],
            },
          },
          TENANT_A,
          USER_ID,
        ),
      ),
    );
    const savedB = await withTenantContext(TENANT_B, () =>
      harness.saveFeederCalibrations.execute(
        new SaveFeederCalibrationsCommand(
          {
            equipmentId: equipmentB.id,
            dispense: { mode: FeederDispenseControl.TIME_BASED },
            discrete: {
              siloCapacityKg: 45,
              calibrations: [{ feedId: feedSlowB, gramsPerDispensing: 10 }],
            },
          },
          TENANT_B,
          USER_ID,
        ),
      ),
    );

    expect(savedA.map((row) => row.feedId).sort()).toEqual([feedFastA, feedSlowA].sort());
    expect(savedA.map((row) => Number(row.gramsPerMinute)).sort((a, b) => a - b)).toEqual([10, 40]);
    expect(savedB.map((row) => row.feedId)).toEqual([feedSlowB]);
    expect(savedB.map((row) => Number(row.gramsPerDispensing))).toEqual([10]);
    expect(await feederCalibrationRowCount('farm', TENANT_A, equipmentA.id)).toBe(0);
    expect(
      await feederCalibrationRowCount(getTenantSchemaName(TENANT_A), TENANT_A, equipmentA.id),
    ).toBe(2);
    expect(
      await feederCalibrationRowCount(getTenantSchemaName(TENANT_B), TENANT_A, equipmentA.id),
    ).toBe(0);
    expect(await outboxEventCount(TENANT_A, 'FeederCalibrationsSaved', equipmentA.id)).toBe(1);

    await expect(
      withTenantContext(TENANT_A, () =>
        harness.saveFeederCalibrations.execute(
          new SaveFeederCalibrationsCommand(
            {
              equipmentId: equipmentB.id,
              dispense: { mode: FeederDispenseControl.TIME_BASED },
              discrete: {
                siloCapacityKg: 70,
                calibrations: [{ feedId: feedSlowA, gramsPerDispensing: 20 }],
              },
            },
            TENANT_A,
            USER_ID,
          ),
        ),
      ),
    ).rejects.toThrow('not found');
    expect(
      await feederCalibrationRowCount(getTenantSchemaName(TENANT_A), TENANT_A, equipmentA.id),
    ).toBe(2);
    expect(await outboxEventCount(TENANT_A, 'FeederCalibrationsSaved', equipmentA.id)).toBe(1);

    const auditFailingHandler = new SaveFeederCalibrationsHandler(
      requireDataSource(),
      createFailingAuditLogService('audit down'),
      new OutboxPublisher(FarmOutbox),
    );
    const rollbackEquipment = await createEquipmentForTenant(
      TENANT_A,
      departmentA.id,
      systemA.id,
      FEEDER_EQUIPMENT_TYPE_ID,
      'Feeder Rollback Unit',
      'FEEDER-ROLLBACK-01',
      true,
    );

    await expect(
      withTenantContext(TENANT_A, () =>
        auditFailingHandler.execute(
          new SaveFeederCalibrationsCommand(
            {
              equipmentId: rollbackEquipment.id,
              dispense: { mode: FeederDispenseControl.TIME_BASED },
              discrete: {
                siloCapacityKg: 80,
                calibrations: [{ feedId: feedSlowA, gramsPerDispensing: 25 }],
              },
            },
            TENANT_A,
            USER_ID,
          ),
        ),
      ),
    ).rejects.toThrow('audit down');
    expect(
      await feederCalibrationRowCount(
        getTenantSchemaName(TENANT_A),
        TENANT_A,
        rollbackEquipment.id,
      ),
    ).toBe(0);
    expect(await outboxEventCount(TENANT_A, 'FeederCalibrationsSaved', rollbackEquipment.id)).toBe(
      0,
    );
  });

  it('keeps tank create/update/status/delete isolated and immediately visible per tenant', async () => {
    const siteA = await createSiteForTenant(TENANT_A, 'Tank Site A', 'TNK-SITE-A');
    const siteB = await createSiteForTenant(TENANT_B, 'Tank Site B', 'TNK-SITE-B');
    const departmentA = await createDepartmentForTenant(TENANT_A, siteA.id, 'Growout A', 'GROW-A');
    const departmentB = await createDepartmentForTenant(TENANT_B, siteB.id, 'Growout B', 'GROW-B');

    const tankA = await createTankForTenant(TENANT_A, departmentA.id, 'Circular Tank');
    const tankB = await createTankForTenant(TENANT_B, departmentB.id, 'Circular Tank');

    expect(tankA.id).not.toBe(tankB.id);
    expect(await tankRowCount('farm', TENANT_A)).toBe(0);
    expect(await tableTenantRowCount('farm', 'code_sequences', TENANT_A)).toBe(0);
    expect(await tankRowCount(getTenantSchemaName(TENANT_A), TENANT_A)).toBe(1);
    expect(await tankRowCount(getTenantSchemaName(TENANT_B), TENANT_A)).toBe(0);
    expect(
      await tableTenantRowCount(
        getTenantSchemaName(TENANT_A),
        'farm_stock_container_snapshots',
        TENANT_A,
      ),
    ).toBe(1);
    expect(
      await tableTenantRowCount(
        getTenantSchemaName(TENANT_B),
        'farm_stock_container_snapshots',
        TENANT_A,
      ),
    ).toBe(0);
    expect(await codeSequenceLastValue(getTenantSchemaName(TENANT_A), TENANT_A, 'Tank')).toBe(1);
    expect(await outboxEventCount(TENANT_A, 'TankCreated', tankA.id)).toBe(1);
    expect(await outboxEventCount(TENANT_A, 'TankCreated', tankB.id)).toBe(0);

    const createdEventsBeforeRollback = await outboxEventTypeCount(TENANT_A, 'TankCreated');
    const sequenceBeforeRollback = await codeSequenceLastValue(
      getTenantSchemaName(TENANT_A),
      TENANT_A,
      'Tank',
    );
    const rowCountBeforeRollback = await tankRowCount(getTenantSchemaName(TENANT_A), TENANT_A);
    const auditFailingCreateTank = new CreateTankHandler(
      requireDataSource(),
      createFailingAuditLogService('audit down'),
      tankCodeGenerator,
      new OutboxPublisher(FarmOutbox),
      new FarmStockProjectionService(),
    );

    await expect(
      withTenantContext(TENANT_A, () =>
        auditFailingCreateTank.execute(
          new CreateTankCommand(TENANT_A, USER_ID, {
            name: 'Rollback Tank',
            departmentId: departmentA.id,
            tankType: TankType.CIRCULAR,
            material: TankMaterial.FIBERGLASS,
            waterType: WaterType.SALTWATER,
            diameter: 7,
            depth: 3,
            maxBiomass: 900,
            maxDensity: 30,
            status: TankStatus.PREPARING,
          }),
        ),
      ),
    ).rejects.toThrow('audit down');
    expect(await tankRowCount(getTenantSchemaName(TENANT_A), TENANT_A)).toBe(
      rowCountBeforeRollback,
    );
    expect(await codeSequenceLastValue(getTenantSchemaName(TENANT_A), TENANT_A, 'Tank')).toBe(
      sequenceBeforeRollback,
    );
    expect(await outboxEventTypeCount(TENANT_A, 'TankCreated')).toBe(createdEventsBeforeRollback);

    const updated = await withTenantContext(TENANT_A, () =>
      harness.updateTank.execute(
        new UpdateTankCommand(TENANT_A, USER_ID, {
          id: tankA.id,
          name: 'Circular Tank Updated',
          maxBiomass: 1100,
        }),
      ),
    );
    const activated = await withTenantContext(TENANT_A, () =>
      harness.updateTankStatus.execute(
        new UpdateTankStatusCommand(TENANT_A, USER_ID, {
          id: tankA.id,
          status: TankStatus.ACTIVE,
          reason: 'ready-for-stocking',
        }),
      ),
    );
    const getAfterUpdate = await withTenantContext(TENANT_A, () =>
      harness.getTank.execute(new GetTankQuery(TENANT_A, tankA.id)),
    );
    const tenantAList = await withTenantContext(TENANT_A, () =>
      harness.listTanks.execute(
        new ListTanksQuery(TENANT_A, { search: 'Updated', isActive: true, offset: 0, limit: 10 }),
      ),
    );
    const tenantBList = await withTenantContext(TENANT_B, () =>
      harness.listTanks.execute(
        new ListTanksQuery(TENANT_B, { search: 'Updated', isActive: true, offset: 0, limit: 10 }),
      ),
    );

    expect(updated.name).toBe('Circular Tank Updated');
    expect(activated.status).toBe(TankStatus.ACTIVE);
    expect(getAfterUpdate.name).toBe('Circular Tank Updated');
    expect(getAfterUpdate.status).toBe(TankStatus.ACTIVE);
    expect(Number(getAfterUpdate.maxBiomass)).toBe(1100);
    expect(tenantAList.data.map((tank: Tank) => tank.id)).toEqual([tankA.id]);
    expect(tenantBList.data).toHaveLength(0);
    expect(await outboxEventCount(TENANT_A, 'TankUpdated', tankA.id)).toBe(1);
    expect(await outboxEventCount(TENANT_A, 'TankStatusChanged', tankA.id)).toBe(1);

    await withTenantContext(TENANT_A, () =>
      harness.deleteTank.execute(new DeleteTankCommand(TENANT_A, USER_ID, tankA.id)),
    );

    const tenantAActiveAfterDelete = await withTenantContext(TENANT_A, () =>
      harness.listTanks.execute(
        new ListTanksQuery(TENANT_A, {
          search: 'Circular Tank',
          isActive: true,
          offset: 0,
          limit: 10,
        }),
      ),
    );
    const tenantBActiveAfterDelete = await withTenantContext(TENANT_B, () =>
      harness.listTanks.execute(
        new ListTanksQuery(TENANT_B, {
          search: 'Circular Tank',
          isActive: true,
          offset: 0,
          limit: 10,
        }),
      ),
    );

    expect(tenantAActiveAfterDelete.data).toHaveLength(0);
    expect(tenantBActiveAfterDelete.data.map((tank: Tank) => tank.id)).toEqual([tankB.id]);
    expect(await outboxEventCount(TENANT_A, 'TankDeleted', tankA.id)).toBe(1);
  });

  it('routes tank-like equipment to the tenant tanks table and keeps it visible through equipment lists', async () => {
    const siteA = await createSiteForTenant(TENANT_A, 'Tank Equipment Site A', 'TEQ-SITE-A');
    const siteB = await createSiteForTenant(TENANT_B, 'Tank Equipment Site B', 'TEQ-SITE-B');
    const departmentA = await createDepartmentForTenant(
      TENANT_A,
      siteA.id,
      'Tank Equipment Dept A',
      'TEQ-DEPT-A',
    );
    const departmentB = await createDepartmentForTenant(
      TENANT_B,
      siteB.id,
      'Tank Equipment Dept B',
      'TEQ-DEPT-B',
    );
    const systemA = await createSystemForTenant(
      TENANT_A,
      siteA.id,
      'Tank Equipment RAS A',
      'TEQ-RAS-A',
    );
    const systemB = await createSystemForTenant(
      TENANT_B,
      siteB.id,
      'Tank Equipment RAS B',
      'TEQ-RAS-B',
    );

    const tankEquipmentA = await createTankEquipmentForTenant(
      TENANT_A,
      departmentA.id,
      systemA.id,
      'Unified Tank',
    );
    const tankEquipmentB = await createTankEquipmentForTenant(
      TENANT_B,
      departmentB.id,
      systemB.id,
      'Unified Tank',
    );

    expect(tankEquipmentA.id).not.toBe(tankEquipmentB.id);
    expect(await tableTenantRowCount('farm', 'tanks', TENANT_A)).toBe(0);
    expect(await tableTenantRowCount('farm', 'equipment', TENANT_A)).toBe(0);
    expect(
      await tableHasRowForTenantAndId(
        getTenantSchemaName(TENANT_A),
        'tanks',
        TENANT_A,
        tankEquipmentA.id,
      ),
    ).toBe(true);
    expect(
      await tableHasRowForTenantAndId(
        getTenantSchemaName(TENANT_A),
        'equipment',
        TENANT_A,
        tankEquipmentA.id,
      ),
    ).toBe(false);
    expect(
      await tableHasRowForTenantAndId(
        getTenantSchemaName(TENANT_B),
        'tanks',
        TENANT_A,
        tankEquipmentA.id,
      ),
    ).toBe(false);

    const tenantAList = await withTenantContext(TENANT_A, () =>
      harness.listEquipment.execute(
        new ListEquipmentQuery(
          TENANT_A,
          { search: 'Unified Tank', isTank: true, categories: [EquipmentCategory.TANK] },
          { page: 1, limit: 10 },
        ),
      ),
    );
    const tenantBList = await withTenantContext(TENANT_B, () =>
      harness.listEquipment.execute(
        new ListEquipmentQuery(
          TENANT_B,
          { search: 'Unified Tank', isTank: true, categories: [EquipmentCategory.TANK] },
          { page: 1, limit: 10 },
        ),
      ),
    );

    expect(tenantAList.data.map((equipment: Equipment) => equipment.id)).toEqual([
      tankEquipmentA.id,
    ]);
    expect(tenantAList.data[0]?.isTank).toBe(true);
    expect(tenantAList.data[0]?.equipmentType?.code).toBe('tank-circular');
    expect(tenantBList.data.map((equipment: Equipment) => equipment.id)).toEqual([
      tankEquipmentB.id,
    ]);
  });

  it('keeps feed create/update/delete isolated and immediately visible per tenant', async () => {
    const siteA = await createSiteForTenant(TENANT_A, 'Feed Site A', 'FEED-SITE-A');
    const siteB = await createSiteForTenant(TENANT_B, 'Feed Site B', 'FEED-SITE-B');

    const feedA = await createFeedForTenant(TENANT_A, siteA.id, 'Starter Pellet', 'FEED-01');
    const feedB = await createFeedForTenant(TENANT_B, siteB.id, 'Starter Pellet', 'FEED-01');

    expect(feedA.id).not.toBe(feedB.id);
    expect(await feedRowCount('farm', TENANT_A)).toBe(0);
    expect(await feedRowCount(getTenantSchemaName(TENANT_A), TENANT_A)).toBe(1);
    expect(await feedRowCount(getTenantSchemaName(TENANT_B), TENANT_A)).toBe(0);

    const updated = await withTenantContext(TENANT_A, () =>
      harness.updateFeed.execute(
        new UpdateFeedCommand(
          feedA.id,
          {
            id: feedA.id,
            name: 'Starter Pellet Updated',
            status: FeedStatus.LOW_STOCK,
            quantity: 12,
          },
          TENANT_A,
          USER_ID,
        ),
      ),
    );
    const getAfterUpdate = await withTenantContext(TENANT_A, () =>
      harness.getFeed.execute(new GetFeedQuery(feedA.id, TENANT_A)),
    );
    const tenantAList = await withTenantContext(TENANT_A, () =>
      harness.listFeeds.execute(
        new ListFeedsQuery(
          TENANT_A,
          { siteId: siteA.id, search: 'Updated' },
          { page: 1, limit: 10 },
        ),
      ),
    );
    const tenantBList = await withTenantContext(TENANT_B, () =>
      harness.listFeeds.execute(
        new ListFeedsQuery(
          TENANT_B,
          { siteId: siteB.id, search: 'Updated' },
          { page: 1, limit: 10 },
        ),
      ),
    );

    expect(updated.name).toBe('Starter Pellet Updated');
    expect(updated.status).toBe(FeedStatus.LOW_STOCK);
    expect(Number(getAfterUpdate?.quantity)).toBe(12);
    expect(tenantAList.data.map((feed: Feed) => feed.id)).toEqual([feedA.id]);
    expect(tenantBList.data).toHaveLength(0);

    await withTenantContext(TENANT_A, () =>
      harness.deleteFeed.execute(new DeleteFeedCommand(feedA.id, TENANT_A, USER_ID)),
    );

    const tenantAAfterDelete = await withTenantContext(TENANT_A, () =>
      harness.listFeeds.execute(
        new ListFeedsQuery(
          TENANT_A,
          { siteId: siteA.id, search: 'Starter Pellet' },
          { page: 1, limit: 10 },
        ),
      ),
    );
    const tenantBAfterDelete = await withTenantContext(TENANT_B, () =>
      harness.listFeeds.execute(
        new ListFeedsQuery(
          TENANT_B,
          { siteId: siteB.id, search: 'Starter Pellet' },
          { page: 1, limit: 10 },
        ),
      ),
    );

    expect(tenantAAfterDelete.data).toHaveLength(0);
    expect(tenantBAfterDelete.data.map((feed: Feed) => feed.id)).toEqual([feedB.id]);
  });

  it('keeps supplier approved-site replacement tenant-local and rolls back on audit failure', async () => {
    const siteA = await createSiteForTenant(TENANT_A, 'Supplier Site A', 'SUP-SITE-A');
    const siteASecondary = await createSiteForTenant(
      TENANT_A,
      'Supplier Site A Secondary',
      'SUP-SITE-A2',
    );
    const siteB = await createSiteForTenant(TENANT_B, 'Supplier Site B', 'SUP-SITE-B');
    const supplierA = await createSupplierForTenant(TENANT_A, 'Approved Feed Supplier', 'SUP-APP');
    const supplierB = await createSupplierForTenant(TENANT_B, 'Approved Feed Supplier', 'SUP-APP');

    const savedA = await withTenantContext(TENANT_A, () =>
      harness.setSupplierApprovedSites.execute(
        new SetSupplierApprovedSitesCommand(
          supplierA.id,
          [siteA.id, siteASecondary.id],
          siteASecondary.id,
          TENANT_A,
          USER_ID,
        ),
      ),
    );
    const savedB = await withTenantContext(TENANT_B, () =>
      harness.setSupplierApprovedSites.execute(
        new SetSupplierApprovedSitesCommand(supplierB.id, [siteB.id], siteB.id, TENANT_B, USER_ID),
      ),
    );

    expect(savedA.map((row) => row.siteId).sort()).toEqual([siteA.id, siteASecondary.id].sort());
    expect(savedA.find((row) => row.isPreferred)?.siteId).toBe(siteASecondary.id);
    expect(savedB.map((row) => row.siteId)).toEqual([siteB.id]);
    expect(await tableTenantRowCount('farm', 'supplier_sites', TENANT_A)).toBe(0);
    expect(await supplierSiteRowCount(getTenantSchemaName(TENANT_A), TENANT_A, supplierA.id)).toBe(
      2,
    );
    expect(await supplierSiteRowCount(getTenantSchemaName(TENANT_B), TENANT_A, supplierA.id)).toBe(
      0,
    );
    expect(await outboxEventCount(TENANT_A, 'SupplierApprovedSitesChanged', supplierA.id)).toBe(1);

    await expect(
      withTenantContext(TENANT_A, () =>
        harness.setSupplierApprovedSites.execute(
          new SetSupplierApprovedSitesCommand(
            supplierA.id,
            [siteB.id],
            siteB.id,
            TENANT_A,
            USER_ID,
          ),
        ),
      ),
    ).rejects.toThrow('Site ids not found in tenant');
    expect(await supplierSiteRowCount(getTenantSchemaName(TENANT_A), TENANT_A, supplierA.id)).toBe(
      2,
    );
    expect(await outboxEventCount(TENANT_A, 'SupplierApprovedSitesChanged', supplierA.id)).toBe(1);

    const auditFailingHandler = new SetSupplierApprovedSitesHandler(
      requireDataSource(),
      new OutboxPublisher(FarmOutbox),
      createFailingAuditLogService('audit down'),
    );
    const rollbackSupplier = await createSupplierForTenant(
      TENANT_A,
      'Audit Rollback Supplier',
      'SUP-ROLLBACK',
    );

    await expect(
      withTenantContext(TENANT_A, () =>
        auditFailingHandler.execute(
          new SetSupplierApprovedSitesCommand(
            rollbackSupplier.id,
            [siteA.id],
            siteA.id,
            TENANT_A,
            USER_ID,
          ),
        ),
      ),
    ).rejects.toThrow('audit down');
    expect(
      await supplierSiteRowCount(getTenantSchemaName(TENANT_A), TENANT_A, rollbackSupplier.id),
    ).toBe(0);
    expect(
      await outboxEventCount(TENANT_A, 'SupplierApprovedSitesChanged', rollbackSupplier.id),
    ).toBe(0);
  });

  it('invalidates water-quality parameter config cache only for the mutated tenant', async () => {
    const configA = await createParameterConfigForTenant(
      TENANT_A,
      'do_cache',
      'Dissolved Oxygen Cache',
      1,
    );
    const configB = await createParameterConfigForTenant(
      TENANT_B,
      'do_cache',
      'Dissolved Oxygen Cache',
      1,
    );

    expect(await parameterConfigRowCount('farm', TENANT_A)).toBe(0);
    expect(await parameterConfigRowCount(getTenantSchemaName(TENANT_A), TENANT_A)).toBe(1);
    expect(await parameterConfigRowCount(getTenantSchemaName(TENANT_B), TENANT_A)).toBe(0);

    const tenantAWarmCache = await withTenantContext(TENANT_A, () =>
      harness.parameterConfigCache.getActiveConfigs(TENANT_A),
    );
    const tenantBWarmCache = await withTenantContext(TENANT_B, () =>
      harness.parameterConfigCache.getActiveConfigs(TENANT_B),
    );

    expect(tenantAWarmCache.map((config) => config.id)).toEqual([configA.id]);
    expect(tenantBWarmCache.map((config) => config.id)).toEqual([configB.id]);

    const updated = await withTenantContext(TENANT_A, () =>
      harness.updateParameterConfig.execute(
        new UpdateParameterConfigCommand(
          TENANT_A,
          configA.id,
          {
            name: 'Dissolved Oxygen Cache Updated',
            displayOrder: 0,
          },
          USER_ID,
        ),
      ),
    );
    const getAfterUpdate = await withTenantContext(TENANT_A, () =>
      harness.getParameterConfig.execute(new GetParameterConfigQuery(TENANT_A, configA.id)),
    );
    const listAfterUpdate = await withTenantContext(TENANT_A, () =>
      harness.listParameterConfigs.execute(
        new ListParameterConfigsQuery(TENANT_A, { group: ParameterGroup.BASIC, isActive: true }),
      ),
    );
    const tenantACacheAfterUpdate = await withTenantContext(TENANT_A, () =>
      harness.parameterConfigCache.getActiveConfigs(TENANT_A),
    );
    const tenantBCacheAfterTenantAUpdate = await withTenantContext(TENANT_B, () =>
      harness.parameterConfigCache.getActiveConfigs(TENANT_B),
    );

    expect(updated.name).toBe('Dissolved Oxygen Cache Updated');
    expect(getAfterUpdate.name).toBe('Dissolved Oxygen Cache Updated');
    expect(listAfterUpdate.map((config) => config.id)).toEqual([configA.id]);
    expect(tenantACacheAfterUpdate.map((config) => config.name)).toEqual([
      'Dissolved Oxygen Cache Updated',
    ]);
    expect(tenantBCacheAfterTenantAUpdate.map((config) => config.name)).toEqual([
      'Dissolved Oxygen Cache',
    ]);

    await withTenantContext(TENANT_A, () =>
      harness.deleteParameterConfig.execute(new DeleteParameterConfigCommand(TENANT_A, configA.id)),
    );

    const tenantACacheAfterDelete = await withTenantContext(TENANT_A, () =>
      harness.parameterConfigCache.getActiveConfigs(TENANT_A),
    );
    const tenantBCacheAfterDelete = await withTenantContext(TENANT_B, () =>
      harness.parameterConfigCache.getActiveConfigs(TENANT_B),
    );

    expect(tenantACacheAfterDelete).toHaveLength(0);
    expect(tenantBCacheAfterDelete.map((config) => config.id)).toEqual([configB.id]);
  });

  async function createSiteForTenant(tenantId: string, name: string, code: string): Promise<Site> {
    return withTenantContext(tenantId, () =>
      harness.createSite.execute(
        new CreateSiteCommand(
          {
            name,
            code,
            country: 'NO',
            timezone: 'UTC',
            status: SiteStatus.ACTIVE,
          },
          tenantId,
          USER_ID,
        ),
      ),
    );
  }

  async function rowCount(schema: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await requireDataSource().query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."sites" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function createSystemForTenant(
    tenantId: string,
    siteId: string,
    name: string,
    code: string,
  ): Promise<System> {
    return withTenantContext(tenantId, () =>
      harness.createSystem.execute(
        new CreateSystemCommand(
          {
            siteId,
            name,
            code,
            type: SystemType.RAS,
            status: SystemStatus.OPERATIONAL,
            tankCount: 4,
          },
          tenantId,
          USER_ID,
        ),
      ),
    );
  }

  async function systemRowCount(schema: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await requireDataSource().query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."systems" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function createDepartmentForTenant(
    tenantId: string,
    siteId: string,
    name: string,
    code: string,
  ): Promise<Department> {
    return withTenantContext(tenantId, () =>
      harness.createDepartment.execute(
        new CreateDepartmentCommand(
          {
            siteId,
            name,
            code,
            type: DepartmentType.PRODUCTION,
            capacity: 100,
          },
          tenantId,
          USER_ID,
        ),
      ),
    );
  }

  async function createEquipmentForTenant(
    tenantId: string,
    departmentId: string,
    systemId: string,
    equipmentTypeId: string,
    name: string,
    code: string,
    isVisibleInSensor: boolean,
  ): Promise<Equipment> {
    return withTenantContext(tenantId, () =>
      harness.createEquipment.execute(
        new CreateEquipmentCommand(
          {
            departmentId,
            systemIds: [systemId],
            equipmentTypeId,
            name,
            code,
            status: EquipmentStatus.OPERATIONAL,
            isVisibleInSensor,
            specifications: { flowRate: 100 },
          },
          tenantId,
          USER_ID,
        ),
      ),
    );
  }

  async function createTankEquipmentForTenant(
    tenantId: string,
    departmentId: string,
    systemId: string,
    name: string,
  ): Promise<Equipment> {
    return withTenantContext(tenantId, () =>
      harness.createEquipment.execute(
        new CreateEquipmentCommand(
          {
            departmentId,
            systemIds: [systemId],
            equipmentTypeId: TANK_EQUIPMENT_TYPE_ID,
            name,
            code: `${name.replace(/\s+/g, '-').toUpperCase()}-IGNORED`,
            status: EquipmentStatus.PREPARING,
            specifications: {
              tankType: 'circular',
              material: 'fiberglass',
              waterType: 'saltwater',
              dimensions: {
                diameter: 4,
                depth: 2,
              },
              maxBiomass: 900,
              maxDensity: 25,
            },
          },
          tenantId,
          USER_ID,
        ),
      ),
    );
  }

  async function createTankForTenant(
    tenantId: string,
    departmentId: string,
    name: string,
  ): Promise<Tank> {
    return withTenantContext(tenantId, () =>
      harness.createTank.execute(
        new CreateTankCommand(tenantId, USER_ID, {
          name,
          departmentId,
          tankType: TankType.CIRCULAR,
          material: TankMaterial.FIBERGLASS,
          waterType: WaterType.SALTWATER,
          diameter: 5,
          depth: 2,
          maxBiomass: 1000,
          maxDensity: 30,
          status: TankStatus.PREPARING,
        }),
      ),
    );
  }

  async function tankRowCount(schema: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await requireDataSource().query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."tanks" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function createFeedForTenant(
    tenantId: string,
    siteId: string,
    name: string,
    code: string,
  ): Promise<Feed> {
    return withTenantContext(tenantId, () =>
      harness.createFeed.execute(
        new CreateFeedCommand(
          {
            name,
            code,
            siteId,
            type: FeedType.STARTER,
            status: FeedStatus.AVAILABLE,
            quantity: 100,
            minStock: 10,
            unit: 'kg',
          },
          tenantId,
          USER_ID,
        ),
      ),
    );
  }

  async function feedRowCount(schema: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await requireDataSource().query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."feeds" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function createSupplierForTenant(
    tenantId: string,
    name: string,
    code: string,
  ): Promise<Supplier> {
    const repository = tenantManagerRepo(requireDataSource().manager, Supplier, tenantId);
    return withTenantContext(tenantId, () =>
      repository.save({
        tenantId,
        name,
        code,
        type: SupplierType.FEED,
        supplyTypes: [SupplierType.FEED],
        status: SupplierStatus.ACTIVE,
        isActive: true,
        createdBy: USER_ID,
        updatedBy: USER_ID,
      }),
    );
  }

  async function supplierSiteRowCount(
    schema: string,
    tenantId: string,
    supplierId: string,
  ): Promise<number> {
    const rows: Array<{ count: string }> = await requireDataSource().query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."supplier_sites" WHERE "tenantId" = $1 AND "supplierId" = $2`,
      [tenantId, supplierId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function feederCalibrationRowCount(
    schema: string,
    tenantId: string,
    equipmentId: string,
  ): Promise<number> {
    const rows: Array<{ count: string }> = await requireDataSource().query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."feeder_calibrations" WHERE "tenant_id" = $1 AND "equipment_id" = $2`,
      [tenantId, equipmentId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function outboxEventCount(
    tenantId: string,
    eventType: string,
    aggregateId: string,
  ): Promise<number> {
    const rows: Array<{ count: string }> = await requireDataSource().query(
      `SELECT COUNT(*)::text AS count FROM "farm"."outbox_events" WHERE "tenantId" = $1 AND "eventType" = $2 AND "aggregateId" = $3`,
      [tenantId, eventType, aggregateId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function outboxEventTypeCount(tenantId: string, eventType: string): Promise<number> {
    const rows: Array<{ count: string }> = await requireDataSource().query(
      `SELECT COUNT(*)::text AS count FROM "farm"."outbox_events" WHERE "tenantId" = $1 AND "eventType" = $2`,
      [tenantId, eventType],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function codeSequenceLastValue(
    schema: string,
    tenantId: string,
    entityType: string,
  ): Promise<number> {
    const rows: Array<{ value: string | null }> = await requireDataSource().query(
      `SELECT COALESCE(MAX("lastSequence"), 0)::text AS value FROM "${schema}"."code_sequences" WHERE "tenantId" = $1 AND "entityType" = $2`,
      [tenantId, entityType],
    );
    return Number(rows[0]?.value ?? 0);
  }

  async function createParameterConfigForTenant(
    tenantId: string,
    code: string,
    name: string,
    displayOrder: number,
  ): Promise<WaterQualityParameterConfig> {
    return withTenantContext(tenantId, () =>
      harness.createParameterConfig.execute(
        new CreateParameterConfigCommand(
          tenantId,
          {
            code,
            name,
            unit: 'mg/L',
            dataType: ParameterDataType.NUMBER,
            group: ParameterGroup.BASIC,
            precision: 2,
            displayOrder,
            isActive: true,
            isVisible: true,
          },
          USER_ID,
        ),
      ),
    );
  }

  async function parameterConfigRowCount(schema: string, tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await requireDataSource().query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."water_quality_parameter_configs" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function tableTenantRowCount(
    schema: string,
    table: string,
    tenantId: string,
  ): Promise<number> {
    const rows: Array<{ count: string }> = await requireDataSource().query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."${table}" WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function tableHasRowForTenantAndId(
    schema: string,
    table: string,
    tenantId: string,
    id: string,
    idColumn = 'id',
  ): Promise<boolean> {
    const rows: Array<{ count: string }> = await requireDataSource().query(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."${table}" WHERE "tenantId" = $1 AND "${idColumn}" = $2`,
      [tenantId, id],
    );
    return Number(rows[0]?.count ?? 0) === 1;
  }

  async function seedEquipmentTypesForSetupTest(): Promise<void> {
    await requireDataSource().manager.save(EquipmentType, [
      requireDataSource().manager.create(EquipmentType, {
        id: PUMP_EQUIPMENT_TYPE_ID,
        name: 'Centrifugal Pump',
        code: 'pump-centrifugal',
        category: EquipmentCategory.PUMP,
        specificationSchema: {
          fields: [{ name: 'flowRate', label: 'Flow Rate', type: 'number' }],
        },
        isActive: true,
        isSystem: true,
        sortOrder: 1,
      }),
      requireDataSource().manager.create(EquipmentType, {
        id: FEEDER_EQUIPMENT_TYPE_ID,
        name: 'Automatic Feeder',
        code: 'feeder-automatic',
        category: EquipmentCategory.FEEDING,
        specificationSchema: {
          fields: [{ name: 'siloVolume', label: 'Silo Volume', type: 'number' }],
        },
        isActive: true,
        isSystem: true,
        sortOrder: 3,
      }),
      requireDataSource().manager.create(EquipmentType, {
        id: TANK_EQUIPMENT_TYPE_ID,
        name: 'Circular Tank',
        code: 'tank-circular',
        category: EquipmentCategory.TANK,
        specificationSchema: {
          fields: [
            { name: 'tankType', label: 'Tank Type', type: 'text', required: true },
            { name: 'maxBiomass', label: 'Max Biomass', type: 'number', required: true },
          ],
        },
        isActive: true,
        isSystem: true,
        sortOrder: 2,
      }),
    ]);
  }
});

function unusedRepository<T extends ObjectLiteral>(): Repository<T> {
  return {} as Repository<T>;
}

function createTankCommandBus(handlers: {
  createTank: CreateTankHandler;
  updateTank: UpdateTankHandler;
  deleteTank: DeleteTankHandler;
}): CommandBus {
  return {
    execute: async (command: unknown) => {
      if (command instanceof CreateTankCommand) {
        return handlers.createTank.execute(command);
      }
      if (command instanceof UpdateTankCommand) {
        return handlers.updateTank.execute(command);
      }
      if (command instanceof DeleteTankCommand) {
        return handlers.deleteTank.execute(command);
      }
      const commandName =
        typeof command === 'object' && command !== null ? command.constructor?.name : 'unknown';
      throw new Error(`Unsupported tank equipment adapter command: ${commandName ?? 'unknown'}`);
    },
  } as unknown as CommandBus;
}

function createAuditLogService(): AuditLogService {
  // as never: AuditLogService grew members this stub never exercises;
  // a direct `as AuditLogService` no longer sufficiently overlaps and
  // error-poisons every downstream handler argument.
  return {
    log: () => Promise.resolve(new AuditLog()),
    logWithManager: () => Promise.resolve(new AuditLog()),
  } as never;
}

function createFailingAuditLogService(message: string): AuditLogService {
  return {
    log: () => Promise.resolve(new AuditLog()),
    logWithManager: () => Promise.reject(new Error(message)),
  } as never;
}
