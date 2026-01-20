/**
 * VerifyMeasurementHandler
 *
 * VerifyMeasurementCommand'ı işler ve ölçümü doğrular.
 *
 * @module Growth/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { VerifyMeasurementCommand } from '../commands/verify-measurement.command';
import { GrowthMeasurement } from '../entities/growth-measurement.entity';

@Injectable()
@CommandHandler(VerifyMeasurementCommand)
export class VerifyMeasurementHandler implements ICommandHandler<VerifyMeasurementCommand, GrowthMeasurement> {
  constructor(
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
  ) {}

  async execute(command: VerifyMeasurementCommand): Promise<GrowthMeasurement> {
    const { tenantId, measurementId, userId, notes } = command;

    // Measurement'ı bul
    const measurement = await this.measurementRepository.findOne({
      where: { id: measurementId, tenantId },
    });

    if (!measurement) {
      throw new NotFoundException(`Measurement ${measurementId} bulunamadı`);
    }

    if (measurement.isVerified) {
      throw new BadRequestException('Bu ölçüm zaten doğrulanmış');
    }

    // Doğrulamayı yapan kişi ölçümü yapan kişiden farklı olmalı
    if (measurement.measuredBy === userId) {
      throw new BadRequestException('Ölçümü doğrulayan kişi ölçümü yapan kişi olamaz');
    }

    // Doğrula
    measurement.isVerified = true;
    measurement.verifiedBy = userId;
    measurement.verifiedAt = new Date();

    if (notes) {
      measurement.notes = measurement.notes
        ? `${measurement.notes}\n[Doğrulama notu]: ${notes}`
        : `[Doğrulama notu]: ${notes}`;
    }

    return this.measurementRepository.save(measurement);
  }
}
