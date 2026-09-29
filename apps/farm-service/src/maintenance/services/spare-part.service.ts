/**
 * SparePart Service
 *
 * Spare-part catalogue (CRUD) and the operator entry points for spare-part
 * stock. Stock itself lives in the ONE storage ledger (FARM-HIGH-338): every
 * change goes through SparePartLedgerService → StockMovementService, and the
 * quantity/status a caller sees are derived from the ledger
 * (SparePartStockReader), never stored on the part.
 *
 * @module Maintenance/Services
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Like } from 'typeorm';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';

import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import {
  CreateSparePartInput,
  UpdateSparePartInput,
  StockMovementInput,
} from '../dto/spare-part.dto';
import { SparePartActor, SparePartLedgerService } from './spare-part-ledger.service';

/** Spare-part stock summary (ledger-derived). */
export interface StockSummary {
  totalParts: number;
  totalValue: number;
  lowStockCount: number;
  outOfStockCount: number;
  byStatus: Record<SparePartStatus, number>;
}

/** A spare part at or below its reorder point (ledger-derived). */
export interface LowStockAlert {
  sparePart: SparePart;
  currentQuantity: number;
  minStock: number;
  reorderPoint: number;
  deficit: number;
}

@Injectable()
export class SparePartService {
  private readonly logger = new Logger(SparePartService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: SparePartLedgerService,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * Register a part. WHY one transaction: the opening balance is a ledger IN
   * movement; if it fails (bad location) the part must not exist either.
   */
  async create(
    tenantId: string,
    input: CreateSparePartInput,
    actor: SparePartActor,
  ): Promise<SparePart> {
    this.logger.log(`Creating spare part for tenant: ${tenantId}`);
    if (input.openingQuantity > 0 && !input.storageLocationId) {
      throw new BadRequestException(
        'An opening quantity needs the storage location that holds it (storageLocationId)',
      );
    }

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const repo = tenantManagerRepo(manager, SparePart, tenantId);

      const existing = await repo.findOne({ where: { tenantId, partNumber: input.partNumber } });
      if (existing) {
        throw new BadRequestException(`Bu parça numarası zaten mevcut: ${input.partNumber}`);
      }
      if (input.storageLocationId) {
        await this.ledger.assertLocation(manager, tenantId, input.storageLocationId);
      }

      const saved = await repo.save(
        repo.create({
          tenantId,
          code: await this.generateCode(manager, tenantId),
          name: input.name,
          partNumber: input.partNumber,
          description: input.description,
          equipmentTypeId: input.equipmentTypeId,
          compatibleEquipmentTypes: input.compatibleEquipmentTypes,
          supplierId: input.supplierId,
          manufacturer: input.manufacturer,
          minStock: input.minStock,
          maxStock: input.maxStock,
          reorderPoint: input.reorderPoint,
          unit: input.unit,
          storageLocationId: input.storageLocationId,
          binDetail: input.binDetail,
          unitPrice: input.unitPrice,
          currency: input.currency,
          leadTimeDays: input.leadTimeDays,
          notes: input.notes,
          isActive: true,
          createdBy: actor.userId,
        }),
      );

      if (input.openingQuantity > 0) {
        await this.ledger.recordOpeningBalance(
          manager,
          tenantId,
          saved,
          input.openingQuantity,
          actor,
        );
      }
      this.logger.log(`Spare part created: ${saved.code}`);
      return saved;
    });
  }

  /**
   * Update catalogue fields. Stock and status are NOT here (FARM-HIGH-338):
   * stock moves only through the ledger and the status is derived from it.
   */
  async update(
    tenantId: string,
    input: UpdateSparePartInput,
    updatedBy: string,
  ): Promise<SparePart> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const repo = tenantManagerRepo(manager, SparePart, tenantId);
      const sparePart = await this.findInTransaction(manager, tenantId, input.id);

      if (input.partNumber && input.partNumber !== sparePart.partNumber) {
        const existing = await repo.findOne({ where: { tenantId, partNumber: input.partNumber } });
        if (existing) {
          throw new BadRequestException(`Bu parça numarası zaten mevcut: ${input.partNumber}`);
        }
      }
      // undefined = unchanged; null = no default location; an id = re-home.
      // Either change is refused while stock still sits at the current home.
      if (input.storageLocationId === null) {
        await this.ledger.assertRelocatable(manager, tenantId, sparePart, null);
        sparePart.storageLocationId = null;
      } else if (input.storageLocationId !== undefined) {
        await this.ledger.assertLocation(manager, tenantId, input.storageLocationId);
        await this.ledger.assertRelocatable(manager, tenantId, sparePart, input.storageLocationId);
        sparePart.storageLocationId = input.storageLocationId;
      }

      if (input.name) sparePart.name = input.name;
      if (input.partNumber) sparePart.partNumber = input.partNumber;
      if (input.description !== undefined) sparePart.description = input.description;
      if (input.equipmentTypeId !== undefined) sparePart.equipmentTypeId = input.equipmentTypeId;
      if (input.compatibleEquipmentTypes !== undefined) {
        sparePart.compatibleEquipmentTypes = input.compatibleEquipmentTypes;
      }
      if (input.supplierId !== undefined) sparePart.supplierId = input.supplierId;
      if (input.manufacturer !== undefined) sparePart.manufacturer = input.manufacturer;
      if (input.minStock !== undefined) sparePart.minStock = input.minStock;
      if (input.maxStock !== undefined) sparePart.maxStock = input.maxStock;
      if (input.reorderPoint !== undefined) sparePart.reorderPoint = input.reorderPoint;
      if (input.unit) sparePart.unit = input.unit;
      if (input.binDetail) sparePart.binDetail = input.binDetail;
      if (input.unitPrice !== undefined) sparePart.unitPrice = input.unitPrice;
      if (input.currency) sparePart.currency = input.currency;
      if (input.leadTimeDays !== undefined) sparePart.leadTimeDays = input.leadTimeDays;
      if (input.isActive !== undefined) sparePart.isActive = input.isActive;
      if (input.notes !== undefined) sparePart.notes = input.notes;
      sparePart.updatedBy = updatedBy;

      return repo.save(sparePart);
    });
  }

  /** Soft delete: the part becomes inactive (derived status DISCONTINUED). */
  async delete(tenantId: string, id: string): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const sparePart = await this.findInTransaction(queryRunner.manager, tenantId, id);
      sparePart.isActive = false;
      await tenantManagerRepo(queryRunner.manager, SparePart, tenantId).save(sparePart);
    });
  }

  // -------------------------------------------------------------------------
  // STOCK MANAGEMENT (ledger-backed)
  // -------------------------------------------------------------------------

  /** One operator movement; the movement row is persisted by the ledger sink. */
  async recordStockMovement(
    tenantId: string,
    input: StockMovementInput,
    actor: SparePartActor,
  ): Promise<SparePart> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const sparePart = await this.findInTransaction(manager, tenantId, input.sparePartId);
      await this.ledger.recordMovement(manager, tenantId, sparePart, input, actor);
      sparePart.updatedBy = actor.userId;
      this.logger.log(
        `Spare-part movement recorded in the ledger: ${sparePart.code} - ${input.movementType} ${input.quantity}`,
      );
      return tenantManagerRepo(manager, SparePart, tenantId).save(sparePart);
    });
  }

  /** Receive several parts at once; each becomes an IN movement. All or nothing. */
  async bulkStockIn(
    tenantId: string,
    items: { sparePartId: string; quantity: number; notes?: string }[],
    actor: SparePartActor,
    reason?: string,
  ): Promise<SparePart[]> {
    if (items.length === 0) return [];
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const repo = tenantManagerRepo(manager, SparePart, tenantId);
      const parts = await repo.find({
        where: { tenantId, id: In(items.map((item) => item.sparePartId)) },
      });
      await this.ledger.receiveMany(manager, tenantId, parts, items, reason, actor);
      for (const part of parts) part.updatedBy = actor.userId;
      return repo.saveMany(parts);
    });
  }

  // -------------------------------------------------------------------------
  // HELPER METHODS
  // -------------------------------------------------------------------------

  private async findInTransaction(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<SparePart> {
    const sparePart = await tenantManagerRepo(manager, SparePart, tenantId).findOne({
      where: { id, tenantId },
    });
    if (!sparePart) throw new NotFoundException(`Yedek parça bulunamadı: ${id}`);
    return sparePart;
  }

  /** Next `SP-000001` style code within the tenant. */
  private async generateCode(manager: EntityManager, tenantId: string): Promise<string> {
    const prefix = 'SP-';
    const lastPart = await tenantManagerRepo(manager, SparePart, tenantId).findOne({
      where: { tenantId, code: Like(`${prefix}%`) },
      order: { code: 'DESC' },
    });
    const nextNumber = lastPart ? parseInt(lastPart.code.replace(prefix, ''), 10) + 1 : 1;
    return `${prefix}${nextNumber.toString().padStart(6, '0')}`;
  }
}
