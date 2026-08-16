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
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  emailTemplateEmailTemplateResponseArrayContract,
  type EmailTemplateEmailTemplateResponseDto,
  emailTemplateGetTemplateCategoriesResponseArrayContract,
  type EmailTemplateGetTemplateCategoriesResponseDto,
  emailTemplateEmailTemplateResponseContract,
  voidResponseContract,
  type VoidResponseDto,
  emailTemplateRenderTemplateResponseContract,
  type EmailTemplateRenderTemplateResponseDto,
  emailTemplatePreviewTemplateResponseContract,
  type EmailTemplatePreviewTemplateResponseDto,
  emailTemplateValidateTemplateResponseContract,
  type EmailTemplateValidateTemplateResponseDto,
  emailTemplateSendTestEmailResponseContract,
  type EmailTemplateSendTestEmailResponseDto,
} from '../contracts/admin-http-response.contract';

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
  @AdminResponseContract(emailTemplateEmailTemplateResponseArrayContract)
  @Get()
  async getAllTemplates(
    @Query('tenantId') tenantId?: string,
  ): Promise<EmailTemplateEmailTemplateResponseDto[]> {
    return this.templateService.getAllTemplates(tenantId);
  }

  /**
   * Get templates by category
   */
  @AdminResponseContract(emailTemplateEmailTemplateResponseArrayContract)
  @Get('category/:category')
  async getTemplatesByCategory(
    @Param('category') category: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<EmailTemplateEmailTemplateResponseDto[]> {
    return this.templateService.getTemplatesByCategory(category, tenantId);
  }

  /**
   * Get template categories
   */
  @AdminResponseContract(emailTemplateGetTemplateCategoriesResponseArrayContract)
  @Get('categories')
  getTemplateCategories(): EmailTemplateGetTemplateCategoriesResponseDto[] {
    return this.templateService.getTemplateCategories();
  }

  /**
   * Get template by code
   */
  @AdminResponseContract(emailTemplateEmailTemplateResponseContract)
  @Get('code/:code')
  async getTemplateByCode(
    @Param('code') code: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<EmailTemplateEmailTemplateResponseDto> {
    return this.templateService.getTemplateByCode(code, tenantId);
  }

  /**
   * Get template by ID
   */
  @AdminResponseContract(emailTemplateEmailTemplateResponseContract)
  @Get(':id')
  async getTemplateById(@Param('id') id: string): Promise<EmailTemplateEmailTemplateResponseDto> {
    return this.templateService.getTemplateById(id);
  }

  /**
   * Create a new template
   */
  @AdminResponseContract(emailTemplateEmailTemplateResponseContract)
  @Post()
  async createTemplate(
    @Body() dto: CreateEmailTemplateDto,
  ): Promise<EmailTemplateEmailTemplateResponseDto> {
    return this.templateService.createTemplate(dto);
  }

  /**
   * Update a template
   */
  @AdminResponseContract(emailTemplateEmailTemplateResponseContract)
  @Put(':id')
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateEmailTemplateDto,
  ): Promise<EmailTemplateEmailTemplateResponseDto> {
    return this.templateService.updateTemplate(id, dto);
  }

  /**
   * Create tenant-specific override
   */
  @AdminResponseContract(emailTemplateEmailTemplateResponseContract)
  @Post('code/:code/override')
  async createTenantOverride(
    @Param('code') code: string,
    @Body() dto: CreateTenantOverrideDto,
  ): Promise<EmailTemplateEmailTemplateResponseDto> {
    const { tenantId, ...overrides } = dto;
    return this.templateService.createTenantOverride(code, tenantId, overrides);
  }

  /**
   * Delete a template
   */
  @AdminResponseContract(voidResponseContract)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTemplate(@Param('id') id: string): Promise<void> {
    await this.templateService.deleteTemplate(id);
  }

  // ============================================================================
  // Template Rendering
  // ============================================================================

  /**
   * Render a template with variables
   */
  @AdminResponseContract(emailTemplateRenderTemplateResponseContract)
  @Post('render')
  async renderTemplate(
    @Body() dto: RenderTemplateDto,
  ): Promise<EmailTemplateRenderTemplateResponseDto> {
    return this.templateService.renderTemplate(dto);
  }

  /**
   * Preview a template with sample data
   */
  @AdminResponseContract(emailTemplatePreviewTemplateResponseContract)
  @Get('by-id/:id/preview')
  async previewTemplate(@Param('id') id: string): Promise<EmailTemplatePreviewTemplateResponseDto> {
    return this.templateService.previewTemplate(id);
  }

  /**
   * Validate template syntax
   */
  @AdminResponseContract(emailTemplateValidateTemplateResponseContract)
  @Post('validate')
  async validateTemplate(
    @Body() dto: ValidateTemplateDto,
  ): Promise<EmailTemplateValidateTemplateResponseDto> {
    return this.templateService.validateTemplate(dto.bodyHtml, dto.variables);
  }

  // ============================================================================
  // Test Email
  // ============================================================================

  /**
   * Send a test email using a template
   * Note: Actual email sending would be handled by a notification service
   */
  @AdminResponseContract(emailTemplateSendTestEmailResponseContract)
  @Post(':id/test')
  async sendTestEmail(
    @Param('id') id: string,
    @Body() dto: SendTestEmailDto,
  ): Promise<EmailTemplateSendTestEmailResponseDto> {
    // This would integrate with a notification/email service
    // For now, just return the rendered template
    const template = await this.templateService.getTemplateById(id);

    const rendered = await this.templateService.renderTemplate({
      templateCode: template.code,
      variables: dto.variables,
    });

    return {
      message: 'Test email would be sent (email service integration required)',
      recipientEmail: dto.recipientEmail,
      rendered,
    };
  }
}
