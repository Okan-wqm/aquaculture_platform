import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('INVARIANT: sites setup remediation plan is durable and registry-backed', () => {
  it('keeps the persistent plan metadata and phase gates explicit', () => {
    const plan = read('docs/plans/sites-setup-remediation/README.md');

    expect(plan).toContain('Created: 2026-06-01');
    expect(plan).toContain('Last Resumed: 2026-06-02');
    expect(plan).toContain('Current Phase: Phase 3 - Backend Write Path Replacement');
    expect(plan).toContain('Registry Finding: `FARM-HIGH-003`');
    expect(plan).toContain('MODULE_SCHEMAS');
    expect(plan).toContain('farm_documents');
    expect(plan).toContain('runInTenantTransaction');
    expect(plan).toContain('AuditLogService.logWithManager');
    expect(plan).toContain('OutboxPublisher.enqueue');
    expect(plan).toContain('No raw setup transaction or query runner');
  });

  it('keeps the narrative review anchor and registry entry in sync', () => {
    const review = read('docs/reviews/farm-expert/2026-06-01-sites-setup-ssot-remediation.md');
    const registry = read('docs/reviews/_registry/findings.jsonl');

    expect(review).toContain('## FARM-HIGH-003');
    expect(registry).toContain('"id":"FARM-HIGH-003"');
    expect(registry).toContain(
      '"review_file":"docs/reviews/farm-expert/2026-06-01-sites-setup-ssot-remediation.md"',
    );
  });

  it('does not leave farm architecture docs claiming unfinished setup write migration is complete', () => {
    const architecture = read('docs/architecture/farm-enterprise-ssot.md');
    const outboxRunbook = read('docs/runbooks/farm-outbox-inbox-migration.md');

    expect(architecture).toContain(
      'Site, PII-free site contact replacement events, department, system, non-tank equipment, sub-equipment, tank-like equipment compatibility, tank, supplier approved-site, and feeder calibration setup writes now use the target tenant transaction/audit/outbox contract',
    );
    expect(architecture).toContain('strict JSON schemas and gateway realtime bridge dispatch');
    expect(architecture).toContain('docs/plans/sites-setup-remediation/README.md');
    expect(outboxRunbook).not.toContain(
      'Current migrated examples: site, department, and system create/update handlers',
    );
    expect(outboxRunbook).toContain(
      'site, PII-free site-contact metadata, department, system, non-tank equipment, sub-equipment, tank-like equipment compatibility, tank, supplier approved-site, and feeder calibration setup write paths',
    );
    expect(outboxRunbook).toContain('strict JSON schemas and gateway realtime bridge dispatch');
  });

  it('keeps the Phase 1 inventory bound to owners, successors, runtime signals, and gates', () => {
    const plan = read('docs/plans/sites-setup-remediation/README.md');
    const inventory = read('docs/plans/sites-setup-remediation/INVENTORY.md');

    expect(plan).toContain('docs/plans/sites-setup-remediation/INVENTORY.md');
    expect(inventory).toContain('Phase 1 - Inventory And Runtime Baseline');
    expect(inventory).toContain('farm_workers');
    expect(inventory).toContain('farm_documents');
    expect(inventory).toContain('SchemaManagerService.syncTenantSchema()');
    expect(inventory).toContain('FishHealthChemicalsTab');
    expect(inventory).toContain('eventBus.publish');
    expect(inventory).toContain('/upload/presigned-url');
    expect(inventory).toContain('web/modules/farm-module/src/hooks/useSites.ts');
    expect(inventory).toContain('setup_legacy_write_total');
    expect(inventory).toContain('Removal gate');
  });

  it('keeps the farm_documents drop complete across every authority surface (ORPHAN-HIGH-369)', () => {
    // Owner decision (FARMPLAT-HIGH-001): farm_documents was a fully built but
    // UNWIRED document-management surface — no resolver/controller, no
    // frontend. This invariant used to pin the surface as registered; it now
    // pins the DROP as complete, so a partial resurrection (entity without
    // module, registry entry without table, …) fails loudly.
    const migration = read(
      'apps/farm-service/src/database/migrations/1805300000000-DropFarmDocuments.ts',
    );
    const manifest = read('apps/farm-service/src/database/migrations/manifest.ts');
    const schemaManager = read('libs/backend-common/src/database/schema-manager.service.ts');
    const appModule = read('apps/farm-service/src/app.module.ts');
    const cleanupModule = read('apps/farm-service/src/common/file-cleanup/file-cleanup.module.ts');

    // The code surface is gone…
    expect(existsSync(resolve(REPO_ROOT, 'apps/farm-service/src/document'))).toBe(false);
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/farm-service/src/common/file-cleanup/farm-document-path.provider.ts',
        ),
      ),
    ).toBe(false);
    expect(appModule).not.toContain('FarmDocumentModule');
    expect(cleanupModule).not.toContain('FarmDocumentPathProvider');
    expect(schemaManager).not.toContain("'farm_documents'");

    // …and the physical drop is registered, guarded, and per-schema scoped.
    expect(manifest).toContain('DropFarmDocuments1805300000000');
    expect(migration).toContain('RAISE EXCEPTION');
    expect(migration).toContain('DROP TABLE IF EXISTS %I.farm_documents');
    expect(migration).toContain('current_schema()');
  });

  it('keeps farm setup events bound to canonical outbox_events for new writes', () => {
    const outboxEntity = read('apps/farm-service/src/outbox/farm-outbox.entity.ts');
    const outboxModule = read('apps/farm-service/src/outbox/farm-outbox.module.ts');
    const schemaManager = read('libs/backend-common/src/database/schema-manager.service.ts');
    const appModule = read('apps/farm-service/src/app.module.ts');
    const createSite = read('apps/farm-service/src/site/handlers/create-site.handler.ts');
    const updateSite = read('apps/farm-service/src/site/handlers/update-site.handler.ts');
    const deleteSite = read('apps/farm-service/src/site/handlers/delete-site.handler.ts');
    const siteContacts = read(
      'apps/farm-service/src/site/handlers/upsert-site-contacts.handler.ts',
    );
    const createDepartment = read(
      'apps/farm-service/src/department/handlers/create-department.handler.ts',
    );
    const updateDepartment = read(
      'apps/farm-service/src/department/handlers/update-department.handler.ts',
    );
    const deleteDepartment = read(
      'apps/farm-service/src/department/handlers/delete-department.handler.ts',
    );
    const createSystem = read('apps/farm-service/src/system/handlers/create-system.handler.ts');
    const updateSystem = read('apps/farm-service/src/system/handlers/update-system.handler.ts');
    const deleteSystem = read('apps/farm-service/src/system/handlers/delete-system.handler.ts');
    const supplierApprovedSites = read(
      'apps/farm-service/src/supplier/handlers/set-supplier-approved-sites.handler.ts',
    );
    const feederCalibrations = read(
      'apps/farm-service/src/equipment/handlers/save-feeder-calibrations.handler.ts',
    );
    const createEquipment = read(
      'apps/farm-service/src/equipment/handlers/create-equipment.handler.ts',
    );
    const updateEquipment = read(
      'apps/farm-service/src/equipment/handlers/update-equipment.handler.ts',
    );
    const deleteEquipment = read(
      'apps/farm-service/src/equipment/handlers/delete-equipment.handler.ts',
    );
    const createSubEquipment = read(
      'apps/farm-service/src/equipment/handlers/create-sub-equipment.handler.ts',
    );
    const updateSubEquipment = read(
      'apps/farm-service/src/equipment/handlers/update-sub-equipment.handler.ts',
    );
    const deleteSubEquipment = read(
      'apps/farm-service/src/equipment/handlers/delete-sub-equipment.handler.ts',
    );
    const createTank = read('apps/farm-service/src/tank/handlers/create-tank.handler.ts');
    const updateTank = read('apps/farm-service/src/tank/handlers/update-tank.handler.ts');
    const updateTankStatus = read(
      'apps/farm-service/src/tank/handlers/update-tank-status.handler.ts',
    );
    const deleteTank = read('apps/farm-service/src/tank/handlers/delete-tank.handler.ts');
    const farmEvents = read('libs/event-contracts/src/farm-events.ts');
    const farmEventSchemas = read('libs/event-contracts/src/schemas/farm-events.schema.ts');
    const farmBridge = read('apps/gateway-api/src/websocket/farm-nats-bridge.service.ts');
    const farmGateway = read('apps/gateway-api/src/websocket/farm.gateway.ts');
    const farmRealtimeHook = read('web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts');

    expect(outboxEntity).toContain("name: 'outbox_events'");
    expect(outboxModule).toContain('canonical farm.outbox_events');
    expect(schemaManager).toContain("'outbox_events'");
    expect(schemaManager).toContain("'inbox_messages'");
    expect(schemaManager).toContain("'event_dlq'");
    // farm's RLS excludeTables now DERIVE the infra set (incl. outbox_events) from
    // MODULE_SCHEMAS via getRlsExcludeTablesForService — the canonical binding is
    // the schema-manager SSoT (asserted above), not a hand-copied app.module
    // literal (PR-6 / SSOT-H drift fix).
    expect(appModule).toContain("getRlsExcludeTablesForService('farm')");

    for (const source of [
      createSite,
      updateSite,
      deleteSite,
      siteContacts,
      createDepartment,
      updateDepartment,
      deleteDepartment,
      createSystem,
      updateSystem,
      deleteSystem,
      supplierApprovedSites,
      feederCalibrations,
      createEquipment,
      updateEquipment,
      deleteEquipment,
      createSubEquipment,
      updateSubEquipment,
      deleteSubEquipment,
      createTank,
      updateTank,
      updateTankStatus,
      deleteTank,
    ]) {
      expect(source).toContain('runInTenantTransaction');
      expect(source).toContain('tenantManagerRepo');
      expect(source).toContain('AuditLogService');
      expect(source).toContain('logWithManager');
      expect(source).toContain('OutboxPublisher');
      expect(source).toContain('outboxPublisher.enqueue');
      expect(source).not.toContain('eventBus.publish');
      expect(source).not.toContain('NatsEventBus');
      expect(source).not.toContain('createQueryRunner');
      expect(source).not.toContain('@InjectRepository');
    }
    expect(farmEvents).toContain('FeederCalibrationsSavedEvent');
    expect(farmEvents).toContain("eventType: 'FeederCalibrationsSaved'");
    expect(farmEvents).toContain('TankCreatedEvent');
    expect(farmEvents).toContain('TankStatusChangedEvent');
    expect(farmEvents).toContain('EquipmentCreatedEvent');
    expect(farmEvents).toContain('SubEquipmentCreatedEvent');
    expect(farmEvents).toContain('previousContactCount');
    expect(farmEvents).toContain('primaryContactChanged');
    expect(farmEvents).not.toContain('previousContacts:');
    expect(farmEvents).not.toContain('newContacts:');
    expect(farmEventSchemas).not.toMatch(/interface\s+WireSiteContact\b/);
    expect(farmEventSchemas).not.toContain('previousContacts');
    expect(farmEventSchemas).not.toContain('newContacts');
    for (const eventType of [
      'SiteCreated',
      'SiteUpdated',
      'SiteDeleted',
      'DepartmentCreated',
      'DepartmentUpdated',
      'DepartmentDeleted',
      'SystemCreated',
      'SystemUpdated',
      'SystemDeleted',
      'SiteContactsChanged',
      'EquipmentCreated',
      'EquipmentUpdated',
      'EquipmentDeleted',
      'SubEquipmentCreated',
      'SubEquipmentUpdated',
      'SubEquipmentDeleted',
      'TankCreated',
      'TankUpdated',
      'TankStatusChanged',
      'TankDeleted',
      'SupplierApprovedSitesChanged',
      'FeederCalibrationsSaved',
    ]) {
      expect(farmEventSchemas).toContain(`| '${eventType}'`);
      expect(farmEventSchemas).toContain(`${eventType}:`);
      expect(farmBridge).toContain(`events.*.${eventType}`);
      const frontendEventName = eventType.charAt(0).toLowerCase() + eventType.slice(1);
      expect(farmRealtimeHook).toContain(`${frontendEventName}:`);
    }
    expect(farmEventSchemas).toContain("'aggregateId'");
    expect(farmEventSchemas).toContain("'aggregateType'");
    expect(farmGateway).toContain('broadcastSiteContactsChanged');
    expect(farmGateway).toContain('broadcastTankCreated');
    expect(farmGateway).toContain('broadcastTankStatusChanged');
    expect(farmGateway).toContain('broadcastEquipmentCreated');
    expect(farmGateway).toContain('broadcastSubEquipmentCreated');
    expect(farmGateway).toContain('broadcastSupplierApprovedSitesChanged');
    expect(farmGateway).toContain('broadcastFeederCalibrationsSaved');
  });

  it('routes tank-like equipment writes through the Tank aggregate, not generic equipment persistence (FARM-HIGH-003 Phase 4.3)', () => {
    const createEquipment = read(
      'apps/farm-service/src/equipment/handlers/create-equipment.handler.ts',
    );
    const updateEquipment = read(
      'apps/farm-service/src/equipment/handlers/update-equipment.handler.ts',
    );
    const deleteEquipment = read(
      'apps/farm-service/src/equipment/handlers/delete-equipment.handler.ts',
    );
    const adapter = read(
      'apps/farm-service/src/equipment/services/tank-equipment-adapter.service.ts',
    );

    // Every equipment write path must delegate tank-like categories to the Tank
    // aggregate via TankEquipmentAdapterService — tank/pond/cage identity is
    // canonical in `tanks`, so a tank-like row must never be persisted as a
    // generic equipment row. This pins the already-correct routing so a
    // reintroduction of a direct tank-like equipment write fails loudly.
    for (const source of [createEquipment, updateEquipment, deleteEquipment]) {
      expect(source).toContain('TankEquipmentAdapterService');
      expect(source).toContain('tankEquipmentAdapter');
    }
    expect(createEquipment).toContain('isTankLike');
    expect(createEquipment).toContain('createFromEquipment');
    expect(updateEquipment).toContain('updateFromEquipment');
    expect(deleteEquipment).toContain('deleteFromEquipment');

    // The adapter dispatches Tank commands through the CommandBus (which run the
    // tenant-transaction + audit + outbox contract), never a direct equipment
    // write for tank-like categories.
    expect(adapter).toContain('CreateTankCommand');
    expect(adapter).toContain('UpdateTankCommand');
    expect(adapter).toContain('DeleteTankCommand');
    expect(adapter).toContain('commandBus.execute');
    expect(adapter).toMatch(/EquipmentCategory\.TANK/);
    expect(adapter).toMatch(/EquipmentCategory\.POND/);
    expect(adapter).toMatch(/EquipmentCategory\.CAGE/);
  });

  it('keeps existing-tenant runtime DDL repair fail-closed outside explicit test bootstrap', () => {
    const schemaManager = read('libs/backend-common/src/database/schema-manager.service.ts');
    const adminSchemaService = read(
      'apps/admin-api-service/src/database-management/services/schema-management.service.ts',
    );
    const farmE2eApp = read('apps/farm-service/test/e2e-app.ts');

    expect(schemaManager).toContain('allowExistingTenantRepair');
    expect(schemaManager).toContain('Runtime tenant schema repair is disabled');
    expect(adminSchemaService).toContain('report-only during Sites Setup SSOT remediation');
    expect(adminSchemaService).not.toContain('.syncTenantSchema(');
    expect(farmE2eApp).toContain('allowExistingTenantRepair: true');
    expect(farmE2eApp).toContain('farm-service e2e bootstrap refresh');
  });
});
