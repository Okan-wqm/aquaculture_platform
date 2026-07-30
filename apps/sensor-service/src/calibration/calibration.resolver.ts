import { UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { Tenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { DataChannelType } from '../registration/dto/data-channel.dto';

import { CalibrationEvent } from './calibration-event.entity';
import { CalibrationRecordingService } from './calibration-recording.service';
import { RecordCalibrationInput } from './dto/calibration.dto';

/** Minimal shape of the authenticated JWT payload this resolver reads. */
interface CalibrationUser {
  sub?: string;
  email?: string;
}

/**
 * GraphQL resolver for the calibration aggregate (SENSOR-HIGH-083).
 *
 * `recordCalibration` is the only mutation that changes a channel's calibration
 * coefficients; it returns the updated channel so the client sees the freshly
 * stamped `lastCalibratedAt` / `nextCalibrationDue` (and thus a truthful status)
 * without a second round-trip. `calibrationHistory` exposes the immutable event
 * trail for a channel.
 */
@Resolver(() => CalibrationEvent)
@UseGuards(TenantGuard)
export class CalibrationResolver {
  constructor(private readonly calibrationService: CalibrationRecordingService) {}

  @Query(() => [CalibrationEvent], { name: 'calibrationHistory' })
  async calibrationHistory(
    @Args('channelId', { type: () => ID }) channelId: string,
    @Tenant() tenantId: string,
  ): Promise<CalibrationEvent[]> {
    return this.calibrationService.getCalibrationHistory(tenantId, channelId);
  }

  /**
   * Record a calibration for a channel.
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER.
   */
  @Mutation(() => DataChannelType, { name: 'recordCalibration' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async recordCalibration(
    @Args('input') input: RecordCalibrationInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: CalibrationUser,
  ): Promise<SensorDataChannel> {
    return this.calibrationService.recordCalibration(
      tenantId,
      { userId: user?.sub ?? 'unknown-user', email: user?.email },
      input,
    );
  }
}
