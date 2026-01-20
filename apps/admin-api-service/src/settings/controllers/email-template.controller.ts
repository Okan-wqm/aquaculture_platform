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
import {
  EmailTemplateService,
  CreateEmailTemplateDto,
  UpdateEmailTemplateDto,
  RenderTemplateDto,
} from '../services/email-template.service';
import { EmailTemplateVariable } from '../entities/system-setting.entity';

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
  async getTemplateByCode(
    @Param('code') code: string,
    @Query('tenantId') tenantId?: string,
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
  @Post()
  async createTemplate(@Body() dto: CreateEmailTemplateDto) {
    return this.templateService.createTemplate(dto);
  }

  /**
   * Update a template
   */
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
  @Post('code/:code/override')
  async createTenantOverride(
    @Param('code') code: string,
    @Body() body: { tenantId: string; overrides: Partial<UpdateEmailTemplateDto> },
  ) {
    return this.templateService.createTenantOverride(code, body.tenantId, body.overrides);
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
  async validateTemplate(
    @Body() body: { bodyHtml: string; variables: EmailTemplateVariable[] },
  ) {
    return this.templateService.validateTemplate(body.bodyHtml, body.variables);
  }

  // ============================================================================
  // Test Email
  // ============================================================================

  /**
   * Send a test email using a template
   * Note: Actual email sending would be handled by a notification service
   */
  @Post(':id/test')
  async sendTestEmail(
    @Param('id') id: string,
    @Body() body: { recipientEmail: string; variables: Record<string, string> },
  ) {
    // This would integrate with a notification/email service
    // For now, just return the rendered template
    const template = await this.templateService.getTemplateById(id);

    const rendered = await this.templateService.renderTemplate({
      templateCode: template.code,
      variables: body.variables,
    });

    return {
      message: 'Test email would be sent (email service integration required)',
      recipientEmail: body.recipientEmail,
      rendered,
    };
  }
}
