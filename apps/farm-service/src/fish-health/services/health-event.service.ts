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
import { DataSource, Repository } from 'typeorm';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import {
  HealthEvent,
  HealthEventStatus,
  HealthSeverity,
  TreatmentDetails,
} from '../entities/health-event.entity';
import { CreateHealthEventInput } from '../dto/create-health-event.input';
import { UpdateHealthEventInput } from '../dto/update-health-event.input';

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
    private readonly dataSource: DataSource,
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
    // WHY: a health-event row is per-tenant data — it MUST be written inside the
    // fail-closed tenant boundary so the INSERT lands in tenant_<uuid>.health_events,
    // not the source `farm` schema (which the source-write guard rejects). reportedBy
    // is set authoritatively from the JWT subject, overriding any client value.
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const healthEventRepo = tenantManagerRepo(queryRunner.manager, HealthEvent, tenantId);
      const event = healthEventRepo.create({
        ...input,
        tenantId,
        reportedBy: userId,
      });

      const saved = await healthEventRepo.save(event);
      this.logger.log(`Created health event ${saved.id} for batch ${input.batchId}`);
      return saved;
    });
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

}
