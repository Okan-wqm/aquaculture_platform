/**
 * HealthEvent Service
 *
 * Service for managing health events in the fish health module.
 * Handles CRUD operations and complex queries.
 *
 * @module FishHealth
 */
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import {
  HealthEvent,
  HealthEventStatus,
  HealthSeverity,
  TreatmentDetails,
} from '../entities/health-event.entity';
import { CreateHealthEventInput } from '../dto/create-health-event.input';
import { UpdateHealthEventInput } from '../dto/update-health-event.input';
import { HealthEventFilterInput } from '../dto/health-event-filter.input';

export interface HealthEventStats {
  total: number;
  active: number;
  critical: number;
  underTreatment: number;
  quarantined: number;
  resolved: number;
  byEventType: Record<string, number>;
  bySeverity: Record<string, number>;
}

@Injectable()
export class HealthEventService {
  private readonly logger = new Logger(HealthEventService.name);

  constructor(
    @InjectRepository(HealthEvent)
    private readonly healthEventRepository: Repository<HealthEvent>,
  ) {}

  // =========================================================================
  // CRUD OPERATIONS
  // =========================================================================

  /**
   * Create a new health event
   */
  async create(
    tenantId: string,
    input: CreateHealthEventInput,
    userId: string,
  ): Promise<HealthEvent> {
    const event = this.healthEventRepository.create({
      ...input,
      tenantId,
      reportedBy: userId,
    });

    const saved = await this.healthEventRepository.save(event);
    this.logger.log(`Created health event ${saved.id} for batch ${input.batchId}`);
    return saved;
  }

  /**
   * Update an existing health event
   */
  async update(
    tenantId: string,
    id: string,
    input: UpdateHealthEventInput,
    _userId: string,
  ): Promise<HealthEvent> {
    const event = await this.findByIdOrFail(tenantId, id);

    Object.assign(event, input);

    const updated = await this.healthEventRepository.save(event);
    this.logger.log(`Updated health event ${id}`);
    return updated;
  }

  /**
   * Soft delete a health event
   */
  async delete(tenantId: string, id: string): Promise<boolean> {
    const event = await this.findByIdOrFail(tenantId, id);
    await this.healthEventRepository.remove(event);
    this.logger.log(`Deleted health event ${id}`);
    return true;
  }

  // =========================================================================
  // QUERY METHODS
  // =========================================================================

  /**
   * Find a health event by ID
   */
  async findById(tenantId: string, id: string): Promise<HealthEvent | null> {
    return this.healthEventRepository.findOne({
      where: { id, tenantId },
    });
  }

  /**
   * Find a health event by ID or throw
   */
  async findByIdOrFail(tenantId: string, id: string): Promise<HealthEvent> {
    const event = await this.findById(tenantId, id);
    if (!event) {
      throw new NotFoundException(`Health event ${id} not found`);
    }
    return event;
  }

  // =========================================================================
  // TREATMENT OPERATIONS
  // =========================================================================

  /**
   * Start treatment for a health event
   */
  async startTreatment(
    tenantId: string,
    id: string,
    treatment: TreatmentDetails,
    _userId: string,
  ): Promise<HealthEvent> {
    const event = await this.findByIdOrFail(tenantId, id);

    event.treatment = treatment;
    event.isUnderTreatment = true;

    // Calculate earliest harvest date if withdrawal period specified
    if (treatment.withdrawalPeriod) {
      const withdrawalDays = treatment.withdrawalPeriod;
      event.withdrawalPeriodDays = withdrawalDays;
      event.earliestHarvestDate = new Date(Date.now() + withdrawalDays * 24 * 60 * 60 * 1000);
    }

    return this.healthEventRepository.save(event);
  }

  /**
   * End treatment for a health event
   */
  async endTreatment(
    tenantId: string,
    id: string,
    notes: string | undefined,
    _userId: string,
  ): Promise<HealthEvent> {
    const event = await this.findByIdOrFail(tenantId, id);

    event.isUnderTreatment = false;
    event.treatmentEndDate = new Date();

    if (notes) {
      event.notes = event.notes ? `${event.notes}\n\nTreatment End: ${notes}` : notes;
    }

    return this.healthEventRepository.save(event);
  }

  /**
   * Start quarantine for a health event
   */
  async startQuarantine(
    tenantId: string,
    id: string,
    quarantineTankId: string | undefined,
    _userId: string,
  ): Promise<HealthEvent> {
    const event = await this.findByIdOrFail(tenantId, id);

    event.isQuarantined = true;
    event.quarantineStartDate = new Date();
    event.quarantineTankId = quarantineTankId;

    return this.healthEventRepository.save(event);
  }

  /**
   * End quarantine for a health event
   */
  async endQuarantine(
    tenantId: string,
    id: string,
    _userId: string,
  ): Promise<HealthEvent> {
    const event = await this.findByIdOrFail(tenantId, id);

    event.isQuarantined = false;
    event.quarantineEndDate = new Date();

    return this.healthEventRepository.save(event);
  }

  /**
   * Resolve a health event
   */
  async resolve(
    tenantId: string,
    id: string,
    notes: string | undefined,
    _userId: string,
  ): Promise<HealthEvent> {
    const event = await this.findByIdOrFail(tenantId, id);

    event.status = HealthEventStatus.RESOLVED;
    event.resolvedDate = new Date();

    if (notes) {
      event.resolutionNotes = notes;
    }

    return this.healthEventRepository.save(event);
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  // Static so the ListHealthEvents query handler reuses the one filter SSoT
  // without instantiating the service (FARM-HIGH-060 read-boundary migration).
  static applyFilters(
    query: SelectQueryBuilder<HealthEvent>,
    filter?: HealthEventFilterInput,
  ): void {
    if (!filter) return;

    // Location filters
    if (filter.batchId) {
      query.andWhere('he.batchId = :batchId', { batchId: filter.batchId });
    }
    if (filter.batchIds?.length) {
      query.andWhere('he.batchId IN (:...batchIds)', { batchIds: filter.batchIds });
    }
    if (filter.tankId) {
      query.andWhere('he.tankId = :tankId', { tankId: filter.tankId });
    }

    // Event type filters
    if (filter.eventType) {
      query.andWhere('he.eventType = :eventType', { eventType: filter.eventType });
    }
    if (filter.eventTypes?.length) {
      query.andWhere('he.eventType IN (:...eventTypes)', { eventTypes: filter.eventTypes });
    }

    // Severity and status filters
    if (filter.severity) {
      query.andWhere('he.severity = :severity', { severity: filter.severity });
    }
    if (filter.severities?.length) {
      query.andWhere('he.severity IN (:...severities)', { severities: filter.severities });
    }
    if (filter.status) {
      query.andWhere('he.status = :status', { status: filter.status });
    }
    if (filter.statuses?.length) {
      query.andWhere('he.status IN (:...statuses)', { statuses: filter.statuses });
    }

    // Disease filters
    if (filter.diseaseCategory) {
      query.andWhere('he.diseaseCategory = :diseaseCategory', { diseaseCategory: filter.diseaseCategory });
    }
    if (filter.diseaseName) {
      query.andWhere('he.diseaseName ILIKE :diseaseName', { diseaseName: `%${filter.diseaseName}%` });
    }

    // Date filters
    if (filter.fromDate) {
      query.andWhere('he.eventDate >= :fromDate', { fromDate: filter.fromDate });
    }
    if (filter.toDate) {
      query.andWhere('he.eventDate <= :toDate', { toDate: filter.toDate });
    }

    // Treatment filters
    if (filter.isUnderTreatment !== undefined) {
      query.andWhere('he.isUnderTreatment = :isUnderTreatment', { isUnderTreatment: filter.isUnderTreatment });
    }
    if (filter.isQuarantined !== undefined) {
      query.andWhere('he.isQuarantined = :isQuarantined', { isQuarantined: filter.isQuarantined });
    }

    // Special filters
    if (filter.activeOnly) {
      query.andWhere('he.status IN (:...activeStatuses)', {
        activeStatuses: [HealthEventStatus.ACTIVE, HealthEventStatus.MONITORING],
      });
    }
    if (filter.criticalOnly) {
      query.andWhere('he.severity IN (:...criticalSeverities)', {
        criticalSeverities: [HealthSeverity.CRITICAL, HealthSeverity.SEVERE],
      });
    }

    // Text search
    if (filter.searchText) {
      query.andWhere(
        '(he.title ILIKE :search OR he.description ILIKE :search OR he.notes ILIKE :search)',
        { search: `%${filter.searchText}%` },
      );
    }
  }
}
