/**
 * EquipmentTypeCatalogCheckerService
 *
 * Phase 7.5 — the FINAL onboarding seeder slot. Unlike the four
 * per-tenant seeders that came before (water-quality, species,
 * feeding-protocols, regulatory-settings), equipment types are a
 * GLOBAL catalogue seeded at migration time (`007_seed_equipment_types.sql`)
 * and shared across every tenant. No per-tenant row is created.
 *
 * The value of running this as an "onboarding seeder" is
 * deployment-health signalling: if a tenant provisions against a
 * database where the equipment-types catalogue is empty (migration
 * failed, fresh DB without seed data, test harness leak), the
 * tenant's first attempt to create equipment will fail with a
 * confusing error ("no equipment type found with code 'fish-tank'").
 * The operator needs a loud, timely signal that the global table is
 * empty — not a dev cycle later when the first customer trips over
 * it.
 *
 * This service emits a WARNING log when the catalogue is empty and
 * returns a seed summary compatible with the onboarding event
 * handler's uniform shape. It NEVER writes rows — the migration is
 * the source of truth.
 *
 * # Why not a real seeder?
 *
 * The global catalogue lives in a separate SQL migration precisely
 * because its data is:
 *   - application-versioned (changes with the product, not per tenant)
 *   - large (90+ rows, would bloat the NestJS startup cost)
 *   - shared (migration idempotency is enforced at the SQL level)
 *
 * Duplicating the seed set in TypeScript would create a drift risk
 * — two sources of truth for the same catalogue. The checker is
 * deliberately a read-only verifier.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EquipmentType } from '../entities/equipment-type.entity';

export interface EquipmentTypeCatalogCheckResult {
  seeded: string[];
  skipped: string[];
}

@Injectable()
export class EquipmentTypeCatalogCheckerService {
  private readonly logger = new Logger(EquipmentTypeCatalogCheckerService.name);

  constructor(
    @InjectRepository(EquipmentType)
    private readonly equipmentTypeRepository: Repository<EquipmentType>,
  ) {}

  /**
   * Verify the global equipment-types catalogue has at least one
   * active row. Logs a WARN and returns an empty summary when the
   * catalogue is empty — the onboarding event handler records the
   * seeder as "ok but 0 rows" (no throw, because a missing global
   * catalogue is not a tenant-level data issue).
   *
   * Idempotent by construction: no writes ever happen, so the
   * per-seeder `tenantId` scope is irrelevant — the same query
   * result comes back regardless of which tenant is onboarding. The
   * argument is accepted so the method matches the onboarding
   * handler's uniform signature (`seedDefaults(tenantId)`).
   */
  async seedDefaults(tenantId: string): Promise<EquipmentTypeCatalogCheckResult> {
    const activeCount = await this.equipmentTypeRepository.count({
      where: { isActive: true },
    });

    if (activeCount === 0) {
      this.logger.warn(
        `Equipment-type catalogue is EMPTY when onboarding tenant ` +
          `${tenantId.slice(0, 8)}... This is a deployment-health issue: ` +
          `the global catalogue (migration 007_seed_equipment_types.sql) ` +
          `has not been seeded. Tenants will hit "no equipment type found" ` +
          'errors the first time they try to register equipment. Run the ' +
          'SQL migration on the target database and re-provision.',
      );
      return { seeded: [], skipped: [] };
    }

    this.logger.log(
      `Equipment-type catalogue check for tenant ${tenantId.slice(0, 8)}...: ` +
        `${activeCount} active types present (global, read-only).`,
    );
    return { seeded: [], skipped: ['equipment-types-global'] };
  }
}
