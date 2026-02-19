/**
 * Save Feeder Calibrations Command Handler
 * Upsert strategy: delete existing calibrations for the equipment, then insert new ones.
 * Uses a transaction to ensure atomicity (no data loss on partial failure).
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { SaveFeederCalibrationsCommand } from '../commands/save-feeder-calibrations.command';
import { FeederCalibration } from '../entities/feeder-calibration.entity';

@CommandHandler(SaveFeederCalibrationsCommand)
export class SaveFeederCalibrationsHandler implements ICommandHandler<SaveFeederCalibrationsCommand> {
  private readonly logger = new Logger(SaveFeederCalibrationsHandler.name);

  constructor(
    @InjectRepository(FeederCalibration)
    private readonly calibrationRepository: Repository<FeederCalibration>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: SaveFeederCalibrationsCommand): Promise<FeederCalibration[]> {
    const { input, tenantId } = command;
    const { equipmentId, calibrations } = input;

    this.logger.log(`Saving ${calibrations.length} calibrations for equipment ${equipmentId}`);

    // Wrap delete + insert in a transaction to prevent data loss on partial failure
    return this.dataSource.transaction(async (manager) => {
      // Delete existing calibrations for this equipment
      await manager.delete(FeederCalibration, {
        tenantId,
        equipmentId,
      });

      // Insert new calibrations
      if (calibrations.length === 0) {
        return [];
      }

      const entities = calibrations.map((cal) =>
        manager.create(FeederCalibration, {
          tenantId,
          equipmentId,
          feedSizeMm: cal.feedSizeMm,
          feedSizeLabel: cal.feedSizeLabel,
          gramsPerDispensing: cal.gramsPerDispensing,
          siloCapacityKg: cal.siloCapacityKg,
          notes: cal.notes,
        }),
      );

      const saved = await manager.save(entities);
      this.logger.log(`Saved ${saved.length} calibrations for equipment ${equipmentId}`);
      return saved;
    });
  }
}
