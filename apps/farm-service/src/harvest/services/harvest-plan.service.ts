/**
 * HarvestPlan Service
 *
 * Service for managing harvest plans in the harvest module.
 * Handles CRUD operations and complex queries with tenant isolation.
 *
 * @module Harvest
 */
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import {
  HarvestPlan,
  HarvestPlanStatus,
  HarvestCriteria,
  HarvestEstimates,
  FinancialProjection,
  LogisticsPlan,
  CustomerOrder,
  QualityRequirements,
} from '../entities/harvest-plan.entity';
import { CreateHarvestPlanInput } from '../dto/create-harvest-plan.input';
import { UpdateHarvestPlanInput } from '../dto/update-harvest-plan.input';
import { HarvestPlanFilterInput } from '../dto/harvest-plan-filter.input';
import { BatchHarvestEligibilityService } from '../../fish-health/services/batch-harvest-eligibility.service';

// ============================================================================
// INTERFACES
// ============================================================================

export interface HarvestPlanStats {
  total: number;
  draft: number;
  planned: number;
  approved: number;
  scheduled: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  postponed: number;
  totalEstimatedBiomass: number;
  totalActualBiomass: number;
  upcomingCount: number;
  overdueCount: number;
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class HarvestPlanService {
  private readonly logger = new Logger(HarvestPlanService.name);

  constructor(
    @InjectRepository(HarvestPlan)
    private readonly harvestPlanRepository: Repository<HarvestPlan>,
    private readonly harvestEligibility: BatchHarvestEligibilityService,
  ) {}

  // =========================================================================
  // CRUD OPERATIONS
  // =========================================================================

  /**
   * Create a new harvest plan
   */
  async create(
    tenantId: string,
    input: CreateHarvestPlanInput,
    userId: string,
  ): Promise<HarvestPlan> {
    // ── COMPLIANCE ADVISORY: withdrawal-period check on planned date ──
    //
    // The plan is NOT blocked if the proposed plannedDate falls inside
    // an active medicine withdrawal window — plans are planning
    // artefacts, not physical harvest events, and the operator may
    // deliberately schedule the harvest for AFTER the withdrawal
    // clears. But a plan that ignores an open treatment altogether is
    // a compliance risk, so we log a warning with the full list of
    // blocking events. The hard block lives in
    // `create-harvest-record.handler.ts` — no physical harvest can
    // happen until the withdrawal is clear.
    //
    // The `batchHarvestEligibility` GraphQL query surfaces the same
    // information to the UI at submit time; this log acts as a
    // server-side audit trail.
    const plannedDate = input.plannedDate ?? new Date();
    const eligibility = await this.harvestEligibility.checkEligibility(
      tenantId,
      input.batchId,
      plannedDate instanceof Date ? plannedDate : new Date(plannedDate),
    );
    if (!eligibility.eligible) {
      this.logger.warn(
        `Harvest plan for batch ${input.batchId} scheduled inside an ` +
          `active withdrawal window. plannedDate=${plannedDate.toString()}, ` +
          `earliestHarvestDate=${eligibility.blockedUntil?.toISOString().slice(0, 10)}, ` +
          `blocking events=${eligibility.blockingEvents.map((e) => e.id).join(', ')}. ` +
          `Plan will be created but createHarvestRecord will reject until the ` +
          `withdrawal period clears.`,
      );
    }

    // Generate plan code
    const planCode = await this.generatePlanCode(tenantId);

    // Build criteria object
    const criteria: HarvestCriteria = {
      targetWeight: {
        min: input.criteria.targetWeightMin,
        max: input.criteria.targetWeightMax,
        target: input.criteria.targetWeightTarget,
      },
      targetQuantity: input.criteria.targetQuantityValue
        ? {
            value: input.criteria.targetQuantityValue,
            unit: input.criteria.targetQuantityUnit as 'pieces' | 'kg' | 'percent',
          }
        : undefined,
      qualityGrade: input.criteria.qualityGrade,
      minimumConditionFactor: input.criteria.minimumConditionFactor,
    };

    // Build estimates object
    const estimates: HarvestEstimates = {
      estimatedQuantity: input.estimates.estimatedQuantity,
      estimatedBiomass: input.estimates.estimatedBiomass,
      estimatedAvgWeight: input.estimates.estimatedAvgWeight,
      estimatedYield: input.estimates.estimatedYield,
      confidenceLevel: input.estimates.confidenceLevel as 'low' | 'medium' | 'high',
      basedOnMeasurementDate: input.estimates.basedOnMeasurementDate,
    };

    // Build optional objects
    const financialProjection: FinancialProjection | undefined = input.financialProjection
      ? {
          estimatedRevenue: input.financialProjection.estimatedRevenue,
          estimatedPrice: input.financialProjection.estimatedPrice,
          priceUnit: input.financialProjection.priceUnit as 'per_kg' | 'per_piece',
          estimatedCost: input.financialProjection.estimatedCost,
          estimatedProfit: input.financialProjection.estimatedProfit,
          margin: input.financialProjection.margin,
          currency: input.financialProjection.currency,
        }
      : undefined;

    const logistics: LogisticsPlan | undefined = input.logistics
      ? {
          harvestStartTime: input.logistics.harvestStartTime,
          expectedDuration: input.logistics.expectedDuration,
          requiredEquipment: input.logistics.requiredEquipment,
          requiredPersonnel: input.logistics.requiredPersonnel,
          transportType: input.logistics.transportType as 'truck' | 'boat' | 'container',
          transportCapacity: input.logistics.transportCapacity,
          destinationType: input.logistics.destinationType as 'processing' | 'market' | 'direct_sale' | 'export',
          destinationAddress: input.logistics.destinationAddress,
          coldChainRequired: input.logistics.coldChainRequired,
        }
      : undefined;

    const customerOrder: CustomerOrder | undefined = input.customerOrder
      ? {
          customerId: input.customerOrder.customerId,
          customerName: input.customerOrder.customerName,
          orderId: input.customerOrder.orderId,
          orderQuantity: input.customerOrder.orderQuantity,
          orderUnit: input.customerOrder.orderUnit,
          deliveryDate: input.customerOrder.deliveryDate,
          contractPrice: input.customerOrder.contractPrice,
        }
      : undefined;

    const qualityRequirements: QualityRequirements | undefined = input.qualityRequirements
      ? {
          certifications: input.qualityRequirements.certifications,
          sizeGrading: input.qualityRequirements.sizeGrading,
          qualityInspection: input.qualityRequirements.qualityInspection,
          traceabilityRequired: input.qualityRequirements.traceabilityRequired,
          specificRequirements: input.qualityRequirements.specificRequirements,
        }
      : undefined;

    const plan = this.harvestPlanRepository.create({
      tenantId,
      planCode,
      name: input.name,
      description: input.description,
      batchId: input.batchId,
      status: input.status || HarvestPlanStatus.DRAFT,
      harvestType: input.harvestType,
      plannedDate: input.plannedDate,
      confirmedDate: input.confirmedDate,
      windowStartDate: input.windowStartDate,
      windowEndDate: input.windowEndDate,
      criteria,
      harvestMethod: input.harvestMethod,
      productForm: input.productForm,
      estimates,
      financialProjection,
      logistics,
      customerOrder,
      qualityRequirements,
      notes: input.notes,
      attachments: input.attachments,
      createdBy: userId,
    });

    const saved = await this.harvestPlanRepository.save(plan);
    this.logger.log(`Created harvest plan ${saved.id} (${planCode}) for batch ${input.batchId}`);
    return saved;
  }

  /**
   * Update an existing harvest plan
   */
  async update(
    tenantId: string,
    input: UpdateHarvestPlanInput,
    userId: string,
  ): Promise<HarvestPlan> {
    const plan = await this.findByIdOrFail(tenantId, input.id);

    // Check if plan can be edited
    if (
      plan.status === HarvestPlanStatus.COMPLETED ||
      plan.status === HarvestPlanStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Cannot update harvest plan with status ${plan.status}`,
      );
    }

    // Update simple fields
    if (input.name !== undefined) plan.name = input.name;
    if (input.description !== undefined) plan.description = input.description;
    if (input.status !== undefined) plan.status = input.status;
    if (input.harvestType !== undefined) plan.harvestType = input.harvestType;
    if (input.plannedDate !== undefined) plan.plannedDate = input.plannedDate;
    if (input.confirmedDate !== undefined) plan.confirmedDate = input.confirmedDate;
    if (input.windowStartDate !== undefined) plan.windowStartDate = input.windowStartDate;
    if (input.windowEndDate !== undefined) plan.windowEndDate = input.windowEndDate;
    if (input.harvestMethod !== undefined) plan.harvestMethod = input.harvestMethod;
    if (input.productForm !== undefined) plan.productForm = input.productForm;
    if (input.notes !== undefined) plan.notes = input.notes;
    if (input.attachments !== undefined) plan.attachments = input.attachments;
    if (input.actualQuantityHarvested !== undefined) plan.actualQuantityHarvested = input.actualQuantityHarvested;
    if (input.actualBiomassHarvested !== undefined) plan.actualBiomassHarvested = input.actualBiomassHarvested;
    if (input.actualAvgWeight !== undefined) plan.actualAvgWeight = input.actualAvgWeight;

    // Update criteria if provided
    if (input.criteria) {
      plan.criteria = {
        targetWeight: {
          min: input.criteria.targetWeightMin,
          max: input.criteria.targetWeightMax,
          target: input.criteria.targetWeightTarget,
        },
        targetQuantity: input.criteria.targetQuantityValue
          ? {
              value: input.criteria.targetQuantityValue,
              unit: input.criteria.targetQuantityUnit as 'pieces' | 'kg' | 'percent',
            }
          : undefined,
        qualityGrade: input.criteria.qualityGrade,
        minimumConditionFactor: input.criteria.minimumConditionFactor,
      };
    }

    // Update estimates if provided
    if (input.estimates) {
      plan.estimates = {
        estimatedQuantity: input.estimates.estimatedQuantity,
        estimatedBiomass: input.estimates.estimatedBiomass,
        estimatedAvgWeight: input.estimates.estimatedAvgWeight,
        estimatedYield: input.estimates.estimatedYield,
        confidenceLevel: input.estimates.confidenceLevel as 'low' | 'medium' | 'high',
        basedOnMeasurementDate: input.estimates.basedOnMeasurementDate,
      };
    }

    // Update financial projection if provided
    if (input.financialProjection) {
      plan.financialProjection = {
        estimatedRevenue: input.financialProjection.estimatedRevenue,
        estimatedPrice: input.financialProjection.estimatedPrice,
        priceUnit: input.financialProjection.priceUnit as 'per_kg' | 'per_piece',
        estimatedCost: input.financialProjection.estimatedCost,
        estimatedProfit: input.financialProjection.estimatedProfit,
        margin: input.financialProjection.margin,
        currency: input.financialProjection.currency,
      };
    }

    // Update logistics if provided
    if (input.logistics) {
      plan.logistics = {
        harvestStartTime: input.logistics.harvestStartTime,
        expectedDuration: input.logistics.expectedDuration,
        requiredEquipment: input.logistics.requiredEquipment,
        requiredPersonnel: input.logistics.requiredPersonnel,
        transportType: input.logistics.transportType as 'truck' | 'boat' | 'container',
        transportCapacity: input.logistics.transportCapacity,
        destinationType: input.logistics.destinationType as 'processing' | 'market' | 'direct_sale' | 'export',
        destinationAddress: input.logistics.destinationAddress,
        coldChainRequired: input.logistics.coldChainRequired,
      };
    }

    // Update customer order if provided
    if (input.customerOrder) {
      plan.customerOrder = {
        customerId: input.customerOrder.customerId,
        customerName: input.customerOrder.customerName,
        orderId: input.customerOrder.orderId,
        orderQuantity: input.customerOrder.orderQuantity,
        orderUnit: input.customerOrder.orderUnit,
        deliveryDate: input.customerOrder.deliveryDate,
        contractPrice: input.customerOrder.contractPrice,
      };
    }

    // Update quality requirements if provided
    if (input.qualityRequirements) {
      plan.qualityRequirements = {
        certifications: input.qualityRequirements.certifications,
        sizeGrading: input.qualityRequirements.sizeGrading,
        qualityInspection: input.qualityRequirements.qualityInspection,
        traceabilityRequired: input.qualityRequirements.traceabilityRequired,
        specificRequirements: input.qualityRequirements.specificRequirements,
      };
    }

    const updated = await this.harvestPlanRepository.save(plan);
    this.logger.log(`Updated harvest plan ${input.id}`);
    return updated;
  }

  /**
   * Delete a harvest plan
   */
  async delete(tenantId: string, id: string): Promise<boolean> {
    const plan = await this.findByIdOrFail(tenantId, id);

    // Only allow deletion of draft plans
    if (plan.status !== HarvestPlanStatus.DRAFT) {
      throw new BadRequestException(
        `Cannot delete harvest plan with status ${plan.status}. Only draft plans can be deleted.`,
      );
    }

    await this.harvestPlanRepository.remove(plan);
    this.logger.log(`Deleted harvest plan ${id}`);
    return true;
  }

  // =========================================================================
  // QUERY METHODS
  // =========================================================================

  /**
   * Find a harvest plan by ID
   */
  async findById(tenantId: string, id: string): Promise<HarvestPlan | null> {
    return this.harvestPlanRepository.findOne({
      where: { id, tenantId },
    });
  }

  /**
   * Find a harvest plan by ID or throw
   */
  async findByIdOrFail(tenantId: string, id: string): Promise<HarvestPlan> {
    const plan = await this.findById(tenantId, id);
    if (!plan) {
      throw new NotFoundException(`Harvest plan ${id} not found`);
    }
    return plan;
  }

  // =========================================================================
  // WORKFLOW OPERATIONS
  // =========================================================================

  /**
   * Approve a harvest plan
   */
  async approve(tenantId: string, id: string, userId: string): Promise<HarvestPlan> {
    const plan = await this.findByIdOrFail(tenantId, id);

    if (plan.status !== HarvestPlanStatus.PLANNED) {
      throw new BadRequestException(
        `Cannot approve harvest plan with status ${plan.status}. Plan must be in 'planned' status.`,
      );
    }

    plan.approve(userId);
    const updated = await this.harvestPlanRepository.save(plan);
    this.logger.log(`Approved harvest plan ${id}`);
    return updated;
  }

  /**
   * Schedule a harvest plan (set confirmed date)
   */
  async schedule(
    tenantId: string,
    id: string,
    confirmedDate: Date,
    _userId: string,
  ): Promise<HarvestPlan> {
    const plan = await this.findByIdOrFail(tenantId, id);

    if (plan.status !== HarvestPlanStatus.APPROVED) {
      throw new BadRequestException(
        `Cannot schedule harvest plan with status ${plan.status}. Plan must be approved first.`,
      );
    }

    plan.schedule(confirmedDate);
    const updated = await this.harvestPlanRepository.save(plan);
    this.logger.log(`Scheduled harvest plan ${id} for ${confirmedDate}`);
    return updated;
  }

  /**
   * Start harvest
   */
  async startHarvest(tenantId: string, id: string, _userId: string): Promise<HarvestPlan> {
    const plan = await this.findByIdOrFail(tenantId, id);

    if (plan.status !== HarvestPlanStatus.SCHEDULED) {
      throw new BadRequestException(
        `Cannot start harvest for plan with status ${plan.status}. Plan must be scheduled first.`,
      );
    }

    plan.startHarvest();
    const updated = await this.harvestPlanRepository.save(plan);
    this.logger.log(`Started harvest for plan ${id}`);
    return updated;
  }

  /**
   * Complete harvest
   */
  async completeHarvest(
    tenantId: string,
    id: string,
    actualQuantity: number,
    actualBiomass: number,
    actualAvgWeight: number,
    _userId: string,
  ): Promise<HarvestPlan> {
    const plan = await this.findByIdOrFail(tenantId, id);

    if (plan.status !== HarvestPlanStatus.IN_PROGRESS) {
      throw new BadRequestException(
        `Cannot complete harvest for plan with status ${plan.status}. Harvest must be in progress.`,
      );
    }

    plan.complete(actualQuantity, actualBiomass, actualAvgWeight);
    const updated = await this.harvestPlanRepository.save(plan);
    this.logger.log(`Completed harvest for plan ${id}`);
    return updated;
  }

  /**
   * Cancel a harvest plan
   */
  async cancel(tenantId: string, id: string, _userId: string): Promise<HarvestPlan> {
    const plan = await this.findByIdOrFail(tenantId, id);

    if (
      plan.status === HarvestPlanStatus.COMPLETED ||
      plan.status === HarvestPlanStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Cannot cancel harvest plan with status ${plan.status}.`,
      );
    }

    plan.cancel();
    const updated = await this.harvestPlanRepository.save(plan);
    this.logger.log(`Cancelled harvest plan ${id}`);
    return updated;
  }

  /**
   * Postpone a harvest plan
   */
  async postpone(
    tenantId: string,
    id: string,
    newDate: Date,
    _userId: string,
  ): Promise<HarvestPlan> {
    const plan = await this.findByIdOrFail(tenantId, id);

    if (
      plan.status === HarvestPlanStatus.COMPLETED ||
      plan.status === HarvestPlanStatus.CANCELLED ||
      plan.status === HarvestPlanStatus.IN_PROGRESS
    ) {
      throw new BadRequestException(
        `Cannot postpone harvest plan with status ${plan.status}.`,
      );
    }

    plan.postpone(newDate);
    const updated = await this.harvestPlanRepository.save(plan);
    this.logger.log(`Postponed harvest plan ${id} to ${newDate}`);
    return updated;
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  /**
   * Generate a unique plan code
   */
  private async generatePlanCode(tenantId: string): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `HP-${year}-`;

    // Find the latest plan code for this tenant and year
    const latestPlan = await this.harvestPlanRepository
      .createQueryBuilder('hp')
      .where('hp.tenantId = :tenantId', { tenantId })
      .andWhere('hp.planCode LIKE :prefix', { prefix: `${prefix}%` })
      .orderBy('hp.planCode', 'DESC')
      .getOne();

    let nextNumber = 1;
    if (latestPlan) {
      const currentNumber = parseInt(latestPlan.planCode.replace(prefix, ''), 10);
      nextNumber = currentNumber + 1;
    }

    return `${prefix}${nextNumber.toString().padStart(5, '0')}`;
  }

  /**
   * Apply harvest-plan filters to a query builder. Static so the
   * ListHarvestPlansHandler reuses this exact WHERE logic (single SSoT) without
   * a service dependency or duplicated filter code.
   */
  static applyFilters(
    query: SelectQueryBuilder<HarvestPlan>,
    filter?: HarvestPlanFilterInput,
  ): void {
    if (!filter) return;

    // Batch filters
    if (filter.batchId) {
      query.andWhere('hp.batchId = :batchId', { batchId: filter.batchId });
    }
    if (filter.batchIds?.length) {
      query.andWhere('hp.batchId IN (:...batchIds)', { batchIds: filter.batchIds });
    }

    // Status filters
    if (filter.status) {
      query.andWhere('hp.status = :status', { status: filter.status });
    }
    if (filter.statuses?.length) {
      query.andWhere('hp.status IN (:...statuses)', { statuses: filter.statuses });
    }

    // Type filters
    if (filter.harvestType) {
      query.andWhere('hp.harvestType = :harvestType', { harvestType: filter.harvestType });
    }
    if (filter.harvestTypes?.length) {
      query.andWhere('hp.harvestType IN (:...harvestTypes)', { harvestTypes: filter.harvestTypes });
    }
    if (filter.harvestMethod) {
      query.andWhere('hp.harvestMethod = :harvestMethod', { harvestMethod: filter.harvestMethod });
    }
    if (filter.productForm) {
      query.andWhere('hp.productForm = :productForm', { productForm: filter.productForm });
    }

    // Date filters
    if (filter.plannedDateFrom) {
      query.andWhere('hp.plannedDate >= :plannedDateFrom', { plannedDateFrom: filter.plannedDateFrom });
    }
    if (filter.plannedDateTo) {
      query.andWhere('hp.plannedDate <= :plannedDateTo', { plannedDateTo: filter.plannedDateTo });
    }
    if (filter.confirmedDateFrom) {
      query.andWhere('hp.confirmedDate >= :confirmedDateFrom', { confirmedDateFrom: filter.confirmedDateFrom });
    }
    if (filter.confirmedDateTo) {
      query.andWhere('hp.confirmedDate <= :confirmedDateTo', { confirmedDateTo: filter.confirmedDateTo });
    }
    if (filter.createdFrom) {
      query.andWhere('hp.createdAt >= :createdFrom', { createdFrom: filter.createdFrom });
    }
    if (filter.createdTo) {
      query.andWhere('hp.createdAt <= :createdTo', { createdTo: filter.createdTo });
    }

    // User filters
    if (filter.createdBy) {
      query.andWhere('hp.createdBy = :createdBy', { createdBy: filter.createdBy });
    }
    if (filter.approvedBy) {
      query.andWhere('hp.approvedBy = :approvedBy', { approvedBy: filter.approvedBy });
    }

    // Customer filters
    if (filter.customerId) {
      query.andWhere("hp.customerOrder->>'customerId' = :customerId", { customerId: filter.customerId });
    }
    if (filter.orderId) {
      query.andWhere("hp.customerOrder->>'orderId' = :orderId", { orderId: filter.orderId });
    }

    // Text search
    if (filter.searchText) {
      query.andWhere(
        '(hp.planCode ILIKE :search OR hp.name ILIKE :search OR hp.notes ILIKE :search)',
        { search: `%${filter.searchText}%` },
      );
    }

    // Special filters
    if (filter.hasConfirmedDate === true) {
      query.andWhere('hp.confirmedDate IS NOT NULL');
    } else if (filter.hasConfirmedDate === false) {
      query.andWhere('hp.confirmedDate IS NULL');
    }

    if (filter.approvedOnly) {
      query.andWhere('hp.status IN (:...approvedStatuses)', {
        approvedStatuses: [
          HarvestPlanStatus.APPROVED,
          HarvestPlanStatus.SCHEDULED,
          HarvestPlanStatus.IN_PROGRESS,
          HarvestPlanStatus.COMPLETED,
        ],
      });
    }

    if (filter.activeOnly) {
      query.andWhere('hp.status NOT IN (:...inactiveStatuses)', {
        inactiveStatuses: [HarvestPlanStatus.COMPLETED, HarvestPlanStatus.CANCELLED],
      });
    }

    if (filter.overdueOnly) {
      const today = new Date();
      query.andWhere('hp.plannedDate < :today', { today });
      query.andWhere('hp.status NOT IN (:...completedStatuses)', {
        completedStatuses: [HarvestPlanStatus.COMPLETED, HarvestPlanStatus.CANCELLED],
      });
    }

    if (filter.upcomingDays) {
      const today = new Date();
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + filter.upcomingDays);
      query.andWhere('hp.plannedDate BETWEEN :today AND :futureDate', { today, futureDate });
      query.andWhere('hp.status NOT IN (:...completedStatuses)', {
        completedStatuses: [HarvestPlanStatus.COMPLETED, HarvestPlanStatus.CANCELLED],
      });
    }
  }
}
