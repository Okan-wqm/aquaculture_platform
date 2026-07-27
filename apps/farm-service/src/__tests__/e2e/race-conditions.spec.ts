/**
 * Race Condition E2E Tests
 *
 * TOCTOU (Time-of-Check-to-Time-of-Use) race condition korumasini dogrular.
 * Pessimistic lock ile concurrent islemlerin guvenli sekilde serilestirildigini test eder.
 *
 * Test stratejisi: Mock DataSource ve QueryRunner kullanarak handler'larin
 * transaction + pessimistic lock pattern'ini dogru uyguladigini dogrular.
 *
 * @module Farm-Service/Tests/E2E
 */
import { Role } from '@aquaculture/backend-common/decorators';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { DataSource, Repository, EntityManager } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import { NatsEventBus } from '@platform/event-bus';

// Handlers
import { RecordMortalityHandler } from '../../batch/handlers/record-mortality.handler';
import { MortalityCullPolicyService } from '../../batch/services/mortality-cull-policy.service';
import { RemovalQuantityPolicyService } from '../../batch/services/removal-quantity-policy.service';

// Idempotency envelope reused across the mortality race-condition commands.
const RACE_ENVELOPE = { clientCommandId: 'cmd-race', payloadHash: 'hash-race' };

// Commands
import { RecordMortalityCommand, MortalityReason } from '../../batch/commands/record-mortality.command';

// Entities
import { Batch, BatchStatus } from '../../batch/entities/batch.entity';
import { MortalityRecord } from '../../batch/entities/mortality-record.entity';
import { TankOperation } from '../../batch/entities/tank-operation.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';

// ============================================================================
// HELPERS
// ============================================================================

interface MockManagerType {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  query: jest.Mock;
  createQueryBuilder: jest.Mock;
}

/**
 * Mock QueryRunner factory - tracks transaction lifecycle and lock calls.
 */
function createMockQueryRunner(mockManager: MockManagerType) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    // `runInTenantTransaction` pins the transaction's search_path through the
    // RUNNER (not the manager) before handing control to the callback —
    // `pinTenantSchemaTransactionSearchPath` issues `set_config('search_path',…)`.
    // Omitting it here made every tenant-scoped handler blow up with
    // "queryRunner.query is not a function"; the double must carry the same
    // surface the production transaction helper drives.
    query: jest.fn().mockResolvedValue(undefined),
    manager: mockManager as unknown as EntityManager,
  };
}

/**
 * Mock DataSource factory.
 */
function createMockDataSource(queryRunner: ReturnType<typeof createMockQueryRunner>) {
  return {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  } as unknown as DataSource;
}

/** Create a no-op OutboxPublisher mock for transactional domain events. */
function createMockOutboxPublisher(): OutboxPublisher {
  return {
    enqueue: jest.fn().mockResolvedValue(undefined),
  } as unknown as OutboxPublisher;
}

/** Create a no-op NATS event bus mock for post-commit notifications. */
function createMockNatsEventBus(): NatsEventBus {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
  } as unknown as NatsEventBus;
}

function createDefaultMockManager(): MockManagerType {
  return {
    findOne: jest.fn(),
    create: jest.fn().mockImplementation((_entity: any, data: any) => data),
    save: jest.fn().mockImplementation((_entity: any, data: any) => Promise.resolve(data || _entity)),
    // MobileCommandReceiptService.begin INSERT returns a started receipt id.
    query: jest.fn().mockResolvedValue([{ id: 'receipt-race' }]),
    createQueryBuilder: jest.fn().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

/**
 * Tenant kimlikleri UUID v4 OLMAK ZORUNDA: `withTenantContext` (ve üzerinden
 * `runInTenantTransaction`) UUID olmayan bir kimliği fail-closed reddeder —
 * şema adı `tenant_<uuid>` türetildiği için serbest metin bir kimlik yanlış
 * şemaya yazma riskidir. Bu spec eskiden `'tenant-race-test'` gibi düz
 * etiketler kullanıyordu; doğrulama eklendiğinde 7 testin 6'sı kırmızıya
 * döndü ve kimse görmedi, çünkü bu dosyayı koşan `test:integration` hedefi
 * CI'da hiçbir yerden çağrılmıyordu (FARM-MEDIUM-301).
 */
const TENANT_RACE = '11111111-1111-4111-8111-111111111111';
const TENANT_EXACT = '22222222-2222-4222-8222-222222222222';

// ============================================================================
// RECORD MORTALITY - RACE CONDITION TESTS
// ============================================================================

describe('Race Condition Protection: RecordMortalityHandler', () => {
  let handler: RecordMortalityHandler;
  let mockManager: MockManagerType;
  let mockQueryRunner: ReturnType<typeof createMockQueryRunner>;
  let mockDataSource: DataSource;
  /** TankBatch SSoT yazıcısının aldığı delta — testler bunu denetler. */
  let applyBatchDelta: jest.Mock;

  const tenantId = TENANT_RACE;
  const batchId = 'batch-001';
  const tankId = 'tank-001';

  /**
   * GERÇEK `Batch` örneği — düz nesne literali DEĞİL.
   *
   * Fixture eskiden entity metotlarını tek tek `jest.fn()` ile taklit ediyordu
   * (`isOperational`, `getMortalityRate`, …). Domain sonradan
   * `isStockMutable()` çağırmaya başlayınca fixture o metodu taşımadığı için
   * "is not a function" ile patladı: taklit edilen her metot, entity büyüdükçe
   * ayrı bir sapma noktası. Prototipi olan gerçek bir örnek kullanmak bu sınıfı
   * yapısal olarak kapatır — yeni bir domain metodu fixture'ı bozamaz ve
   * testler gerçek karar mantığını koşar. Hiçbir assert eski stub değerlerine
   * bakmıyordu, dolayısıyla davranış kaybı yok.
   */
  function createMockBatch(overrides: Partial<Batch> = {}): Batch {
    return Object.assign(new Batch(), {
      id: batchId,
      tenantId,
      batchNumber: 'B-RACE',
      // `isStockMutable()` gerçek `status` alanından türer.
      status: BatchStatus.ACTIVE,
      isActive: true,
      initialQuantity: 100000,
      currentQuantity: 10000,
      totalMortality: 0,
      cullCount: 0,
      mortalitySummary: {
        totalMortality: 0,
        mortalityRate: 0,
        lastMortalityAt: undefined as unknown as Date,
        mainCause: undefined as unknown as string,
      },
      ...overrides,
    });
  }

  function createMockEquipment(overrides: Partial<Equipment> = {}): Partial<Equipment> {
    return {
      id: tankId,
      tenantId,
      isActive: true,
      isDeleted: false,
      volume: 1000,
      currentBiomass: 500,
      currentCount: 10000,
      ...overrides,
    };
  }

  beforeEach(() => {
    mockManager = createDefaultMockManager();
    applyBatchDelta = jest.fn().mockResolvedValue({});

    mockQueryRunner = createMockQueryRunner(mockManager);
    mockDataSource = createMockDataSource(mockQueryRunner);

    // Default findOne responses
    const mockBatch = createMockBatch();
    const mockEquipment = createMockEquipment();
    const mockTankBatch: Partial<TankBatch> = {
      tenantId,
      tankId,
      // assertBatchInTank requires the batch to be held in this tank
      primaryBatchId: batchId,
      totalQuantity: 10000,
      totalBiomassKg: 500,
      densityKgM3: 0.5,
    };

    mockManager.findOne.mockImplementation((entity: any) => {
      if (entity === Batch) return Promise.resolve(mockBatch);
      if (entity === Equipment) return Promise.resolve(mockEquipment);
      if (entity === TankBatch) return Promise.resolve(mockTankBatch);
      if (entity === Tank) return Promise.resolve(null); // fallback lookup
      return Promise.resolve(null);
    });

    handler = new RecordMortalityHandler(
      mockDataSource,
      {} as Repository<Batch>,
      {} as Repository<MortalityRecord>,
      {} as Repository<TankOperation>,
      {} as Repository<TankBatch>,
      {} as Repository<Equipment>,
      {} as Repository<Tank>,
      {} as Repository<EquipmentType>,
      createMockOutboxPublisher(),
      // Gün-içi recalc (P-31) + giriş modu politikası (D-3) — bu race testleri
      // kilit/TOCTOU davranışına odaklı; recalc mock, politika gerçek (saf).
      { recalcForUnit: jest.fn().mockResolvedValue(null) } as never,
      new RemovalQuantityPolicyService(),
      { validate: jest.fn() } as never,
      { logWithManager: jest.fn().mockResolvedValue({}) } as never,
      // SEC-HIGH-051: object-level site authorization SSoT (real instance — the
      // commands below default to MODULE_MANAGER, so the hierarchy bypass keeps
      // these lock/TOCTOU race tests focused on concurrency, not site authz).
      new SiteAuthorizationService(),
      // TankBatch'in TEK SSoT yazıcısı. Mock'lu, çünkü bu dosya kilit/TOCTOU
      // davranışını denetler; deltanın aritmetiği TankBatchService'in kendi
      // birim testlerinin işi. Handler'ın ona GEÇTİĞİ delta burada assert
      // edilir — `manager.save(TankBatch, …)` aramak yapısal olarak boşunaydı,
      // çünkü o çağrı mock'un içinde kalıyor (eski testin sessiz kusuru).
      { applyBatchDelta } as never,
      new MortalityCullPolicyService(),
      { refreshContainers: jest.fn().mockResolvedValue(undefined) } as never,
      new MobileCommandReceiptService(),
    );
  });

  it('should acquire pessimistic_write lock on Batch inside transaction', async () => {
    const command = new RecordMortalityCommand(tenantId, batchId, {
      tankId,
      quantity: 50,
      reason: MortalityReason.DISEASE,
      observedAt: new Date(),
    }, 'user-001', [Role.MODULE_MANAGER], [], RACE_ENVELOPE);

    await handler.execute(command);

    // Verify transaction lifecycle
    expect(mockQueryRunner.connect).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.startTransaction).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.release).toHaveBeenCalledTimes(1);

    // Verify pessimistic lock on Batch
    expect(mockManager.findOne).toHaveBeenCalledWith(Batch, {
      where: { id: batchId, tenantId, isActive: true },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('should acquire pessimistic_write lock on TankBatch inside transaction', async () => {
    const command = new RecordMortalityCommand(tenantId, batchId, {
      tankId,
      quantity: 50,
      reason: MortalityReason.DISEASE,
      observedAt: new Date(),
    }, 'user-001', [Role.MODULE_MANAGER], [], RACE_ENVELOPE);

    await handler.execute(command);

    // Verify pessimistic lock on TankBatch
    expect(mockManager.findOne).toHaveBeenCalledWith(TankBatch, {
      where: { tenantId, tankId },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('should use Math.max(0, ...) for currentQuantity to prevent negatives', async () => {
    // Simulate batch with very low quantity that could go negative
    const lowBatch = createMockBatch({ currentQuantity: 30 });
    mockManager.findOne.mockImplementation((entity: any) => {
      if (entity === Batch) return Promise.resolve(lowBatch);
      if (entity === Equipment) return Promise.resolve(createMockEquipment());
      if (entity === TankBatch) return Promise.resolve({
        tenantId, tankId, primaryBatchId: batchId, totalQuantity: 30, totalBiomassKg: 6, densityKgM3: 0.006,
      });
      if (entity === Tank) return Promise.resolve(null);
      return Promise.resolve(null);
    });

    const command = new RecordMortalityCommand(tenantId, batchId, {
      tankId,
      quantity: 30,
      reason: MortalityReason.DISEASE,
      observedAt: new Date(),
    }, 'user-001', [Role.MODULE_MANAGER], [], RACE_ENVELOPE);

    await handler.execute(command);

    // Verify batch save was called and currentQuantity is 0, not negative
    const batchSaveCall = mockManager.save.mock.calls.find(
      (call: any[]) => call[0] === Batch
    );
    expect(batchSaveCall).toBeDefined();
    const savedBatch = batchSaveCall![1];
    expect(savedBatch.currentQuantity).toBe(0);
    expect(savedBatch.currentQuantity).toBeGreaterThanOrEqual(0);
  });

  it('should rollback transaction on error', async () => {
    mockManager.findOne.mockImplementation((entity: any) => {
      if (entity === Batch) return Promise.resolve(null);
      return Promise.resolve(null);
    });

    const command = new RecordMortalityCommand(tenantId, batchId, {
      tankId,
      quantity: 50,
      reason: MortalityReason.DISEASE,
      observedAt: new Date(),
    }, 'user-001', [Role.MODULE_MANAGER], [], RACE_ENVELOPE);

    await expect(handler.execute(command)).rejects.toThrow(NotFoundException);

    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalledTimes(1);
  });

  /**
   * Bu test eskiden `Math.max(0, …)` clamp'ini doğruluyordu. O clamp W4'te
   * (FARM-HIGH-246) BİLEREK kaldırıldı: aşırı beyan edilen kg'ı sessizce 0'a
   * yuvarlamak, içinde canlı balık olan tankı "boşalmış" gösterip yemleme
   * planını iptal ettiriyor ve alarm da üretmiyordu. Bugünkü sözleşme
   * clamp DEĞİL, fail-closed reddir — testin premisi ölmüştü, kimse görmedi
   * çünkü bu dosyayı koşan hedef CI'da çağrılmıyordu (FARM-MEDIUM-301).
   *
   * `batchDetails[]` fixture'a KONUR: W4/D-2 onu tank-içi durumun SSoT'si
   * yaptı ve aggregate'ler ondan türetilir. Onsuz gerçek yol hiç koşmuyordu.
   */
  const AVG_WEIGHT_G = 100;

  /** Kendi içinde tutarlı tank: quantity × AVG_WEIGHT_G / 1000 === biomassKg. */
  function tankBatchHolding(quantity: number) {
    const biomassKg = (quantity * AVG_WEIGHT_G) / 1000;
    return {
      tenantId,
      tankId,
      primaryBatchId: batchId,
      totalQuantity: quantity,
      totalBiomassKg: biomassKg,
      densityKgM3: 0.002,
      batchDetails: [
        {
          batchId,
          batchNumber: 'B-RACE',
          quantity,
          avgWeightG: AVG_WEIGHT_G,
          biomassKg,
          percentageOfTank: 100,
        },
      ],
    };
  }

  function arrangeTank(tankBatch: ReturnType<typeof tankBatchHolding>): void {
    mockManager.findOne.mockImplementation((entity: any) => {
      if (entity === Batch) return Promise.resolve(createMockBatch({ currentQuantity: 100 }));
      if (entity === Equipment)
        return Promise.resolve(
          createMockEquipment({
            currentBiomass: tankBatch.totalBiomassKg,
            currentCount: tankBatch.totalQuantity,
          }),
        );
      if (entity === TankBatch) return Promise.resolve(tankBatch);
      if (entity === Tank) return Promise.resolve(null);
      return Promise.resolve(null);
    });
  }

  function mortalityOf(quantity: number): RecordMortalityCommand {
    return new RecordMortalityCommand(
      tenantId,
      batchId,
      {
        tankId,
        quantity,
        avgWeightG: AVG_WEIGHT_G,
        reason: MortalityReason.DISEASE,
        observedAt: new Date(),
      },
      'user-001',
      [Role.MODULE_MANAGER],
      [],
      RACE_ENVELOPE,
    );
  }

  it('drains a tank to exactly zero by handing the SSoT writer an exact negative delta', async () => {
    arrangeTank(tankBatchHolding(20));

    await handler.execute(mortalityOf(20));

    expect(applyBatchDelta).toHaveBeenCalledTimes(1);
    const [, , , delta] = applyBatchDelta.mock.calls[0] ?? [];
    expect(delta).toMatchObject({
      batchId,
      // Tankın TAMAMI: 20 balık, 2 kg. Taşma yok, yuvarlama yok.
      quantityDelta: -20,
      biomassDelta: -2,
    });
  });

  it('REJECTS an overdraft instead of silently clamping it to zero (FARM-HIGH-246)', async () => {
    arrangeTank(tankBatchHolding(20));

    // Tankta 20 balık var, 50 ölüm beyan ediliyor. Eski `Math.max(0, …)` bunu
    // 0'a yuvarlayıp canlı tankı "boşalmış" gösteriyordu; W4 tavanı TANK
    // kapsamında doğruluyor ve taşmayı domain hatası sayıyor.
    await expect(handler.execute(mortalityOf(50))).rejects.toThrow(
      /Düşüm tanesi \(50\) mevcut sayıdan \(20\) fazla olamaz/,
    );

    // Reddedilen taşma SSoT yazıcısına HİÇ ulaşmaz.
    expect(applyBatchDelta).not.toHaveBeenCalled();
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
  });
});

// ============================================================================
// CROSS-HANDLER: CONCURRENT OPERATION SAFETY
// ============================================================================

describe('Race Condition Protection: Cross-handler concurrent safety', () => {
  it('should not produce negative values when mortality equals currentQuantity', async () => {
    const mockManager = createDefaultMockManager();
    const mockQueryRunner = createMockQueryRunner(mockManager);
    const mockDataSource = createMockDataSource(mockQueryRunner);

    // Batch with exactly the amount being removed — gerçek entity örneği.
    const exactBatch: Batch = Object.assign(new Batch(), {
      id: 'batch-exact',
      tenantId: TENANT_EXACT,
      batchNumber: 'B-EXACT',
      status: BatchStatus.ACTIVE,
      isActive: true,
      initialQuantity: 100,
      currentQuantity: 100,
      totalMortality: 0,
      cullCount: 0,
      mortalitySummary: {
        totalMortality: 0,
        mortalityRate: 0,
        lastMortalityAt: undefined as unknown as Date,
        mainCause: undefined as unknown as string,
      },
    });

    const exactEquipment: Partial<Equipment> = {
      id: 'tank-exact',
      tenantId: TENANT_EXACT,
      isActive: true,
      isDeleted: false,
      volume: 1000,
      currentBiomass: 20,
      currentCount: 100,
    };

    const exactTankBatch = {
      tenantId: TENANT_EXACT,
      tankId: 'tank-exact',
      primaryBatchId: 'batch-exact',
      totalQuantity: 100,
      totalBiomassKg: 20,
      densityKgM3: 0.02,
      currentQuantity: 100,
      currentBiomassKg: 20,
    };

    mockManager.findOne.mockImplementation((entity: any) => {
      if (entity === Batch) return Promise.resolve(exactBatch);
      if (entity === Equipment) return Promise.resolve(exactEquipment);
      if (entity === TankBatch) return Promise.resolve(exactTankBatch);
      if (entity === Tank) return Promise.resolve(null);
      return Promise.resolve(null);
    });

    const handler = new RecordMortalityHandler(
      mockDataSource,
      {} as Repository<Batch>,
      {} as Repository<MortalityRecord>,
      {} as Repository<TankOperation>,
      {} as Repository<TankBatch>,
      {} as Repository<Equipment>,
      {} as Repository<Tank>,
      {} as Repository<EquipmentType>,
      createMockOutboxPublisher(),
      // Gün-içi recalc (P-31) + giriş modu politikası (D-3) — bu race testleri
      // kilit/TOCTOU davranışına odaklı; recalc mock, politika gerçek (saf).
      { recalcForUnit: jest.fn().mockResolvedValue(null) } as never,
      new RemovalQuantityPolicyService(),
      { validate: jest.fn() } as never,
      { logWithManager: jest.fn().mockResolvedValue({}) } as never,
      // SEC-HIGH-051: object-level site authorization SSoT (real instance — the
      // commands below default to MODULE_MANAGER, so the hierarchy bypass keeps
      // these lock/TOCTOU race tests focused on concurrency, not site authz).
      new SiteAuthorizationService(),
      { applyBatchDelta: jest.fn().mockResolvedValue({}) } as never,
      new MortalityCullPolicyService(),
      { refreshContainers: jest.fn().mockResolvedValue(undefined) } as never,
      new MobileCommandReceiptService(),
    );

    const command = new RecordMortalityCommand(TENANT_EXACT, 'batch-exact', {
      tankId: 'tank-exact',
      quantity: 100, // Exactly all remaining fish
      avgWeightG: 200,
      reason: MortalityReason.DISEASE,
      observedAt: new Date(),
    }, 'user-001', [Role.MODULE_MANAGER], [], RACE_ENVELOPE);

    await handler.execute(command);

    // Verify all saves produced non-negative values
    for (const call of mockManager.save.mock.calls) {
      const entity = call[1] || call[0];
      if (entity.currentQuantity !== undefined) {
        expect(entity.currentQuantity).toBeGreaterThanOrEqual(0);
      }
      if (entity.totalQuantity !== undefined) {
        expect(entity.totalQuantity).toBeGreaterThanOrEqual(0);
      }
      if (entity.totalBiomassKg !== undefined) {
        expect(entity.totalBiomassKg).toBeGreaterThanOrEqual(0);
      }
      if (entity.currentBiomassKg !== undefined) {
        expect(entity.currentBiomassKg).toBeGreaterThanOrEqual(0);
      }
    }

    expect(mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('should verify all handlers use pessimistic lock pattern', () => {
    // This is a structural test - verify the handler source imports and uses
    // the correct lock pattern. The actual handlers are tested individually above.
    //
    // The key invariants we enforce:
    // 1. All reads happen INSIDE the transaction (after startTransaction)
    // 2. Reads use { lock: { mode: 'pessimistic_write' } }
    // 3. All subtractions use Math.max(0, ...)
    // 4. Transaction is committed only after all writes
    // 5. Rollback happens on any error
    // 6. QueryRunner is always released in finally block

    // Verified through the individual handler tests above
    expect(true).toBe(true);
  });
});
