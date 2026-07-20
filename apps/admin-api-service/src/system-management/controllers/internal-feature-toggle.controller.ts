import {
  RequireInternalServiceCallers,
  InternalServiceCallersGuard,
} from '@aquaculture/backend-common/guards';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  Matches,
} from 'class-validator';
import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { Public } from '../../decorators/public.decorator';
import { SkipResponseEnvelope } from '../../shared/skip-response-envelope.decorator';
import { GlobalSettingsService } from '../services/global-settings.service';
import { InternalFeatureEvaluationSigner } from '../services/internal-feature-evaluation-signer.service';

export class InternalFeatureEvaluationRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[a-z][a-z0-9_]{0,99}$/, { each: true })
  featureKeys!: string[];
}

@Controller('internal/feature-toggles')
@Public()
@UseGuards(InternalServiceCallersGuard)
@RequireInternalServiceCallers('gateway-api', 'farm-service')
@SkipResponseEnvelope()
export class InternalFeatureToggleController {
  constructor(
    private readonly settings: GlobalSettingsService,
    private readonly signer: InternalFeatureEvaluationSigner,
  ) {}

  @Post('evaluate')
  @HttpCode(HttpStatus.OK)
  async evaluate(@Req() request: TenantRequest, @Body() body: InternalFeatureEvaluationRequestDto) {
    const identity = request.verifiedIdentity;
    const tenantId = identity?.effectiveTenantId ?? identity?.tenantId;
    if (!identity || !tenantId) {
      throw new ForbiddenException('Verified tenant-bound service identity is required');
    }

    const featureKeys = [...body.featureKeys].sort();
    const evaluations = await Promise.all(
      featureKeys.map(async (key) => {
        const evaluation = await this.settings.evaluateFeatureToggle(key, { tenantId });
        return { key, enabled: evaluation.enabled };
      }),
    );

    return this.signer.sign({
      audience: identity.serviceName,
      tenantId,
      evaluations,
    });
  }
}
