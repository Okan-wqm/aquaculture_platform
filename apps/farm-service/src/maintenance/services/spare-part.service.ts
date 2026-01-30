/**
 * SparePart Service
 *
 * Yedek parça stok yönetimi ve envanter takibi.
 * Stok hareketleri ve düşük stok uyarıları.
 *
 * @module Maintenance/Services
 */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThanOrEqual, Like, DataSource } from 'typeorm';
import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import {
  CreateSparePartInput,
  UpdateSparePartInput,
  StockMovementInput,
  SparePartFilterInput,
} from '../dto/spare-part.dto';
import { PaginatedResult } from './work-order.service';

/**
 * Stok hareketi kaydı
 */
export interface StockMovement {
  id: string;
  sparePartId: string;
  tenantId: string;
  movementType: 'in' | 'out' | 'adjustment';
  quantity: number;
  previousQuantity: number;
  newQuantity: number;
  reason?: string;
  workOrderId?: string;
  performedBy: string;
  performedAt: Date;
  notes?: string;
}

/**
 * Stok özeti
 */
export interface StockSummary {
  totalParts: number;
  totalValue: number;
  lowStockCount: number;
  outOfStockCount: number;
  byStatus: Record<SparePartStatus, number>;
}

/**
 * Düşük stok uyarısı
 */
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
    @InjectRepository(SparePart)
    private readonly sparePartRepository: Repository<SparePart>,
    private readonly dataSource: DataSource,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * Yeni yedek parça oluşturur
   */
  async create(
    tenantId: string,
    input: CreateSparePartInput,
    createdBy: string,
  ): Promise<SparePart> {
    this.logger.log(`Creating spare part for tenant: ${tenantId}`);

    // Check for duplicate part number
    const existing = await this.sparePartRepository.findOne({
      where: { tenantId, partNumber: input.partNumber },
    });

    if (existing) {
      throw new BadRequestException(
        `Bu parça numarası zaten mevcut: ${input.partNumber}`,
      );
    }

    // Generate unique code
    const code = await this.generateCode(tenantId);

    // Determine initial status
    let status = SparePartStatus.IN_STOCK;
    if (input.quantity === 0) {
      status = SparePartStatus.OUT_OF_STOCK;
    } else if (input.quantity <= input.minStock) {
      status = SparePartStatus.LOW_STOCK;
    }

    const sparePart = this.sparePartRepository.create({
      tenantId,
      code,
      name: input.name,
      partNumber: input.partNumber,
      description: input.description,
      equipmentTypeId: input.equipmentTypeId,
      compatibleEquipmentTypes: input.compatibleEquipmentTypes,
      supplierId: input.supplierId,
      manufacturer: input.manufacturer,
      quantity: input.quantity,
      minStock: input.minStock,
      maxStock: input.maxStock,
      reorderPoint: input.reorderPoint,
      unit: input.unit,
      status,
      location: input.location,
      unitPrice: input.unitPrice,
      currency: input.currency,
      leadTimeDays: input.leadTimeDays,
      notes: input.notes,
      isActive: true,
      createdBy,
    });

    const saved = await this.sparePartRepository.save(sparePart);
    this.logger.log(`Spare part created: ${saved.code}`);

    return saved;
  }

  /**
   * Yedek parçayı günceller
   */
  async update(
    tenantId: string,
    input: UpdateSparePartInput,
    updatedBy: string,
  ): Promise<SparePart> {
    const sparePart = await this.findById(tenantId, input.id);

    // Check for duplicate part number if changing
    if (input.partNumber && input.partNumber !== sparePart.partNumber) {
      const existing = await this.sparePartRepository.findOne({
        where: { tenantId, partNumber: input.partNumber },
      });
      if (existing) {
        throw new BadRequestException(
          `Bu parça numarası zaten mevcut: ${input.partNumber}`,
        );
      }
    }

    // Update fields
    if (input.name) sparePart.name = input.name;
    if (input.partNumber) sparePart.partNumber = input.partNumber;
    if (input.description !== undefined) sparePart.description = input.description;
    if (input.equipmentTypeId !== undefined) {
      sparePart.equipmentTypeId = input.equipmentTypeId;
    }
    if (input.compatibleEquipmentTypes !== undefined) {
      sparePart.compatibleEquipmentTypes = input.compatibleEquipmentTypes;
    }
    if (input.supplierId !== undefined) sparePart.supplierId = input.supplierId;
    if (input.manufacturer !== undefined) sparePart.manufacturer = input.manufacturer;
    if (input.quantity !== undefined) sparePart.quantity = input.quantity;
    if (input.minStock !== undefined) sparePart.minStock = input.minStock;
    if (input.maxStock !== undefined) sparePart.maxStock = input.maxStock;
    if (input.reorderPoint !== undefined) sparePart.reorderPoint = input.reorderPoint;
    if (input.unit) sparePart.unit = input.unit;
    if (input.status) sparePart.status = input.status;
    if (input.location) sparePart.location = input.location;
    if (input.unitPrice !== undefined) sparePart.unitPrice = input.unitPrice;
    if (input.currency) sparePart.currency = input.currency;
    if (input.leadTimeDays !== undefined) sparePart.leadTimeDays = input.leadTimeDays;
    if (input.isActive !== undefined) sparePart.isActive = input.isActive;
    if (input.notes !== undefined) sparePart.notes = input.notes;

    sparePart.updatedBy = updatedBy;

    // Update status based on quantity
    this.updateStockStatus(sparePart);

    return this.sparePartRepository.save(sparePart);
  }

  /**
   * Yedek parçayı siler (soft delete)
   */
  async delete(tenantId: string, id: string): Promise<void> {
    const sparePart = await this.findById(tenantId, id);
    sparePart.isActive = false;
    await this.sparePartRepository.save(sparePart);
  }

  // -------------------------------------------------------------------------
  // QUERY OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * ID ile yedek parça bulur
   */
  async findById(tenantId: string, id: string): Promise<SparePart> {
    const sparePart = await this.sparePartRepository.findOne({
      where: { id, tenantId },
    });

    if (!sparePart) {
      throw new NotFoundException(`Yedek parça bulunamadı: ${id}`);
    }

    return sparePart;
  }

  /**
   * Kod ile yedek parça bulur
   */
  async findByCode(tenantId: string, code: string): Promise<SparePart> {
    const sparePart = await this.sparePartRepository.findOne({
      where: { code, tenantId },
    });

    if (!sparePart) {
      throw new NotFoundException(`Yedek parça bulunamadı: ${code}`);
    }

    return sparePart;
  }

  /**
   * Parça numarası ile yedek parça bulur
   */
  async findByPartNumber(tenantId: string, partNumber: string): Promise<SparePart> {
    const sparePart = await this.sparePartRepository.findOne({
      where: { partNumber, tenantId },
    });

    if (!sparePart) {
      throw new NotFoundException(`Yedek parça bulunamadı: ${partNumber}`);
    }

    return sparePart;
  }

  /**
   * Filtrelenmiş yedek parçaları listeler
   */
  async findAll(
    tenantId: string,
    filter?: SparePartFilterInput,
    page = 1,
    limit = 20,
    sortBy = 'name',
    sortOrder: 'ASC' | 'DESC' = 'ASC',
  ): Promise<PaginatedResult<SparePart>> {
    const query = this.sparePartRepository
      .createQueryBuilder('sp')
      .where('sp.tenantId = :tenantId', { tenantId });

    // Apply filters
    if (filter?.status?.length) {
      query.andWhere('sp.status IN (:...statuses)', { statuses: filter.status });
    }
    if (filter?.equipmentTypeId) {
      query.andWhere('sp.equipmentTypeId = :equipmentTypeId', {
        equipmentTypeId: filter.equipmentTypeId,
      });
    }
    if (filter?.supplierId) {
      query.andWhere('sp.supplierId = :supplierId', {
        supplierId: filter.supplierId,
      });
    }
    if (filter?.manufacturer) {
      query.andWhere('sp.manufacturer ILIKE :manufacturer', {
        manufacturer: `%${filter.manufacturer}%`,
      });
    }
    if (filter?.isActive !== undefined) {
      query.andWhere('sp.isActive = :isActive', { isActive: filter.isActive });
    }
    if (filter?.isLowStock) {
      query.andWhere('sp.quantity <= sp.minStock');
      query.andWhere('sp.quantity > 0');
    }
    if (filter?.isOutOfStock) {
      query.andWhere('sp.quantity = 0');
    }
    if (filter?.searchTerm) {
      query.andWhere(
        '(sp.name ILIKE :search OR sp.code ILIKE :search OR sp.partNumber ILIKE :search)',
        { search: `%${filter.searchTerm}%` },
      );
    }

    // Count total
    const total = await query.getCount();

    // Apply sorting and pagination
    const validSortFields = [
      'name',
      'code',
      'partNumber',
      'quantity',
      'status',
      'createdAt',
    ];
    const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'name';

    query
      .orderBy(`sp.${finalSortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    const data = await query.getMany();

    const totalPages = Math.ceil(total / limit);

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  /**
   * Düşük stoklu yedek parçaları getirir
   */
  async findLowStock(tenantId: string): Promise<LowStockAlert[]> {
    const parts = await this.sparePartRepository.find({
      where: [
        { tenantId, isActive: true, status: SparePartStatus.LOW_STOCK },
        { tenantId, isActive: true, status: SparePartStatus.OUT_OF_STOCK },
      ],
      order: { quantity: 'ASC' },
    });

    return parts.map((part) => ({
      sparePart: part,
      currentQuantity: part.quantity,
      minStock: part.minStock,
      reorderPoint: part.reorderPoint,
      deficit: Math.max(0, part.reorderPoint - part.quantity),
    }));
  }

  /**
   * Ekipman tipi için uyumlu yedek parçaları getirir
   */
  async findByEquipmentType(
    tenantId: string,
    equipmentTypeId: string,
  ): Promise<SparePart[]> {
    return this.sparePartRepository
      .createQueryBuilder('sp')
      .where('sp.tenantId = :tenantId', { tenantId })
      .andWhere('sp.isActive = true')
      .andWhere(
        '(sp.equipmentTypeId = :equipmentTypeId OR :equipmentTypeId = ANY(sp.compatibleEquipmentTypes))',
        { equipmentTypeId },
      )
      .orderBy('sp.name', 'ASC')
      .getMany();
  }

  // -------------------------------------------------------------------------
  // STOCK MANAGEMENT
  // -------------------------------------------------------------------------

  /**
   * Stok hareketi kaydeder
   */
  async recordStockMovement(
    tenantId: string,
    input: StockMovementInput,
    performedBy: string,
  ): Promise<SparePart> {
    const sparePart = await this.findById(tenantId, input.sparePartId);
    const previousQuantity = sparePart.quantity;

    switch (input.movementType) {
      case 'in':
        sparePart.quantity += input.quantity;
        sparePart.lastOrderDate = new Date();
        break;
      case 'out':
        if (sparePart.quantity < input.quantity) {
          throw new BadRequestException(
            `Yetersiz stok. Mevcut: ${sparePart.quantity}, İstenen: ${input.quantity}`,
          );
        }
        sparePart.quantity -= input.quantity;
        sparePart.lastUsedDate = new Date();
        break;
      case 'adjustment':
        sparePart.quantity = input.quantity;
        break;
    }

    sparePart.updatedBy = performedBy;

    // Update status
    this.updateStockStatus(sparePart);

    // Log movement (in a real implementation, this would be stored in a separate table)
    const movement: StockMovement = {
      id: Date.now().toString(),
      sparePartId: sparePart.id,
      tenantId,
      movementType: input.movementType,
      quantity: input.quantity,
      previousQuantity,
      newQuantity: sparePart.quantity,
      reason: input.reason,
      workOrderId: input.workOrderId,
      performedBy,
      performedAt: new Date(),
      notes: input.notes,
    };

    this.logger.log(
      `Stock movement recorded: ${sparePart.code} - ${input.movementType} ${input.quantity}`,
    );

    return this.sparePartRepository.save(sparePart);
  }

  /**
   * İş emri için malzemeleri çıkış yapar
   * Uses transaction to ensure all material consumptions succeed or fail together
   */
  async consumeForWorkOrder(
    tenantId: string,
    workOrderId: string,
    materials: { sparePartId: string; quantity: number }[],
    performedBy: string,
  ): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      for (const material of materials) {
        // Find spare part within transaction
        const sparePart = await queryRunner.manager.findOne(SparePart, {
          where: { id: material.sparePartId, tenantId },
        });

        if (!sparePart) {
          throw new NotFoundException(`Yedek parça bulunamadı: ${material.sparePartId}`);
        }

        if (sparePart.quantity < material.quantity) {
          throw new BadRequestException(
            `Yetersiz stok. Mevcut: ${sparePart.quantity}, İstenen: ${material.quantity}`,
          );
        }

        const previousQuantity = sparePart.quantity;
        sparePart.quantity -= material.quantity;
        sparePart.lastUsedDate = new Date();
        sparePart.updatedBy = performedBy;

        // Update stock status
        this.updateStockStatus(sparePart);

        // Save within transaction
        await queryRunner.manager.save(sparePart);

        // Log movement
        this.logger.log(
          `Stock movement recorded: ${sparePart.code} - out ${material.quantity} for work order ${workOrderId}`,
        );
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Toplu stok girişi yapar
   */
  async bulkStockIn(
    tenantId: string,
    items: { sparePartId: string; quantity: number; notes?: string }[],
    performedBy: string,
    reason?: string,
  ): Promise<SparePart[]> {
    const results: SparePart[] = [];

    for (const item of items) {
      const sparePart = await this.recordStockMovement(
        tenantId,
        {
          sparePartId: item.sparePartId,
          quantity: item.quantity,
          movementType: 'in',
          reason: reason || 'Toplu stok girişi',
          notes: item.notes,
        },
        performedBy,
      );
      results.push(sparePart);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // STATISTICS & REPORTS
  // -------------------------------------------------------------------------

  /**
   * Stok özeti getirir
   */
  async getStockSummary(tenantId: string): Promise<StockSummary> {
    const parts = await this.sparePartRepository.find({
      where: { tenantId, isActive: true },
    });

    const summary: StockSummary = {
      totalParts: parts.length,
      totalValue: 0,
      lowStockCount: 0,
      outOfStockCount: 0,
      byStatus: {} as Record<SparePartStatus, number>,
    };

    // Initialize status counts
    Object.values(SparePartStatus).forEach((s) => (summary.byStatus[s] = 0));

    for (const part of parts) {
      // Calculate total value
      if (part.unitPrice) {
        summary.totalValue += Number(part.unitPrice) * part.quantity;
      }

      // Count by status
      summary.byStatus[part.status]++;

      // Count low/out of stock
      if (part.status === SparePartStatus.LOW_STOCK) {
        summary.lowStockCount++;
      } else if (part.status === SparePartStatus.OUT_OF_STOCK) {
        summary.outOfStockCount++;
      }
    }

    return summary;
  }

  // -------------------------------------------------------------------------
  // HELPER METHODS
  // -------------------------------------------------------------------------

  /**
   * Benzersiz kod üretir
   */
  private async generateCode(tenantId: string): Promise<string> {
    const prefix = 'SP-';

    const lastPart = await this.sparePartRepository.findOne({
      where: { tenantId, code: Like(`${prefix}%`) },
      order: { code: 'DESC' },
    });

    let nextNumber = 1;
    if (lastPart) {
      const lastNumber = parseInt(lastPart.code.replace(prefix, ''), 10);
      nextNumber = lastNumber + 1;
    }

    return `${prefix}${nextNumber.toString().padStart(6, '0')}`;
  }

  /**
   * Stok durumunu günceller
   */
  private updateStockStatus(sparePart: SparePart): void {
    if (sparePart.quantity === 0) {
      sparePart.status = SparePartStatus.OUT_OF_STOCK;
    } else if (sparePart.quantity <= sparePart.minStock) {
      sparePart.status = SparePartStatus.LOW_STOCK;
    } else {
      sparePart.status = SparePartStatus.IN_STOCK;
    }
  }
}
