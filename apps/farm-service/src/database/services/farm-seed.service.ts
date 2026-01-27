/**
 * Farm Seed Service
 *
 * Farm modulune sahip tenant'lar icin gerekli baslangic verilerini olusturur:
 * - Test tenant ve kullanici
 * - EquipmentTypes (Tank, Pump, Aerator, Filter)
 * - Sites, Departments, Systems, SubSystems
 * - Tanks (bagimsiz entity)
 * - Species (turler)
 * - Feeds (yemler)
 * - Feed Inventory (yem stoklari)
 * - Sample Batch (ornek parti)
 *
 * @module Database
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { randomUUID } from 'crypto';
import { EQUIPMENT_TYPES_SEED } from '../../equipment/seeds/equipment-types.seed';

/**
 * Interface for raw query row with id field
 */
interface IdRow {
  id: string;
}

@Injectable()
export class FarmSeedService implements OnModuleInit {
  private readonly logger = new Logger(FarmSeedService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    // Sadece gelistirme ortaminda otomatik calistir
    if (process.env.NODE_ENV === 'production') {
      this.logger.log('Skipping seed in production environment');
      return;
    }

    try {
      // Equipment types sistem geneli olduğu için önce ve bağımsız olarak çalıştır
      await this.seedEquipmentTypesStandalone();

      // Tenant'a bağlı diğer verileri seed et
      await this.seedFarmData();
    } catch (error) {
      this.logger.error('Error during farm seed:', error);
    }
  }

  /**
   * Equipment Types'ı bağımsız olarak seed eder (tenant'a bağlı değil)
   */
  private async seedEquipmentTypesStandalone() {
    this.logger.log('Seeding equipment types (system-wide)...');

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.seedEquipmentTypes(queryRunner);
      await queryRunner.commitTransaction();
      this.logger.log('Equipment types seeding completed successfully');
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Equipment types seeding failed:', error);
      // Equipment types hatası diğer seed'leri engellemesin
    } finally {
      await queryRunner.release();
    }
  }

  async seedFarmData() {
    this.logger.log('========================================');
    this.logger.log('Starting Farm Module Comprehensive Seed');
    this.logger.log('========================================');

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Test tenant olustur
      const tenantId = await this.ensureTestTenant(queryRunner);
      this.logger.log(`Using tenant: ${tenantId}`);

      // EquipmentTypes artık seedEquipmentTypesStandalone'da bağımsız çalışıyor

      // 2. Site olustur
      const siteId = await this.ensureSite(queryRunner, tenantId);

      // 4. Department olustur
      const departmentId = await this.ensureDepartment(queryRunner, tenantId, siteId);

      // 5. System ve SubSystem olustur
      const systemId = await this.ensureSystem(queryRunner, tenantId, siteId);
      const subSystemId = await this.ensureSubSystem(queryRunner, tenantId, systemId);

      // 6. Species olustur
      const speciesIds = await this.seedSpecies(queryRunner, tenantId);

      // 7. Tanks olustur (bagimsiz tank entity)
      const tankIds = await this.seedTanks(queryRunner, tenantId, departmentId);

      // 8. Feeds olustur
      const feedIds = await this.seedFeeds(queryRunner, tenantId);

      // 9. Feed Inventory olustur
      await this.seedFeedInventory(queryRunner, tenantId, siteId, departmentId, feedIds);

      // 10. Sample Batch olustur
      const seabassId = speciesIds.seabass || Object.values(speciesIds)[0] || '';
      await this.seedSampleBatch(queryRunner, tenantId, seabassId, tankIds);

      await queryRunner.commitTransaction();

      this.logger.log('========================================');
      this.logger.log('Farm Module Seed completed successfully!');
      this.logger.log('========================================');
      this.logger.log(`Tenant ID: ${tenantId}`);
      this.logger.log(`Site ID: ${siteId}`);
      this.logger.log(`Department ID: ${departmentId}`);
      this.logger.log(`Tanks: ${tankIds.length}`);
      this.logger.log(`Species: ${Object.keys(speciesIds).length}`);
      this.logger.log(`Feeds: ${feedIds.length}`);
      this.logger.log('========================================');
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Farm seed failed, rolling back:', error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Test tenant olusturur veya mevcut olani doner
   */
  private async ensureTestTenant(queryRunner: QueryRunner): Promise<string> {
    const testTenantCode = 'FARM_TEST';

    // Mevcut tenant'i kontrol et
    const existing = await queryRunner.query(
      `SELECT id FROM tenants WHERE code = $1`,
      [testTenantCode]
    );

    if (existing.length > 0) {
      this.logger.log('Test tenant already exists');
      return existing[0].id;
    }

    // Tenant olustur
    const tenantId = randomUUID();
    await queryRunner.query(
      `INSERT INTO tenants (id, name, code, slug, status, "isActive", settings, "createdAt", "updatedAt")
       VALUES ($1, 'Farm Test Tenant', $2, 'farm-test', 'active', true, $3, NOW(), NOW())`,
      [tenantId, testTenantCode, JSON.stringify({
        locale: 'tr-TR',
        timezone: 'Europe/Istanbul',
        currency: 'TRY',
        measurementSystem: 'metric',
      })]
    );
    this.logger.log(`Created test tenant: ${tenantId}`);

    // Farm module'u tenant'a ata (tenant_modules tablosu varsa)
    try {
      const farmModule = await queryRunner.query(
        `SELECT id FROM modules WHERE code = 'farm' OR code = 'FARM' LIMIT 1`
      );

      if (farmModule.length > 0) {
        await queryRunner.query(
          `INSERT INTO tenant_modules ("tenantId", "moduleId", "isActive", "createdAt")
           VALUES ($1, $2, true, NOW())
           ON CONFLICT DO NOTHING`,
          [tenantId, farmModule[0].id]
        );
        this.logger.log('Assigned farm module to tenant');
      }
    } catch (e) {
      this.logger.warn('Could not assign farm module (table may not exist)');
    }

    return tenantId;
  }

  /**
   * Equipment Types seed - EQUIPMENT_TYPES_SEED'den kapsamlı veriler kullanır
   * UPSERT mantığı: Mevcut kayıtları günceller, yeni kayıtları ekler
   */
  private async seedEquipmentTypes(queryRunner: QueryRunner) {
    this.logger.log('  Seeding equipment types with comprehensive specification schemas...');

    for (const et of EQUIPMENT_TYPES_SEED) {
      const exists = await queryRunner.query(
        `SELECT id FROM farm.equipment_types WHERE code = $1`,
        [et.code]
      );

      if (exists.length > 0) {
        // UPDATE: Mevcut kaydın specificationSchema'sını güncelle
        await queryRunner.query(
          `UPDATE farm.equipment_types
           SET name = $1,
               description = $2,
               category = $3,
               icon = $4,
               "specificationSchema" = $5,
               "sortOrder" = $6,
               "updatedAt" = NOW()
           WHERE code = $7`,
          [
            et.name,
            et.description,
            et.category,
            et.icon,
            JSON.stringify(et.specificationSchema),
            et.sortOrder,
            et.code
          ]
        );
        this.logger.log(`  Updated equipment type: ${et.name} (${et.code})`);
      } else {
        // INSERT: Yeni kayıt ekle
        await queryRunner.query(
          `INSERT INTO farm.equipment_types (id, name, code, description, category, icon, "specificationSchema", "allowedSubEquipmentTypes", "isActive", "isSystem", "sortOrder", "createdAt", "updatedAt")
           VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, true, true, $8, NOW(), NOW())`,
          [
            et.name,
            et.code,
            et.description,
            et.category,
            et.icon,
            JSON.stringify(et.specificationSchema),
            JSON.stringify(et.allowedSubEquipmentTypes || []),
            et.sortOrder
          ]
        );
        this.logger.log(`  Created equipment type: ${et.name} (${et.code})`);
      }
    }

    this.logger.log(`  Seeded ${EQUIPMENT_TYPES_SEED.length} equipment types`);
  }

  private async ensureSite(queryRunner: QueryRunner, tenantId: string): Promise<string> {
    const existing = await queryRunner.query(
      `SELECT id FROM sites WHERE "tenantId" = $1 LIMIT 1`,
      [tenantId]
    );

    if (existing.length > 0) {
      return existing[0].id;
    }

    const siteId = randomUUID();
    await queryRunner.query(
      `INSERT INTO sites (id, "tenantId", name, code, description, timezone, status, type, "isActive", "isDeleted", "createdAt", "updatedAt", version)
       VALUES ($1, $2, 'Bodrum Tesisi', 'BOD-01', 'Ana uretim tesisi - Bodrum', 'Europe/Istanbul', 'active', 'land_based', true, false, NOW(), NOW(), 1)`,
      [siteId, tenantId]
    );

    this.logger.log(`  Created site: Bodrum Tesisi`);
    return siteId;
  }

  private async ensureDepartment(queryRunner: QueryRunner, tenantId: string, siteId: string): Promise<string> {
    const existing = await queryRunner.query(
      `SELECT id FROM departments WHERE "tenantId" = $1 AND "siteId" = $2 LIMIT 1`,
      [tenantId, siteId]
    );

    if (existing.length > 0) {
      return existing[0].id;
    }

    const departmentId = randomUUID();
    await queryRunner.query(
      `INSERT INTO departments (id, "tenantId", "siteId", name, code, description, status, "isActive", "isDeleted", "createdAt", "updatedAt", version)
       VALUES ($1, $2, $3, 'Buyutme Departmani', 'GROW-01', 'Ana buyutme unitesi', 'active', true, false, NOW(), NOW(), 1)`,
      [departmentId, tenantId, siteId]
    );

    this.logger.log(`  Created department: Buyutme Departmani`);
    return departmentId;
  }

  private async ensureSystem(queryRunner: QueryRunner, tenantId: string, siteId: string): Promise<string> {
    const existing = await queryRunner.query(
      `SELECT id FROM systems WHERE "tenantId" = $1 AND "siteId" = $2 LIMIT 1`,
      [tenantId, siteId]
    );

    if (existing.length > 0) {
      return existing[0].id;
    }

    const systemId = randomUUID();
    await queryRunner.query(
      `INSERT INTO systems (id, "tenantId", "siteId", name, code, description, type, status, "isActive", "createdAt", "updatedAt", version, "subSystemCount", "equipmentCount")
       VALUES ($1, $2, $3, 'RAS Sistemi 1', 'RAS-001', 'Recirculating Aquaculture System', 'ras', 'active', true, NOW(), NOW(), 1, 0, 0)`,
      [systemId, tenantId, siteId]
    );

    this.logger.log(`  Created system: RAS Sistemi 1`);
    return systemId;
  }

  private async ensureSubSystem(queryRunner: QueryRunner, tenantId: string, systemId: string): Promise<string> {
    const existing = await queryRunner.query(
      `SELECT id FROM sub_systems WHERE "tenantId" = $1 AND "systemId" = $2 LIMIT 1`,
      [tenantId, systemId]
    );

    if (existing.length > 0) {
      return existing[0].id;
    }

    const subSystemId = randomUUID();
    await queryRunner.query(
      `INSERT INTO sub_systems (id, "tenantId", "systemId", name, code, description, type, status, "isActive", "createdAt", "updatedAt", version, "equipmentCount", "tankCount")
       VALUES ($1, $2, $3, 'Buyutme Unitesi A', 'UNIT-A', 'Buyutme unitesi A - 6 tank', 'grow_out', 'active', true, NOW(), NOW(), 1, 0, 6)`,
      [subSystemId, tenantId, systemId]
    );

    this.logger.log(`  Created sub-system: Buyutme Unitesi A`);
    return subSystemId;
  }

  /**
   * Species (tur) verilerini olusturur
   */
  private async seedSpecies(queryRunner: QueryRunner, tenantId: string): Promise<Record<string, string>> {
    const speciesIds: Record<string, string> = {};

    const speciesList = [
      {
        key: 'seabass',
        scientificName: 'Dicentrarchus labrax',
        commonName: 'European Seabass',
        localName: 'Levrek',
        code: 'SEABASS',
        category: 'fish',
        waterType: 'saltwater',
        family: 'Moronidae',
        genus: 'Dicentrarchus',
        optimalConditions: {
          temperature: { min: 14, max: 28, optimal: 22, unit: 'celsius', criticalMin: 8, criticalMax: 32 },
          ph: { min: 7.5, max: 8.5, optimal: 8.0 },
          dissolvedOxygen: { min: 5, optimal: 7, critical: 3, unit: 'mg/L' },
          salinity: { min: 15, max: 40, optimal: 35, unit: 'ppt' },
          ammonia: { max: 0.02, warning: 0.01 },
        },
        growthParameters: {
          maxDensity: 30,
          optimalDensity: 20,
          densityUnit: 'kg/m3',
          avgDailyGrowth: 1.5,
          avgHarvestWeight: 400,
          harvestWeightUnit: 'gram',
          avgTimeToHarvestDays: 365,
          targetFCR: 1.5,
          minFCR: 1.2,
          maxFCR: 1.8,
          expectedSurvivalRate: 90,
        },
        harvestDaysPerInputType: {
          fry: 365,
          fingerling: 300,
          juvenile: 240,
        },
      },
      {
        key: 'seabream',
        scientificName: 'Sparus aurata',
        commonName: 'Gilthead Seabream',
        localName: 'Cipura',
        code: 'SEABREAM',
        category: 'fish',
        waterType: 'saltwater',
        family: 'Sparidae',
        genus: 'Sparus',
        optimalConditions: {
          temperature: { min: 12, max: 28, optimal: 24, unit: 'celsius', criticalMin: 6, criticalMax: 30 },
          ph: { min: 7.5, max: 8.5, optimal: 8.0 },
          dissolvedOxygen: { min: 5, optimal: 7, critical: 3, unit: 'mg/L' },
          salinity: { min: 15, max: 45, optimal: 35, unit: 'ppt' },
        },
        growthParameters: {
          maxDensity: 25,
          optimalDensity: 18,
          densityUnit: 'kg/m3',
          avgDailyGrowth: 1.2,
          avgHarvestWeight: 350,
          harvestWeightUnit: 'gram',
          avgTimeToHarvestDays: 400,
          targetFCR: 1.6,
          expectedSurvivalRate: 88,
        },
      },
      {
        key: 'salmon',
        scientificName: 'Salmo salar',
        commonName: 'Atlantic Salmon',
        localName: 'Atlantik Somon',
        code: 'SALMON',
        category: 'fish',
        waterType: 'saltwater',
        family: 'Salmonidae',
        genus: 'Salmo',
        optimalConditions: {
          temperature: { min: 8, max: 16, optimal: 12, unit: 'celsius', criticalMin: 2, criticalMax: 22 },
          ph: { min: 6.5, max: 8.0, optimal: 7.2 },
          dissolvedOxygen: { min: 6, optimal: 9, critical: 4, unit: 'mg/L' },
          salinity: { min: 28, max: 35, optimal: 33, unit: 'ppt' },
        },
        growthParameters: {
          maxDensity: 25,
          optimalDensity: 20,
          densityUnit: 'kg/m3',
          avgDailyGrowth: 2.0,
          avgHarvestWeight: 4500,
          harvestWeightUnit: 'gram',
          avgTimeToHarvestDays: 730,
          targetFCR: 1.2,
          expectedSurvivalRate: 92,
        },
      },
      {
        key: 'trout',
        scientificName: 'Oncorhynchus mykiss',
        commonName: 'Rainbow Trout',
        localName: 'Gokkusagi Alabaligi',
        code: 'TROUT',
        category: 'fish',
        waterType: 'freshwater',
        family: 'Salmonidae',
        genus: 'Oncorhynchus',
        optimalConditions: {
          temperature: { min: 10, max: 18, optimal: 14, unit: 'celsius', criticalMin: 4, criticalMax: 24 },
          ph: { min: 6.5, max: 8.5, optimal: 7.5 },
          dissolvedOxygen: { min: 6, optimal: 9, critical: 4, unit: 'mg/L' },
        },
        growthParameters: {
          maxDensity: 35,
          optimalDensity: 25,
          densityUnit: 'kg/m3',
          avgDailyGrowth: 1.8,
          avgHarvestWeight: 350,
          harvestWeightUnit: 'gram',
          avgTimeToHarvestDays: 270,
          targetFCR: 1.1,
          expectedSurvivalRate: 95,
        },
      },
    ];

    for (const sp of speciesList) {
      const existing = await queryRunner.query(
        `SELECT id FROM species WHERE "tenantId" = $1 AND code = $2`,
        [tenantId, sp.code]
      );

      if (existing.length > 0) {
        speciesIds[sp.key] = existing[0].id;
        continue;
      }

      const speciesId = randomUUID();
      await queryRunner.query(
        `INSERT INTO species (
          id, "tenantId", "scientificName", "commonName", "localName", code,
          category, "waterType", family, genus,
          "optimalConditions", "growthParameters", "harvestDaysPerInputType",
          status, "isActive", "isDeleted", "createdAt", "updatedAt", version
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13,
          'active', true, false, NOW(), NOW(), 1
        )`,
        [
          speciesId, tenantId, sp.scientificName, sp.commonName, sp.localName, sp.code,
          sp.category, sp.waterType, sp.family, sp.genus,
          JSON.stringify(sp.optimalConditions),
          JSON.stringify(sp.growthParameters),
          sp.harvestDaysPerInputType ? JSON.stringify(sp.harvestDaysPerInputType) : null,
        ]
      );

      speciesIds[sp.key] = speciesId;
      this.logger.log(`  Created species: ${sp.commonName} (${sp.localName})`);
    }

    return speciesIds;
  }

  /**
   * Tank verilerini olusturur (bagimsiz tanks tablosu)
   */
  private async seedTanks(queryRunner: QueryRunner, tenantId: string, departmentId: string): Promise<string[]> {
    const tankIds: string[] = [];

    const existing = await queryRunner.query(
      `SELECT id FROM tanks WHERE "tenantId" = $1 LIMIT 1`,
      [tenantId]
    );

    if (existing.length > 0) {
      const allTanks = await queryRunner.query(
        `SELECT id FROM tanks WHERE "tenantId" = $1`,
        [tenantId]
      );
      return allTanks.map((t: IdRow) => t.id);
    }

    const tanks = [
      { name: 'Tank A1', code: 'TNK-A1', tankType: 'circular', diameter: 8, depth: 4, waterDepth: 3.5, maxDensity: 25, material: 'fiberglass', waterType: 'saltwater' },
      { name: 'Tank A2', code: 'TNK-A2', tankType: 'circular', diameter: 8, depth: 4, waterDepth: 3.5, maxDensity: 25, material: 'fiberglass', waterType: 'saltwater' },
      { name: 'Tank A3', code: 'TNK-A3', tankType: 'circular', diameter: 8, depth: 4, waterDepth: 3.5, maxDensity: 25, material: 'fiberglass', waterType: 'saltwater' },
      { name: 'Tank B1', code: 'TNK-B1', tankType: 'rectangular', length: 12, width: 6, depth: 4, waterDepth: 3.5, maxDensity: 30, material: 'concrete', waterType: 'saltwater' },
      { name: 'Tank B2', code: 'TNK-B2', tankType: 'rectangular', length: 12, width: 6, depth: 4, waterDepth: 3.5, maxDensity: 30, material: 'concrete', waterType: 'saltwater' },
      { name: 'Raceway 1', code: 'RCW-01', tankType: 'raceway', length: 30, width: 3, depth: 1.2, waterDepth: 1.0, maxDensity: 35, material: 'concrete', waterType: 'saltwater' },
    ];

    for (const tank of tanks) {
      const tankId = randomUUID();

      // Hacim hesapla
      let volume: number;
      if (tank.tankType === 'circular') {
        volume = Math.PI * Math.pow((tank.diameter || 0) / 2, 2) * tank.depth;
      } else {
        volume = (tank.length || 0) * (tank.width || 0) * tank.depth;
      }

      const waterVolume = tank.tankType === 'circular'
        ? Math.PI * Math.pow((tank.diameter || 0) / 2, 2) * tank.waterDepth
        : (tank.length || 0) * (tank.width || 0) * tank.waterDepth;

      const maxBiomass = waterVolume * tank.maxDensity;

      await queryRunner.query(
        `INSERT INTO tanks (
          id, "tenantId", "departmentId", name, code, description,
          "tankType", material, "waterType",
          diameter, length, width, depth, "waterDepth",
          volume, "waterVolume", "maxBiomass", "currentBiomass", "maxDensity",
          status, "isActive", "createdAt", "updatedAt", version
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9,
          $10, $11, $12, $13, $14,
          $15, $16, $17, 0, $18,
          'preparing', true, NOW(), NOW(), 1
        )`,
        [
          tankId, tenantId, departmentId, tank.name, tank.code, `${tank.tankType} buyutme tanki`,
          tank.tankType, tank.material, tank.waterType,
          tank.diameter || null, tank.length || null, tank.width || null, tank.depth, tank.waterDepth,
          Math.round(volume * 100) / 100, Math.round(waterVolume * 100) / 100, Math.round(maxBiomass * 100) / 100, tank.maxDensity,
        ]
      );

      tankIds.push(tankId);
      this.logger.log(`  Created tank: ${tank.name} (${Math.round(volume)}m³)`);
    }

    return tankIds;
  }

  /**
   * Feed (yem) verilerini olusturur
   */
  private async seedFeeds(queryRunner: QueryRunner, tenantId: string): Promise<string[]> {
    const feedIds: string[] = [];

    const existing = await queryRunner.query(
      `SELECT id FROM feeds WHERE "tenantId" = $1 LIMIT 1`,
      [tenantId]
    );

    if (existing.length > 0) {
      const allFeeds = await queryRunner.query(
        `SELECT id FROM feeds WHERE "tenantId" = $1`,
        [tenantId]
      );
      return allFeeds.map((f: IdRow) => f.id);
    }

    const feeds = [
      {
        name: 'Starter Plus 0.5mm',
        code: 'STR-05',
        type: 'starter',
        brand: 'BioMar',
        pelletSize: 0.5,
        floatingType: 'slow_sinking',
        targetSpecies: 'Seabass, Seabream',
        nutritionalContent: {
          crudeProtein: 54,
          crudeFat: 18,
          crudeAsh: 10,
          moisture: 8,
          energy: 19.5,
          energyUnit: 'MJ',
          phosphorus: 1.2,
        },
        pricePerKg: 45.00,
      },
      {
        name: 'Grower Pro 3mm',
        code: 'GRW-03',
        type: 'grower',
        brand: 'BioMar',
        pelletSize: 3.0,
        floatingType: 'floating',
        targetSpecies: 'Seabass, Seabream',
        nutritionalContent: {
          crudeProtein: 48,
          crudeFat: 20,
          crudeAsh: 9,
          moisture: 8,
          energy: 21.0,
          energyUnit: 'MJ',
          phosphorus: 1.0,
        },
        pricePerKg: 35.00,
      },
      {
        name: 'Grower Pro 5mm',
        code: 'GRW-05',
        type: 'grower',
        brand: 'BioMar',
        pelletSize: 5.0,
        floatingType: 'floating',
        targetSpecies: 'Seabass, Seabream',
        nutritionalContent: {
          crudeProtein: 46,
          crudeFat: 22,
          crudeAsh: 8,
          moisture: 8,
          energy: 22.0,
          energyUnit: 'MJ',
          phosphorus: 0.9,
        },
        pricePerKg: 32.00,
      },
      {
        name: 'Finisher Supreme 7mm',
        code: 'FIN-07',
        type: 'finisher',
        brand: 'Skretting',
        pelletSize: 7.0,
        floatingType: 'floating',
        targetSpecies: 'Seabass, Seabream',
        nutritionalContent: {
          crudeProtein: 44,
          crudeFat: 24,
          crudeAsh: 7,
          moisture: 7,
          energy: 23.5,
          energyUnit: 'MJ',
        },
        pricePerKg: 28.00,
      },
    ];

    for (const feed of feeds) {
      const feedId = randomUUID();

      await queryRunner.query(
        `INSERT INTO feeds (
          id, "tenantId", name, code, description, brand,
          type, "targetSpecies", "pelletSize", "floatingType",
          "nutritionalContent", status, "pricePerKg", currency, unit,
          quantity, "minStock", "isActive", "createdAt", "updatedAt", version
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, 'available', $12, 'TRY', 'kg',
          0, 100, true, NOW(), NOW(), 1
        )`,
        [
          feedId, tenantId, feed.name, feed.code, `${feed.brand} ${feed.type} yemi`, feed.brand,
          feed.type, feed.targetSpecies, feed.pelletSize, feed.floatingType,
          JSON.stringify(feed.nutritionalContent), feed.pricePerKg,
        ]
      );

      feedIds.push(feedId);
      this.logger.log(`  Created feed: ${feed.name}`);
    }

    return feedIds;
  }

  /**
   * Feed inventory (yem stoku) olusturur
   */
  private async seedFeedInventory(
    queryRunner: QueryRunner,
    tenantId: string,
    siteId: string,
    departmentId: string,
    feedIds: string[]
  ): Promise<void> {
    const existing = await queryRunner.query(
      `SELECT id FROM feed_inventory WHERE "tenantId" = $1 LIMIT 1`,
      [tenantId]
    );

    if (existing.length > 0) {
      return;
    }

    // Her yem icin stok olustur
    const inventoryData = [
      { feedIndex: 0, quantity: 500, lotNumber: 'LOT-2024-001', expiryMonths: 6 },
      { feedIndex: 1, quantity: 2000, lotNumber: 'LOT-2024-002', expiryMonths: 8 },
      { feedIndex: 2, quantity: 3000, lotNumber: 'LOT-2024-003', expiryMonths: 8 },
      { feedIndex: 3, quantity: 1500, lotNumber: 'LOT-2024-004', expiryMonths: 10 },
    ];

    for (const inv of inventoryData) {
      if (inv.feedIndex >= feedIds.length) continue;

      const feedId = feedIds[inv.feedIndex];
      const expiryDate = new Date();
      expiryDate.setMonth(expiryDate.getMonth() + inv.expiryMonths);

      await queryRunner.query(
        `INSERT INTO feed_inventory (
          id, "tenantId", "feedId", "siteId", "departmentId",
          "quantityKg", "minStockKg", status, "lotNumber",
          "manufacturingDate", "expiryDate", "receivedDate",
          "storageLocation", "createdAt", "updatedAt"
        ) VALUES (
          uuid_generate_v4(), $1, $2, $3, $4,
          $5, 100, 'available', $6,
          NOW() - INTERVAL '30 days', $7, NOW() - INTERVAL '7 days',
          'Depo A - Raf 1', NOW(), NOW()
        )`,
        [
          tenantId, feedId, siteId, departmentId,
          inv.quantity, inv.lotNumber, expiryDate.toISOString(),
        ]
      );
    }

    this.logger.log(`  Created ${inventoryData.length} feed inventory records`);
  }

  /**
   * Sample batch olusturur
   */
  private async seedSampleBatch(
    queryRunner: QueryRunner,
    tenantId: string,
    speciesId: string,
    tankIds: string[]
  ): Promise<void> {
    const existing = await queryRunner.query(
      `SELECT id FROM batches_v2 WHERE "tenantId" = $1 LIMIT 1`,
      [tenantId]
    );

    if (existing.length > 0) {
      return;
    }

    const batchId = randomUUID();
    const stockedAt = new Date();
    stockedAt.setDate(stockedAt.getDate() - 90); // 90 gun once stoklandi

    const expectedHarvestDate = new Date(stockedAt);
    expectedHarvestDate.setDate(expectedHarvestDate.getDate() + 365);

    const initialQuantity = 50000;
    const currentQuantity = 48500; // %3 mortality
    const initialAvgWeight = 5; // g
    const currentAvgWeight = 85; // 90 gunde buyudu
    const totalFeedConsumed = 3800; // kg

    const weight = {
      initial: {
        avgWeight: initialAvgWeight,
        totalBiomass: (initialQuantity * initialAvgWeight) / 1000,
        measuredAt: stockedAt.toISOString(),
      },
      theoretical: {
        avgWeight: currentAvgWeight,
        totalBiomass: (currentQuantity * currentAvgWeight) / 1000,
        lastCalculatedAt: new Date().toISOString(),
        basedOnFCR: 1.5,
      },
      actual: {
        avgWeight: currentAvgWeight,
        totalBiomass: (currentQuantity * currentAvgWeight) / 1000,
        lastMeasuredAt: new Date().toISOString(),
        sampleSize: 50,
        confidencePercent: 95,
      },
      variance: {
        weightDifference: 0,
        percentageDifference: 0,
        isSignificant: false,
      },
    };

    const fcr = {
      target: 1.5,
      actual: totalFeedConsumed / ((weight.actual.totalBiomass - weight.initial.totalBiomass)),
      theoretical: 1.5,
      isUserOverride: false,
      lastUpdatedAt: new Date().toISOString(),
    };

    const feedingSummary = {
      currentFeedName: 'Grower Pro 3mm',
      totalFeedGiven: totalFeedConsumed,
      totalFeedCost: totalFeedConsumed * 35,
      lastFeedingAt: new Date().toISOString(),
      avgDailyFeed: totalFeedConsumed / 90,
    };

    const growthMetrics = {
      currentGrowthStage: 'grower',
      growthRate: {
        actual: (currentAvgWeight - initialAvgWeight) / 90,
        target: 1.5,
        variancePercent: (((currentAvgWeight - initialAvgWeight) / 90) - 1.5) / 1.5 * 100,
      },
      daysInProduction: 90,
      projections: {
        harvestDate: expectedHarvestDate.toISOString(),
        harvestWeight: 400,
        harvestBiomass: (currentQuantity * 400) / 1000,
        confidenceLevel: 'medium',
      },
    };

    const mortalitySummary = {
      totalMortality: initialQuantity - currentQuantity,
      mortalityRate: ((initialQuantity - currentQuantity) / initialQuantity) * 100,
      lastMortalityAt: new Date().toISOString(),
    };

    await queryRunner.query(
      `INSERT INTO batches_v2 (
        id, "tenantId", "batchNumber", name, description,
        "speciesId", "inputType", "initialQuantity", "currentQuantity",
        "totalMortality", "cullCount", "totalFeedConsumed", "totalFeedCost",
        weight, fcr, "feedingSummary", "growthMetrics", "mortalitySummary",
        "stockedAt", "expectedHarvestDate", status, "statusChangedAt",
        "isActive", "createdAt", "updatedAt", version
      ) VALUES (
        $1, $2, 'B-2024-00001', 'Levrek Partisi 1', 'Test levrek partisi - 50000 adet',
        $3, 'fry', $4, $5,
        $6, 0, $7, $8,
        $9, $10, $11, $12, $13,
        $14, $15, 'growing', NOW(),
        true, NOW(), NOW(), 1
      )`,
      [
        batchId, tenantId, speciesId, initialQuantity, currentQuantity,
        initialQuantity - currentQuantity, totalFeedConsumed, totalFeedConsumed * 35,
        JSON.stringify(weight), JSON.stringify(fcr), JSON.stringify(feedingSummary),
        JSON.stringify(growthMetrics), JSON.stringify(mortalitySummary),
        stockedAt.toISOString(), expectedHarvestDate.toISOString(),
      ]
    );

    this.logger.log(`  Created sample batch: B-2024-00001`);

    // Tank'a batch allocation yap (ilk tank'a)
    if (tankIds.length > 0) {
      const tankBatchId = randomUUID();
      const biomass = weight.actual.totalBiomass;

      await queryRunner.query(
        `INSERT INTO tank_batches (
          id, "tenantId", "tankId", "batchId",
          "quantity", "biomassKg", "avgWeightG", "densityKgM3",
          "allocatedAt", status, "isActive",
          "createdAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          NOW(), 'active', true,
          NOW(), NOW()
        )`,
        [
          tankBatchId, tenantId, tankIds[0], batchId,
          currentQuantity, biomass, currentAvgWeight,
          biomass / 175.9, // circular tank volume
        ]
      );

      // Tank'in currentBiomass'ini guncelle
      await queryRunner.query(
        `UPDATE tanks SET "currentBiomass" = $1, "currentCount" = $2, status = 'active' WHERE id = $3`,
        [biomass, currentQuantity, tankIds[0]]
      );

      this.logger.log(`  Allocated batch to Tank A1`);
    }
  }
}
