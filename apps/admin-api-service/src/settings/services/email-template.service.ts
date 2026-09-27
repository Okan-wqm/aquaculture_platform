import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  emailButton,
  emailCallout,
  emailParagraph,
  emailPlainText,
  emailRows,
  renderEmail,
} from '@aquaculture/shared-contracts';

import { EmailTemplate, EmailTemplateVariable } from '../entities/system-setting.entity';

// ============================================================================
// DTOs
// ============================================================================

export interface CreateEmailTemplateDto {
  code: string;
  name: string;
  description?: string;
  category: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  variables?: EmailTemplateVariable[];
  isActive?: boolean;
  tenantId?: string;
}

export interface UpdateEmailTemplateDto {
  name?: string;
  description?: string;
  category?: string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  variables?: EmailTemplateVariable[];
  isActive?: boolean;
  updatedBy?: string;
}

export interface RenderTemplateDto {
  templateCode: string;
  variables: Record<string, string>;
  tenantId?: string;
}

export interface EmailTemplateResponse {
  id: string;
  code: string;
  name: string;
  description?: string;
  category: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  variables: EmailTemplateVariable[];
  isActive: boolean;
  isSystem: boolean;
  tenantId?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Default Templates
// ============================================================================

const DEFAULT_EMAIL_TEMPLATES: CreateEmailTemplateDto[] = [
  {
    code: 'welcome',
    name: 'Welcome Email',
    description: 'Sent to new users upon registration',
    category: 'auth',
    subject: 'Welcome to {{platform_name}}!',
    bodyHtml: renderEmail({
      title: 'Welcome to {{platform_name}}!',
      tone: 'brand',
      productName: '{{platform_name}}',
      preheader: 'Verify your e-mail address to finish setting up your account.',
      footerLines: ['© {{year}} {{platform_name}}. All rights reserved.'],
      body:
        emailParagraph('Hello {{user_name}},') +
        emailParagraph(
          "Your account has been created successfully. We're excited to have you on board!",
        ) +
        emailParagraph('To get started, please click the button below to verify your email:') +
        emailButton('Verify Email', '{{verification_link}}') +
        emailParagraph("If you didn't create this account, please ignore this email."),
    }),
    bodyText: `Welcome to {{platform_name}}!

Hello {{user_name}},

Your account has been created successfully. We're excited to have you on board!

To get started, please visit the following link to verify your email:
{{verification_link}}

If you didn't create this account, please ignore this email.

© {{year}} {{platform_name}}. All rights reserved.`,
    variables: [
      {
        name: 'platform_name',
        description: 'Platform name',
        required: true,
        defaultValue: 'Aquaculture Platform',
      },
      { name: 'user_name', description: 'User full name', required: true },
      { name: 'verification_link', description: 'Email verification URL', required: true },
      {
        name: 'year',
        description: 'Current year',
        required: false,
        defaultValue: new Date().getFullYear().toString(),
      },
    ],
  },
  {
    code: 'password_reset',
    name: 'Password Reset',
    description: 'Sent when user requests password reset',
    category: 'auth',
    subject: 'Reset Your Password - {{platform_name}}',
    bodyHtml: renderEmail({
      title: 'Password Reset Request',
      tone: 'error',
      productName: '{{platform_name}}',
      preheader: 'Choose a new password. The link expires in {{expiry_hours}} hours.',
      footerLines: ['© {{year}} {{platform_name}}. All rights reserved.'],
      body:
        emailParagraph('Hello {{user_name}},') +
        emailParagraph(
          'We received a request to reset your password. Click the button below to create a new password:',
        ) +
        emailButton('Reset Password', '{{reset_link}}', 'error') +
        emailParagraph('This link will expire in {{expiry_hours}} hours.') +
        emailCallout(
          "<strong>Security Notice:</strong> If you didn't request this password reset, please ignore this email and your password will remain unchanged.",
        ),
    }),
    bodyText: `Password Reset Request

Hello {{user_name}},

We received a request to reset your password. Visit the following link to create a new password:
{{reset_link}}

This link will expire in {{expiry_hours}} hours.

Security Notice: If you didn't request this password reset, please ignore this email and your password will remain unchanged.

© {{year}} {{platform_name}}. All rights reserved.`,
    variables: [
      {
        name: 'platform_name',
        description: 'Platform name',
        required: true,
        defaultValue: 'Aquaculture Platform',
      },
      { name: 'user_name', description: 'User full name', required: true },
      { name: 'reset_link', description: 'Password reset URL', required: true },
      {
        name: 'expiry_hours',
        description: 'Link expiry in hours',
        required: false,
        defaultValue: '24',
      },
      {
        name: 'year',
        description: 'Current year',
        required: false,
        defaultValue: new Date().getFullYear().toString(),
      },
    ],
  },
  {
    code: 'invitation',
    name: 'User Invitation',
    description: 'Sent when inviting a new user to the platform',
    category: 'auth',
    subject: "You've been invited to {{tenant_name}} on {{platform_name}}",
    bodyHtml: renderEmail({
      title: "You're Invited!",
      tone: 'success',
      productName: '{{platform_name}}',
      preheader: '{{inviter_name}} has invited you to join {{tenant_name}}.',
      footerLines: ['© {{year}} {{platform_name}}. All rights reserved.'],
      body:
        emailParagraph('Hello,') +
        emailParagraph(
          '<strong>{{inviter_name}}</strong> has invited you to join <strong>{{tenant_name}}</strong> on {{platform_name}}.',
        ) +
        emailRows([
          { label: 'Your Role', value: '{{user_role}}' },
          { label: 'Organization', value: '{{tenant_name}}' },
        ]) +
        emailButton('Accept Invitation', '{{invitation_link}}', 'success') +
        emailParagraph('This invitation will expire in {{expiry_days}} days.'),
    }),
    bodyText: `You're Invited!

Hello,

{{inviter_name}} has invited you to join {{tenant_name}} on {{platform_name}}.

Your Role: {{user_role}}
Organization: {{tenant_name}}

Accept the invitation by visiting:
{{invitation_link}}

This invitation will expire in {{expiry_days}} days.

© {{year}} {{platform_name}}. All rights reserved.`,
    variables: [
      {
        name: 'platform_name',
        description: 'Platform name',
        required: true,
        defaultValue: 'Aquaculture Platform',
      },
      { name: 'inviter_name', description: 'Name of user sending invitation', required: true },
      { name: 'tenant_name', description: 'Organization name', required: true },
      { name: 'user_role', description: 'Assigned role', required: true },
      { name: 'invitation_link', description: 'Invitation acceptance URL', required: true },
      { name: 'expiry_days', description: 'Days until expiry', required: false, defaultValue: '7' },
      {
        name: 'year',
        description: 'Current year',
        required: false,
        defaultValue: new Date().getFullYear().toString(),
      },
    ],
  },
  {
    code: 'invoice',
    name: 'Invoice Email',
    description: 'Sent with invoice for billing',
    category: 'billing',
    subject: 'Invoice #{{invoice_number}} from {{platform_name}}',
    bodyHtml: renderEmail({
      title: 'Invoice #{{invoice_number}}',
      tone: 'neutral',
      productName: '{{platform_name}}',
      preheader: '{{currency}}{{amount}} due on {{due_date}}.',
      footerLines: ['© {{year}} {{platform_name}}. All rights reserved.'],
      body:
        emailParagraph('Hello {{billing_name}},') +
        emailParagraph('Please find your invoice details below:') +
        emailRows([
          { label: 'Invoice Number', value: '{{invoice_number}}', strong: true },
          { label: 'Issue Date', value: '{{issue_date}}' },
          { label: 'Due Date', value: '{{due_date}}' },
          { label: 'Plan', value: '{{plan_name}}' },
          { label: 'Amount Due', value: '{{currency}}{{amount}}', large: true },
        ]) +
        emailButton('Pay Now', '{{payment_link}}'),
    }),
    bodyText: `Invoice #{{invoice_number}}

Hello {{billing_name}},

Please find your invoice details below:

Invoice Number: {{invoice_number}}
Issue Date: {{issue_date}}
Due Date: {{due_date}}
Plan: {{plan_name}}
Amount Due: {{currency}}{{amount}}

Pay now: {{payment_link}}

© {{year}} {{platform_name}}. All rights reserved.`,
    variables: [
      {
        name: 'platform_name',
        description: 'Platform name',
        required: true,
        defaultValue: 'Aquaculture Platform',
      },
      { name: 'billing_name', description: 'Billing contact name', required: true },
      { name: 'invoice_number', description: 'Invoice number', required: true },
      { name: 'issue_date', description: 'Invoice issue date', required: true },
      { name: 'due_date', description: 'Payment due date', required: true },
      { name: 'plan_name', description: 'Subscription plan name', required: true },
      { name: 'currency', description: 'Currency symbol', required: false, defaultValue: '$' },
      { name: 'amount', description: 'Total amount', required: true },
      { name: 'payment_link', description: 'Payment URL', required: true },
      {
        name: 'year',
        description: 'Current year',
        required: false,
        defaultValue: new Date().getFullYear().toString(),
      },
    ],
  },
  {
    code: 'alert_notification',
    name: 'Alert Notification',
    description: 'Sent for sensor/system alerts',
    category: 'notification',
    subject: '[{{severity}}] Alert: {{alert_title}} - {{platform_name}}',
    bodyHtml: renderEmail({
      title: '{{severity}} Alert',
      subtitle: '{{alert_title}}',
      // One stored template for every severity: the band takes its colour from
      // the class `severity_class` substitutes — critical red, warning amber,
      // info blue — instead of a copy of this template per level.
      tone: {
        variable: 'severity_class',
        cases: { critical: 'error', warning: 'warning', info: 'info' },
        fallback: 'neutral',
      },
      productName: '{{platform_name}}',
      preheader: '{{alert_title}} — {{sensor_name}} at {{location}}.',
      footerLines: ['© {{year}} {{platform_name}}. All rights reserved.'],
      body:
        emailRows([
          { label: 'Location', value: '{{location}}' },
          { label: 'Sensor', value: '{{sensor_name}}' },
          { label: 'Value', value: '{{current_value}} (Threshold: {{threshold}})', large: true },
          { label: 'Time', value: '{{alert_time}}' },
        ]) +
        emailParagraph('{{alert_message}}') +
        emailButton('View Dashboard', '{{dashboard_link}}', 'neutral'),
    }),
    bodyText: `{{severity}} Alert: {{alert_title}}

Location: {{location}}
Sensor: {{sensor_name}}
Value: {{current_value}} (Threshold: {{threshold}})
Time: {{alert_time}}

{{alert_message}}

View Dashboard: {{dashboard_link}}

© {{year}} {{platform_name}}. All rights reserved.`,
    variables: [
      {
        name: 'platform_name',
        description: 'Platform name',
        required: true,
        defaultValue: 'Aquaculture Platform',
      },
      { name: 'severity', description: 'Alert severity (CRITICAL, WARNING, INFO)', required: true },
      { name: 'severity_class', description: 'CSS class for severity', required: true },
      { name: 'alert_title', description: 'Alert title', required: true },
      { name: 'location', description: 'Farm/Site location', required: true },
      { name: 'sensor_name', description: 'Sensor name', required: true },
      { name: 'current_value', description: 'Current sensor value', required: true },
      { name: 'threshold', description: 'Threshold value', required: true },
      { name: 'alert_time', description: 'Alert timestamp', required: true },
      { name: 'alert_message', description: 'Alert description', required: true },
      { name: 'dashboard_link', description: 'Dashboard URL', required: true },
      {
        name: 'year',
        description: 'Current year',
        required: false,
        defaultValue: new Date().getFullYear().toString(),
      },
    ],
  },
];

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class EmailTemplateService {
  private readonly logger = new Logger(EmailTemplateService.name);

  constructor(
    @InjectRepository(EmailTemplate)
    private readonly templateRepository: Repository<EmailTemplate>,
  ) {}

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Seed default templates on application startup
   */
  async seedDefaultTemplates(): Promise<void> {
    this.logger.log('Checking for missing default email templates...');

    const existingCodes = (
      await this.templateRepository.find({ where: { tenantId: undefined } })
    ).map((t) => t.code);

    const missingTemplates = DEFAULT_EMAIL_TEMPLATES.filter((t) => !existingCodes.includes(t.code));

    if (missingTemplates.length === 0) {
      this.logger.log('All default email templates already exist');
      return;
    }

    const templates = missingTemplates.map((t) =>
      this.templateRepository.create({
        ...t,
        isSystem: true,
        isActive: true,
      }),
    );

    await this.templateRepository.save(templates);
    this.logger.log(`Seeded ${missingTemplates.length} default email templates`);
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  /**
   * Get all templates (global and tenant-specific)
   */
  async getAllTemplates(tenantId?: string): Promise<EmailTemplateResponse[]> {
    const query = this.templateRepository.createQueryBuilder('template');

    if (tenantId) {
      // Get global templates and tenant-specific templates
      query.where('template.tenantId IS NULL OR template.tenantId = :tenantId', { tenantId });
    } else {
      // Only global templates
      query.where('template.tenantId IS NULL');
    }

    query.orderBy('template.category', 'ASC').addOrderBy('template.name', 'ASC');

    const templates = await query.getMany();
    return templates.map((t) => this.toResponse(t));
  }

  /**
   * Get templates by category
   */
  async getTemplatesByCategory(
    category: string,
    tenantId?: string,
  ): Promise<EmailTemplateResponse[]> {
    const query = this.templateRepository
      .createQueryBuilder('template')
      .where('template.category = :category', { category });

    if (tenantId) {
      query.andWhere('(template.tenantId IS NULL OR template.tenantId = :tenantId)', { tenantId });
    } else {
      query.andWhere('template.tenantId IS NULL');
    }

    query.orderBy('template.name', 'ASC');

    const templates = await query.getMany();
    return templates.map((t) => this.toResponse(t));
  }

  /**
   * Get template by code
   */
  async getTemplateByCode(code: string, tenantId?: string): Promise<EmailTemplateResponse> {
    // First try tenant-specific, then fall back to global
    let template: EmailTemplate | null = null;

    if (tenantId) {
      template = await this.templateRepository.findOne({
        where: { code, tenantId },
      });
    }

    if (!template) {
      template = await this.templateRepository.findOne({
        where: { code, tenantId: undefined },
      });
    }

    if (!template) {
      throw new NotFoundException(`Template with code "${code}" not found`);
    }

    return this.toResponse(template);
  }

  /**
   * Get template by ID
   */
  async getTemplateById(id: string): Promise<EmailTemplateResponse> {
    const template = await this.templateRepository.findOne({ where: { id } });

    if (!template) {
      throw new NotFoundException(`Template with ID "${id}" not found`);
    }

    return this.toResponse(template);
  }

  /**
   * Create a new template
   */
  async createTemplate(dto: CreateEmailTemplateDto): Promise<EmailTemplateResponse> {
    // Check for duplicate code in same scope
    const existing = await this.templateRepository.findOne({
      where: { code: dto.code, tenantId: dto.tenantId || undefined },
    });

    if (existing) {
      throw new ConflictException(
        `Template with code "${dto.code}" already exists${dto.tenantId ? ' for this tenant' : ''}`,
      );
    }

    const template = this.templateRepository.create({
      ...dto,
      isSystem: false,
      isActive: dto.isActive ?? true,
      variables: dto.variables || [],
    });

    const saved = await this.templateRepository.save(template);
    this.logger.log(`Created email template: ${dto.code}`);
    return this.toResponse(saved);
  }

  /**
   * Update a template
   */
  async updateTemplate(id: string, dto: UpdateEmailTemplateDto): Promise<EmailTemplateResponse> {
    const template = await this.templateRepository.findOne({ where: { id } });

    if (!template) {
      throw new NotFoundException(`Template with ID "${id}" not found`);
    }

    // System templates cannot be deleted but can be customized
    if (dto.name !== undefined) template.name = dto.name;
    if (dto.description !== undefined) template.description = dto.description;
    if (dto.category !== undefined) template.category = dto.category;
    if (dto.subject !== undefined) template.subject = dto.subject;
    if (dto.bodyHtml !== undefined) template.bodyHtml = dto.bodyHtml;
    if (dto.bodyText !== undefined) template.bodyText = dto.bodyText;
    if (dto.variables !== undefined) template.variables = dto.variables;
    if (dto.isActive !== undefined) template.isActive = dto.isActive;
    if (dto.updatedBy) template.updatedBy = dto.updatedBy;

    const saved = await this.templateRepository.save(template);
    this.logger.log(`Updated email template: ${template.code}`);
    return this.toResponse(saved);
  }

  /**
   * Create tenant-specific override of a global template
   */
  async createTenantOverride(
    code: string,
    tenantId: string,
    overrides: Partial<UpdateEmailTemplateDto>,
  ): Promise<EmailTemplateResponse> {
    // Get the global template
    const globalTemplate = await this.templateRepository.findOne({
      where: { code, tenantId: undefined },
    });

    if (!globalTemplate) {
      throw new NotFoundException(`Global template with code "${code}" not found`);
    }

    // Check if override already exists
    const existing = await this.templateRepository.findOne({
      where: { code, tenantId },
    });

    if (existing) {
      throw new ConflictException(`Override for template "${code}" already exists for this tenant`);
    }

    // Create tenant-specific version
    const override = this.templateRepository.create({
      code: globalTemplate.code,
      name: overrides.name || globalTemplate.name,
      description: overrides.description || globalTemplate.description,
      category: globalTemplate.category,
      subject: overrides.subject || globalTemplate.subject,
      bodyHtml: overrides.bodyHtml || globalTemplate.bodyHtml,
      bodyText: overrides.bodyText || globalTemplate.bodyText,
      variables: globalTemplate.variables,
      isActive: overrides.isActive ?? true,
      isSystem: false,
      tenantId,
    });

    const saved = await this.templateRepository.save(override);
    this.logger.log(`Created tenant override for template: ${code} (tenant: ${tenantId})`);
    return this.toResponse(saved);
  }

  /**
   * Delete a template
   */
  async deleteTemplate(id: string): Promise<void> {
    const template = await this.templateRepository.findOne({ where: { id } });

    if (!template) {
      throw new NotFoundException(`Template with ID "${id}" not found`);
    }

    if (template.isSystem && !template.tenantId) {
      throw new BadRequestException('Cannot delete system templates');
    }

    await this.templateRepository.remove(template);
    this.logger.log(`Deleted email template: ${template.code}`);
  }

  // ============================================================================
  // Template Rendering
  // ============================================================================

  /**
   * Render a template with variables
   */
  async renderTemplate(dto: RenderTemplateDto): Promise<{
    subject: string;
    bodyHtml: string;
    bodyText: string;
  }> {
    const template = await this.getTemplateByCode(dto.templateCode, dto.tenantId);

    if (!template.isActive) {
      throw new BadRequestException(`Template "${dto.templateCode}" is not active`);
    }

    // Validate required variables
    const missingVariables = template.variables
      .filter((v) => v.required && !dto.variables[v.name] && !v.defaultValue)
      .map((v) => v.name);

    if (missingVariables.length > 0) {
      throw new BadRequestException(`Missing required variables: ${missingVariables.join(', ')}`);
    }

    // Build complete variable map with defaults
    const variableMap: Record<string, string> = {};
    for (const varDef of template.variables) {
      variableMap[varDef.name] = dto.variables[varDef.name] || varDef.defaultValue || '';
    }
    // Add any extra variables provided
    Object.assign(variableMap, dto.variables);

    // Render templates
    const subject = this.replaceVariables(template.subject, variableMap);
    const bodyHtml = this.replaceVariables(template.bodyHtml, variableMap);
    const bodyText = template.bodyText
      ? this.replaceVariables(template.bodyText, variableMap)
      : this.stripHtml(bodyHtml);

    return { subject, bodyHtml, bodyText };
  }

  /**
   * Preview a template with sample data
   */
  async previewTemplate(id: string): Promise<{
    subject: string;
    bodyHtml: string;
    bodyText: string;
  }> {
    const template = await this.getTemplateById(id);

    // Build sample variable map
    const variableMap: Record<string, string> = {};
    for (const varDef of template.variables) {
      variableMap[varDef.name] = varDef.defaultValue || `[${varDef.name}]`;
    }

    const subject = this.replaceVariables(template.subject, variableMap);
    const bodyHtml = this.replaceVariables(template.bodyHtml, variableMap);
    const bodyText = template.bodyText
      ? this.replaceVariables(template.bodyText, variableMap)
      : this.stripHtml(bodyHtml);

    return { subject, bodyHtml, bodyText };
  }

  /**
   * Validate template syntax
   */
  async validateTemplate(
    bodyHtml: string,
    variables: EmailTemplateVariable[],
  ): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Find all variable placeholders in template
    const regex = /\{\{([^}]+)\}\}/g;
    const matches = bodyHtml.matchAll(regex);
    const usedVariables = new Set<string>();

    for (const match of matches) {
      const captured = match[1];
      if (captured) {
        usedVariables.add(captured.trim());
      }
    }

    // Check for undefined variables
    const definedNames = new Set(variables.map((v) => v.name));
    for (const used of usedVariables) {
      if (!definedNames.has(used)) {
        warnings.push(`Variable "{{${used}}}" is used but not defined`);
      }
    }

    // Check for unused defined variables
    for (const defined of variables) {
      if (!usedVariables.has(defined.name)) {
        warnings.push(`Variable "${defined.name}" is defined but never used`);
      }
    }

    // Basic HTML validation
    const openTags = (bodyHtml.match(/<[a-z]+/gi) || []).length;
    const closeTags = (bodyHtml.match(/<\/[a-z]+/gi) || []).length;
    if (Math.abs(openTags - closeTags) > 5) {
      warnings.push('HTML may have unclosed tags');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Replace template variables
   */
  private replaceVariables(text: string, variables: Record<string, string>): string {
    return text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
      const trimmedKey = key.trim();
      return variables[trimmedKey] !== undefined ? variables[trimmedKey] : match;
    });
  }

  /**
   * Strip HTML tags for plain text version — the same reduction the layout
   * module applies, so a template without a `bodyText` reads like one with it.
   */
  private stripHtml(html: string): string {
    return emailPlainText(html);
  }

  /**
   * Convert entity to response DTO
   */
  private toResponse(template: EmailTemplate): EmailTemplateResponse {
    return {
      id: template.id,
      code: template.code,
      name: template.name,
      description: template.description,
      category: template.category,
      subject: template.subject,
      bodyHtml: template.bodyHtml,
      bodyText: template.bodyText,
      variables: template.variables,
      isActive: template.isActive,
      isSystem: template.isSystem,
      tenantId: template.tenantId,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    };
  }

  /**
   * Get available template categories
   */
  getTemplateCategories(): string[] {
    return ['auth', 'billing', 'notification', 'marketing', 'system'];
  }
}
