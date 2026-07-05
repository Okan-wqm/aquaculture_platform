/**
 * Feeding Program Service
 *
 * Yemleme programı yönetimi servisi. Tank bazlı yemleme programları
 * oluşturma, güncelleme ve yönetim işlemlerini sağlar.
 *
 * Özellikler:
 * - CRUD operasyonları (create, update, delete, get, list)
 * - Program durumu yönetimi (activate, pause)
 * - Tank yönetimi (add, remove, list)
 * - Ağırlık bazlı otomatik yem seçimi
 * - Sıcaklık/ağırlık bazlı FCR hesaplama (bilinear interpolation)
 *
 * @module Feeding
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';

import { Equipment } from '../../equipment/entities/equipment.entity';
import { Feed } from '../../feed/entities/feed.entity';
import {
  FeedingProgramTank,
  ProgramEquipmentType,
} from '../entities/feeding-program-tank.entity';
import {
  FeedingProgram,
  FeedingProgramStatus,
  FeedAssignment,
  FCRTable,
  FCRSource,
  GrowthApplicationMode,
} from '../entities/feeding-program.entity';

import { BilinearInterpolationService } from './bilinear-interpolation.service';

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Program oluşturma girdisi
 */
export interface CreateProgramInput {
  name: string;
  code: string;
  description?: string;
  feedAssignments: FeedAssignment[];
  fcrTable?: FCRTable;
  startDate: Date;
  endDate?: Date;
  settings?: {
    autoTransition?: boolean;
    transitionBuffer?: number;
    notifyOnTransition?: boolean;
    fcrSource?: FCRSource;
    growthApplicationMode?: GrowthApplicationMode;
    defaultMealsPerDay?: number;
    minFeedingRatePercent?: number;
    maxFeedingRatePercent?: number;
  };
}

/**
 * Program güncelleme girdisi
 */
export interface UpdateProgramInput {
  name?: string;
  description?: string;
  feedAssignments?: FeedAssignment[];
  fcrTable?: FCRTable;
  startDate?: Date;
  endDate?: Date;
  settings?: {
    autoTransition?: boolean;
    transitionBuffer?: number;
    notifyOnTransition?: boolean;
    fcrSource?: FCRSource;
    growthApplicationMode?: GrowthApplicationMode;
    defaultMealsPerDay?: number;
    minFeedingRatePercent?: number;
    maxFeedingRatePercent?: number;
  };
}

/**
 * Program filtreleme girdisi
 */
export interface ProgramFilterInput {
  status?: FeedingProgramStatus | FeedingProgramStatus[];
  search?: string;
  startDateFrom?: Date;
  startDateTo?: Date;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * FCR sonucu
 */
export interface FCRResult {
  fcr: number;
  source: FCRSource;
  temperature?: number;
  weight?: number;
  boundingBox?: {
    t1: number;
    t2: number;
    w1: number;
    w2: number;
  };
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class FeedingProgramService {
  private readonly logger = new Logger(FeedingProgramService.name);

  constructor(
    @InjectRepository(FeedingProgram)
    private readonly programRepository: Repository<FeedingProgram>,

    @InjectRepository(FeedingProgramTank)
    private readonly programTankRepository: Repository<FeedingProgramTank>,

    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,

    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,

    private readonly dataSource: DataSource,

    private readonly bilinearInterpolationService: BilinearInterpolationService,
  ) {}

  // ==========================================================================
  // CRUD OPERATIONS
  // ==========================================================================

  /**
   * Yeni yemleme programı oluşturur
   */
  async createProgram(
    input: CreateProgramInput,
    userId: string,
    tenantId: string,
  ): Promise<FeedingProgram> {
    this.logger.log(`Creating feeding program: ${input.name} for tenant ${tenantId}`);

    // Date validation: startDate < endDate
    if (input.endDate && input.startDate >= input.endDate) {
      throw new BadRequestException('startDate must be before endDate');
    }

    // Kod benzersizlik kontrolü
    const existingProgram = await this.programRepository.findOne({
      where: { tenantId, code: input.code },
    });

    if (existingProgram) {
      throw new ConflictException(`Program with code '${input.code}' already exists`);
    }

    // Feed assignments doğrulama
    const validationResult = this.validateFeedAssignments(input.feedAssignments);
    if (!validationResult.valid) {
      throw new BadRequestException(
        `Invalid feed assignments: ${validationResult.errors.join(', ')}`,
      );
    }

    // FCR tablosu doğrulama (varsa)
    if (input.fcrTable) {
      const fcrValidation = this.validateFCRTable(input.fcrTable);
      if (!fcrValidation.valid) {
        throw new BadRequestException(
          `Invalid FCR table: ${fcrValidation.errors.join(', ')}`,
        );
      }
    }

    // Yem ID'lerinin geçerliliğini kontrol et
    await this.validateFeedIds(input.feedAssignments, tenantId);

    // Program oluştur
    const program = this.programRepository.create({
      tenantId,
      name: input.name,
      code: input.code,
      description: input.description,
      feedAssignments: input.feedAssignments,
      fcrTable: input.fcrTable,
      startDate: input.startDate,
      endDate: input.endDate,
      settings: {
        autoTransition: input.settings?.autoTransition ?? true,
        transitionBuffer: input.settings?.transitionBuffer ?? 0.5,
        notifyOnTransition: input.settings?.notifyOnTransition ?? true,
        fcrSource: input.settings?.fcrSource ?? FCRSource.FEED,
        growthApplicationMode:
          input.settings?.growthApplicationMode ?? GrowthApplicationMode.PER_FEEDING,
        defaultMealsPerDay: input.settings?.defaultMealsPerDay ?? 4,
        minFeedingRatePercent: input.settings?.minFeedingRatePercent,
        maxFeedingRatePercent: input.settings?.maxFeedingRatePercent,
      },
      status: FeedingProgramStatus.DRAFT,
      createdBy: userId,
      totalTanks: 0,
      totalFeedTransitions: 0,
    });

    const savedProgram = await this.programRepository.save(program);
    this.logger.log(`Created feeding program: ${savedProgram.id}`);

    return savedProgram;
  }

  /**
   * Yemleme programını günceller
   */
  async updateProgram(
    id: string,
    input: UpdateProgramInput,
    userId: string,
    tenantId: string,
  ): Promise<FeedingProgram> {
    this.logger.log(`Updating feeding program: ${id}`);

    const program = await this.programRepository.findOne({
      where: { id, tenantId },
    });

    if (!program) {
      throw new NotFoundException(`Feeding program not found: ${id}`);
    }

    // Sadece DRAFT veya PAUSED durumundaki programlar düzenlenebilir
    if (!program.isEditable()) {
      throw new BadRequestException(
        `Cannot edit program in '${program.status}' status. Only DRAFT or PAUSED programs can be edited.`,
      );
    }

    // Feed assignments doğrulama (varsa)
    if (input.feedAssignments) {
      const validationResult = this.validateFeedAssignments(input.feedAssignments);
      if (!validationResult.valid) {
        throw new BadRequestException(
          `Invalid feed assignments: ${validationResult.errors.join(', ')}`,
        );
      }

      await this.validateFeedIds(input.feedAssignments, tenantId);
      program.feedAssignments = input.feedAssignments;
    }

    // FCR tablosu doğrulama (varsa)
    if (input.fcrTable !== undefined) {
      if (input.fcrTable) {
        const fcrValidation = this.validateFCRTable(input.fcrTable);
        if (!fcrValidation.valid) {
          throw new BadRequestException(
            `Invalid FCR table: ${fcrValidation.errors.join(', ')}`,
          );
        }
      }
      program.fcrTable = input.fcrTable;
    }

    // Diğer alanları güncelle
    if (input.name !== undefined) program.name = input.name;
    if (input.description !== undefined) program.description = input.description;
    if (input.startDate !== undefined) program.startDate = input.startDate;
    if (input.endDate !== undefined) program.endDate = input.endDate;

    // Date validation: startDate < endDate (after potential updates)
    const effectiveStartDate = input.startDate ?? program.startDate;
    const effectiveEndDate = input.endDate ?? program.endDate;
    if (effectiveEndDate && effectiveStartDate >= effectiveEndDate) {
      throw new BadRequestException('startDate must be before endDate');
    }

    // Ayarları güncelle
    if (input.settings) {
      program.settings = {
        ...program.settings,
        ...input.settings,
      };
    }

    program.lastModifiedBy = userId;

    const updatedProgram = await this.programRepository.save(program);
    this.logger.log(`Updated feeding program: ${id}`);

    return updatedProgram;
  }

  /**
   * Yemleme programını siler (soft delete)
   */
  async deleteProgram(id: string, tenantId: string): Promise<void> {
    this.logger.log(`Deleting feeding program: ${id}`);

    const program = await this.programRepository.findOne({
      where: { id, tenantId },
    });

    if (!program) {
      throw new NotFoundException(`Feeding program not found: ${id}`);
    }

    // Aktif programlar silinemez
    if (program.status === FeedingProgramStatus.ACTIVE) {
      throw new BadRequestException(
        'Cannot delete an active program. Please pause or complete it first.',
      );
    }

    // Use transaction for consistency
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // İlişkili tankları da işaretle (soft delete)
      await queryRunner.manager.update(
        FeedingProgramTank,
        { feedingProgramId: id, tenantId },
        { isActive: false, removedAt: new Date() },
      );

      // Soft delete program by setting status to CANCELLED
      program.status = FeedingProgramStatus.CANCELLED;
      await queryRunner.manager.save(program);

      await queryRunner.commitTransaction();
      this.logger.log(`Soft deleted feeding program: ${id}`);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to delete feeding program: ${id}`, error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Tek bir yemleme programını getirir
   */
  async getProgram(id: string, tenantId: string): Promise<FeedingProgram> {
    const program = await this.programRepository.findOne({
      where: { id, tenantId },
      relations: ['tanks'],
    });

    if (!program) {
      throw new NotFoundException(`Feeding program not found: ${id}`);
    }

    return program;
  }

  /**
   * Yemleme programlarını filtreli olarak listeler
   */
  async getPrograms(
    filter: ProgramFilterInput,
    tenantId: string,
  ): Promise<{ programs: FeedingProgram[]; total: number }> {
    const queryBuilder = this.programRepository
      .createQueryBuilder('program')
      .where('program.tenantId = :tenantId', { tenantId });

    // Status filtresi
    if (filter.status) {
      if (Array.isArray(filter.status)) {
        queryBuilder.andWhere('program.status IN (:...statuses)', {
          statuses: filter.status,
        });
      } else {
        queryBuilder.andWhere('program.status = :status', {
          status: filter.status,
        });
      }
    }

    // Arama (escape LIKE wildcards for security)
    if (filter.search) {
      const sanitizedSearch = this.escapeLikeWildcards(filter.search);
      queryBuilder.andWhere(
        '(program.name ILIKE :search OR program.code ILIKE :search OR program.description ILIKE :search)',
        { search: `%${sanitizedSearch}%` },
      );
    }

    // Tarih filtreleri
    if (filter.startDateFrom) {
      queryBuilder.andWhere('program.startDate >= :startDateFrom', {
        startDateFrom: filter.startDateFrom,
      });
    }

    if (filter.startDateTo) {
      queryBuilder.andWhere('program.startDate <= :startDateTo', {
        startDateTo: filter.startDateTo,
      });
    }

    // Toplam sayı
    const total = await queryBuilder.getCount();

    // Sıralama ve pagination
    queryBuilder
      .orderBy('program.createdAt', 'DESC')
      .skip(filter.offset ?? 0)
      .take(filter.limit ?? 50);

    const programs = await queryBuilder.getMany();

    return { programs, total };
  }

  /**
   * Programı aktifleştirir
   */
  async activateProgram(id: string, tenantId: string): Promise<FeedingProgram> {
    this.logger.log(`Activating feeding program: ${id}`);

    const program = await this.programRepository.findOne({
      where: { id, tenantId },
    });

    if (!program) {
      throw new NotFoundException(`Feeding program not found: ${id}`);
    }

    // Sadece DRAFT veya PAUSED programlar aktifleştirilebilir
    if (
      program.status !== FeedingProgramStatus.DRAFT &&
      program.status !== FeedingProgramStatus.PAUSED
    ) {
      throw new BadRequestException(
        `Cannot activate program in '${program.status}' status`,
      );
    }

    // Feed assignments kontrolü
    if (!program.feedAssignments || program.feedAssignments.length === 0) {
      throw new BadRequestException(
        'Cannot activate program without feed assignments',
      );
    }

    program.status = FeedingProgramStatus.ACTIVE;
    const updatedProgram = await this.programRepository.save(program);

    this.logger.log(`Activated feeding program: ${id}`);
    return updatedProgram;
  }

  /**
   * Programı duraklatır
   */
  async pauseProgram(id: string, tenantId: string): Promise<FeedingProgram> {
    this.logger.log(`Pausing feeding program: ${id}`);

    const program = await this.programRepository.findOne({
      where: { id, tenantId },
    });

    if (!program) {
      throw new NotFoundException(`Feeding program not found: ${id}`);
    }

    // Sadece ACTIVE programlar duraklatılabilir
    if (program.status !== FeedingProgramStatus.ACTIVE) {
      throw new BadRequestException(
        `Cannot pause program in '${program.status}' status. Only ACTIVE programs can be paused.`,
      );
    }

    program.status = FeedingProgramStatus.PAUSED;
    const updatedProgram = await this.programRepository.save(program);

    this.logger.log(`Paused feeding program: ${id}`);
    return updatedProgram;
  }

  // ==========================================================================
  // TANK MANAGEMENT
  // ==========================================================================

  /**
   * Programa tank/pond/cage ekler
   */
  async addTankToProgram(
    programId: string,
    equipmentId: string,
    tenantId: string,
    sensorId?: string,
  ): Promise<FeedingProgramTank> {
    this.logger.log(`Adding tank ${equipmentId} to program ${programId}`);

    // Program kontrolü with tenantId
    const program = await this.programRepository.findOne({
      where: { id: programId, tenantId },
    });

    if (!program) {
      throw new NotFoundException(`Feeding program not found: ${programId}`);
    }

    // Equipment kontrolü with tenantId
    const equipment = await this.equipmentRepository.findOne({
      where: { id: equipmentId, tenantId },
    });

    if (!equipment) {
      throw new NotFoundException(`Equipment not found: ${equipmentId}`);
    }

    // Tank olabilecek ekipman mı kontrol et
    if (!equipment.canHoldFish()) {
      throw new BadRequestException(
        `Equipment '${equipment.name}' cannot hold fish (not a tank/pond/cage)`,
      );
    }

    // NOTE: sensorId validation is not performed here because sensors are managed
    // by sensor-service (different microservice). The resolver/gateway layer should
    // validate sensor ownership if cross-service validation is required.
    // The sensorId is accepted as-is (optional, stored as a UUID reference).

    // Use transaction for consistency
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Aynı programa zaten eklenmiş mi?
      const existingAssignment = await queryRunner.manager.findOne(FeedingProgramTank, {
        where: {
          feedingProgramId: programId,
          equipmentId,
          isActive: true,
        },
      });

      if (existingAssignment) {
        throw new ConflictException(
          `Equipment '${equipment.name}' is already assigned to this program`,
        );
      }

      // Equipment tipini belirle
      let equipmentType = ProgramEquipmentType.TANK;
      if (equipment.isTank) {
        equipmentType = ProgramEquipmentType.TANK;
      }
      // Diğer tipler için gerekirse burada ek kontroller yapılabilir

      // ProgramTank oluştur
      const programTank = queryRunner.manager.create(FeedingProgramTank, {
        tenantId,
        feedingProgramId: programId,
        equipmentId,
        equipmentType,
        equipmentName: equipment.name,
        equipmentCode: equipment.code,
        temperatureSensorId: sensorId,
        isActive: true,
        addedAt: new Date(),
      });

      const savedProgramTank = await queryRunner.manager.save(programTank);

      // Program tank sayısını güncelle
      const tankCount = await queryRunner.manager.count(FeedingProgramTank, {
        where: { feedingProgramId: programId, isActive: true },
      });
      program.totalTanks = tankCount;
      await queryRunner.manager.save(program);

      await queryRunner.commitTransaction();

      this.logger.log(`Added tank ${equipmentId} to program ${programId}`);
      return savedProgramTank;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      // Re-throw known exceptions
      if (error instanceof ConflictException || error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Failed to add tank ${equipmentId} to program ${programId}`, error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Programdan tank/pond/cage çıkarır
   */
  async removeTankFromProgram(
    programId: string,
    equipmentId: string,
    tenantId: string,
  ): Promise<void> {
    this.logger.log(`Removing tank ${equipmentId} from program ${programId}`);

    // Use transaction for consistency
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const programTank = await queryRunner.manager.findOne(FeedingProgramTank, {
        where: {
          feedingProgramId: programId,
          equipmentId,
          tenantId,
          isActive: true,
        },
      });

      if (!programTank) {
        throw new NotFoundException(
          `Equipment ${equipmentId} is not assigned to program ${programId}`,
        );
      }

      // Soft remove - markAsRemoved kullan
      programTank.markAsRemoved();
      await queryRunner.manager.save(programTank);

      // Program tank sayısını güncelle
      const program = await queryRunner.manager.findOne(FeedingProgram, {
        where: { id: programId, tenantId },
      });

      if (program) {
        const tankCount = await queryRunner.manager.count(FeedingProgramTank, {
          where: { feedingProgramId: programId, isActive: true },
        });
        program.totalTanks = tankCount;
        await queryRunner.manager.save(program);
      }

      await queryRunner.commitTransaction();
      this.logger.log(`Removed tank ${equipmentId} from program ${programId}`);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Failed to remove tank ${equipmentId} from program ${programId}`, error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Programa bağlı tankları listeler
   */
  async getProgramTanks(programId: string, tenantId: string): Promise<FeedingProgramTank[]> {
    const tanks = await this.programTankRepository.find({
      where: {
        feedingProgramId: programId,
        tenantId,
        isActive: true,
      },
      order: { addedAt: 'ASC' },
    });

    return tanks;
  }

  // ==========================================================================
  // FEED SELECTION
  // ==========================================================================

  /**
   * Ağırlık için uygun yemi bulur
   *
   * Feed assignments içinden verilen ortalama ağırlık için
   * uygun yem atamasını bulur (önceliğe göre sıralı).
   *
   * For FeedingProgram entity, use program.findFeedForWeight() directly
   * which delegates to the entity's business logic.
   */
  findActiveFeedForWeight(
    feedAssignments: FeedAssignment[],
    avgWeightG: number,
  ): FeedAssignment | null {
    if (!feedAssignments || feedAssignments.length === 0) {
      return null;
    }

    // Önce priority'ye göre sırala (düşük priority = yüksek öncelik)
    const sortedByPriority = [...feedAssignments].sort(
      (a, b) => a.priority - b.priority,
    );

    // Ağırlık aralığına uyan ilk atamayı bul
    for (const assignment of sortedByPriority) {
      if (
        avgWeightG >= assignment.minWeightG &&
        avgWeightG < assignment.maxWeightG
      ) {
        return assignment;
      }
    }

    // Sort by maxWeightG to find proper fallback for over-range
    const sortedByWeight = [...feedAssignments].sort(
      (a, b) => a.maxWeightG - b.maxWeightG,
    );

    // En yüksek ağırlık aralığının üstündeyse, en yüksek maxWeight'e sahip atamayı döndür
    const highestWeightAssignment = sortedByWeight[sortedByWeight.length - 1];
    if (highestWeightAssignment && avgWeightG >= highestWeightAssignment.maxWeightG) {
      return highestWeightAssignment;
    }

    // En düşük ağırlık aralığının altındaysa, en düşük minWeight'e sahip atamayı döndür
    const lowestWeightAssignment = sortedByWeight[0];
    if (lowestWeightAssignment && avgWeightG < lowestWeightAssignment.minWeightG) {
      return lowestWeightAssignment;
    }

    return null;
  }

  // ==========================================================================
  // FCR CALCULATION
  // ==========================================================================

  /**
   * Koşullara göre FCR değerini hesaplar
   *
   * BilinearInterpolationService kullanarak sıcaklık ve ağırlık
   * değerlerine göre FCR interpolasyonu yapar.
   *
   * FCR kaynağı (settings.fcrSource):
   * - PROGRAM: Program'ın kendi fcrTable'ı kullanılır
   * - FEED: Feed entity'sindeki feedingMatrix2D kullanılır
   */
  getFCRForConditions(
    program: FeedingProgram,
    feed: Feed,
    tempC: number,
    weightG: number,
  ): FCRResult {
    const fcrSource = program.settings?.fcrSource ?? FCRSource.FEED;

    // FCR kaynağına göre interpolasyon yap
    if (fcrSource === FCRSource.PROGRAM && program.fcrTable) {
      // Program'ın FCR tablosunu kullan
      return this.interpolateFromProgramFCR(program.fcrTable, tempC, weightG);
    }

    // Feed'in feedingMatrix2D'sini kullan
    if (feed.feedingMatrix2D) {
      const result = this.bilinearInterpolationService.interpolate(
        feed.feedingMatrix2D,
        tempC,
        weightG,
      );

      return {
        fcr: result.fcr ?? 1.0,
        source: FCRSource.FEED,
        temperature: tempC,
        weight: weightG,
        boundingBox: result.boundingBox,
      };
    }

    // feedingCurve'den FCR al (1D)
    if (feed.feedingCurve && Array.isArray(feed.feedingCurve)) {
      const fcr = this.getFCRFromCurve(feed.feedingCurve, weightG);
      return {
        fcr: fcr ?? 1.0,
        source: FCRSource.FEED,
        temperature: tempC,
        weight: weightG,
      };
    }

    // Varsayılan FCR
    this.logger.warn(
      `No FCR data available for program ${program.id}, feed ${feed.id}. Using default FCR=1.0`,
    );
    return {
      fcr: 1.0,
      source: fcrSource,
      temperature: tempC,
      weight: weightG,
    };
  }

  // ==========================================================================
  // PRIVATE METHODS
  // ==========================================================================

  /**
   * Feed assignments doğrulama
   */
  private validateFeedAssignments(
    assignments: FeedAssignment[],
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!assignments || assignments.length === 0) {
      errors.push('At least one feed assignment is required');
      return { valid: false, errors };
    }

    // Sıralı kontrol
    const sorted = [...assignments].sort(
      (a, b) => a.minWeightG - b.minWeightG,
    );

    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];
      if (!current) continue;

      // Min < Max kontrolü
      if (current.minWeightG >= current.maxWeightG) {
        errors.push(
          `${current.feedCode}: minWeight (${current.minWeightG}) must be less than maxWeight (${current.maxWeightG})`,
        );
      }

      // Negatif değer kontrolü
      if (current.minWeightG < 0 || current.maxWeightG < 0) {
        errors.push(`${current.feedCode}: Weight values cannot be negative`);
      }

      // Priority kontrolü
      if (current.priority < 1) {
        errors.push(`${current.feedCode}: Priority must be at least 1`);
      }

      // feedId kontrolü
      if (!current.feedId) {
        errors.push(`${current.feedCode}: feedId is required`);
      }

      // Boşluk kontrolü
      if (i > 0) {
        const prev = sorted[i - 1];
        if (prev && current.minWeightG > prev.maxWeightG) {
          errors.push(
            `Weight range gap between ${prev.feedCode} (max: ${prev.maxWeightG}g) and ${current.feedCode} (min: ${current.minWeightG}g)`,
          );
        }
      }

      // Örtüşme kontrolü (uyarı olarak)
      if (i > 0) {
        const prev = sorted[i - 1];
        if (prev && current.minWeightG < prev.maxWeightG) {
          // Örtüşme varsa priority ile çözülür, bu bir hata değil uyarı
          this.logger.warn(
            `Overlapping weight ranges: ${prev.feedCode} and ${current.feedCode}. Priority will be used to resolve.`,
          );
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * FCR tablosu doğrulama
   */
  private validateFCRTable(
    fcrTable: FCRTable,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!fcrTable.temperatures || fcrTable.temperatures.length === 0) {
      errors.push('FCR table must have at least one temperature value');
    }

    if (!fcrTable.weights || fcrTable.weights.length === 0) {
      errors.push('FCR table must have at least one weight value');
    }

    if (!fcrTable.fcrValues || fcrTable.fcrValues.length === 0) {
      errors.push('FCR table must have FCR values');
    }

    // Matris boyutları kontrolü
    if (fcrTable.temperatures && fcrTable.fcrValues) {
      if (fcrTable.fcrValues.length !== fcrTable.temperatures.length) {
        errors.push(
          `FCR matrix rows (${fcrTable.fcrValues.length}) must match temperature count (${fcrTable.temperatures.length})`,
        );
      }
    }

    if (fcrTable.weights && fcrTable.fcrValues) {
      for (let i = 0; i < fcrTable.fcrValues.length; i++) {
        const row = fcrTable.fcrValues[i];
        if (row && row.length !== fcrTable.weights.length) {
          errors.push(
            `FCR matrix row ${i} columns (${row.length}) must match weight count (${fcrTable.weights.length})`,
          );
        }
      }
    }

    // FCR değerleri kontrolü (0 = uncovered cell, 0 < FCR <= 5 geçerli)
    if (fcrTable.fcrValues) {
      for (let i = 0; i < fcrTable.fcrValues.length; i++) {
        const row = fcrTable.fcrValues[i];
        if (row) {
          for (let j = 0; j < row.length; j++) {
            const fcr = row[j];
            // 0 is allowed as it indicates an uncovered cell
            if (fcr !== undefined && fcr !== 0 && (fcr < 0 || fcr > 5)) {
              errors.push(
                `Invalid FCR value at [${i}][${j}]: ${fcr} (must be 0 or between 0 and 5)`,
              );
            }
          }
        }
      }
    }

    // Sıralama kontrolü (artan sırada olmalı)
    if (fcrTable.temperatures && fcrTable.temperatures.length > 1) {
      for (let i = 1; i < fcrTable.temperatures.length; i++) {
        const current = fcrTable.temperatures[i];
        const prev = fcrTable.temperatures[i - 1];
        if (current !== undefined && prev !== undefined && current <= prev) {
          errors.push('Temperature values must be in ascending order');
          break;
        }
      }
    }

    if (fcrTable.weights && fcrTable.weights.length > 1) {
      for (let i = 1; i < fcrTable.weights.length; i++) {
        const current = fcrTable.weights[i];
        const prev = fcrTable.weights[i - 1];
        if (current !== undefined && prev !== undefined && current <= prev) {
          errors.push('Weight values must be in ascending order');
          break;
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Yem ID'lerinin geçerliliğini kontrol eder
   */
  private async validateFeedIds(
    assignments: FeedAssignment[],
    tenantId: string,
  ): Promise<void> {
    const feedIds = assignments.map((a) => a.feedId);
    const uniqueFeedIds = [...new Set(feedIds)];

    const feeds = await this.feedRepository.find({
      where: {
        id: In(uniqueFeedIds),
        tenantId,
        isDeleted: false,
      },
      select: ['id', 'code'],
    });

    const foundIds = new Set(feeds.map((f) => f.id));
    const missingIds = uniqueFeedIds.filter((id) => !foundIds.has(id));

    if (missingIds.length > 0) {
      throw new BadRequestException(
        `Feed(s) not found: ${missingIds.join(', ')}`,
      );
    }
  }

  /**
   * Program FCR tablosundan interpolasyon yapar
   */
  private interpolateFromProgramFCR(
    fcrTable: FCRTable,
    tempC: number,
    weightG: number,
  ): FCRResult {
    const { temperatures, weights, fcrValues } = fcrTable;

    // Sıcaklık için sınır indekslerini bul
    const tIndices = this.findBoundingIndices(temperatures, tempC);
    // Ağırlık için sınır indekslerini bul
    const wIndices = this.findBoundingIndices(weights, weightG);

    // Köşe değerlerini al
    const t1 = temperatures[tIndices.lower] ?? temperatures[0] ?? 15;
    const t2 = temperatures[tIndices.upper] ?? temperatures[0] ?? 15;
    const w1 = weights[wIndices.lower] ?? weights[0] ?? 10;
    const w2 = weights[wIndices.upper] ?? weights[0] ?? 10;

    // FCR matrisinden köşe değerlerini al
    const f11 = this.safeGet(fcrValues, tIndices.lower, wIndices.lower, 1.0);
    const f21 = this.safeGet(fcrValues, tIndices.upper, wIndices.lower, 1.0);
    const f12 = this.safeGet(fcrValues, tIndices.lower, wIndices.upper, 1.0);
    const f22 = this.safeGet(fcrValues, tIndices.upper, wIndices.upper, 1.0);

    // Bilinear interpolasyon
    const fcr = this.bilinear(tempC, weightG, t1, t2, w1, w2, f11, f21, f12, f22);

    return {
      fcr: Math.round(fcr * 100) / 100,
      source: FCRSource.PROGRAM,
      temperature: tempC,
      weight: weightG,
      boundingBox: { t1, t2, w1, w2 },
    };
  }

  /**
   * 1D feeding curve'den FCR alır
   */
  private getFCRFromCurve(
    feedingCurve: Array<{ fishWeightG: number; fcr: number }>,
    avgWeightG: number,
  ): number | null {
    if (!Array.isArray(feedingCurve) || feedingCurve.length === 0) {
      return null;
    }

    // Sort by fish weight descending and find the first match
    const sortedCurve = [...feedingCurve].sort(
      (a, b) => b.fishWeightG - a.fishWeightG,
    );
    const curvePoint = sortedCurve.find((p) => avgWeightG >= p.fishWeightG);

    return curvePoint?.fcr ?? null;
  }

  /**
   * Verilen değer için sınırlayıcı indeksleri bulur
   */
  private findBoundingIndices(
    axis: number[],
    value: number,
  ): { lower: number; upper: number } {
    if (!axis || axis.length === 0) {
      return { lower: 0, upper: 0 };
    }

    const firstVal = axis[0];
    const lastVal = axis[axis.length - 1];

    // Değer minimum'dan küçükse
    if (firstVal !== undefined && value <= firstVal) {
      return { lower: 0, upper: 0 };
    }

    // Değer maksimumdan büyükse
    if (lastVal !== undefined && value >= lastVal) {
      const last = axis.length - 1;
      return { lower: last, upper: last };
    }

    // Aradaki indeksleri bul
    for (let i = 0; i < axis.length - 1; i++) {
      const current = axis[i];
      const next = axis[i + 1];
      if (
        current !== undefined &&
        next !== undefined &&
        value >= current &&
        value < next
      ) {
        return { lower: i, upper: i + 1 };
      }
    }

    return { lower: 0, upper: 0 };
  }

  /**
   * 2D diziden güvenli değer okuma
   */
  private safeGet(
    matrix: number[][],
    row: number,
    col: number,
    defaultValue: number,
  ): number {
    const rowData = matrix?.[row];
    if (!rowData) {
      return defaultValue;
    }
    const value = rowData[col];
    if (value === undefined || value === null || typeof value !== 'number' || isNaN(value)) {
      return defaultValue;
    }
    return value;
  }

  /**
   * Bilinear interpolasyon formülü
   */
  private bilinear(
    x: number,
    y: number,
    x1: number,
    x2: number,
    y1: number,
    y2: number,
    f11: number,
    f21: number,
    f12: number,
    f22: number,
  ): number {
    // Edge case: Aynı nokta
    if (x1 === x2 && y1 === y2) {
      return f11;
    }

    // Sadece x'te interpolasyon
    if (y1 === y2) {
      if (x1 === x2) return f11;
      return f11 + ((f21 - f11) * (x - x1)) / (x2 - x1);
    }

    // Sadece y'de interpolasyon
    if (x1 === x2) {
      return f11 + ((f12 - f11) * (y - y1)) / (y2 - y1);
    }

    // Tam bilinear interpolasyon
    const denom = (x2 - x1) * (y2 - y1);

    return (
      (f11 * (x2 - x) * (y2 - y) +
        f21 * (x - x1) * (y2 - y) +
        f12 * (x2 - x) * (y - y1) +
        f22 * (x - x1) * (y - y1)) /
      denom
    );
  }

  /**
   * Escapes LIKE wildcards (%, _) in search strings to prevent SQL injection
   * and unintended pattern matching.
   */
  private escapeLikeWildcards(input: string): string {
    return input
      .replace(/\\/g, '\\\\')  // Escape backslash first
      .replace(/%/g, '\\%')    // Escape percent
      .replace(/_/g, '\\_');   // Escape underscore
  }
}
