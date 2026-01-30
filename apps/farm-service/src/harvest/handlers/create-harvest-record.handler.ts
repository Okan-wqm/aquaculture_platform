/**
 * CreateHarvestRecordHandler
 *
 * CreateHarvestRecordCommand'ı işler ve harvest kaydı oluşturur.
 * Tank ve Batch'i günceller.
 *
 * @module Harvest/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { CreateHarvestRecordCommand, CreateHarvestRecordInput } from '../commands/create-harvest-record.command';
import { HarvestRecord, HarvestRecordStatus, QualityGrade, HarvestOperation, LotInfo } from '../entities/harvest-record.entity';
import { HarvestMethod, ProductForm } from '../entities/harvest-plan.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import { Tank } from '../../tank/entities/tank.entity';

@Injectable()
@CommandHandler(CreateHarvestRecordCommand)
export class CreateHarvestRecordHandler implements ICommandHandler<CreateHarvestRecordCommand, Batch> {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(HarvestRecord)
    private readonly harvestRepository: Repository<HarvestRecord>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
  ) {}

  async execute(command: CreateHarvestRecordCommand): Promise<Batch> {
    const { tenantId, input, recordedBy } = command;

    // Read operations for validation (outside transaction)
    const batch = await this.batchRepository.findOne({
      where: { id: input.batchId, tenantId, isActive: true },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${input.batchId} bulunamadı`);
    }

    const tank = await this.tankRepository.findOne({
      where: { id: input.tankId, tenantId, isActive: true },
    });

    if (!tank) {
      throw new NotFoundException(`Tank ${input.tankId} bulunamadı`);
    }

    if (input.quantityHarvested > batch.currentQuantity) {
      throw new BadRequestException(
        `Harvest miktarı (${input.quantityHarvested}) batch'in mevcut miktarından (${batch.currentQuantity}) fazla olamaz`
      );
    }

    const tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: input.tankId },
    });

    if (tankBatch && input.quantityHarvested > tankBatch.totalQuantity) {
      throw new BadRequestException(
        `Harvest miktarı (${input.quantityHarvested}) tank'taki miktardan (${tankBatch.totalQuantity}) fazla olamaz`
      );
    }

    // Biomass hesapla
    const biomassKg = input.totalBiomass || (input.quantityHarvested * input.averageWeight) / 1000;

    // Record code ve lot number oluştur (outside transaction for code generation)
    const recordCode = await this.generateCode(tenantId, 'HR');
    const lotNumber = await this.generateCode(tenantId, 'LOT');

    // Parse harvestDate
    const harvestDate = typeof input.harvestDate === 'string'
      ? new Date(input.harvestDate)
      : input.harvestDate;

    // Parse qualityGrade
    const qualityGrade = this.parseQualityGrade(input.qualityGrade);

    // Operation detaylarını oluştur
    const operation: HarvestOperation = {
      startTime: harvestDate,
      method: HarvestMethod.NET,
    };

    // Lot bilgilerini oluştur
    const lotInfo: LotInfo = {
      lotNumber,
      productionDate: harvestDate,
    };

    // Pre-operation state kaydet
    const preOperationState = tankBatch ? {
      quantity: tankBatch.totalQuantity,
      biomassKg: tankBatch.totalBiomassKg,
      densityKgM3: tankBatch.densityKgM3,
    } : undefined;

    // Start transaction for all write operations
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // HarvestRecord oluştur
      const harvestRecord = queryRunner.manager.create(HarvestRecord, {
        tenantId,
        recordCode,
        lotNumber,
        batchId: input.batchId,
        tankId: input.tankId,
        status: HarvestRecordStatus.COMPLETED,
        harvestDate,
        operation,
        method: HarvestMethod.NET,
        quantityHarvested: input.quantityHarvested,
        totalBiomass: biomassKg,
        averageWeight: input.averageWeight,
        productForm: ProductForm.FRESH_WHOLE,
        qualityGrade,
        lotInfo,
        supervisorId: recordedBy,
        notes: input.notes,
        totalRevenue: input.pricePerKg ? biomassKg * input.pricePerKg : undefined,
        currency: input.pricePerKg ? 'TRY' : undefined,
      });

      // Customer delivery bilgisi ekle
      if (input.buyerName) {
        harvestRecord.customerDeliveries = [{
          customerId: 'direct-buyer',
          customerName: input.buyerName,
          quantity: biomassKg,
          quantityUnit: 'kg',
          unitPrice: input.pricePerKg || 0,
          totalValue: input.pricePerKg ? biomassKg * input.pricePerKg : 0,
          currency: 'TRY',
          deliveryStatus: 'pending',
        }];
      }

      await queryRunner.manager.save(HarvestRecord, harvestRecord);

      // TankOperation kaydı oluştur
      const tankOperation = queryRunner.manager.create(TankOperation, {
        tenantId,
        tankId: input.tankId,
        batchId: input.batchId,
        operationType: OperationType.HARVEST,
        operationDate: harvestDate,
        quantity: input.quantityHarvested,
        avgWeightG: input.averageWeight,
        biomassKg,
        preOperationState,
        performedBy: recordedBy,
        notes: input.notes,
        isDeleted: false,
      });

      await queryRunner.manager.save(TankOperation, tankOperation);

      // Batch güncelle
      batch.currentQuantity -= input.quantityHarvested;
      batch.harvestedQuantity = (batch.harvestedQuantity || 0) + input.quantityHarvested;
      batch.retentionRate = batch.getRetentionRate();
      batch.updatedBy = recordedBy;

      await queryRunner.manager.save(Batch, batch);

      // TankBatch güncelle
      if (tankBatch) {
        // Ensure numeric operations (decimal columns may come as strings)
        tankBatch.totalQuantity = Number(tankBatch.totalQuantity) - input.quantityHarvested;
        tankBatch.totalBiomassKg = Number(tankBatch.totalBiomassKg) - biomassKg;
        tankBatch.currentQuantity = tankBatch.totalQuantity;
        tankBatch.currentBiomassKg = tankBatch.totalBiomassKg;

        if (tankBatch.totalQuantity > 0) {
          tankBatch.avgWeightG = (Number(tankBatch.totalBiomassKg) * 1000) / tankBatch.totalQuantity;
          const effectiveVolume = tank.waterVolume || tank.volume;
          tankBatch.densityKgM3 = effectiveVolume ? Number(tankBatch.totalBiomassKg) / Number(effectiveVolume) : 0;
        } else {
          tankBatch.avgWeightG = 0;
          tankBatch.densityKgM3 = 0;
        }

        await queryRunner.manager.save(TankBatch, tankBatch);
      }

      // Tank güncelle
      tank.currentBiomass = Number(tank.currentBiomass || 0) - biomassKg;
      tank.currentCount = (tank.currentCount || 0) - input.quantityHarvested;
      await queryRunner.manager.save(Tank, tank);

      // Post-operation state güncelle
      const updatedTankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: input.tankId },
      });

      if (updatedTankBatch) {
        tankOperation.postOperationState = {
          quantity: updatedTankBatch.totalQuantity,
          biomassKg: updatedTankBatch.totalBiomassKg,
          densityKgM3: updatedTankBatch.densityKgM3,
        };
        await queryRunner.manager.save(TankOperation, tankOperation);
      }

      // Commit transaction
      await queryRunner.commitTransaction();

      return batch;
    } catch (error) {
      // Rollback transaction on any error
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      // Release query runner
      await queryRunner.release();
    }
  }

  /**
   * Code oluşturma (HR-2024-00001 veya LOT-2024-00001 formatında)
   */
  private async generateCode(tenantId: string, prefix: string): Promise<string> {
    const year = new Date().getFullYear();

    // En son kaydı bul
    const lastRecord = await this.harvestRepository
      .createQueryBuilder('hr')
      .where('hr.tenantId = :tenantId', { tenantId })
      .andWhere(prefix === 'HR' ? 'hr.recordCode LIKE :pattern' : 'hr.lotNumber LIKE :pattern', {
        pattern: `${prefix}-${year}-%`
      })
      .orderBy(prefix === 'HR' ? 'hr.recordCode' : 'hr.lotNumber', 'DESC')
      .getOne();

    let sequence = 1;
    if (lastRecord) {
      const codeField = prefix === 'HR' ? lastRecord.recordCode : lastRecord.lotNumber;
      const match = codeField.match(new RegExp(`${prefix}-${year}-(\\d+)`));
      if (match && match[1]) {
        sequence = parseInt(match[1], 10) + 1;
      }
    }

    return `${prefix}-${year}-${sequence.toString().padStart(5, '0')}`;
  }

  /**
   * QualityGrade parse et
   */
  private parseQualityGrade(grade: string | QualityGrade): QualityGrade {
    const gradeMap: Record<string, QualityGrade> = {
      'PREMIUM': QualityGrade.PREMIUM,
      'premium': QualityGrade.PREMIUM,
      'GRADE_A': QualityGrade.GRADE_A,
      'grade_a': QualityGrade.GRADE_A,
      'GRADE_B': QualityGrade.GRADE_B,
      'grade_b': QualityGrade.GRADE_B,
      'GRADE_C': QualityGrade.GRADE_C,
      'grade_c': QualityGrade.GRADE_C,
      'REJECT': QualityGrade.REJECT,
      'reject': QualityGrade.REJECT,
    };

    return gradeMap[grade] || QualityGrade.GRADE_A;
  }
}
