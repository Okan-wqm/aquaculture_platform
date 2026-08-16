/**
 * Reports Controller
 *
 * The only report mutation surface is the typed execution resource. Legacy
 * synchronous generators, quick aliases, and type-specific export routes are
 * intentionally absent: they bypassed durable qualification evidence.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsIn,
  Matches,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import type { Request, Response } from 'express';
import { createAdminAttachmentFilename } from '@platform/admin-http-contracts';
import {
  REPORT_FORMATS,
  REPORT_TYPES,
  type ReportFormat,
  type ReportType,
} from '@platform/reporting-contracts';

import {
  createStandardPaginatedResult,
  type IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import {
  type ReportDefinitionStatus,
  type ReportExecutionStatus,
  toReportDefinitionDto,
  toReportExecutionDto,
} from '../dto/report-contract.dto';
import { ReportsService } from '../services/reports.service';
import {
  AdminManualResponse,
  AdminResponseContract,
} from '../../shared/admin-response-contract.decorator';
import { sendAdminBinaryResponse } from '../../shared/admin-manual-response.sender';
import {
  reportsArtifactDownloadProfile,
  reportsReportCapabilityDtoArrayContract,
  type ReportsReportCapabilityDto,
  reportsReportDefinitionDtoContract,
  reportsReportDefinitionDtoPageContract,
  type ReportsReportDefinitionDtoDto,
  reportsReportExecutionDtoContract,
  reportsReportExecutionDtoPageContract,
  type ReportsReportExecutionDtoDto,
  voidResponseContract,
} from '../contracts/admin-http-response.contract';

class CreateDefinitionDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsIn([...REPORT_TYPES])
  type!: ReportType;

  @IsOptional()
  @IsIn([...REPORT_FORMATS])
  defaultFormat?: ReportFormat;

  @IsOptional()
  @IsObject()
  defaultFilters?: Record<string, unknown>;

}

class UpdateDefinitionDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn([...REPORT_FORMATS])
  defaultFormat?: ReportFormat;

  @IsOptional()
  @IsIn(['active', 'inactive', 'draft'])
  status?: ReportDefinitionStatus;

  @IsOptional()
  @IsObject()
  defaultFilters?: Record<string, unknown>;

}

class ExecuteReportDto {
  @IsOptional()
  @IsString()
  definitionId?: string;

  @IsOptional()
  @IsIn([...REPORT_TYPES])
  reportType?: ReportType;

  @IsOptional()
  @IsString()
  reportName?: string;

  @IsIn([...REPORT_FORMATS])
  format!: ReportFormat;

  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  startDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  endDate?: string;
}

@ApiTags('Analytics')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @AdminResponseContract(reportsReportDefinitionDtoPageContract)
  @Get('definitions')
  async getDefinitions(
    @Query('status') status?: ReportDefinitionStatus,
    @Query('type') type?: ReportType,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<IStandardPaginatedResult<ReportsReportDefinitionDtoDto>> {
    const result = await this.reportsService.getDefinitions({
      status,
      type,
      page: page === undefined ? undefined : Number(page),
      limit: limit === undefined ? undefined : Number(limit),
    });
    return createStandardPaginatedResult(
      result.items.map(toReportDefinitionDto),
      result.total,
      result.page,
      result.limit,
    );
  }

  @AdminResponseContract(reportsReportDefinitionDtoContract)
  @Get('definitions/:id')
  async getDefinition(
    @Param('id') id: string,
  ): Promise<ReportsReportDefinitionDtoDto> {
    return toReportDefinitionDto(await this.reportsService.getDefinition(id));
  }

  @AdminResponseContract(reportsReportDefinitionDtoContract)
  @Post('definitions')
  @HttpCode(HttpStatus.CREATED)
  async createDefinition(
    @Body() dto: CreateDefinitionDto,
  ): Promise<ReportsReportDefinitionDtoDto> {
    return toReportDefinitionDto(await this.reportsService.createDefinition(dto));
  }

  @AdminResponseContract(reportsReportDefinitionDtoContract)
  @Put('definitions/:id')
  async updateDefinition(
    @Param('id') id: string,
    @Body() dto: UpdateDefinitionDto,
  ): Promise<ReportsReportDefinitionDtoDto> {
    return toReportDefinitionDto(
      await this.reportsService.updateDefinition(id, dto),
    );
  }

  @AdminResponseContract(voidResponseContract)
  @Delete('definitions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDefinition(@Param('id') id: string): Promise<void> {
    await this.reportsService.deleteDefinition(id);
  }

  @AdminResponseContract(reportsReportExecutionDtoPageContract)
  @Get('executions')
  async getExecutions(
    @Query('definitionId') definitionId?: string,
    @Query('status') status?: ReportExecutionStatus,
    @Query('reportType') reportType?: ReportType,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ): Promise<IStandardPaginatedResult<ReportsReportExecutionDtoDto>> {
    const result = await this.reportsService.getExecutions({
      definitionId,
      status,
      reportType,
      page: page === undefined ? undefined : Number(page),
      limit: limit === undefined ? undefined : Number(limit),
    });
    return createStandardPaginatedResult(
      result.items.map(toReportExecutionDto),
      result.total,
      result.page,
      result.limit,
    );
  }

  @AdminResponseContract(reportsReportExecutionDtoContract)
  @Post('executions')
  @HttpCode(HttpStatus.CREATED)
  async createExecution(
    @Body() dto: ExecuteReportDto,
    @Req() request: Request & { user?: { id?: string; email?: string } },
  ): Promise<ReportsReportExecutionDtoDto> {
    const startDate = dto.startDate === undefined ? undefined : new Date(dto.startDate);
    const endDate = dto.endDate === undefined ? undefined : new Date(dto.endDate);

    if (startDate && Number.isNaN(startDate.getTime())) {
      throw new BadRequestException('Invalid startDate format');
    }
    if (endDate && Number.isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid endDate format');
    }
    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('Start date must be before end date');
    }

    return toReportExecutionDto(
      await this.reportsService.executeReport({
        definitionId: dto.definitionId,
        reportType: dto.reportType,
        reportName: dto.reportName,
        format: dto.format,
        filters: dto.filters,
        startDate,
        endDate,
        executedBy: request.user?.id,
        executedByEmail: request.user?.email,
      }),
    );
  }

  @AdminResponseContract(reportsReportExecutionDtoContract)
  @Get('executions/:id')
  async getExecution(
    @Param('id') id: string,
  ): Promise<ReportsReportExecutionDtoDto> {
    return toReportExecutionDto(await this.reportsService.getExecution(id));
  }

  @AdminManualResponse(reportsArtifactDownloadProfile)
  @Get('executions/:id/download')
  async downloadExecution(
    @Param('id') id: string,
    @Res() response: Response,
  ): Promise<void> {
    const download = await this.reportsService.getExecutionDownload(id);
    sendAdminBinaryResponse(response, reportsArtifactDownloadProfile, {
      status: HttpStatus.OK,
      mediaType: download.contentType,
      filename: createAdminAttachmentFilename(download.filename),
      data: download.data,
    });
  }

  @AdminResponseContract(reportsReportCapabilityDtoArrayContract)
  @Get('capabilities')
  getReportCapabilities(): ReportsReportCapabilityDto[] {
    return this.reportsService.getReportCapabilities();
  }
}
