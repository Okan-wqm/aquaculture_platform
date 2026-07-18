import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import {
  SensorDataChannel,
  ChannelDataType,
} from '../database/entities/sensor-data-channel.entity';

import { CalibrationEvent } from './calibration-event.entity';
import { RecordCalibrationInput } from './dto/calibration.dto';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Identity of the operator recording a calibration. Threaded from the resolver's
 * authenticated `@CurrentUser` so the event carries a real actor, not a log line.
 */
export interface CalibrationActor {
  userId: string;
  email?: string;
}

/**
 * CalibrationRecordingService — the calibration aggregate (SENSOR-HIGH-083).
 *
 * `recordCalibration` is the SINGLE write path for a channel's calibration
 * coefficients. It appends an immutable `CalibrationEvent` AND, in the same
 * transaction, stamps the channel's coefficients, `lastCalibratedAt`, and the
 * computed `nextCalibrationDue`. `updateDataChannel` no longer writes
 * coefficients, so the calibration status the UI derives can no longer lie:
 * a channel that has been calibrated reports its real last/next dates, and
 * overdue-calibration warnings actually fire once a per-channel interval is set.
 */
@Injectable()
export class CalibrationRecordingService {
  private readonly logger = new Logger(CalibrationRecordingService.name);

  constructor(
    @InjectRepository(CalibrationEvent)
    private readonly calibrationEventRepository: Repository<CalibrationEvent>,
    @InjectRepository(SensorDataChannel)
    private readonly channelRepository: Repository<SensorDataChannel>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Record a calibration for a channel: persist the event and atomically update
   * the channel's coefficients, last-calibrated stamp, and next-due date.
   *
   * SECURITY: tenantId in the WHERE clause prevents cross-tenant IDOR.
   */
  async recordCalibration(
    tenantId: string,
    actor: CalibrationActor,
    input: RecordCalibrationInput,
  ): Promise<SensorDataChannel> {
    const channel = await this.channelRepository.findOne({
      where: { id: input.channelId, tenantId },
    });
    if (!channel) {
      throw new NotFoundException(`Channel with ID '${input.channelId}' not found`);
    }

    // Calibration only has meaning for numeric channels — the coefficients are
    // applied as `raw * multiplier + offset` to a numeric reading.
    if (channel.dataType !== ChannelDataType.NUMBER) {
      throw new BadRequestException(
        `Channel '${channel.channelKey}' is not numeric; calibration applies only to number channels`,
      );
    }

    // A non-finite or zero multiplier would corrupt every reading (zero collapses
    // all readings to the offset; NaN/Infinity poisons the data path).
    if (!Number.isFinite(input.calibrationMultiplier) || input.calibrationMultiplier === 0) {
      throw new BadRequestException(
        'calibrationMultiplier must be a finite, non-zero number',
      );
    }
    if (!Number.isFinite(input.calibrationOffset)) {
      throw new BadRequestException('calibrationOffset must be a finite number');
    }

    // Per-channel interval: an explicit input wins; otherwise reuse the channel's
    // stored interval. With neither set, no due date is computed — the channel
    // stays "calibrated" rather than falsely showing "overdue".
    const intervalDays = input.intervalDays ?? channel.calibrationIntervalDays ?? undefined;

    const calibratedAt = new Date();
    const nextCalibrationDue =
      intervalDays != null
        ? new Date(calibratedAt.getTime() + intervalDays * MS_PER_DAY)
        : undefined;

    const referenceValues = input.referenceValues?.map((p) => ({
      raw: p.raw,
      reference: p.reference,
      ...(p.label !== undefined ? { label: p.label } : {}),
    }));

    // The event carries an explicit tenantId and the channel was loaded
    // tenant-scoped above, so writing them through the transaction's EntityManager
    // (manager.create/save with the entity class — never getRepository) keeps
    // tenant isolation intact while making the two writes atomic.
    const updatedChannel = await this.dataSource.transaction(async (manager) => {
      const event = manager.create(CalibrationEvent, {
        tenantId,
        channelId: channel.id,
        sensorId: channel.sensorId,
        calibrationMultiplier: input.calibrationMultiplier,
        calibrationOffset: input.calibrationOffset,
        referenceValues,
        intervalDays,
        nextCalibrationDue,
        performedBy: actor.userId,
        performedByEmail: actor.email,
        notes: input.notes,
        calibratedAt,
      });
      await manager.save(CalibrationEvent, event);

      channel.calibrationEnabled = input.calibrationEnabled;
      channel.calibrationMultiplier = input.calibrationMultiplier;
      channel.calibrationOffset = input.calibrationOffset;
      channel.lastCalibratedAt = calibratedAt;
      channel.nextCalibrationDue = nextCalibrationDue;
      if (intervalDays != null) {
        channel.calibrationIntervalDays = intervalDays;
      }

      return manager.save(SensorDataChannel, channel);
    });

    this.logger.log(
      `Recorded calibration for channel ${channel.channelKey} (${channel.id}) by ${actor.userId}`,
    );

    return updatedChannel;
  }

  /**
   * Return the calibration history for a channel, newest first.
   * SECURITY: tenantId in the WHERE clause prevents cross-tenant IDOR.
   */
  async getCalibrationHistory(
    tenantId: string,
    channelId: string,
  ): Promise<CalibrationEvent[]> {
    return this.calibrationEventRepository.find({
      where: { tenantId, channelId },
      order: { calibratedAt: 'DESC' },
    });
  }
}
