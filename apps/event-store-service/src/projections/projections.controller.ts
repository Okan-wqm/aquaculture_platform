import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Req,
  UnauthorizedException,
  GoneException,
} from '@nestjs/common';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import { IsOptional, IsString, Matches } from 'class-validator';
import { ProjectionsService } from './projections.service';
import { ProjectionCheckpoint } from './entities/projection-checkpoint.entity';
import { ProjectionRebuildStatus } from './entities/projection-rebuild.entity';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class RebuildProjectionDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  requestedFromPosition?: string;

  @IsString()
  reason!: string;

  @IsOptional()
  @IsString()
  requestedBy?: string;

  @IsOptional()
  @IsString()
  correlationId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

/**
 * Extracts and validates tenant ID from the service-identity guard result.
 */
function extractTenantId(request: TenantRequest): string {
  const tenantId = request.verifiedIdentity?.effectiveTenantId ?? request.tenantId;
  if (!tenantId || typeof tenantId !== 'string') {
    throw new UnauthorizedException('Verified tenant context is required');
  }

  const trimmedTenantId = tenantId.trim();
  if (trimmedTenantId.length === 0) {
    throw new UnauthorizedException('Verified tenant context cannot be empty');
  }

  // Validate UUID format to prevent injection and ensure proper tenant isolation
  if (!UUID_REGEX.test(trimmedTenantId)) {
    throw new UnauthorizedException('Invalid tenant ID format');
  }

  return trimmedTenantId;
}

@Controller('projections')
export class ProjectionsController {
  constructor(private readonly projectionsService: ProjectionsService) {}

  /**
   * Get all projections
   */
  @Get()
  async getAllProjections(
    @Req() request: TenantRequest,
  ): Promise<ProjectionCheckpoint[]> {
    const tenantId = extractTenantId(request);
    return this.projectionsService.getAllProjections(tenantId);
  }

  /**
   * Get projection status
   */
  @Get(':name')
  async getProjectionStatus(
    @Param('name') name: string,
    @Req() request: TenantRequest,
  ): Promise<ProjectionCheckpoint> {
    const tenantId = extractTenantId(request);
    const projection = await this.projectionsService.getProjectionStatus(name, tenantId);
    if (!projection) {
      throw new NotFoundException(`Projection ${name} not found`);
    }
    return projection;
  }

  /**
   * Get projection lag
   */
  @Get(':name/lag')
  async getProjectionLag(
    @Param('name') name: string,
    @Req() request: TenantRequest,
  ): Promise<{ name: string; lag: string }> {
    const tenantId = extractTenantId(request);
    const lag = await this.projectionsService.getProjectionLag(name, tenantId);
    return { name, lag };
  }

  /**
   * Start a projection
   */
  @Post(':name/start')
  @HttpCode(HttpStatus.OK)
  async startProjection(
    @Param('name') name: string,
    @Req() request: TenantRequest,
  ): Promise<{ message: string }> {
    const tenantId = extractTenantId(request);
    await this.projectionsService.startProjection(name, tenantId);
    return { message: `Projection ${name} started` };
  }

  /**
   * Stop a projection
   */
  @Post(':name/stop')
  @HttpCode(HttpStatus.OK)
  async stopProjection(
    @Param('name') name: string,
    @Req() request: TenantRequest,
  ): Promise<{ message: string }> {
    const tenantId = extractTenantId(request);
    await this.projectionsService.stopProjection(name, tenantId);
    return { message: `Projection ${name} stopped` };
  }

  /**
   * Pause a projection
   */
  @Post(':name/pause')
  @HttpCode(HttpStatus.OK)
  async pauseProjection(
    @Param('name') name: string,
    @Req() request: TenantRequest,
  ): Promise<{ message: string }> {
    const tenantId = extractTenantId(request);
    await this.projectionsService.pauseProjection(name, tenantId);
    return { message: `Projection ${name} paused` };
  }

  /**
   * Resume a paused projection
   */
  @Post(':name/resume')
  @HttpCode(HttpStatus.OK)
  async resumeProjection(
    @Param('name') name: string,
    @Req() request: TenantRequest,
  ): Promise<{ message: string }> {
    const tenantId = extractTenantId(request);
    await this.projectionsService.resumeProjection(name, tenantId);
    return { message: `Projection ${name} resumed` };
  }

  /**
   * Deprecated reset alias. Production rebuilds must use POST /projections/:name/rebuilds.
   */
  @Post(':name/reset')
  @HttpCode(HttpStatus.GONE)
  async resetProjection(
    @Param('name') name: string,
    @Req() request: TenantRequest,
  ): Promise<never> {
    extractTenantId(request);
    throw new GoneException(
      `Projection reset endpoint for ${name} is retired; use POST /projections/:name/rebuilds`,
    );
  }

  /**
   * Request an auditable projection rebuild from a specific position.
   */
  @Post(':name/rebuilds')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestProjectionRebuild(
    @Param('name') name: string,
    @Body() dto: RebuildProjectionDto,
    @Req() request: TenantRequest,
  ): Promise<{
    jobId: string;
    projectionName: string;
    tenantId: string;
    requestedFromPosition: string;
    sourceGeneration: number;
    targetGeneration: number;
    status: ProjectionRebuildStatus;
  }> {
    const tenantId = extractTenantId(request);
    return this.projectionsService.requestProjectionRebuild(name, tenantId, {
      requestedFromPosition: dto.requestedFromPosition ?? '0',
      reason: dto.reason,
      requestedBy: dto.requestedBy,
      correlationId: dto.correlationId,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /**
   * Process a batch manually
   */
  @Post(':name/process')
  @HttpCode(HttpStatus.OK)
  async processBatch(
    @Param('name') name: string,
    @Req() request: TenantRequest,
  ): Promise<{ processed: number; failed: number; newPosition: string }> {
    const tenantId = extractTenantId(request);
    return this.projectionsService.processBatch(name, tenantId);
  }
}
