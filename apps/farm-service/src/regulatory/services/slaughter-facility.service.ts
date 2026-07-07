/**
 * Slaughter Facility Service — catalog CRUD + the default-facility read the
 * slakt assemblers use for godkjenningsnummer.
 *
 * Default discipline: at most one default per tenant, maintained inside the
 * write transaction (creating/marking a default clears the previous one; the
 * first facility becomes default automatically so the assembler always has a
 * facility once the catalog is non-empty).
 */
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, Not } from 'typeorm';
import {
  runInTenantRead,
  runInTenantTransaction,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';

import { SlaughterFacility } from '../entities/slaughter-facility.entity';
import {
  CreateSlaughterFacilityInput,
  UpdateSlaughterFacilityInput,
} from '../dto/slaughter-facility.inputs';

@Injectable()
export class SlaughterFacilityService {
  private readonly logger = new Logger(SlaughterFacilityService.name);

  constructor(private readonly dataSource: DataSource) {}

  async create(tenantId: string, input: CreateSlaughterFacilityInput): Promise<SlaughterFacility> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const repo = tenantManagerRepo(queryRunner.manager, SlaughterFacility, tenantId);

      const duplicate = await repo.findOne({
        where: { tenantId, godkjenningsnummer: input.godkjenningsnummer },
      });
      if (duplicate) {
        throw new ConflictException(
          `A facility with approval number ${input.godkjenningsnummer} already exists`,
        );
      }

      const existingCount = await repo.count({ where: { tenantId } });
      const isDefault = input.isDefault || existingCount === 0;
      if (isDefault) {
        await repo.update({ tenantId, isDefault: true }, { isDefault: false });
      }

      const saved = await repo.save(
        repo.create({
          tenantId,
          name: input.name,
          godkjenningsnummer: input.godkjenningsnummer,
          isDefault,
          address: input.address,
          isActive: true,
        }),
      );
      this.logger.log(`Created slaughter facility ${saved.id} (${saved.godkjenningsnummer})`);
      return saved;
    });
  }

  async update(tenantId: string, input: UpdateSlaughterFacilityInput): Promise<SlaughterFacility> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const repo = tenantManagerRepo(queryRunner.manager, SlaughterFacility, tenantId);

      const facility = await repo.findOne({ where: { id: input.id, tenantId } });
      if (!facility) {
        throw new NotFoundException(`Slaughter facility ${input.id} not found`);
      }

      if (input.godkjenningsnummer && input.godkjenningsnummer !== facility.godkjenningsnummer) {
        const duplicate = await repo.findOne({
          where: { tenantId, godkjenningsnummer: input.godkjenningsnummer, id: Not(input.id) },
        });
        if (duplicate) {
          throw new ConflictException(
            `A facility with approval number ${input.godkjenningsnummer} already exists`,
          );
        }
        facility.godkjenningsnummer = input.godkjenningsnummer;
      }

      if (input.name !== undefined) facility.name = input.name;
      if (input.address !== undefined) facility.address = input.address;
      if (input.isActive !== undefined) facility.isActive = input.isActive;
      if (input.isDefault === true && !facility.isDefault) {
        await repo.update({ tenantId, isDefault: true }, { isDefault: false });
        facility.isDefault = true;
      }
      if (input.isDefault === false) facility.isDefault = false;

      const saved = await repo.save(facility);
      this.logger.log(`Updated slaughter facility ${saved.id}`);
      return saved;
    });
  }

  /** The facility the slakt assemblers key godkjenningsnummer from. */
  async getDefaultFacility(tenantId: string): Promise<SlaughterFacility | null> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.manager.findOne(SlaughterFacility, {
        where: { tenantId, isDefault: true, isActive: true },
      });
    });
  }
}
