import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ProjectionsService } from './projections.service';
import { ProjectionCheckpoint } from './entities/projection-checkpoint.entity';

class ResetProjectionDto {
  position?: number;
}

@Controller('projections')
export class ProjectionsController {
  constructor(private readonly projectionsService: ProjectionsService) {}

  /**
   * Get all projections
   */
  @Get()
  async getAllProjections(): Promise<ProjectionCheckpoint[]> {
    return this.projectionsService.getAllProjections();
  }

  /**
   * Get projection status
   */
  @Get(':name')
  async getProjectionStatus(
    @Param('name') name: string,
  ): Promise<ProjectionCheckpoint> {
    const projection = await this.projectionsService.getProjectionStatus(name);
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
  ): Promise<{ name: string; lag: number }> {
    const lag = await this.projectionsService.getProjectionLag(name);
    return { name, lag };
  }

  /**
   * Start a projection
   */
  @Post(':name/start')
  @HttpCode(HttpStatus.OK)
  async startProjection(
    @Param('name') name: string,
  ): Promise<{ message: string }> {
    await this.projectionsService.startProjection(name);
    return { message: `Projection ${name} started` };
  }

  /**
   * Stop a projection
   */
  @Post(':name/stop')
  @HttpCode(HttpStatus.OK)
  async stopProjection(
    @Param('name') name: string,
  ): Promise<{ message: string }> {
    await this.projectionsService.stopProjection(name);
    return { message: `Projection ${name} stopped` };
  }

  /**
   * Pause a projection
   */
  @Post(':name/pause')
  @HttpCode(HttpStatus.OK)
  async pauseProjection(
    @Param('name') name: string,
  ): Promise<{ message: string }> {
    await this.projectionsService.pauseProjection(name);
    return { message: `Projection ${name} paused` };
  }

  /**
   * Resume a paused projection
   */
  @Post(':name/resume')
  @HttpCode(HttpStatus.OK)
  async resumeProjection(
    @Param('name') name: string,
  ): Promise<{ message: string }> {
    await this.projectionsService.resumeProjection(name);
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
  ): Promise<{ message: string }> {
    await this.projectionsService.resetProjection(name, dto.position || 0);
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
  ): Promise<{ processed: number; failed: number; newPosition: number }> {
    return this.projectionsService.processBatch(name);
  }
}
