/**
 * FCR Calculation Service Unit Tests
 *
 * Feed Conversion Ratio (FCR) hesaplama servisinin kapsamlı testleri.
 *
 * @module Growth/Tests
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';

import { BatchLocation } from '../../../batch/entities/batch-location.entity';
import { Batch } from '../../../batch/entities/batch.entity';
import { OperationType, TankOperation } from '../../../batch/entities/tank-operation.entity';
import { FeedingProgramTank } from '../../../feeding/entities/feeding-program-tank.entity';
import {
  FeedingProgram,
  FeedingProgramStatus,
} from '../../../feeding/entities/feeding-program.entity';
import { FeedingRecord } from '../../../feeding/entities/feeding-record.entity';
import { Species } from '../../../species/entities/species.entity';
import { GrowthMeasurement } from '../../entities/growth-measurement.entity';
import { FeedingProtocolStatus } from '../../../feeding-protocol/entities/feeding-protocol-v2.entity';
import { ProtocolAssignmentStatus } from '../../../feeding-protocol/entities/protocol-assignment.entity';
import { ProtocolRateService } from '../../../feeding-protocol/services/protocol-rate.service';
import { FCRCalculationService, FCRCalculationInput } from '../../services/fcr-calculation.service';

describe('FCRCalculationService', () => {
  let service: FCRCalculationService;
  let feedingRecordRepository: jest.Mocked<Repository<FeedingRecord>>;
  let growthMeasurementRepository: jest.Mocked<Repository<GrowthMeasurement>>;
  let batchRepository: jest.Mocked<Repository<Batch>>;

  // calculateCumulativeFCR now derives current biomass on read via
  // Batch.getCurrentBiomass (currentQuantity × effectiveAvgWeightG / 1000),
  // NOT from the latest growth-measurement snapshot. So mock batches must be
  // REAL Batch instances (so the method exists) with currentQuantity + an
  // actual avgWeight that produces the intended current biomass.
  //   currentBiomassKg = currentQuantity × actualAvgWeightG / 1000
  //   startBiomassKg   = initialQuantity × initialAvgWeightG / 1000
  const makeBatch = (params: {
    currentBiomassKg: number;
    startBiomassKg: number;
    initialQuantity?: number;
    batchNumber?: string;
  }): Batch => {
    const initialQuantity = params.initialQuantity ?? 10000;
    const currentQuantity = initialQuantity; // count fixed; vary avgWeight
    const initialAvgWeightG = (params.startBiomassKg * 1000) / initialQuantity;
    const actualAvgWeightG = (params.currentBiomassKg * 1000) / currentQuantity;
    return Object.assign(new Batch(), {
      id: 'batch-456',
      batchNumber: params.batchNumber ?? 'B-2024-001',
      initialQuantity,
      currentQuantity,
      weight: {
        initial: {
          avgWeight: initialAvgWeightG,
          totalBiomass: params.startBiomassKg,
          measuredAt: new Date(),
        },
        theoretical: { avgWeight: 0, totalBiomass: 0, lastCalculatedAt: new Date(), basedOnFCR: 0 },
        actual: {
          avgWeight: actualAvgWeightG,
          totalBiomass: params.currentBiomassKg,
          lastMeasuredAt: new Date(),
          sampleSize: 100,
          confidencePercent: 95,
        },
        variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
      },
    });
  };

  // The cumulative FCR authority reads its feed and ledger totals as raw SQL
  // over per-batch windows (one statement each, grouped by batch).
  const mockFeedQuery = jest.fn();
  const mockLedgerQuery = jest.fn();
  const mockFeedingRecordRepository = {
    find: jest.fn(),
    manager: { query: mockFeedQuery },
  };

  // getTargetFCR v2 zinciri (P-14) ham SQL'i repository.manager.query üzerinden
  // atar — varsayılan boş sonuç: v2 ataması yok, zincir legacy dallara düşer.
  const mockManagerQuery = jest.fn();
  // W5 (FARM-LOW-291): trend analizi de toplu ham sorguya döndü — pencere
  // fonksiyonu tek çağrıda son 10 ölçümü batch başına getirir.
  const mockGrowthMeasurementQuery = jest.fn();
  const mockGrowthMeasurementRepository = {
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
    manager: { query: mockGrowthMeasurementQuery },
  };
  const mockBatchRepository = {
    findOne: jest.fn(),
    // Toplu yol (`getTargetFCRForBatches`) batch'leri `find` ile ön-yükler.
    find: jest.fn(),
    manager: { query: mockManagerQuery },
  };

  const mockSpeciesRepository = {
    findOne: jest.fn(),
  };

  const mockBatchLocationRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockFeedingProgramRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockFeedingProgramTankRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  /** Feed given to batch-456 (the id makeBatch uses), as its grouped row. */
  const givenFeedTotal = (totalFeed: number): void => {
    mockFeedQuery.mockResolvedValue([{ batchId: 'batch-456', totalFeed }]);
  };

  /**
   * Net biomass that left batch-456 per the TankOperation ledger, as its
   * grouped row. The head count it carries is read only by the weighing
   * window, never by the to-now window these cases use.
   */
  const givenNetRemovedKg = (netRemovedKg: number): void => {
    mockLedgerQuery.mockResolvedValue([{ batchId: 'batch-456', netRemovedKg, headCountAtEnd: 0 }]);
  };

  /**
   * The ledger statement's answer when nothing left any batch: one row per
   * requested batch (it joins the batch row, so every existing batch has one),
   * with no removals.
   */
  const ledgerRowPerBatchWithNoRemovals = async (
    _sql: string,
    params: unknown[],
  ): Promise<Array<{ batchId: string; netRemovedKg: string; headCountAtEnd: string }>> =>
    (params[1] as string[]).map((batchId) => ({ batchId, netRemovedKg: '0', headCountAtEnd: '0' }));

  /** The ledger operation types the authority binds, from the enum. */
  const LEDGER_TYPES = [
    OperationType.MORTALITY,
    OperationType.CULL,
    OperationType.HARVEST,
    OperationType.TRANSFER_OUT,
    OperationType.TRANSFER_IN,
  ];

  /**
   * The batch every read sees: compareFCR, getBatchFCRSummary and the target
   * chain load it with findOne, the cumulative authority with find (bulk).
   */
  const givenBatch = (batch: Batch | null): void => {
    mockBatchRepository.findOne.mockResolvedValue(batch);
    mockBatchRepository.find.mockResolvedValue(batch === null ? [] : [batch]);
  };

  const mockTankOperationRepository = {
    manager: { query: mockLedgerQuery },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FCRCalculationService,
        // Saf servis — gerçek instance (band/matris çözümü specteki değerlerle sınanır).
        ProtocolRateService,
        {
          provide: getRepositoryToken(FeedingRecord),
          useValue: mockFeedingRecordRepository,
        },
        {
          provide: getRepositoryToken(GrowthMeasurement),
          useValue: mockGrowthMeasurementRepository,
        },
        {
          provide: getRepositoryToken(Batch),
          useValue: mockBatchRepository,
        },
        {
          provide: getRepositoryToken(Species),
          useValue: mockSpeciesRepository,
        },
        {
          provide: getRepositoryToken(BatchLocation),
          useValue: mockBatchLocationRepository,
        },
        {
          provide: getRepositoryToken(FeedingProgram),
          useValue: mockFeedingProgramRepository,
        },
        {
          provide: getRepositoryToken(FeedingProgramTank),
          useValue: mockFeedingProgramTankRepository,
        },
        {
          provide: getRepositoryToken(TankOperation),
          useValue: mockTankOperationRepository,
        },
      ],
    }).compile();

    service = module.get<FCRCalculationService>(FCRCalculationService);
    feedingRecordRepository = module.get(getRepositoryToken(FeedingRecord));
    growthMeasurementRepository = module.get(getRepositoryToken(GrowthMeasurement));
    batchRepository = module.get(getRepositoryToken(Batch));

    jest.clearAllMocks();

    // Default: no feed in any window, and nothing removed from any batch.
    mockFeedQuery.mockResolvedValue([]);
    mockLedgerQuery.mockImplementation(ledgerRowPerBatchWithNoRemovals);
    mockBatchRepository.find.mockResolvedValue([]);
    mockManagerQuery.mockResolvedValue([]);
    mockGrowthMeasurementQuery.mockResolvedValue([]);
  });

  describe('calculatePeriodFCR', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';
    const startDate = new Date('2024-01-01');
    const endDate = new Date('2024-01-31');

    const defaultInput: FCRCalculationInput = {
      batchId,
      tenantId,
      startDate,
      endDate,
      targetFCR: 1.5,
    };

    it('should calculate FCR correctly for valid data', async () => {
      // Feeding records: total 150kg feed
      mockFeedingRecordRepository.find.mockResolvedValue([
        { id: '1', actualAmount: 50 },
        { id: '2', actualAmount: 50 },
        { id: '3', actualAmount: 50 },
      ]);

      // Growth measurements: 1000kg start, 1100kg end = 100kg growth
      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1100, measurementDate: endDate },
      ]);

      // Mock cumulative calculation
      givenFeedTotal(200);
      givenBatch(makeBatch({ currentBiomassKg: 1100, startBiomassKg: 1000 }));

      const result = await service.calculatePeriodFCR(defaultInput);

      // FCR = 150kg / 100kg = 1.5
      expect(result.periodFCR).toBe(1.5);
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('should return warning when less than 2 measurements', async () => {
      mockFeedingRecordRepository.find.mockResolvedValue([{ id: '1', actualAmount: 50 }]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
      ]);

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Yetersiz büyüme ölçümü - en az 2 ölçüm gerekli');
    });

    it('should return warning for negative or zero growth', async () => {
      mockFeedingRecordRepository.find.mockResolvedValue([{ id: '1', actualAmount: 50 }]);

      // No growth - same biomass
      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1000, measurementDate: endDate },
      ]);

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Negatif veya sıfır büyüme tespit edildi');
    });

    it('should warn for abnormally high FCR', async () => {
      // 510kg feed for 100kg growth = FCR 5.1
      mockFeedingRecordRepository.find.mockResolvedValue([{ id: '1', actualAmount: 510 }]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1100, measurementDate: endDate },
      ]);

      givenFeedTotal(510);
      givenBatch(makeBatch({ currentBiomassKg: 1100, startBiomassKg: 1000 }));

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.periodFCR).toBe(5.1);
      expect(result.warnings.some((w) => w.includes('Anormal FCR'))).toBe(true);
    });

    it('should warn for abnormally low FCR', async () => {
      // 40kg feed for 100kg growth = FCR 0.4
      mockFeedingRecordRepository.find.mockResolvedValue([{ id: '1', actualAmount: 40 }]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1100, measurementDate: endDate },
      ]);

      givenFeedTotal(40);
      givenBatch(makeBatch({ currentBiomassKg: 1100, startBiomassKg: 1000 }));

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.periodFCR).toBe(0.4);
      expect(result.warnings.some((w) => w.includes('Anormal FCR'))).toBe(true);
    });

    it('should include FCR analysis in result', async () => {
      mockFeedingRecordRepository.find.mockResolvedValue([{ id: '1', actualAmount: 150 }]);

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, measurementDate: startDate },
        { id: '2', estimatedBiomass: 1100, measurementDate: endDate },
      ]);

      givenFeedTotal(200);
      givenBatch(makeBatch({ currentBiomassKg: 1100, startBiomassKg: 1000 }));

      const result = await service.calculatePeriodFCR(defaultInput);

      expect(result.analysis).toBeDefined();
      expect(result.analysis.periodFeedGiven).toBe(150);
      expect(result.analysis.periodGrowth).toBe(100);
      expect(result.analysis.periodFCR).toBe(1.5);
      expect(result.analysis.targetFCR).toBe(1.5);
    });
  });

  describe('calculateCumulativeFCR', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    it('should return zeros when batch not found, without the totals queries', async () => {
      givenBatch(null);

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      expect(result).toEqual({ fcr: 0, totalFeed: 0, totalGrowth: 0, removedBiomassKg: 0 });
      expect(mockFeedQuery).not.toHaveBeenCalled();
      expect(mockLedgerQuery).not.toHaveBeenCalled();
    });

    it('computes the to-now window in one feed and one ledger statement', async () => {
      givenBatch(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }));
      mockFeedQuery.mockResolvedValue([{ batchId, totalFeed: '300' }]);
      mockLedgerQuery.mockResolvedValue([{ batchId, netRemovedKg: '100', headCountAtEnd: '7' }]);

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      // 300 / ((1200 + 100) − 1000) = 1.0. The to-now window keeps the current
      // biomass (FARM-MEDIUM-450), so the ledger's head count is not read.
      expect(result).toEqual({ fcr: 1, totalFeed: 300, totalGrowth: 300, removedBiomassKg: 100 });
      // The window is open-ended: no end date on either statement.
      expect(mockFeedQuery).toHaveBeenCalledTimes(1);
      expect(mockFeedQuery).toHaveBeenCalledWith(expect.stringContaining('GROUP BY'), [
        tenantId,
        [batchId],
        [null],
      ]);
      expect(mockLedgerQuery).toHaveBeenCalledTimes(1);
      expect(mockLedgerQuery).toHaveBeenCalledWith(expect.stringContaining('GROUP BY'), [
        tenantId,
        [batchId],
        [null],
        LEDGER_TYPES,
        OperationType.TRANSFER_IN,
      ]);
    });

    it('returns zeros for a batch that left the tenant between its read and the ledger statement', async () => {
      // The ledger statement joins the batch row: no row means no batch.
      givenBatch(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }));
      givenFeedTotal(300);
      mockLedgerQuery.mockResolvedValue([]);

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      expect(result).toEqual({ fcr: 0, totalFeed: 0, totalGrowth: 0, removedBiomassKg: 0 });
    });

    it('should calculate cumulative FCR from batch start (derive-on-read biomass)', async () => {
      // 1000kg start, 1400kg current (derived from currentQuantity × avgWeight)
      givenBatch(makeBatch({ currentBiomassKg: 1400, startBiomassKg: 1000 }));

      // Total feed: 500kg
      givenFeedTotal(500);

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      // FCR = 500 / 400 = 1.25
      expect(result.fcr).toBe(1.25);
      expect(result.totalFeed).toBe(500);
      expect(result.totalGrowth).toBe(400);
    });

    it('should respect endDate parameter', async () => {
      const endDate = new Date('2024-01-15');

      givenBatch(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }));

      givenFeedTotal(300);

      await service.calculateCumulativeFCR(batchId, tenantId, endDate);

      // The batch's window ends on endDate: feed dated after it is not counted.
      expect(mockFeedQuery).toHaveBeenCalledWith(
        expect.stringContaining('fr."feedingDate" <= w."endsOn"'),
        [tenantId, [batchId], [endDate]],
      );
    });

    it('should return 0 FCR when no growth', async () => {
      // current biomass == start biomass (1000kg) → zero realized growth
      givenBatch(makeBatch({ currentBiomassKg: 1000, startBiomassKg: 1000 }));

      givenFeedTotal(100);

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      expect(result.fcr).toBe(0);
      expect(result.totalGrowth).toBe(0);
    });

    it('should add back biomass removed by mortality/cull/harvest to realized growth', async () => {
      // 1000kg start, 1400kg current still in the water (derive-on-read)
      givenBatch(makeBatch({ currentBiomassKg: 1400, startBiomassKg: 1000 }));

      givenFeedTotal(600);
      // …but 200kg left the system (mortality + partial harvest). Those fish
      // ate feed and grew before exiting — naive (current − start) hides that
      // growth and inflates FCR (600/400=1.5 instead of the true 600/600=1.0).
      givenNetRemovedKg(200);

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      expect(result.totalGrowth).toBe(600); // (1400 + 200) − 1000
      expect(result.removedBiomassKg).toBe(200);
      expect(result.fcr).toBe(1.0);
    });

    it('should subtract transfer-in biomass (entered without consuming feed)', async () => {
      // 1000kg start, 1400kg current (derive-on-read)
      givenBatch(makeBatch({ currentBiomassKg: 1400, startBiomassKg: 1000 }));

      givenFeedTotal(300);
      // Net negative ledger: 100kg more came IN via transfer than left.
      // That biomass did not grow on this batch's feed.
      givenNetRemovedKg(-100);

      const result = await service.calculateCumulativeFCR(batchId, tenantId);

      expect(result.totalGrowth).toBe(300); // (1400 − 100) − 1000
      expect(result.fcr).toBe(1.0);
    });

    it('should apply endDate to the tank-operation ledger query', async () => {
      const endDate = new Date('2024-01-15');

      givenBatch(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }));

      givenFeedTotal(300);

      await service.calculateCumulativeFCR(batchId, tenantId, endDate);

      expect(mockLedgerQuery).toHaveBeenCalledWith(
        expect.stringContaining('op."operationDate" <= w."endsOn"'),
        [tenantId, [batchId], [endDate], LEDGER_TYPES, OperationType.TRANSFER_IN],
      );
    });
  });

  describe('calculateFcrAtLastWeighingMany (FARM-CRITICAL-444 review)', () => {
    const tenantId = 'tenant-123';
    const weighedOn = '2024-03-01T12:00:00.000Z';

    /**
     * A batch of 10 000 fish stocked at 100 g (1000 kg), last weighed on
     * `weighedOn` at `weighedAvgWeightG`. (JSONB hands lastMeasuredAt back as an
     * ISO string; the real-PostgreSQL spec covers that.) The live count, the
     * current average and the stored `totalBiomass` are deliberately different
     * from the batch on the weighing day: the window must read none of them.
     * The count on the weighing day comes from the ledger statement's row.
     */
    const weighedBatch = (id: string, weighedAvgWeightG: number, sampleSize = 30): Batch => {
      const batch = Object.assign(makeBatch({ currentBiomassKg: 5000, startBiomassKg: 1000 }), {
        id,
      });
      batch.currentQuantity = 9000;
      batch.weight.actual = {
        avgWeight: weighedAvgWeightG,
        // populationSize x average as typed when the sample was entered: not read.
        totalBiomass: 123_456,
        lastMeasuredAt: new Date(weighedOn),
        sampleSize,
        confidencePercent: 95,
      };
      return batch;
    };

    it('judges each weighed batch over feed and ledger up to its weighing, at its count on that day', async () => {
      mockBatchRepository.find.mockResolvedValue([
        weighedBatch('b-converting', 140),
        weighedBatch('b-not-growing', 98),
        weighedBatch('b-unfed', 110),
      ]);
      mockFeedQuery.mockResolvedValue([
        { batchId: 'b-converting', totalFeed: '600' },
        { batchId: 'b-not-growing', totalFeed: '300' },
      ]);
      // Each batch held 10 000 fish at the end of its weighing day.
      mockLedgerQuery.mockResolvedValue([
        { batchId: 'b-converting', netRemovedKg: '200', headCountAtEnd: '10000' },
        { batchId: 'b-not-growing', netRemovedKg: '0', headCountAtEnd: '10000' },
        { batchId: 'b-unfed', netRemovedKg: '0', headCountAtEnd: '10000' },
      ]);

      const verdicts = await service.calculateFcrAtLastWeighingMany(tenantId, [
        'b-converting',
        'b-not-growing',
        'b-unfed',
      ]);

      // 10 000 x 140 g = 1400 kg; (1400 + 200) − 1000 = 600 kg grown on 600 kg of feed.
      expect(verdicts.get('b-converting')).toEqual({
        kind: 'converting',
        weighedOn: new Date(weighedOn),
        fcr: 1,
        totalFeed: 600,
        totalGrowth: 600,
        removedBiomassKg: 200,
      });
      // 980 kg against 1000 kg stocked: fed, but no realized growth, and no FCR
      // field to misread as on target.
      expect(verdicts.get('b-not-growing')).toEqual({
        kind: 'not-growing',
        weighedOn: new Date(weighedOn),
        totalFeed: 300,
        totalGrowth: -20,
        removedBiomassKg: 0,
      });
      expect(verdicts.get('b-unfed')).toEqual({
        kind: 'unfed',
        weighedOn: new Date(weighedOn),
        totalFeed: 0,
        totalGrowth: 100,
        removedBiomassKg: 0,
      });

      // Every window ends on its own weighing day, in one statement per table.
      const weighingDays = [new Date(weighedOn), new Date(weighedOn), new Date(weighedOn)];
      const ids = ['b-converting', 'b-not-growing', 'b-unfed'];
      expect(mockFeedQuery).toHaveBeenCalledTimes(1);
      expect(mockFeedQuery).toHaveBeenCalledWith(expect.any(String), [tenantId, ids, weighingDays]);
      expect(mockLedgerQuery).toHaveBeenCalledTimes(1);
      expect(mockLedgerQuery).toHaveBeenCalledWith(expect.any(String), [
        tenantId,
        ids,
        weighingDays,
        LEDGER_TYPES,
        OperationType.TRANSFER_IN,
      ]);
    });

    it('takes the weighed biomass from the head count at the weighing day, not from the typed population', async () => {
      // On the weighing day the batch held 10 000 fish at 140 g. Since then
      // 1000 left (the live count is 9000), and the sample was typed with some
      // other population: the stored totalBiomass is 123 456 kg. Only the
      // count the ledger statement reconstructs for the weighing day is read.
      mockBatchRepository.find.mockResolvedValue([weighedBatch('b-1', 140)]);
      mockFeedQuery.mockResolvedValue([{ batchId: 'b-1', totalFeed: '480' }]);
      mockLedgerQuery.mockResolvedValue([
        { batchId: 'b-1', netRemovedKg: '0', headCountAtEnd: '10000' },
      ]);

      const verdicts = await service.calculateFcrAtLastWeighingMany(tenantId, ['b-1']);

      // 10 000 x 140 g = 1400 kg; 1400 − 1000 = 400 kg grown; 480 / 400 = 1.2.
      expect(verdicts.get('b-1')).toMatchObject({
        kind: 'converting',
        fcr: 1.2,
        totalGrowth: 400,
      });
      // The count is read in the same statement as the ledger cut: the live
      // count plus what the ledger types moved out after the window's end.
      const [ledgerSql] = mockLedgerQuery.mock.calls[0] ?? [];
      expect(String(ledgerSql)).toContain('b."currentQuantity"');
      expect(String(ledgerSql)).toContain('op."operationDate" > w."endsOn"');
      expect(String(ledgerSql)).toContain('op."operationDate" <= w."endsOn"');
    });

    it('does not judge a batch never weighed since stocking, nor an unknown id', async () => {
      // CreateBatchHandler leaves weight.actual at the stocking weight with
      // sampleSize 0: growth is unknown, whatever the ledger's rounding says.
      mockBatchRepository.find.mockResolvedValue([weighedBatch('b-unweighed', 100, 0)]);

      const verdicts = await service.calculateFcrAtLastWeighingMany(tenantId, [
        'b-unweighed',
        'b-gone',
      ]);

      expect(verdicts.get('b-unweighed')).toEqual({ kind: 'unweighed' });
      expect(verdicts.get('b-gone')).toEqual({ kind: 'unweighed' });
      expect(mockFeedQuery).not.toHaveBeenCalled();
      expect(mockLedgerQuery).not.toHaveBeenCalled();
    });

    it('issues no query for an empty id list', async () => {
      const verdicts = await service.calculateFcrAtLastWeighingMany(tenantId, []);

      expect(verdicts.size).toBe(0);
      expect(mockBatchRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('analyzeFCRTrend', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    it('should return stable trend when insufficient data', async () => {
      mockGrowthMeasurementQuery.mockResolvedValue([
        { batchId, fcrAnalysis: { periodFCR: 1.5 } },
        { batchId, fcrAnalysis: { periodFCR: 1.4 } },
      ]);

      const result = await service.analyzeFCRTrend(batchId, tenantId);

      expect(result.trend).toBe('stable');
      expect(result.recommendations).toContain('Yeterli veri yok - daha fazla ölçüm gerekli');
    });

    it('should detect improving trend (decreasing FCR)', async () => {
      mockGrowthMeasurementQuery.mockResolvedValue([
        { batchId, fcrAnalysis: { periodFCR: 1.8, cumulativeFCR: 1.8 } },
        { batchId, fcrAnalysis: { periodFCR: 1.6, cumulativeFCR: 1.7 } },
        { batchId, fcrAnalysis: { periodFCR: 1.4, cumulativeFCR: 1.6 } },
        { batchId, fcrAnalysis: { periodFCR: 1.2, cumulativeFCR: 1.5 } },
      ]);

      const result = await service.analyzeFCRTrend(batchId, tenantId);

      expect(result.trend).toBe('improving');
      expect(result.slope).toBeLessThan(0);
    });

    it('should detect declining trend (increasing FCR)', async () => {
      mockGrowthMeasurementQuery.mockResolvedValue([
        { batchId, fcrAnalysis: { periodFCR: 1.2, cumulativeFCR: 1.2 } },
        { batchId, fcrAnalysis: { periodFCR: 1.4, cumulativeFCR: 1.3 } },
        { batchId, fcrAnalysis: { periodFCR: 1.6, cumulativeFCR: 1.4 } },
        { batchId, fcrAnalysis: { periodFCR: 1.8, cumulativeFCR: 1.5 } },
      ]);

      const result = await service.analyzeFCRTrend(batchId, tenantId);

      expect(result.trend).toBe('declining');
      expect(result.slope).toBeGreaterThan(0);
    });

    it('should include recommendations for declining trend', async () => {
      mockGrowthMeasurementQuery.mockResolvedValue([
        { batchId, fcrAnalysis: { periodFCR: 1.2 } },
        { batchId, fcrAnalysis: { periodFCR: 1.5 } },
        { batchId, fcrAnalysis: { periodFCR: 1.8 } },
        { batchId, fcrAnalysis: { periodFCR: 2.1 } },
      ]);

      const result = await service.analyzeFCRTrend(batchId, tenantId);

      expect(result.recommendations).toContain('Yemleme programını gözden geçirin');
      expect(result.recommendations).toContain('Su kalitesi parametrelerini kontrol edin');
    });
  });

  describe('compareFCR', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    beforeEach(() => {
      // 1000kg start, 1200kg current → 200kg realized growth (derive-on-read)
      givenBatch(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }));
    });

    it('should rate excellent performance when FCR is 10%+ below target', async () => {
      // FCR 1.3 vs target 1.5 = -13.3% variance
      givenFeedTotal(260);

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.performance).toBe('excellent');
      expect(result.varianceFromTarget).toBeLessThan(-10);
    });

    it('should rate good performance when FCR is at or below target', async () => {
      // FCR 1.45 vs target 1.5 = -3.3% variance
      givenFeedTotal(290);

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.performance).toBe('good');
    });

    it('should rate poor performance when FCR is 20%+ above target', async () => {
      // FCR 2.0 vs target 1.5 = +33% variance
      givenFeedTotal(400);

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.performance).toBe('poor');
      expect(result.varianceFromTarget).toBeGreaterThan(20);
    });

    it('should compare against industry average', async () => {
      givenFeedTotal(300);

      const result = await service.compareFCR(batchId, tenantId, 'rainbow_trout');

      expect(result.industryAvgFCR).toBe(1.1); // Rainbow trout industry avg
      expect(result.varianceFromIndustry).toBeDefined();
    });
  });

  describe('detectFCRAnomalies', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    beforeEach(() => {
      // 1000kg start, 1200kg current → 200kg realized growth (derive-on-read)
      givenBatch(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }));
      mockGrowthMeasurementRepository.find.mockResolvedValue([]);
    });

    it('should detect critically high FCR', async () => {
      // FCR > 3 is critical
      givenFeedTotal(700);

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(true);
      expect(result.anomalies.some((a) => a.includes('Kritik'))).toBe(true);
    });

    it('should detect suspiciously low FCR', async () => {
      // FCR < 0.7 is suspicious
      givenFeedTotal(100);

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(true);
      expect(result.anomalies.some((a) => a.includes('çok düşük'))).toBe(true);
    });

    it('should detect significant variance from target', async () => {
      // FCR 2.1 vs target 1.5 = 40% variance
      givenFeedTotal(420);

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(true);
      expect(result.anomalies.some((a) => a.includes('sapma'))).toBe(true);
    });

    it('should return no anomalies for normal FCR', async () => {
      // FCR 1.5 is normal
      givenFeedTotal(300);

      const result = await service.detectFCRAnomalies(batchId, tenantId);

      expect(result.hasAnomaly).toBe(false);
      expect(result.anomalies).toHaveLength(0);
    });
  });

  describe('getTargetFCR — P-14 v2 protokol zinciri (compareFCR üzerinden)', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    // makeBatch 120g ortalama üretir (1200kg / 10000 adet) — band [0, 1e6) kapsar.
    const v2Row = (params?: {
      overrides?: Record<string, unknown>;
      fcrSource?: string;
      fcrMatrix?: { temperatures: number[]; weights: number[]; fcrValues: number[][] } | null;
    }): Record<string, unknown> => ({
      overrides: params?.overrides ?? {},
      bands: [
        {
          minWeightG: 0,
          maxWeightG: 1000000,
          feedId: 'feed-1',
          feedCode: 'F1',
          feedName: 'Starter F1',
          feedingRatePercent: 2,
          expectedFcr: 1.2,
        },
      ],
      settings: {
        autoTransition: true,
        transitionBufferG: 10,
        growthApplicationMode: 'per_meal',
        underfeedAlertThresholdPercent: 15,
        fcrSource: params?.fcrSource ?? 'band',
      },
      fcrMatrix: params?.fcrMatrix ?? null,
    });

    beforeEach(() => {
      // 1000kg start, 1200kg current → cumulative FCR 300/200 = 1.5.
      givenBatch(
        Object.assign(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }), {
          tenantId,
        }),
      );
      givenFeedTotal(300);
    });

    it('aktif v2 ataması varken hedef FCR banddan gelir ve legacy program dalı HİÇ sorgulanmaz', async () => {
      mockManagerQuery.mockResolvedValueOnce([v2Row()]);

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.targetFCR).toBe(1.2);
      // Zincir sırası pinli: v2 çözüldüyse legacy FeedingProgram yoluna inilmez.
      expect(mockBatchLocationRepository.findOne).not.toHaveBeenCalled();
      expect(mockFeedingProgramTankRepository.findOne).not.toHaveBeenCalled();
    });

    it('ünite fcrOverrides girdisi band varsayılanını ezer (OVERRIDE önceliği)', async () => {
      mockManagerQuery.mockResolvedValueOnce([
        v2Row({ overrides: { fcrOverrides: [{ feedId: 'feed-1', expectedFcr: 1.05 }] } }),
      ]);

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.targetFCR).toBe(1.05);
    });

    it('fcrSource=feed protokolde band yeminin FCR matrisi ağırlık ekseninde interpolasyonla çözülür', async () => {
      mockManagerQuery.mockResolvedValueOnce([v2Row({ fcrSource: 'feed' })]).mockResolvedValueOnce([
        {
          matrix: {
            temperatures: [10],
            weights: [100, 200],
            rates: [[2.5, 2.0]],
            fcrMatrix: [[1.0, 1.4]],
          },
        },
      ]);

      const result = await service.compareFCR(batchId, tenantId);

      // 120g: wFrac = (120−100)/(200−100) = 0.2 → 1.0 + 0.4×0.2 = 1.08.
      expect(result.targetFCR).toBeCloseTo(1.08, 10);
      expect(mockManagerQuery).toHaveBeenCalledTimes(2);
      expect(String(mockManagerQuery.mock.calls[1]?.[0])).toContain('feedingMatrix2D');
    });

    it('v2 ataması yokken zincir species targetFCR dalına düşer', async () => {
      givenBatch(
        Object.assign(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }), {
          tenantId,
          species: { growthParameters: { targetFCR: 1.35 } },
        }),
      );

      const result = await service.compareFCR(batchId, tenantId);

      expect(mockManagerQuery).toHaveBeenCalledTimes(1);
      expect(result.targetFCR).toBe(1.35);
    });

    it('getTargetFCRForBatches legacy dala düşen batch’ler için de SORGU ATMAZ (FARM-LOW-291)', async () => {
      // Bulgunun tam senaryosu. Toplu API'nin DIŞ iki çağrısı toplulaştırılmıştı,
      // ama zincirin 3. adımı — legacy yemleme programı — batch başına İKİ
      // `findOne` atmaya devam ediyordu: `batch_locations` ve
      // `feeding_program_tanks`. O adıma, v2 ataması OLMAYAN her batch düşer;
      // cutover'ı bitirmemiş bir tenant'ta bu, batch'lerin çoğunluğudur. Yani
      // "toplu" okuma, bulgunun saydığı sorguları hâlâ atıyordu.
      const batchIds = ['batch-a', 'batch-b', 'batch-c'];
      mockBatchRepository.find.mockResolvedValue(
        batchIds.map((id) =>
          Object.assign(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }), {
            id,
            tenantId,
            species: undefined,
            speciesId: 'species-1',
          }),
        ),
      );
      mockSpeciesRepository.findOne.mockResolvedValue(null);
      mockManagerQuery
        // 1) v2 atama sorgusu — hiçbiri atanmamış, hepsi legacy dala düşer.
        .mockResolvedValueOnce([])
        // 2) legacy program sorgusu — TOPLU. Yalnız batch-b'nin programı var.
        .mockResolvedValueOnce([
          {
            batchId: 'batch-b',
            fcrTable: { temperatures: [10], weights: [100, 200], fcrValues: [[1.1, 1.5]] },
          },
        ]);

      const targets = await service.getTargetFCRForBatches(tenantId, batchIds);

      // Legacy tablosu olan batch onun interpolasyonunu alır; olmayanlar
      // zincirin devamına düşer (species yok → endüstri yok → 1.5).
      // 120g: wFrac = 0.2 → 1.1 + 0.4×0.2 = 1.18.
      expect(targets.get('batch-b')).toBeCloseTo(1.18, 10);
      expect(targets.get('batch-a')).toBe(1.5);
      expect(targets.get('batch-c')).toBe(1.5);

      // Asıl iddia: batch BAŞINA hiçbir legacy round-trip yok.
      expect(mockBatchLocationRepository.findOne).not.toHaveBeenCalled();
      expect(mockFeedingProgramTankRepository.findOne).not.toHaveBeenCalled();
      // Ham sorgu sayısı batch sayısından BAĞIMSIZ: v2 + legacy = 2.
      expect(mockManagerQuery).toHaveBeenCalledTimes(2);
      // FARM-HIGH-445: every status is bound from its enum. The enum's
      // database values are lowercase, so a typed 'ACTIVE' literal made
      // PostgreSQL reject the query (proven in fcr-alert-sweep.postgres.spec.ts).
      expect(mockManagerQuery).toHaveBeenNthCalledWith(
        1,
        expect.not.stringMatching(/"status" = '/),
        [tenantId, batchIds, ProtocolAssignmentStatus.ACTIVE, FeedingProtocolStatus.ACTIVE],
      );
      expect(mockManagerQuery).toHaveBeenNthCalledWith(2, expect.not.stringContaining("'ACTIVE'"), [
        tenantId,
        batchIds,
        FeedingProgramStatus.ACTIVE,
      ]);
    });

    it('kullanıcı override (batch.fcr.target) her şeyden önce gelir — v2 sorgusu atılmaz', async () => {
      givenBatch(
        Object.assign(makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000 }), {
          tenantId,
          fcr: { isUserOverride: true, target: 2.0 },
        }),
      );

      const result = await service.compareFCR(batchId, tenantId);

      expect(result.targetFCR).toBe(2.0);
      expect(mockManagerQuery).not.toHaveBeenCalled();
    });
  });

  describe('getBatchFCRSummary', () => {
    const tenantId = 'tenant-123';
    const batchId = 'batch-456';

    it('should return null when batch not found', async () => {
      givenBatch(null);

      const result = await service.getBatchFCRSummary(batchId, tenantId);

      expect(result).toBeNull();
    });

    it('should return comprehensive summary', async () => {
      givenBatch(
        makeBatch({ currentBiomassKg: 1200, startBiomassKg: 1000, batchNumber: 'B-2024-001' }),
      );

      mockGrowthMeasurementRepository.find.mockResolvedValue([
        { id: '1', estimatedBiomass: 1000, fcrAnalysis: { periodFCR: 1.4 } },
        { id: '2', estimatedBiomass: 1100, fcrAnalysis: { periodFCR: 1.5 } },
        { id: '3', estimatedBiomass: 1200, fcrAnalysis: { periodFCR: 1.6 } },
      ]);

      givenFeedTotal(300);

      const result = await service.getBatchFCRSummary(batchId, tenantId);

      expect(result).not.toBeNull();
      expect(result!.batchId).toBe(batchId);
      expect(result!.batchCode).toBe('B-2024-001');
      expect(result!.measurementCount).toBe(3);
      expect(result!.bestFCR).toBe(1.4);
      expect(result!.worstFCR).toBe(1.6);
      expect(result!.avgFCR).toBeCloseTo(1.5, 1);
    });
  });
});
