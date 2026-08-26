import { SecurityEventService } from '@aquaculture/backend-common/security';
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { IngressOwnerPolicy } from '@platform/event-contracts';

import { AuditSeverity } from '../audit/audit.entity';
import { AuditLogService } from '../audit/audit.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { PlatformAdminGuard } from '../guards/platform-admin.guard';

import { AppendIngressOwnerPolicyDto } from './dto/append-ingress-owner-policy.dto';
import { IngressOwnerPolicyService } from './services/ingress-owner-policy.service';

interface OwnerPolicyAdminUser {
  id: string;
  email: string;
  roles: string[];
}

@ApiTags('Ingress Owner Policy')
@Controller('admin/ingress-owner-policies')
@UseGuards(PlatformAdminGuard)
export class IngressOwnerPolicyController {
  constructor(
    private readonly policyService: IngressOwnerPolicyService,
    private readonly auditLogService: AuditLogService,
    private readonly securityEventService: SecurityEventService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append a versioned ingress-owner handoff state' })
  async appendPolicy(
    @Body() dto: AppendIngressOwnerPolicyDto,
    @CurrentUser() user: OwnerPolicyAdminUser,
  ): Promise<IngressOwnerPolicy> {
    const policy = await this.policyService.append({
      policy: {
        tenantId: dto.tenantId,
        version: dto.version,
        owner: dto.owner,
        effectiveEpoch: dto.effectiveEpoch,
        state: dto.state,
      },
      drainBarrierSatisfied: dto.drainBarrierSatisfied,
      drainBarrierEvidence: dto.drainBarrierEvidence,
      actorId: user.id,
    });

    await this.auditLogService.log({
      action: 'INGRESS_OWNER_POLICY_CHANGED',
      entityType: 'ingress_owner_policy',
      entityId: policy.tenantId,
      tenantId: policy.tenantId,
      performedBy: user.id,
      performedByEmail: user.email,
      severity: AuditSeverity.CRITICAL,
      details: {
        version: policy.version,
        owner: policy.owner,
        effectiveEpoch: policy.effectiveEpoch,
        state: policy.state,
        drainBarrierSatisfied: dto.drainBarrierSatisfied,
        drainBarrierEvidence: dto.drainBarrierEvidence,
        reason: dto.reason,
      },
    });
    await this.securityEventService.publishSuspiciousActivity({
      userId: user.id,
      tenantId: policy.tenantId,
      description: 'Ingress owner policy changed',
      action: 'INGRESS_OWNER_POLICY_CHANGED',
      version: policy.version,
      owner: policy.owner,
      effectiveEpoch: policy.effectiveEpoch,
      state: policy.state,
    });

    return policy;
  }
}
