/**
 * Spare-part criticality (FARM-24) against a REAL PostgreSQL.
 *
 * WHY: every rule of `GetSparePartCriticalityHandler` lives in one SQL
 * statement — the join paths, the soft-delete filters, the text comparison of
 * a `simple-array` column, the recursive child-system walk, the backup
 * predicate and the tenant predicates. A mocked manager returns whatever the
 * test hands it, so none of those can fail there; only Postgres can.
 *
 * WHAT: each case builds its own world (own site, own equipment types), so the
 * cases cannot see each other's rows. The handler runs through the real
 * `runInTenantRead` boundary against a derived tenant schema. Rows are seeded
 * with `manager.create` + `manager.save` (create keeps entity hooks such as
 * `Tank.calculateVolume` alive). `tank_batches` rows are written directly: the
 * query reads only their count columns (`totalQuantity`, the count SSoT, and
 * `cleanerFishQuantity`), so the stocking writers add nothing under test here.
 *
 * Other-tenant rows are written INTO THE SAME tenant schema on purpose: the
 * schema boundary alone would hide them, and the case exists to prove the SQL
 * tenantId predicates exclude them by themselves.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { NotFoundException } from '@nestjs/common';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, DeepPartial, ObjectLiteral } from 'typeorm';

import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import {
  Department,
  DepartmentStatus,
  DepartmentType,
} from '../../department/entities/department.entity';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { EquipmentCategory, EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { Equipment, EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { SparePart } from '../../maintenance/entities/spare-part.entity';
import { GetSparePartCriticalityHandler } from '../../maintenance/handlers/get-spare-part-criticality.handler';
import {
  GetSparePartCriticalityQuery,
  SparePartCriticalityResult,
} from '../../maintenance/queries/get-spare-part-criticality.query';
import { Site, SiteStatus, SiteType } from '../../site/entities/site.entity';
import { Species } from '../../species/entities/species.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { SubSystem, SubSystemType } from '../../system/entities/sub-system.entity';
import { System, SystemType } from '../../system/entities/system.entity';
import {
  Tank,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../tank/entities/tank.entity';

import { createTenantSchemaDerived } from './helpers/tenant-schema-harness';

const TENANT = '5c1e7a2b-3d4f-4a6b-8c9d-0e1f2a3b4c5d';
const OTHER_TENANT = '9d8c7b6a-5f4e-4d3c-9b2a-1f0e9d8c7b6a';

interface Place {
  siteId: string;
  departmentId: string;
}

interface EquipmentOpts {
  tenantId?: string;
  departmentId?: string | null;
  subSystemId?: string;
  status?: EquipmentStatus;
  isTank?: boolean;
  isActive?: boolean;
  isDeleted?: boolean;
}

describe('GetSparePartCriticalityHandler — real Postgres (FARM-24)', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let handler: GetSparePartCriticalityHandler;
  let seq = 0;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-spare-part-criticality-${randomBytes(4).toString('hex')}`,
      // The tables the query reads plus their relation closure: TypeORM builds
      // metadata only when every relation TARGET is registered too.
      entities: [
        SparePart,
        Supplier,
        EquipmentType,
        Equipment,
        EquipmentSystem,
        Site,
        Department,
        System,
        SubSystem,
        Tank,
        TankBatch,
        Batch,
        BatchDocument,
        Species,
      ],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();

    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();
    await createTenantSchemaDerived(dataSource, getTenantSchemaName(TENANT));

    handler = new GetSparePartCriticalityHandler(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  // ── seed helpers — every write lands in TENANT's schema ─────────────────

  function nextCode(prefix: string): string {
    seq += 1;
    return `${prefix}-${seq}`;
  }

  function insert<E extends ObjectLiteral>(entity: new () => E, row: DeepPartial<E>): Promise<E> {
    return withTenantContext(TENANT, () => {
      const manager = dataSource.manager;
      return manager.save(manager.create(entity, row));
    });
  }

  async function place(tenantId: string = TENANT, siteId?: string): Promise<Place> {
    const resolvedSiteId =
      siteId ??
      (
        await insert(Site, {
          tenantId,
          name: nextCode('Site'),
          code: nextCode('S'),
          type: SiteType.LAND_BASED,
          country: 'NO',
          timezone: 'UTC',
          status: SiteStatus.ACTIVE,
          isActive: true,
        })
      ).id;
    const department = await insert(Department, {
      tenantId,
      siteId: resolvedSiteId,
      name: nextCode('Dept'),
      code: nextCode('D'),
      type: DepartmentType.PRODUCTION,
      status: DepartmentStatus.ACTIVE,
      isActive: true,
      isDeleted: false,
    });
    return { siteId: resolvedSiteId, departmentId: department.id };
  }

  async function equipmentType(): Promise<string> {
    const type = await insert(EquipmentType, {
      name: nextCode('Blower type'),
      code: nextCode('blower'),
      category: EquipmentCategory.AERATION,
      specificationSchema: { fields: [] },
      isActive: true,
    });
    return type.id;
  }

  async function system(
    at: Place,
    opts: { tenantId?: string; parentSystemId?: string; isDeleted?: boolean } = {},
  ): Promise<string> {
    const row = await insert(System, {
      tenantId: opts.tenantId ?? TENANT,
      siteId: at.siteId,
      name: nextCode('System'),
      code: nextCode('SYS'),
      type: SystemType.RAS,
      parentSystemId: opts.parentSystemId,
      isActive: !opts.isDeleted,
      isDeleted: opts.isDeleted ?? false,
    });
    return row.id;
  }

  async function subSystem(systemId: string): Promise<string> {
    const row = await insert(SubSystem, {
      tenantId: TENANT,
      systemId,
      name: nextCode('Sub'),
      code: nextCode('SUB'),
      type: SubSystemType.AERATION,
      isActive: true,
      isDeleted: false,
    });
    return row.id;
  }

  async function equipment(at: Place, typeId: string, opts: EquipmentOpts = {}): Promise<string> {
    const row = await insert(Equipment, {
      tenantId: opts.tenantId ?? TENANT,
      departmentId: opts.departmentId === null ? undefined : (opts.departmentId ?? at.departmentId),
      subSystemId: opts.subSystemId,
      equipmentTypeId: typeId,
      name: nextCode('Unit'),
      code: nextCode('EQ'),
      status: opts.status ?? EquipmentStatus.OPERATIONAL,
      isTank: opts.isTank ?? false,
      isActive: opts.isActive ?? true,
      isDeleted: opts.isDeleted ?? false,
    });
    return row.id;
  }

  async function serve(
    equipmentId: string,
    systemId: string,
    criticalityLevel: number,
    opts: { role?: string; tenantId?: string } = {},
  ): Promise<void> {
    await insert(EquipmentSystem, {
      tenantId: opts.tenantId ?? TENANT,
      equipmentId,
      systemId,
      isPrimary: true,
      role: opts.role,
      criticalityLevel,
    });
  }

  async function liveFish(
    tankId: string,
    totalQuantity: number,
    opts: { tenantId?: string; cleanerFishQuantity?: number } = {},
  ): Promise<void> {
    await insert(TankBatch, {
      tenantId: opts.tenantId ?? TENANT,
      tankId,
      totalQuantity,
      avgWeightG: 100,
      totalBiomassKg: totalQuantity / 10,
      densityKgM3: 0,
      isMixedBatch: false,
      cleanerFishQuantity: opts.cleanerFishQuantity ?? 0,
      cleanerFishBiomassKg: 0,
      isOverCapacity: false,
    });
  }

  /** A `tanks`-table unit in `systemId` holding `quantity` fish. */
  async function stockedTank(
    at: Place,
    systemId: string,
    quantity: number,
    opts: { batchTenantId?: string; cleanerFishQuantity?: number } = {},
  ): Promise<string> {
    const tank = await insert(Tank, {
      tenantId: TENANT,
      name: nextCode('Tank'),
      code: nextCode('TNK'),
      departmentId: at.departmentId,
      systemId,
      tankType: TankType.CIRCULAR,
      material: TankMaterial.FIBERGLASS,
      waterType: WaterType.SALTWATER,
      diameter: 5,
      depth: 2,
      waterDepth: 2,
      maxBiomass: 1500,
      currentBiomass: quantity / 10,
      currentCount: quantity,
      maxDensity: 30,
      status: TankStatus.ACTIVE,
      isActive: true,
    });
    await liveFish(tank.id, quantity, {
      tenantId: opts.batchTenantId,
      cleanerFishQuantity: opts.cleanerFishQuantity,
    });
    return tank.id;
  }

  async function sparePart(
    fit: { equipmentTypeId?: string; compatibleEquipmentTypes?: string[] },
    tenantId: string = TENANT,
  ): Promise<string> {
    const row = await insert(SparePart, {
      tenantId,
      name: nextCode('Impeller'),
      code: nextCode('SP'),
      partNumber: nextCode('PN'),
      equipmentTypeId: fit.equipmentTypeId,
      compatibleEquipmentTypes: fit.compatibleEquipmentTypes,
      // Stock columns are left to their DB defaults: the query never reads
      // stock, and they are being moved to the storage ledger (FARM-HIGH-338).
      minStock: 2,
      maxStock: 10,
      reorderPoint: 3,
      unit: 'piece',
      currency: 'USD',
      isActive: true,
    });
    return row.id;
  }

  function criticality(sparePartId: string, siteId: string): Promise<SparePartCriticalityResult> {
    return handler.execute(new GetSparePartCriticalityQuery(TENANT, sparePartId, siteId));
  }

  function sorted(ids: string[]): string[] {
    return [...ids].sort();
  }

  // ── cases ───────────────────────────────────────────────────────────────

  it('returns null when no equipment of a compatible type exists', async () => {
    // SCENARIO: a stocked system served (crit 5) only by equipment of another type.
    // EXPECTS: null level and no evidence ids.
    const at = await place();
    const [partType, otherType] = [await equipmentType(), await equipmentType()];
    const sys = await system(at);
    await stockedTank(at, sys, 100);
    await serve(await equipment(at, otherType), sys, 5);
    const part = await sparePart({ equipmentTypeId: partType });

    await expect(criticality(part, at.siteId)).resolves.toEqual({
      sparePartId: part,
      siteId: at.siteId,
      maxCriticalityLevel: null,
      contributingEquipmentIds: [],
      contributingSystemIds: [],
    });
  });

  it('ignores compatible equipment placed at another site and resolves placement via sub-system', async () => {
    // SCENARIO: site Y has a qualifying unit (crit 4) and a sub-system-placed unit
    //   (crit 3, no department); a unit whose department sits at site X links into
    //   Y's system with crit 5. Site X itself has nothing.
    // EXPECTS: X → null; Y → max 4 from the two Y-placed units only.
    const siteX = await place();
    const siteY = await place();
    const type = await equipmentType();
    const sysY = await system(siteY);
    await stockedTank(siteY, sysY, 50);
    const onY = await equipment(siteY, type);
    await serve(onY, sysY, 4);
    const viaSubSystem = await equipment(siteY, type, {
      departmentId: null,
      subSystemId: await subSystem(sysY),
    });
    await serve(viaSubSystem, sysY, 3);
    await serve(await equipment(siteX, type), sysY, 5);
    const part = await sparePart({ equipmentTypeId: type });

    expect((await criticality(part, siteX.siteId)).maxCriticalityLevel).toBeNull();
    const onSiteY = await criticality(part, siteY.siteId);
    expect(onSiteY.maxCriticalityLevel).toBe(4);
    expect(onSiteY.contributingEquipmentIds).toEqual(sorted([onY, viaSubSystem]));
    expect(onSiteY.contributingSystemIds).toEqual([sysY]);
  });

  it('ignores systems without live fish and counts cleaner fish as live', async () => {
    // SCENARIO: crit-5 links to a system whose tank row holds 0 fish and to a
    //   system with no tanks; a crit-2 link to a system holding only cleaner fish.
    // EXPECTS: only the cleaner-fish system qualifies → level 2.
    const at = await place();
    const type = await equipmentType();
    const emptied = await system(at);
    await stockedTank(at, emptied, 0);
    const tankless = await system(at);
    const cleanerOnly = await system(at);
    await stockedTank(at, cleanerOnly, 0, { cleanerFishQuantity: 20 });
    await serve(await equipment(at, type), emptied, 5);
    await serve(await equipment(at, type), tankless, 5);
    const cleanerUnit = await equipment(at, type);
    await serve(cleanerUnit, cleanerOnly, 2);
    const part = await sparePart({ equipmentTypeId: type });

    const result = await criticality(part, at.siteId);

    expect(result.maxCriticalityLevel).toBe(2);
    expect(result.contributingEquipmentIds).toEqual([cleanerUnit]);
    expect(result.contributingSystemIds).toEqual([cleanerOnly]);
  });

  it('ignores a system whose link has an operational same-type backup — both links of the pair', async () => {
    // SCENARIO: primary (crit 5) + standby backup (role " Backup ", crit 5), same
    //   type, both serving one stocked system.
    // EXPECTS: null — the primary is covered by the backup and the backup by the
    //   operational primary; a redundant pair is not critical.
    const at = await place();
    const type = await equipmentType();
    const sys = await system(at);
    await stockedTank(at, sys, 80);
    await serve(await equipment(at, type), sys, 5, { role: 'primary' });
    await serve(await equipment(at, type, { status: EquipmentStatus.STANDBY }), sys, 5, {
      role: ' Backup ',
    });
    const part = await sparePart({ equipmentTypeId: type });

    expect((await criticality(part, at.siteId)).maxCriticalityLevel).toBeNull();
  });

  it('keeps a link critical when its backup cannot take over', async () => {
    // SCENARIO: site A — the backup is in REPAIR; site B — the "backup" is of
    //   another type. Primaries carry crit 3 (A) and 4 (B).
    // EXPECTS: A → 3 from the primary only (the repair unit is covered by the
    //   operational primary); B → 4 from the primary.
    const type = await equipmentType();
    const otherType = await equipmentType();
    const siteA = await place();
    const sysA = await system(siteA);
    await stockedTank(siteA, sysA, 40);
    const primaryA = await equipment(siteA, type);
    await serve(primaryA, sysA, 3);
    await serve(await equipment(siteA, type, { status: EquipmentStatus.REPAIR }), sysA, 3, {
      role: 'backup',
    });
    const siteB = await place();
    const sysB = await system(siteB);
    await stockedTank(siteB, sysB, 40);
    const primaryB = await equipment(siteB, type);
    await serve(primaryB, sysB, 4);
    await serve(await equipment(siteB, otherType), sysB, 4, { role: 'backup' });
    const part = await sparePart({ equipmentTypeId: type });

    const onA = await criticality(part, siteA.siteId);
    expect(onA.maxCriticalityLevel).toBe(3);
    expect(onA.contributingEquipmentIds).toEqual([primaryA]);
    const onB = await criticality(part, siteB.siteId);
    expect(onB.maxCriticalityLevel).toBe(4);
    expect(onB.contributingEquipmentIds).toEqual([primaryB]);
  });

  it('takes the max over two qualifying systems and reports both', async () => {
    // SCENARIO: unit 1 → stocked system 1 at crit 2; unit 2 → stocked system 2 at crit 4.
    // EXPECTS: max 4; both units and both systems reported.
    const at = await place();
    const type = await equipmentType();
    const sys1 = await system(at);
    const sys2 = await system(at);
    await stockedTank(at, sys1, 10);
    await stockedTank(at, sys2, 10);
    const unit1 = await equipment(at, type);
    const unit2 = await equipment(at, type);
    await serve(unit1, sys1, 2);
    await serve(unit2, sys2, 4);
    const part = await sparePart({ equipmentTypeId: type });

    await expect(criticality(part, at.siteId)).resolves.toEqual({
      sparePartId: part,
      siteId: at.siteId,
      maxCriticalityLevel: 4,
      contributingEquipmentIds: sorted([unit1, unit2]),
      contributingSystemIds: sorted([sys1, sys2]),
    });
  });

  it('uses compatibleEquipmentTypes only when equipmentTypeId is NULL', async () => {
    // SCENARIO: types T1/T2/T3 each serve their own stocked system at crit 3/5/4.
    //   Part A: equipmentTypeId NULL, compatible [T1, T2]. Part B: equipmentTypeId
    //   T3 and a stale compatible [T1, T2].
    // EXPECTS: A → 5 via T1+T2 units; B → 4 via the T3 unit only.
    const at = await place();
    const [t1, t2, t3] = [await equipmentType(), await equipmentType(), await equipmentType()];
    const unitServingOwnStockedSystem = async (type: string, level: number): Promise<string> => {
      const sys = await system(at);
      await stockedTank(at, sys, 25);
      const unit = await equipment(at, type);
      await serve(unit, sys, level);
      return unit;
    };
    const unitT1 = await unitServingOwnStockedSystem(t1, 3);
    const unitT2 = await unitServingOwnStockedSystem(t2, 5);
    const unitT3 = await unitServingOwnStockedSystem(t3, 4);
    const listOnly = await sparePart({ compatibleEquipmentTypes: [t1, t2] });
    const singleWins = await sparePart({ equipmentTypeId: t3, compatibleEquipmentTypes: [t1, t2] });

    const viaList = await criticality(listOnly, at.siteId);
    expect(viaList.maxCriticalityLevel).toBe(5);
    expect(viaList.contributingEquipmentIds).toEqual(sorted([unitT1, unitT2]));
    const viaSingle = await criticality(singleWins, at.siteId);
    expect(viaSingle.maxCriticalityLevel).toBe(4);
    expect(viaSingle.contributingEquipmentIds).toEqual([unitT3]);
  });

  it("ignores another tenant's rows even inside the same schema", async () => {
    // SCENARIO: tenant link crit 2 on a stocked system. Other-tenant rows: a
    //   same-site unit + link (crit 5) into that system, an operational
    //   other-tenant "backup" link into it, and the ONLY fish row of a second
    //   tenant system (served at crit 5) carrying the other tenantId.
    // EXPECTS: 2 from the tenant's own link; the other tenant's part is NotFound.
    const at = await place();
    const otherAt = await place(OTHER_TENANT, at.siteId);
    const type = await equipmentType();
    const sys = await system(at);
    await stockedTank(at, sys, 60);
    const own = await equipment(at, type);
    await serve(own, sys, 2);
    const foreign = await equipment(otherAt, type, { tenantId: OTHER_TENANT });
    await serve(foreign, sys, 5, { tenantId: OTHER_TENANT });
    const foreignBackup = await equipment(otherAt, type, { tenantId: OTHER_TENANT });
    await serve(foreignBackup, sys, 1, { tenantId: OTHER_TENANT, role: 'backup' });
    const leaked = await system(at);
    await stockedTank(at, leaked, 500, { batchTenantId: OTHER_TENANT });
    await serve(await equipment(at, type), leaked, 5);
    const part = await sparePart({ equipmentTypeId: type });
    const foreignPart = await sparePart({ equipmentTypeId: type }, OTHER_TENANT);

    await expect(criticality(part, at.siteId)).resolves.toEqual({
      sparePartId: part,
      siteId: at.siteId,
      maxCriticalityLevel: 2,
      contributingEquipmentIds: [own],
      contributingSystemIds: [sys],
    });
    await expect(criticality(foreignPart, at.siteId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('counts fish in child systems and in isTank equipment units', async () => {
    // SCENARIO: parent system (no own tanks) with a stocked child → crit 3 link;
    //   a system holding an isTank equipment unit linked via equipment_systems → crit 4;
    //   a system holding an isTank unit placed via its sub-system → crit 1;
    //   a parent whose only stocked child is soft-deleted → crit 5 link.
    // EXPECTS: max 4 from the first three; the deleted child contributes nothing.
    const at = await place();
    const type = await equipmentType();
    const tankType = await equipmentType();
    const parent = await system(at);
    await stockedTank(at, await system(at, { parentSystemId: parent }), 30);
    const viaChild = await equipment(at, type);
    await serve(viaChild, parent, 3);
    const linkedSys = await system(at);
    const linkedUnit = await equipment(at, tankType, { isTank: true });
    await serve(linkedUnit, linkedSys, 3);
    await liveFish(linkedUnit, 70);
    const viaLink = await equipment(at, type);
    await serve(viaLink, linkedSys, 4);
    const subSys = await system(at);
    const subUnit = await equipment(at, tankType, {
      isTank: true,
      subSystemId: await subSystem(subSys),
    });
    await liveFish(subUnit, 15);
    const viaSub = await equipment(at, type);
    await serve(viaSub, subSys, 1);
    const orphanParent = await system(at);
    await stockedTank(at, await system(at, { parentSystemId: orphanParent, isDeleted: true }), 90);
    await serve(await equipment(at, type), orphanParent, 5);
    const part = await sparePart({ equipmentTypeId: type });

    const result = await criticality(part, at.siteId);

    expect(result.maxCriticalityLevel).toBe(4);
    expect(result.contributingEquipmentIds).toEqual(sorted([viaChild, viaLink, viaSub]));
    expect(result.contributingSystemIds).toEqual(sorted([parent, linkedSys, subSys]));
  });

  it('ignores deleted, inactive and decommissioned units and soft-deleted systems', async () => {
    // SCENARIO: crit-5 links from a deleted, an inactive and a DECOMMISSIONED unit,
    //   and from a healthy unit into a soft-deleted stocked system; one unit in
    //   REPAIR links at crit 1.
    // EXPECTS: 1 — a unit under repair still needs the part.
    const at = await place();
    const type = await equipmentType();
    const sys = await system(at);
    await stockedTank(at, sys, 45);
    await serve(await equipment(at, type, { isDeleted: true, isActive: false }), sys, 5);
    await serve(await equipment(at, type, { isActive: false }), sys, 5);
    await serve(await equipment(at, type, { status: EquipmentStatus.DECOMMISSIONED }), sys, 5);
    const deletedSys = await system(at, { isDeleted: true });
    await stockedTank(at, deletedSys, 45);
    await serve(await equipment(at, type), deletedSys, 5);
    const inRepair = await equipment(at, type, { status: EquipmentStatus.REPAIR });
    await serve(inRepair, sys, 1);
    const part = await sparePart({ equipmentTypeId: type });

    const result = await criticality(part, at.siteId);

    expect(result.maxCriticalityLevel).toBe(1);
    expect(result.contributingEquipmentIds).toEqual([inRepair]);
  });
});
