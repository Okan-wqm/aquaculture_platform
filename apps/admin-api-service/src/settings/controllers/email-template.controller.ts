import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  EmailTemplateService,
  CreateEmailTemplateDto,
  UpdateEmailTemplateDto,
  RenderTemplateDto,
} from '../services/email-template.service';
import { CreateTenantOverrideDto, ValidateTemplateDto } from '../dto/email-template.dto';

@ApiTags('Settings')
@Controller('settings/email-templates')
export class EmailTemplateController {
  constructor(private readonly templateService: EmailTemplateService) {}

  // ============================================================================
  // Template CRUD
  // ============================================================================

  /**
   * Get all templates
   */
  @Get()
  async getAllTemplates(@Query('tenantId') tenantId?: string) {
    return this.templateService.getAllTemplates(tenantId);
  }

  /**
   * Get templates by category
   */
  @Get('category/:category')
  async getTemplatesByCategory(
    @Param('category') category: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.templateService.getTemplatesByCategory(category, tenantId);
  }

  /**
   * Get template categories
   */
  @Get('categories')
  getTemplateCategories() {
    return this.templateService.getTemplateCategories();
  }

  /**
   * Get template by code
   */
  @Get('code/:code')
  async getTemplateByCode(@Param('code') code: string, @Query('tenantId') tenantId?: string) {
    return this.templateService.getTemplateByCode(code, tenantId);
  }

  /**
   * Get template by ID
   */
  @Get(':id')
  async getTemplateById(@Param('id') id: string) {
    return this.templateService.getTemplateById(id);
  }

  /**
   * Create a new template
   */
  @Post()
  async createTemplate(@Body() dto: CreateEmailTemplateDto) {
    return this.templateService.createTemplate(dto);
  }

  /**
   * Update a template
   */
  @Put(':id')
  async updateTemplate(@Param('id') id: string, @Body() dto: UpdateEmailTemplateDto) {
    return this.templateService.updateTemplate(id, dto);
  }

  /**
   * Create tenant-specific override
   */
  @Post('code/:code/override')
  async createTenantOverride(@Param('code') code: string, @Body() dto: CreateTenantOverrideDto) {
    const { tenantId, ...overrides } = dto;
    return this.templateService.createTenantOverride(code, tenantId, overrides);
  }

  /**
   * Delete a template
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTemplate(@Param('id') id: string) {
    await this.templateService.deleteTemplate(id);
  }

  // ============================================================================
  // Template Rendering
  // ============================================================================

  /**
   * Render a template with variables
   */
  @Post('render')
  async renderTemplate(@Body() dto: RenderTemplateDto) {
    return this.templateService.renderTemplate(dto);
  }

  /**
   * Preview a template with sample data
   */
  @Get(':id/preview')
  async previewTemplate(@Param('id') id: string) {
    return this.templateService.previewTemplate(id);
  }

  /**
   * Validate template syntax
   */
  @Post('validate')
  async validateTemplate(@Body() dto: ValidateTemplateDto) {
    return this.templateService.validateTemplate(dto.bodyHtml, dto.variables);
  }
}
