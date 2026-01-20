import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  MeteredBillingService,
  PricingTier,
  MeterPricingModel,
  TaxRateConfig,
  BillingCalculation,
  MeterBillingBreakdown,
  InvoicePreview,
} from '../metered-billing.service';
import { UsageAggregatorService, AggregationPeriod, AggregatedUsage } from '../usage-aggregator.service';
import { MeterType } from '../usage-metering.service';
import { BillingCycle, PlanTier } from '../../../billing/entities/subscription.entity';

describe('MeteredBillingService', () => {
  let service: MeteredBillingService;
  let usageAggregator: jest.Mocked<UsageAggregatorService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const mockUsageAggregator = {
    getAggregationsInRange: jest.fn().mockReturnValue([]),
    getAggregation: jest.fn(),
    getTenantUsageSummary: jest.fn(),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MeteredBillingService,
        {
          provide: UsageAggregatorService,
          useValue: mockUsageAggregator,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
      ],
    }).compile();

    service = module.get<MeteredBillingService>(MeteredBillingService);
    usageAggregator = module.get(UsageAggregatorService);
    eventEmitter = module.get(EventEmitter2);

    await service.onModuleInit();
  });

  afterEach(() => {
    jest.clearAllMocks();
    service.clearCache();
  });

  // ============================================================================
  // BASIC BILLING CALCULATION TESTS
  // ============================================================================
  describe('Basic Billing Calculations', () => {
    describe('Simple Unit Price Calculation', () => {
      it('should calculate basic billing with no usage', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          99.00,
          'US',
          'USD',
        );

        expect(calculation).toBeDefined();
        expect(calculation.basePlanFee).toBe(99.00);
        expect(calculation.subtotalMetered).toBe(0);
      });

      it('should calculate billing with usage', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([
          {
            tenantId: 'tenant-1',
            meterType: MeterType.API_CALLS,
            totalUsage: 50000,
            period: AggregationPeriod.MONTHLY,
          } as AggregatedUsage,
        ]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          99.00,
          'US',
          'USD',
        );

        expect(calculation.subtotalMetered).toBeGreaterThan(0);
      });

      it('should maintain 2 decimal precision', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([
          {
            tenantId: 'tenant-1',
            meterType: MeterType.API_CALLS,
            totalUsage: 33333,
            period: AggregationPeriod.MONTHLY,
          } as AggregatedUsage,
        ]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          99.99,
          'US',
          'USD',
        );

        // Check decimal precision
        const decimalPlaces = (calculation.finalTotal.toString().split('.')[1] || '').length;
        expect(decimalPlaces).toBeLessThanOrEqual(2);
      });

      it('should handle zero usage billing (minimum fee)', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          0,
          'US',
          'USD',
        );

        expect(calculation.basePlanFee).toBe(0);
        expect(calculation.finalTotal).toBe(0);
      });
    });

    describe('Free Tier Deduction', () => {
      it('should deduct included units from billable usage', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([
          {
            tenantId: 'tenant-1',
            meterType: MeterType.API_CALLS,
            totalUsage: 15000, // Starter includes 10,000
            period: AggregationPeriod.MONTHLY,
          } as AggregatedUsage,
        ]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          99.00,
          'US',
          'USD',
        );

        const apiBreakdown = calculation.meterBreakdowns.find(
          (b) => b.meterType === MeterType.API_CALLS,
        );

        expect(apiBreakdown?.includedUnits).toBe(10000);
        expect(apiBreakdown?.billableUnits).toBe(5000);
      });

      it('should not charge when usage is within free tier', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([
          {
            tenantId: 'tenant-1',
            meterType: MeterType.API_CALLS,
            totalUsage: 5000, // Less than included 10,000
            period: AggregationPeriod.MONTHLY,
          } as AggregatedUsage,
        ]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          99.00,
          'US',
          'USD',
        );

        const apiBreakdown = calculation.meterBreakdowns.find(
          (b) => b.meterType === MeterType.API_CALLS,
        );

        expect(apiBreakdown?.billableUnits).toBe(0);
        expect(apiBreakdown?.subtotal).toBe(0);
      });
    });

    describe('Overage Calculation', () => {
      it('should calculate overage correctly', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([
          {
            tenantId: 'tenant-1',
            meterType: MeterType.API_CALLS,
            totalUsage: 100000, // Well above included
            period: AggregationPeriod.MONTHLY,
          } as AggregatedUsage,
        ]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          99.00,
          'US',
          'USD',
        );

        const apiBreakdown = calculation.meterBreakdowns.find(
          (b) => b.meterType === MeterType.API_CALLS,
        );

        expect(apiBreakdown?.billableUnits).toBe(90000); // 100000 - 10000 included
        expect(apiBreakdown?.subtotal).toBeGreaterThan(0);
      });
    });
  });

  // ============================================================================
  // PRICING TIER TESTS
  // ============================================================================
  describe('Pricing Tier Application', () => {
    describe('Tiered Pricing', () => {
      it('should apply first tier pricing', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([
          {
            tenantId: 'tenant-1',
            meterType: MeterType.API_CALLS,
            totalUsage: 40000, // 10k included + 30k in first tier
            period: AggregationPeriod.MONTHLY,
          } as AggregatedUsage,
        ]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          99.00,
          'US',
          'USD',
        );

        const apiBreakdown = calculation.meterBreakdowns.find(
          (b) => b.meterType === MeterType.API_CALLS,
        );

        expect(apiBreakdown?.tierBreakdown.length).toBeGreaterThanOrEqual(1);
        expect(apiBreakdown?.tierBreakdown[0]?.pricePerUnit).toBe(0.001);
      });

      it('should apply graduated pricing across tiers', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([
          {
            tenantId: 'tenant-1',
            meterType: MeterType.API_CALLS,
            totalUsage: 150000, // Spans multiple tiers
            period: AggregationPeriod.MONTHLY,
          } as AggregatedUsage,
        ]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          99.00,
          'US',
          'USD',
        );

        const apiBreakdown = calculation.meterBreakdowns.find(
          (b) => b.meterType === MeterType.API_CALLS,
        );

        // Should have multiple tier breakdowns
        expect(apiBreakdown?.tierBreakdown.length).toBeGreaterThan(1);
      });

      it('should apply different rates for each tier', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([
          {
            tenantId: 'tenant-1',
            meterType: MeterType.API_CALLS,
            totalUsage: 200000,
            period: AggregationPeriod.MONTHLY,
          } as AggregatedUsage,
        ]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          99.00,
          'US',
          'USD',
        );

        const apiBreakdown = calculation.meterBreakdowns.find(
          (b) => b.meterType === MeterType.API_CALLS,
        );

        const tierRates = apiBreakdown?.tierBreakdown.map((t) => t.pricePerUnit);
        // Rates should decrease as usage increases (volume discount)
        expect(tierRates).toBeDefined();
      });
    });

    describe('Plan Tier Pricing Models', () => {
      it('should have different pricing for STARTER plan', () => {
        const pricingModel = service.getPricingModel(PlanTier.STARTER);

        expect(pricingModel).toBeDefined();
        expect(pricingModel?.size).toBeGreaterThan(0);

        const apiPricing = pricingModel?.get(MeterType.API_CALLS);
        expect(apiPricing?.includedUnits).toBe(10000);
      });

      it('should have different pricing for PROFESSIONAL plan', () => {
        const pricingModel = service.getPricingModel(PlanTier.PROFESSIONAL);

        expect(pricingModel).toBeDefined();

        const apiPricing = pricingModel?.get(MeterType.API_CALLS);
        expect(apiPricing?.includedUnits).toBe(100000);
      });

      it('should have different pricing for ENTERPRISE plan', () => {
        const pricingModel = service.getPricingModel(PlanTier.ENTERPRISE);

        expect(pricingModel).toBeDefined();

        const apiPricing = pricingModel?.get(MeterType.API_CALLS);
        expect(apiPricing?.includedUnits).toBe(1000000);
      });

      it('should throw error for unknown plan tier', async () => {
        await expect(
          service.calculateBilling(
            'sub-1',
            'tenant-1',
            'UNKNOWN' as PlanTier,
            BillingCycle.MONTHLY,
            new Date('2024-06-01'),
            new Date('2024-06-30'),
            99.00,
            'US',
            'USD',
          ),
        ).rejects.toThrow('No pricing model found');
      });
    });

    describe('Volume-based Pricing', () => {
      it('should decrease per-unit cost at higher volumes', async () => {
        const lowVolumeUsage = [{
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          totalUsage: 30000,
          period: AggregationPeriod.MONTHLY,
        } as AggregatedUsage];

        const highVolumeUsage = [{
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          totalUsage: 200000,
          period: AggregationPeriod.MONTHLY,
        } as AggregatedUsage];

        mockUsageAggregator.getAggregationsInRange.mockReturnValue(lowVolumeUsage);
        const lowCalc = await service.calculateBilling(
          'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
          new Date('2024-06-01'), new Date('2024-06-30'), 0, 'US', 'USD',
        );

        service.clearCache();
        mockUsageAggregator.getAggregationsInRange.mockReturnValue(highVolumeUsage);
        const highCalc = await service.calculateBilling(
          'sub-2', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
          new Date('2024-06-01'), new Date('2024-06-30'), 0, 'US', 'USD',
        );

        const lowBreakdown = lowCalc.meterBreakdowns.find((b) => b.meterType === MeterType.API_CALLS);
        const highBreakdown = highCalc.meterBreakdowns.find((b) => b.meterType === MeterType.API_CALLS);

        const lowCostPerUnit = lowBreakdown!.subtotal / lowBreakdown!.billableUnits;
        const highCostPerUnit = highBreakdown!.subtotal / highBreakdown!.billableUnits;

        // Higher volume should have lower effective per-unit cost
        expect(highCostPerUnit).toBeLessThan(lowCostPerUnit);
      });
    });
  });

  // ============================================================================
  // PRO-RATA CALCULATION TESTS
  // ============================================================================
  describe('Pro-rata Calculations', () => {
    describe('Mid-cycle Upgrade', () => {
      it('should calculate pro-rata for mid-cycle upgrade', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateProRataBilling(
          'sub-1',
          'tenant-1',
          PlanTier.PROFESSIONAL,
          199.00,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          new Date('2024-06-15'), // Mid-cycle start
          new Date('2024-06-30'),
          'upgrade',
          'US',
          'USD',
        );

        expect(calculation.proRataAdjustment).toBeDefined();
        expect(calculation.proRataAdjustment?.reason).toContain('upgrade');
        expect(calculation.proRataAdjustment?.factor).toBeCloseTo(0.5, 1);
      });

      it('should calculate correct pro-rata factor', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateProRataBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          100.00,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          new Date('2024-06-20'), // 10 days
          new Date('2024-06-30'),
          'mid_cycle_start',
          'US',
          'USD',
        );

        // 10 days out of 29 days
        const expectedFactor = 10 / 29;
        expect(calculation.proRataAdjustment?.factor).toBeCloseTo(expectedFactor, 2);
      });
    });

    describe('Mid-cycle Downgrade', () => {
      it('should calculate pro-rata credit for downgrade', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateProRataBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          99.00,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          new Date('2024-06-01'),
          new Date('2024-06-15'), // Downgrade mid-cycle
          'downgrade',
          'US',
          'USD',
        );

        expect(calculation.proRataAdjustment?.reason).toContain('downgrade');
      });
    });

    describe('Trial to Paid Conversion', () => {
      it('should handle mid-cycle subscription start', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateProRataBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          99.00,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          new Date('2024-06-10'),
          new Date('2024-06-30'),
          'mid_cycle_start',
          'US',
          'USD',
        );

        expect(calculation.proRataAdjustment).toBeDefined();
        expect(calculation.finalTotal).toBeLessThan(99.00);
      });
    });

    describe('Cancellation', () => {
      it('should calculate pro-rata refund for cancellation', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateProRataBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          99.00,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          new Date('2024-06-01'),
          new Date('2024-06-10'), // Cancel after 10 days
          'cancellation',
          'US',
          'USD',
        );

        expect(calculation.proRataAdjustment?.reason).toContain('cancellation');
        expect(calculation.proRataAdjustment?.factor).toBeLessThan(1);
      });
    });

    describe('Daily Pro-rata', () => {
      it('should calculate daily pro-rata accurately', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const baseFee = 100.00;

        const calculation = await service.calculateProRataBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          baseFee,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          new Date('2024-06-16'),
          new Date('2024-06-30'),
          'mid_cycle_start',
          'US',
          'USD',
        );

        // Pro-rata factor should be less than 1 (partial month)
        expect(calculation.proRataAdjustment?.factor).toBeLessThan(1);
        expect(calculation.proRataAdjustment?.factor).toBeGreaterThan(0);
        // Pro-rated adjustment should be non-zero
        expect(calculation.proRataAdjustment?.adjustment).toBeDefined();
      });
    });
  });

  // ============================================================================
  // TAX CALCULATION TESTS
  // ============================================================================
  describe('Tax Calculations', () => {
    describe('Regional Tax Rates', () => {
      it('should apply Turkish VAT (18%)', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          100.00,
          'TR',
          'USD',
        );

        expect(calculation.taxes.length).toBeGreaterThan(0);
        expect(calculation.taxes[0]?.rate).toBe(18);
        expect(calculation.taxes[0]?.name).toBe('KDV');
        expect(calculation.totalTax).toBe(18.00);
      });

      it('should apply German VAT (19%)', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          100.00,
          'DE',
          'USD',
        );

        expect(calculation.taxes[0]?.rate).toBe(19);
        expect(calculation.taxes[0]?.name).toBe('MwSt');
      });

      it('should apply UK VAT (20%)', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          100.00,
          'GB',
          'USD',
        );

        expect(calculation.taxes[0]?.rate).toBe(20);
      });

      it('should apply Japanese consumption tax (10%)', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          100.00,
          'JP',
          'USD',
        );

        expect(calculation.taxes[0]?.rate).toBe(10);
      });

      it('should apply Australian GST (10%)', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          100.00,
          'AU',
          'USD',
        );

        expect(calculation.taxes[0]?.rate).toBe(10);
      });

      it('should apply US state sales tax', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calcCA = await service.calculateBilling(
          'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
          new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US-CA', 'USD',
        );

        expect(calcCA.taxes[0]?.rate).toBe(7.25);
      });

      it('should handle regions with no tax', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          100.00,
          'US', // No federal sales tax
          'USD',
        );

        expect(calculation.totalTax).toBe(0);
      });
    });

    describe('Tax Configuration', () => {
      it('should get tax rate for region', () => {
        const taxRate = service.getTaxRate('TR');

        expect(taxRate).toBeDefined();
        expect(taxRate?.rate).toBe(18);
        expect(taxRate?.taxType).toBe('VAT');
        expect(taxRate?.country).toBe('Turkey');
      });

      it('should return undefined for unknown region', () => {
        const taxRate = service.getTaxRate('UNKNOWN');
        expect(taxRate).toBeUndefined();
      });

      it('should list supported tax regions', () => {
        const regions = service.getSupportedTaxRegions();

        expect(regions).toContain('TR');
        expect(regions).toContain('DE');
        expect(regions).toContain('GB');
        expect(regions).toContain('JP');
        expect(regions).toContain('AU');
        expect(regions.length).toBeGreaterThan(10);
      });
    });

    describe('Tax Calculation Accuracy', () => {
      it('should calculate tax after base and metered charges', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([
          {
            tenantId: 'tenant-1',
            meterType: MeterType.API_CALLS,
            totalUsage: 50000,
            period: AggregationPeriod.MONTHLY,
          } as AggregatedUsage,
        ]);

        const calculation = await service.calculateBilling(
          'sub-1',
          'tenant-1',
          PlanTier.STARTER,
          BillingCycle.MONTHLY,
          new Date('2024-06-01'),
          new Date('2024-06-30'),
          100.00,
          'TR',
          'USD',
        );

        const expectedTaxBase = calculation.subtotalBeforeTax;
        const expectedTax = expectedTaxBase * 0.18;
        expect(calculation.totalTax).toBeCloseTo(expectedTax, 2);
      });
    });
  });

  // ============================================================================
  // CURRENCY HANDLING TESTS
  // ============================================================================
  describe('Currency Handling', () => {
    describe('Multi-currency Support', () => {
      it('should support USD as base currency', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
          new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
        );

        expect(calculation.currency).toBe('USD');
      });

      it('should convert to EUR', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
          new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'EUR',
        );

        expect(calculation.currency).toBe('EUR');
        expect(calculation.finalTotal).toBeLessThan(100); // EUR is stronger
      });

      it('should convert to TRY', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
          new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'TR', 'TRY',
        );

        expect(calculation.currency).toBe('TRY');
        expect(calculation.finalTotal).toBeGreaterThan(100); // TRY is weaker
      });

      it('should convert to GBP', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
          new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'GB', 'GBP',
        );

        expect(calculation.currency).toBe('GBP');
      });

      it('should convert to JPY', async () => {
        mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

        const calculation = await service.calculateBilling(
          'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
          new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'JP', 'JPY',
        );

        expect(calculation.currency).toBe('JPY');
        expect(calculation.finalTotal).toBeGreaterThan(1000); // JPY has no decimal
      });
    });

    describe('Exchange Rate Management', () => {
      it('should get exchange rate', () => {
        const rate = service.getExchangeRate('USD', 'EUR');
        expect(rate).toBeCloseTo(0.92, 1);
      });

      it('should return 1 for same currency', () => {
        const rate = service.getExchangeRate('USD', 'USD');
        expect(rate).toBe(1);
      });

      it('should calculate reverse rate', () => {
        const usdToEur = service.getExchangeRate('USD', 'EUR');
        const eurToUsd = service.getExchangeRate('EUR', 'USD');
        expect(usdToEur * eurToUsd).toBeCloseTo(1, 1);
      });

      it('should throw error for unsupported currency pair', () => {
        expect(() => service.getExchangeRate('USD', 'XYZ')).toThrow();
      });

      it('should update exchange rate', async () => {
        await service.updateExchangeRate('USD', 'EUR', 0.95);

        const rate = service.getExchangeRate('USD', 'EUR');
        expect(rate).toBe(0.95);
      });
    });

    describe('Currency Conversion', () => {
      it('should convert amount correctly', () => {
        const converted = service.convertCurrency(100, 'USD', 'EUR');
        expect(converted).toBeCloseTo(92, 0);
      });

      it('should maintain precision after conversion', () => {
        const converted = service.convertCurrency(99.99, 'USD', 'EUR');
        const decimalPlaces = (converted.toString().split('.')[1] || '').length;
        expect(decimalPlaces).toBeLessThanOrEqual(2);
      });
    });
  });

  // ============================================================================
  // INVOICE PREVIEW TESTS
  // ============================================================================
  describe('Invoice Preview', () => {
    it('should generate invoice preview', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([
        {
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          totalUsage: 20000,
          period: AggregationPeriod.MONTHLY,
        } as AggregatedUsage,
      ]);

      const preview = await service.generateInvoicePreview(
        'sub-1',
        'tenant-1',
        PlanTier.STARTER,
        BillingCycle.MONTHLY,
        99.00,
        new Date('2024-06-01'),
        new Date('2024-06-30'),
        'US',
        'USD',
      );

      expect(preview).toBeDefined();
      expect(preview.estimatedCharges).toBe(true);
      expect(preview.projectedUsage).toBeDefined();
    });

    it('should project usage to end of period', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([
        {
          tenantId: 'tenant-1',
          meterType: MeterType.API_CALLS,
          totalUsage: 10000, // Half month
          period: AggregationPeriod.MONTHLY,
        } as AggregatedUsage,
      ]);

      const preview = await service.generateInvoicePreview(
        'sub-1',
        'tenant-1',
        PlanTier.STARTER,
        BillingCycle.MONTHLY,
        99.00,
        new Date('2024-06-01'),
        new Date('2024-06-30'),
        'US',
        'USD',
      );

      // Preview should include projected usage and total
      expect(preview.projectedUsage).toBeDefined();
      expect(preview.total).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // CREDITS AND DISCOUNTS TESTS
  // ============================================================================
  describe('Credits', () => {
    it('should apply credit to calculation', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      const withCredit = service.applyCredits(calculation, 25.00, 'Promotional credit');

      expect(withCredit.credits?.amount).toBe(25.00);
      expect(withCredit.credits?.reason).toBe('Promotional credit');
      expect(withCredit.finalTotal).toBe(75.00);
    });

    it('should not apply credit greater than total', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 50.00, 'US', 'USD',
      );

      const withCredit = service.applyCredits(calculation, 100.00, 'Large credit');

      expect(withCredit.credits?.amount).toBe(50.00); // Capped at total
      expect(withCredit.finalTotal).toBe(0);
    });
  });

  describe('Discounts', () => {
    it('should apply percentage discount', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      const withDiscount = service.applyDiscount(calculation, 'SAVE20', 'percentage', 20);

      expect(withDiscount.discounts?.[0]?.code).toBe('SAVE20');
      expect(withDiscount.discounts?.[0]?.type).toBe('percentage');
      expect(withDiscount.discounts?.[0]?.amount).toBe(20.00);
    });

    it('should apply fixed amount discount', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      const withDiscount = service.applyDiscount(calculation, 'FLAT25', 'fixed', 25);

      expect(withDiscount.discounts?.[0]?.type).toBe('fixed');
      expect(withDiscount.discounts?.[0]?.amount).toBe(25.00);
    });

    it('should recalculate tax after discount', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'TR', 'USD',
      );

      const originalTax = calculation.totalTax;

      const withDiscount = service.applyDiscount(calculation, 'SAVE50', 'percentage', 50);

      // Tax should be recalculated on discounted amount
      expect(withDiscount.totalTax).toBeLessThan(originalTax);
      expect(withDiscount.totalTax).toBeCloseTo(9.00, 2); // 18% of 50
    });

    it('should apply multiple discounts', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      let withDiscounts = service.applyDiscount(calculation, 'FIRST10', 'percentage', 10);
      withDiscounts = service.applyDiscount(withDiscounts, 'EXTRA5', 'fixed', 5);

      expect(withDiscounts.discounts?.length).toBe(2);
    });
  });

  // ============================================================================
  // CACHING TESTS
  // ============================================================================
  describe('Calculation Caching', () => {
    it('should cache calculation results', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      const first = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      const second = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      // Should return cached result
      expect(mockUsageAggregator.getAggregationsInRange).toHaveBeenCalledTimes(1);
    });

    it('should clear cache by subscription', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      service.clearCache('sub-1');

      await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      expect(mockUsageAggregator.getAggregationsInRange).toHaveBeenCalledTimes(2);
    });

    it('should clear all cache', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      await service.calculateBilling(
        'sub-2', 'tenant-2', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      service.clearCache();

      await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      expect(mockUsageAggregator.getAggregationsInRange).toHaveBeenCalledTimes(3);
    });
  });

  // ============================================================================
  // EVENT EMISSION TESTS
  // ============================================================================
  describe('Event Emission', () => {
    it('should emit billing.calculated event', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 100.00, 'US', 'USD',
      );

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'billing.calculated',
        expect.objectContaining({
          subscriptionId: 'sub-1',
          tenantId: 'tenant-1',
        }),
      );
    });

    it('should emit billing.prorata.calculated event', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      await service.calculateProRataBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, 100.00,
        new Date('2024-06-01'), new Date('2024-06-30'),
        new Date('2024-06-15'), new Date('2024-06-30'),
        'upgrade', 'US', 'USD',
      );

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'billing.prorata.calculated',
        expect.objectContaining({
          subscriptionId: 'sub-1',
          reason: 'upgrade',
        }),
      );
    });

    it('should emit billing.exchange_rate.updated event', async () => {
      await service.updateExchangeRate('USD', 'EUR', 0.95);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'billing.exchange_rate.updated',
        expect.objectContaining({
          from: 'USD',
          to: 'EUR',
          rate: 0.95,
        }),
      );
    });
  });

  // ============================================================================
  // BILLING CYCLE TESTS
  // ============================================================================
  describe('Billing Cycles', () => {
    it('should handle monthly billing cycle', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 99.00, 'US', 'USD',
      );

      expect(calculation).toBeDefined();
    });

    it('should handle quarterly billing cycle', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.QUARTERLY,
        new Date('2024-04-01'), new Date('2024-06-30'), 297.00, 'US', 'USD',
      );

      expect(calculation).toBeDefined();
    });

    it('should handle annual billing cycle', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.ANNUAL,
        new Date('2024-01-01'), new Date('2024-12-31'), 1188.00, 'US', 'USD',
      );

      expect(calculation).toBeDefined();
    });
  });

  // ============================================================================
  // METER BREAKDOWN TESTS
  // ============================================================================
  describe('Meter Breakdowns', () => {
    it('should include all meter types in breakdown', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([
        { tenantId: 'tenant-1', meterType: MeterType.API_CALLS, totalUsage: 50000 } as AggregatedUsage,
        { tenantId: 'tenant-1', meterType: MeterType.DATA_STORAGE, totalUsage: 20 } as AggregatedUsage,
        { tenantId: 'tenant-1', meterType: MeterType.SENSOR_READINGS, totalUsage: 500000 } as AggregatedUsage,
      ]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 99.00, 'US', 'USD',
      );

      expect(calculation.meterBreakdowns.length).toBeGreaterThan(0);

      const meterTypes = calculation.meterBreakdowns.map((b) => b.meterType);
      expect(meterTypes).toContain(MeterType.API_CALLS);
      expect(meterTypes).toContain(MeterType.DATA_STORAGE);
      expect(meterTypes).toContain(MeterType.SENSOR_READINGS);
    });

    it('should include tier breakdown for each meter', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([
        { tenantId: 'tenant-1', meterType: MeterType.API_CALLS, totalUsage: 100000 } as AggregatedUsage,
      ]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 99.00, 'US', 'USD',
      );

      const apiBreakdown = calculation.meterBreakdowns.find(
        (b) => b.meterType === MeterType.API_CALLS,
      );

      expect(apiBreakdown?.tierBreakdown).toBeDefined();
      expect(apiBreakdown?.tierBreakdown.length).toBeGreaterThan(0);
    });

    it('should show correct units in breakdown', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([
        { tenantId: 'tenant-1', meterType: MeterType.API_CALLS, totalUsage: 50000 } as AggregatedUsage,
      ]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 99.00, 'US', 'USD',
      );

      const apiBreakdown = calculation.meterBreakdowns.find(
        (b) => b.meterType === MeterType.API_CALLS,
      );

      expect(apiBreakdown?.totalUnits).toBe(50000);
      expect(apiBreakdown?.includedUnits).toBe(10000);
      expect(apiBreakdown?.billableUnits).toBe(40000);
    });
  });

  // ============================================================================
  // EDGE CASES
  // ============================================================================
  describe('Edge Cases', () => {
    it('should handle very large usage numbers', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([
        { tenantId: 'tenant-1', meterType: MeterType.API_CALLS, totalUsage: 100000000 } as AggregatedUsage,
      ]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.ENTERPRISE, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 999.00, 'US', 'USD',
      );

      expect(calculation.subtotalMetered).toBeGreaterThan(0);
      expect(Number.isFinite(calculation.finalTotal)).toBe(true);
    });

    it('should handle decimal usage values', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([
        { tenantId: 'tenant-1', meterType: MeterType.DATA_STORAGE, totalUsage: 10.5 } as AggregatedUsage,
      ]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 99.00, 'US', 'USD',
      );

      const storageBreakdown = calculation.meterBreakdowns.find(
        (b) => b.meterType === MeterType.DATA_STORAGE,
      );

      expect(storageBreakdown?.totalUnits).toBe(10.5);
    });

    it('should handle zero base plan fee', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([
        { tenantId: 'tenant-1', meterType: MeterType.API_CALLS, totalUsage: 50000 } as AggregatedUsage,
      ]);

      const calculation = await service.calculateBilling(
        'sub-1', 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
        new Date('2024-06-01'), new Date('2024-06-30'), 0, 'US', 'USD',
      );

      expect(calculation.basePlanFee).toBe(0);
      expect(calculation.subtotalMetered).toBeGreaterThan(0);
    });

    it('should handle concurrent billing calculations', async () => {
      mockUsageAggregator.getAggregationsInRange.mockReturnValue([]);

      const promises = Array.from({ length: 10 }, (_, i) =>
        service.calculateBilling(
          `sub-${i}`, 'tenant-1', PlanTier.STARTER, BillingCycle.MONTHLY,
          new Date('2024-06-01'), new Date('2024-06-30'), 99.00, 'US', 'USD',
        ),
      );

      const results = await Promise.all(promises);

      expect(results.length).toBe(10);
      results.forEach((calc) => {
        expect(calc.finalTotal).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
