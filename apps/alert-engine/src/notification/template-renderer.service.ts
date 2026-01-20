import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '../database/entities/escalation-policy.entity';
import { AlertIncident } from '../database/entities/alert-incident.entity';
import { AlertSeverity } from '../database/entities/alert-rule.entity';

/**
 * Template context for rendering
 */
export interface TemplateContext {
  incident?: Partial<AlertIncident>;
  severity?: AlertSeverity;
  escalationLevel?: number;
  tenantName?: string;
  farmName?: string;
  userName?: string;
  customData?: Record<string, unknown>;
}

/**
 * Rendered notification
 */
export interface RenderedNotification {
  subject: string;
  body: string;
  htmlBody?: string;
  shortMessage?: string; // For SMS
  metadata?: Record<string, unknown>;
}

/**
 * Template definition
 */
export interface NotificationTemplate {
  id: string;
  name: string;
  channel: NotificationChannel;
  subjectTemplate: string;
  bodyTemplate: string;
  htmlTemplate?: string;
  shortTemplate?: string;
  isDefault?: boolean;
}

/**
 * Built-in templates
 */
const DEFAULT_TEMPLATES: Record<NotificationChannel, NotificationTemplate> = {
  [NotificationChannel.EMAIL]: {
    id: 'default-email',
    name: 'Default Email Template',
    channel: NotificationChannel.EMAIL,
    subjectTemplate: '[{{severity}}] {{incident.title}}',
    bodyTemplate: `Alert: {{incident.title}}

Severity: {{severity}}
Status: {{incident.status}}
Escalation Level: {{escalationLevel}}

Description:
{{incident.description}}

Time: {{timestamp}}
Incident ID: {{incident.id}}

Please review and take appropriate action.`,
    htmlTemplate: `<!DOCTYPE html>
<html>
<head><style>
  .alert-box { border: 2px solid {{severityColor}}; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .severity-badge { background: {{severityColor}}; color: white; padding: 4px 8px; border-radius: 4px; }
</style></head>
<body>
<div class="alert-box">
  <h2><span class="severity-badge">{{severity}}</span> {{incident.title}}</h2>
  <p><strong>Status:</strong> {{incident.status}}</p>
  <p><strong>Escalation Level:</strong> {{escalationLevel}}</p>
  <hr/>
  <p>{{incident.description}}</p>
  <p><small>Incident ID: {{incident.id}} | Time: {{timestamp}}</small></p>
</div>
</body>
</html>`,
    isDefault: true,
  },
  [NotificationChannel.SMS]: {
    id: 'default-sms',
    name: 'Default SMS Template',
    channel: NotificationChannel.SMS,
    subjectTemplate: '',
    bodyTemplate: '[{{severity}}] {{incident.title}} - Level {{escalationLevel}}. ID: {{incident.id}}',
    shortTemplate: '[{{severity}}] {{incident.title}}',
    isDefault: true,
  },
  [NotificationChannel.SLACK]: {
    id: 'default-slack',
    name: 'Default Slack Template',
    channel: NotificationChannel.SLACK,
    subjectTemplate: '',
    bodyTemplate: `*{{severity}} Alert*: {{incident.title}}

*Status:* {{incident.status}}
*Level:* {{escalationLevel}}

{{incident.description}}

_ID: {{incident.id}}_`,
    isDefault: true,
  },
  [NotificationChannel.TEAMS]: {
    id: 'default-teams',
    name: 'Default Teams Template',
    channel: NotificationChannel.TEAMS,
    subjectTemplate: '',
    bodyTemplate: `## {{severity}} Alert: {{incident.title}}

**Status:** {{incident.status}}
**Escalation Level:** {{escalationLevel}}

---

{{incident.description}}

*Incident ID: {{incident.id}}*`,
    isDefault: true,
  },
  [NotificationChannel.WEBHOOK]: {
    id: 'default-webhook',
    name: 'Default Webhook Template',
    channel: NotificationChannel.WEBHOOK,
    subjectTemplate: '',
    bodyTemplate: '{{json}}',
    isDefault: true,
  },
  [NotificationChannel.PUSH]: {
    id: 'default-push',
    name: 'Default Push Template',
    channel: NotificationChannel.PUSH,
    subjectTemplate: '[{{severity}}] Alert',
    bodyTemplate: '{{incident.title}}',
    isDefault: true,
  },
  [NotificationChannel.PAGERDUTY]: {
    id: 'default-pagerduty',
    name: 'Default PagerDuty Template',
    channel: NotificationChannel.PAGERDUTY,
    subjectTemplate: '{{incident.title}}',
    bodyTemplate: `{{incident.description}}

Severity: {{severity}}
Incident ID: {{incident.id}}`,
    isDefault: true,
  },
};

/**
 * Severity colors for templates
 */
const SEVERITY_COLORS: Record<AlertSeverity, string> = {
  [AlertSeverity.CRITICAL]: '#dc2626',
  [AlertSeverity.HIGH]: '#ea580c',
  [AlertSeverity.MEDIUM]: '#ca8a04',
  [AlertSeverity.WARNING]: '#eab308',
  [AlertSeverity.LOW]: '#2563eb',
  [AlertSeverity.INFO]: '#6b7280',
};

@Injectable()
export class TemplateRendererService {
  private readonly logger = new Logger(TemplateRendererService.name);
  private customTemplates: Map<string, NotificationTemplate> = new Map();
  private helpers: Map<string, (value: unknown) => string> = new Map();

  constructor() {
    this.registerDefaultHelpers();
  }

  /**
   * Render notification using template
   */
  render(
    channel: NotificationChannel,
    context: TemplateContext,
    templateId?: string,
  ): RenderedNotification {
    const template = this.getTemplate(channel, templateId);

    const enrichedContext = this.enrichContext(context);

    return {
      subject: this.renderString(template.subjectTemplate, enrichedContext),
      body: this.renderString(template.bodyTemplate, enrichedContext),
      htmlBody: template.htmlTemplate
        ? this.renderString(template.htmlTemplate, enrichedContext)
        : undefined,
      shortMessage: template.shortTemplate
        ? this.renderString(template.shortTemplate, enrichedContext)
        : undefined,
      metadata: {
        templateId: template.id,
        channel,
        renderedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Render for specific channel
   */
  renderForEmail(context: TemplateContext, templateId?: string): RenderedNotification {
    return this.render(NotificationChannel.EMAIL, context, templateId);
  }

  renderForSms(context: TemplateContext, templateId?: string): RenderedNotification {
    return this.render(NotificationChannel.SMS, context, templateId);
  }

  renderForSlack(context: TemplateContext, templateId?: string): RenderedNotification {
    return this.render(NotificationChannel.SLACK, context, templateId);
  }

  renderForTeams(context: TemplateContext, templateId?: string): RenderedNotification {
    return this.render(NotificationChannel.TEAMS, context, templateId);
  }

  renderForWebhook(context: TemplateContext, templateId?: string): RenderedNotification {
    return this.render(NotificationChannel.WEBHOOK, context, templateId);
  }

  renderForPush(context: TemplateContext, templateId?: string): RenderedNotification {
    return this.render(NotificationChannel.PUSH, context, templateId);
  }

  renderForPagerDuty(context: TemplateContext, templateId?: string): RenderedNotification {
    return this.render(NotificationChannel.PAGERDUTY, context, templateId);
  }

  /**
   * Register custom template
   */
  registerTemplate(template: NotificationTemplate): void {
    this.customTemplates.set(template.id, template);
    this.logger.log(`Registered custom template: ${template.id}`);
  }

  /**
   * Remove custom template
   */
  removeTemplate(templateId: string): boolean {
    return this.customTemplates.delete(templateId);
  }

  /**
   * Get template by channel and optional ID
   */
  getTemplate(channel: NotificationChannel, templateId?: string): NotificationTemplate {
    // Try custom template first
    if (templateId) {
      const custom = this.customTemplates.get(templateId);
      if (custom && custom.channel === channel) {
        return custom;
      }
    }

    // Fall back to default
    return DEFAULT_TEMPLATES[channel];
  }

  /**
   * Get all templates for channel
   */
  getTemplatesForChannel(channel: NotificationChannel): NotificationTemplate[] {
    const templates: NotificationTemplate[] = [DEFAULT_TEMPLATES[channel]];

    for (const template of this.customTemplates.values()) {
      if (template.channel === channel) {
        templates.push(template);
      }
    }

    return templates;
  }

  /**
   * Register custom helper function
   */
  registerHelper(name: string, fn: (value: unknown) => string): void {
    this.helpers.set(name, fn);
  }

  /**
   * Render template string with context
   */
  renderString(template: string, context: Record<string, unknown>): string {
    let result = template;

    // Handle {{json}} special case for webhooks
    if (template === '{{json}}') {
      return JSON.stringify(context, null, 2);
    }

    // Replace {{variable}} patterns
    const variablePattern = /\{\{([^}]+)\}\}/g;
    result = result.replace(variablePattern, (match, path) => {
      const trimmedPath = path.trim();

      // Check for helper: {{helper:variable}}
      if (trimmedPath.includes(':')) {
        const [helperName, varPath] = trimmedPath.split(':');
        const helper = this.helpers.get(helperName);
        if (helper) {
          const value = this.getNestedValue(context, varPath);
          return helper(value);
        }
      }

      const value = this.getNestedValue(context, trimmedPath);
      return value !== undefined ? String(value) : match;
    });

    return result;
  }

  /**
   * Get nested value from object using dot notation
   */
  getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Enrich context with additional data
   */
  private enrichContext(context: TemplateContext): Record<string, unknown> {
    const enriched: Record<string, unknown> = {
      ...context,
      timestamp: new Date().toISOString(),
      severityColor: context.severity ? SEVERITY_COLORS[context.severity] : '#6b7280',
    };

    // Flatten incident if present
    if (context.incident) {
      enriched.incident = context.incident;
    }

    // Add JSON representation for webhooks
    enriched.json = JSON.stringify(context, null, 2);

    return enriched;
  }

  /**
   * Register default helpers
   */
  private registerDefaultHelpers(): void {
    // Uppercase helper
    this.helpers.set('upper', (value) => String(value).toUpperCase());

    // Lowercase helper
    this.helpers.set('lower', (value) => String(value).toLowerCase());

    // Truncate helper
    this.helpers.set('truncate', (value) => {
      const str = String(value);
      return str.length > 50 ? str.substring(0, 47) + '...' : str;
    });

    // Date format helper
    this.helpers.set('date', (value) => {
      if (value instanceof Date) {
        return value.toLocaleDateString();
      }
      return String(value);
    });

    // Time format helper
    this.helpers.set('time', (value) => {
      if (value instanceof Date) {
        return value.toLocaleTimeString();
      }
      return String(value);
    });

    // Escape HTML helper
    this.helpers.set('escape', (value) => {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    });
  }

  /**
   * Validate template
   */
  validateTemplate(template: NotificationTemplate): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!template.id) {
      errors.push('Template ID is required');
    }

    if (!template.name) {
      errors.push('Template name is required');
    }

    if (!template.channel) {
      errors.push('Template channel is required');
    }

    if (!template.bodyTemplate) {
      errors.push('Body template is required');
    }

    // Check for email requirements
    if (template.channel === NotificationChannel.EMAIL && !template.subjectTemplate) {
      errors.push('Subject template is required for email');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Preview template with sample data
   */
  previewTemplate(
    template: NotificationTemplate,
    sampleContext?: TemplateContext,
  ): RenderedNotification {
    const context = sampleContext || this.getSampleContext();
    const enrichedContext = this.enrichContext(context);

    return {
      subject: this.renderString(template.subjectTemplate, enrichedContext),
      body: this.renderString(template.bodyTemplate, enrichedContext),
      htmlBody: template.htmlTemplate
        ? this.renderString(template.htmlTemplate, enrichedContext)
        : undefined,
      shortMessage: template.shortTemplate
        ? this.renderString(template.shortTemplate, enrichedContext)
        : undefined,
    };
  }

  /**
   * Get sample context for preview
   */
  private getSampleContext(): TemplateContext {
    return {
      incident: {
        id: 'sample-incident-123',
        title: 'Sample Alert - Temperature Threshold Exceeded',
        description: 'Water temperature has exceeded the safe threshold in Tank A.',
        status: 'NEW' as any,
      },
      severity: AlertSeverity.HIGH,
      escalationLevel: 1,
      tenantName: 'Sample Tenant',
      farmName: 'Sample Farm',
      userName: 'John Doe',
    };
  }

  /**
   * Get all registered helpers
   */
  getHelpers(): string[] {
    return Array.from(this.helpers.keys());
  }

  /**
   * Clear all custom templates
   */
  clearCustomTemplates(): void {
    this.customTemplates.clear();
  }
}
