import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ProjectionsService } from './projections.service';
import { ProjectionCheckpoint } from './entities/projection-checkpoint.entity';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ResetProjectionDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  position?: number;
}

/**
 * Extracts and validates tenant ID from headers
 */
function extractTenantId(tenantIdHeader: string | undefined): string {
  if (!tenantIdHeader || typeof tenantIdHeader !== 'string') {
    throw new UnauthorizedException('Tenant ID is required');
  }

  const trimmedTenantId = tenantIdHeader.trim();
  if (trimmedTenantId.length === 0) {
    throw new UnauthorizedException('Tenant ID cannot be empty');
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
    @Headers('x-tenant-id') tenantIdHeader: string,
  ): Promise<ProjectionCheckpoint[]> {
    const tenantId = extractTenantId(tenantIdHeader);
    return this.projectionsService.getAllProjections(tenantId);
  }

  /**
   * Get projection status
   */
  @Get(':name')
  async getProjectionStatus(
    @Param('name') name: string,
    @Headers('x-tenant-id') tenantIdHeader: string,
  ): Promise<ProjectionCheckpoint> {
    const tenantId = extractTenantId(tenantIdHeader);
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
    @Headers('x-tenant-id') tenantIdHeader: string,
  ): Promise<{ name: string; lag: number }> {
    const tenantId = extractTenantId(tenantIdHeader);
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
    @Headers('x-tenant-id') tenantIdHeader: string,
  ): Promise<{ message: string }> {
    const tenantId = extractTenantId(tenantIdHeader);
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
    @Headers('x-tenant-id') tenantIdHeader: string,
  ): Promise<{ message: string }> {
    const tenantId = extractTenantId(tenantIdHeader);
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
    @Headers('x-tenant-id') tenantIdHeader: string,
  ): Promise<{ message: string }> {
    const tenantId = extractTenantId(tenantIdHeader);
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
    @Headers('x-tenant-id') tenantIdHeader: string,
  ): Promise<{ message: string }> {
    const tenantId = extractTenantId(tenantIdHeader);
    await this.projectionsService.resumeProjection(name, tenantId);
    return { message: `Projection ${name} resumed` };
  }

  /**
   * Reset a projection to a specific position
   */
  @Post(':name/reset')
  @HttpCode(HttpStatus.OK)
  async resetProjection(
    @Param('name') name: string,
    @Body() dto: ResetProjectionDto,
    @Headers('x-tenant-id') tenantIdHeader: string,
  ): Promise<{ message: string }> {
    const tenantId = extractTenantId(tenantIdHeader);
    await this.projectionsService.resetProjection(name, dto.position || 0, tenantId);
    return {
      message: `Projection ${name} reset to position ${dto.position || 0}`,
    };
  }

  /**
   * Process a batch manually
   */
  @Post(':name/process')
  @HttpCode(HttpStatus.OK)
  async processBatch(
    @Param('name') name: string,
    @Headers('x-tenant-id') tenantIdHeader: string,
  ): Promise<{ processed: number; failed: number; newPosition: number }> {
    const tenantId = extractTenantId(tenantIdHeader);
    return this.projectionsService.processBatch(name, tenantId);
  }
}
