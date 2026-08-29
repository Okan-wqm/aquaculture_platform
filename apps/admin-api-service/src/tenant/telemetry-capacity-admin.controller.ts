import { SecurityEventService } from '@aquaculture/backend-common/security';
import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuditSeverity } from '../audit/audit.entity';
import { AuditLogService } from '../audit/audit.service';
import { CurrentUser } from '../decorators/current-user.decorator';

import {
  CreateTelemetryCapacityEnvelopeDto,
  ReleaseTelemetryCapacityEntitlementDto,
} from './dto/tenant.dto';
import {
  TelemetryCapacityService,
  type TelemetryCapacityEntitlementSnapshot,
  type TelemetryCapacityEnvelopeSnapshot,
} from './services/telemetry-capacity.service';

interface CapacityAdminUser {
  id: string;
  email: string;
  roles: string[];
}

@ApiTags('Telemetry Capacity')
@Controller('admin/telemetry-capacity')
export class TelemetryCapacityAdminController {
  constructor(
    private readonly telemetryCapacityService: TelemetryCapacityService,
    private readonly auditLogService: AuditLogService,
    private readonly securityEventService: SecurityEventService,
  ) {}

  @Post('envelopes')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create and activate a versioned telemetry capacity envelope' })
  async createEnvelope(
    @Body() dto: CreateTelemetryCapacityEnvelopeDto,
    @CurrentUser() user: CapacityAdminUser,
  ): Promise<TelemetryCapacityEnvelopeSnapshot> {
    const envelope = await this.telemetryCapacityService.createEnvelope({
      sustainedIngressMessagesPerSecond: dto.sustainedIngressMessagesPerSecond,
      sustainedMetricRowsPerMinute: dto.sustainedMetricRowsPerMinute,
      effectiveAt: new Date(dto.effectiveAt),
      createdBy: user.id,
    });
    await this.auditLogService.log({
      action: 'TELEMETRY_CAPACITY_ENVELOPE_CREATED',
      entityType: 'telemetry_capacity_envelope',
      entityId: envelope.id,
      performedBy: user.id,
      performedByEmail: user.email,
      severity: AuditSeverity.WARNING,
      details: {
        version: envelope.version,
        sustainedIngressMessagesPerSecond: envelope.sustainedIngressMessagesPerSecond,
        sustainedMetricRowsPerMinute: envelope.sustainedMetricRowsPerMinute,
        effectiveAt: envelope.effectiveAt.toISOString(),
      },
    });
    await this.securityEventService.publishSuspiciousActivity({
      userId: user.id,
      description: 'Platform telemetry capacity envelope changed',
      action: 'TELEMETRY_CAPACITY_ENVELOPE_CREATED',
      capacityEnvelopeId: envelope.id,
      capacityEnvelopeVersion: envelope.version,
    });
    return envelope;
  }

  @Post('entitlements/:tenantId/:operationId/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release an entitlement revision and restore its prior active version' })
  async releaseEntitlement(
    @Param('tenantId', new ParseUUIDPipe({ version: '4' })) tenantId: string,
    @Param('operationId', new ParseUUIDPipe({ version: '4' })) operationId: string,
    @Body() dto: ReleaseTelemetryCapacityEntitlementDto,
    @CurrentUser() user: CapacityAdminUser,
  ): Promise<TelemetryCapacityEntitlementSnapshot> {
    const entitlement = await this.telemetryCapacityService.release(operationId, tenantId);
    await this.auditLogService.log({
      action: 'TELEMETRY_CAPACITY_ENTITLEMENT_RELEASED',
      entityType: 'telemetry_capacity_entitlement',
      entityId: entitlement.entitlementId,
      performedBy: user.id,
      performedByEmail: user.email,
      severity: AuditSeverity.WARNING,
      details: {
        operationId,
        tenantId,
        entitlementVersion: entitlement.entitlementVersion,
        reason: dto.reason,
      },
    });
    await this.securityEventService.publishSuspiciousActivity({
      userId: user.id,
      description: 'Platform telemetry capacity entitlement released',
      action: 'TELEMETRY_CAPACITY_ENTITLEMENT_RELEASED',
      tenantId,
      operationId,
      entitlementId: entitlement.entitlementId,
    });
    return entitlement;
  }
}
