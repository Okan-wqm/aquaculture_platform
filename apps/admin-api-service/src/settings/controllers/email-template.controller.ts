import { Destructive, RequiresCapability, TenantParam } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
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
import {
  CreateTenantOverrideDto,
  ValidateTemplateDto,
  SendTestEmailDto,
} from '../dto/email-template.dto';

@ApiTags('Settings')
@Controller('settings/email-templates')
export class EmailTemplateController {
  constructor(
    private readonly templateService: EmailTemplateService,
  ) {}

  // ============================================================================
  // Template CRUD
  // ============================================================================

  /**
   * Get all templates
   */
  @Get()
  async getAllTemplates(@TenantParam('query', { optional: true }) tenantId?: string) {
    return this.templateService.getAllTemplates(tenantId);
  }

  /**
   * Get templates by category
   */
  @Get('category/:category')
  async getTemplatesByCategory(
    @Param('category') category: string,
    @TenantParam('query', { optional: true }) tenantId?: string,
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
  async getTemplateByCode(
    @Param('code') code: string,
    @TenantParam('query', { optional: true }) tenantId?: string,
  ) {
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
  @AuditedOperation({ resource: 'Template', action: 'CREATE' })
  @RequiresCapability('security-ops')
  @Post()
  async createTemplate(@Body() dto: CreateEmailTemplateDto) {
    return this.templateService.createTemplate(dto);
  }

  /**
   * Update a template
   */
  @AuditedOperation({ resource: 'Template', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':id')
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateEmailTemplateDto,
  ) {
    return this.templateService.updateTemplate(id, dto);
  }

  /**
   * Create tenant-specific override
   */
  @AuditedOperation({ resource: 'TenantOverride', action: 'CREATE' })
  @RequiresCapability('security-ops')
  @Post('code/:code/override')
  async createTenantOverride(
    @Param('code') code: string,
    @TenantParam('body') tenantId: string,
    @Body() dto: CreateTenantOverrideDto,
  ) {
    const overrides = dto;
    return this.templateService.createTenantOverride(code, tenantId, overrides);
  }

  /**
   * Delete a template
   */
  @AuditedOperation({ resource: 'Template', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('security-ops')
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
  @AuditedOperation({ resource: 'EmailTemplate', action: 'RENDER_TEMPLATE' })
  @RequiresCapability('security-ops')
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
  @AuditedOperation({ resource: 'Template', action: 'VALIDATE' })
  @RequiresCapability('security-ops')
  @Post('validate')
  async validateTemplate(
    @Body() dto: ValidateTemplateDto,
  ) {
    return this.templateService.validateTemplate(dto.bodyHtml, dto.variables);
  }

  // ============================================================================
  // Test Email
  // ============================================================================

  /**
   * Render a template with test variables for the given recipient.
   *
   * No email leaves the platform from here: admin-api has no dispatch path to
   * notification-service for operator test sends, and the response says so
   * (`sent: false`) instead of claiming a delivery that never happened.
   * Wiring a real dispatch is ADMIN-HIGH-011 (retired / stub surfaces).
   */
  @AuditedOperation({ resource: 'EmailTemplate', action: 'RENDER_TEST' })
  @RequiresCapability('security-ops')
  @Post(':id/test')
  async sendTestEmail(
    @Param('id') id: string,
    @Body() dto: SendTestEmailDto,
  ) {
    const template = await this.templateService.getTemplateById(id);

    const rendered = await this.templateService.renderTemplate({
      templateCode: template.code,
      variables: dto.variables,
    });

    return {
      sent: false,
      reason: 'admin-api has no email dispatch path; the template was rendered, not delivered',
      recipientEmail: dto.recipientEmail,
      rendered,
    };
  }
}
