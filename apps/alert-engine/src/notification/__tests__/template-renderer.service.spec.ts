import { Test, TestingModule } from '@nestjs/testing';
import {
  TemplateRendererService,
  TemplateContext,
  NotificationTemplate,
} from '../template-renderer.service';
import { NotificationChannel } from '../../database/entities/escalation-policy.entity';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { IncidentStatus } from '../../database/entities/alert-incident.entity';

describe('TemplateRendererService', () => {
  let service: TemplateRendererService;

  const baseContext: TemplateContext = {
    incident: {
      id: 'incident-123',
      title: 'Temperature Alert',
      description: 'Water temperature exceeded threshold',
      status: IncidentStatus.NEW,
    },
    severity: AlertSeverity.HIGH,
    escalationLevel: 1,
    tenantName: 'Test Tenant',
    farmName: 'Test Farm',
    userName: 'John Doe',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TemplateRendererService],
    }).compile();

    service = module.get<TemplateRendererService>(TemplateRendererService);
  });

  afterEach(() => {
    service.clearCustomTemplates();
  });

  describe('render', () => {
    it('should render email notification', () => {
      const result = service.render(NotificationChannel.EMAIL, baseContext);

      expect(result.subject).toContain('HIGH');
      expect(result.subject).toContain('Temperature Alert');
      expect(result.body).toContain('Temperature Alert');
      expect(result.body).toContain('incident-123');
      expect(result.htmlBody).toBeDefined();
    });

    it('should render SMS notification', () => {
      const result = service.render(NotificationChannel.SMS, baseContext);

      expect(result.body).toContain('HIGH');
      expect(result.body).toContain('Temperature Alert');
      expect(result.shortMessage).toBeDefined();
    });

    it('should render Slack notification', () => {
      const result = service.render(NotificationChannel.SLACK, baseContext);

      expect(result.body).toContain('HIGH');
      expect(result.body).toContain('Temperature Alert');
      expect(result.body).toContain('*'); // Slack formatting
    });

    it('should render Teams notification', () => {
      const result = service.render(NotificationChannel.TEAMS, baseContext);

      expect(result.body).toContain('##'); // Markdown heading
      expect(result.body).toContain('Temperature Alert');
    });

    it('should render webhook notification as JSON', () => {
      const result = service.render(NotificationChannel.WEBHOOK, baseContext);

      expect(result.body).toBeDefined();
      const parsed = JSON.parse(result.body);
      expect(parsed.incident).toBeDefined();
    });

    it('should render push notification', () => {
      const result = service.render(NotificationChannel.PUSH, baseContext);

      expect(result.subject).toContain('HIGH');
      expect(result.body).toBe('Temperature Alert');
    });

    it('should render PagerDuty notification', () => {
      const result = service.render(NotificationChannel.PAGERDUTY, baseContext);

      expect(result.subject).toBe('Temperature Alert');
      expect(result.body).toContain('HIGH');
    });

    it('should include metadata in result', () => {
      const result = service.render(NotificationChannel.EMAIL, baseContext);

      expect(result.metadata).toBeDefined();
      expect(result.metadata?.templateId).toBeDefined();
      expect(result.metadata?.channel).toBe(NotificationChannel.EMAIL);
    });

    it('should use custom template when specified', () => {
      const customTemplate: NotificationTemplate = {
        id: 'custom-email',
        name: 'Custom Email',
        channel: NotificationChannel.EMAIL,
        subjectTemplate: 'CUSTOM: {{incident.title}}',
        bodyTemplate: 'Custom body for {{incident.title}}',
      };

      service.registerTemplate(customTemplate);

      const result = service.render(NotificationChannel.EMAIL, baseContext, 'custom-email');

      expect(result.subject).toBe('CUSTOM: Temperature Alert');
      expect(result.body).toBe('Custom body for Temperature Alert');
    });
  });

  describe('renderForEmail', () => {
    it('should render email with all fields', () => {
      const result = service.renderForEmail(baseContext);

      expect(result.subject).toBeDefined();
      expect(result.body).toBeDefined();
      expect(result.htmlBody).toBeDefined();
    });

    it('should include severity color in HTML', () => {
      const result = service.renderForEmail(baseContext);

      expect(result.htmlBody).toContain('#ea580c'); // HIGH severity color
    });
  });

  describe('renderForSms', () => {
    it('should render short SMS message', () => {
      const result = service.renderForSms(baseContext);

      expect(result.body.length).toBeLessThanOrEqual(160);
      expect(result.shortMessage).toBeDefined();
    });
  });

  describe('renderString', () => {
    it('should replace simple variables', () => {
      const template = 'Hello {{name}}!';
      const context = { name: 'World' };

      const result = service.renderString(template, context);

      expect(result).toBe('Hello World!');
    });

    it('should replace nested variables', () => {
      const template = 'Incident: {{incident.title}}';
      const context = { incident: { title: 'Test' } };

      const result = service.renderString(template, context);

      expect(result).toBe('Incident: Test');
    });

    it('should preserve unmatched variables', () => {
      const template = 'Value: {{unknown}}';
      const context = {};

      const result = service.renderString(template, context);

      expect(result).toBe('Value: {{unknown}}');
    });

    it('should handle multiple variables', () => {
      const template = '{{a}} and {{b}}';
      const context = { a: 'First', b: 'Second' };

      const result = service.renderString(template, context);

      expect(result).toBe('First and Second');
    });

    it('should handle {{json}} special case', () => {
      const template = '{{json}}';
      const context = { key: 'value' };

      const result = service.renderString(template, context);

      expect(JSON.parse(result)).toEqual({ key: 'value' });
    });
  });

  describe('getNestedValue', () => {
    it('should get top-level value', () => {
      const result = service.getNestedValue({ name: 'Test' }, 'name');

      expect(result).toBe('Test');
    });

    it('should get nested value', () => {
      const result = service.getNestedValue(
        { level1: { level2: { value: 'Deep' } } },
        'level1.level2.value',
      );

      expect(result).toBe('Deep');
    });

    it('should return undefined for missing path', () => {
      const result = service.getNestedValue({ name: 'Test' }, 'missing.path');

      expect(result).toBeUndefined();
    });

    it('should handle null in path', () => {
      const result = service.getNestedValue({ level1: null }, 'level1.level2');

      expect(result).toBeUndefined();
    });
  });

  describe('custom templates', () => {
    it('should register custom template', () => {
      const template: NotificationTemplate = {
        id: 'test-template',
        name: 'Test Template',
        channel: NotificationChannel.EMAIL,
        subjectTemplate: 'Test Subject',
        bodyTemplate: 'Test Body',
      };

      service.registerTemplate(template);

      const retrieved = service.getTemplate(NotificationChannel.EMAIL, 'test-template');
      expect(retrieved.id).toBe('test-template');
    });

    it('should remove custom template', () => {
      const template: NotificationTemplate = {
        id: 'to-remove',
        name: 'To Remove',
        channel: NotificationChannel.EMAIL,
        subjectTemplate: 'Subject',
        bodyTemplate: 'Body',
      };

      service.registerTemplate(template);
      const removed = service.removeTemplate('to-remove');

      expect(removed).toBe(true);
    });

    it('should return false when removing non-existent template', () => {
      const removed = service.removeTemplate('non-existent');

      expect(removed).toBe(false);
    });

    it('should fall back to default template if custom not found', () => {
      const retrieved = service.getTemplate(NotificationChannel.EMAIL, 'non-existent');

      expect(retrieved.isDefault).toBe(true);
    });
  });

  describe('getTemplatesForChannel', () => {
    it('should return default template for channel', () => {
      const templates = service.getTemplatesForChannel(NotificationChannel.EMAIL);

      expect(templates.length).toBeGreaterThanOrEqual(1);
      expect(templates.some(t => t.isDefault)).toBe(true);
    });

    it('should include custom templates for channel', () => {
      service.registerTemplate({
        id: 'custom-sms',
        name: 'Custom SMS',
        channel: NotificationChannel.SMS,
        subjectTemplate: '',
        bodyTemplate: 'Custom SMS body',
      });

      const templates = service.getTemplatesForChannel(NotificationChannel.SMS);

      expect(templates.length).toBe(2);
      expect(templates.some(t => t.id === 'custom-sms')).toBe(true);
    });
  });

  describe('helpers', () => {
    it('should apply upper helper', () => {
      const template = '{{upper:name}}';
      const context = { name: 'test' };

      const result = service.renderString(template, context);

      expect(result).toBe('TEST');
    });

    it('should apply lower helper', () => {
      const template = '{{lower:name}}';
      const context = { name: 'TEST' };

      const result = service.renderString(template, context);

      expect(result).toBe('test');
    });

    it('should apply truncate helper', () => {
      const template = '{{truncate:text}}';
      const context = { text: 'This is a very long text that should be truncated because it exceeds the limit' };

      const result = service.renderString(template, context);

      expect(result.length).toBeLessThanOrEqual(50);
      expect(result.endsWith('...')).toBe(true);
    });

    it('should not truncate short text', () => {
      const template = '{{truncate:text}}';
      const context = { text: 'Short' };

      const result = service.renderString(template, context);

      expect(result).toBe('Short');
    });

    it('should apply escape helper', () => {
      const template = '{{escape:html}}';
      const context = { html: '<script>alert("xss")</script>' };

      const result = service.renderString(template, context);

      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;');
    });

    it('should register custom helper', () => {
      service.registerHelper('reverse', (value) => String(value).split('').reverse().join(''));

      const template = '{{reverse:text}}';
      const context = { text: 'hello' };

      const result = service.renderString(template, context);

      expect(result).toBe('olleh');
    });

    it('should list available helpers', () => {
      const helpers = service.getHelpers();

      expect(helpers).toContain('upper');
      expect(helpers).toContain('lower');
      expect(helpers).toContain('truncate');
      expect(helpers).toContain('escape');
    });
  });

  describe('validateTemplate', () => {
    it('should validate valid template', () => {
      const template: NotificationTemplate = {
        id: 'valid',
        name: 'Valid Template',
        channel: NotificationChannel.EMAIL,
        subjectTemplate: 'Subject',
        bodyTemplate: 'Body',
      };

      const result = service.validateTemplate(template);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail for missing ID', () => {
      const template = {
        id: '',
        name: 'Test',
        channel: NotificationChannel.EMAIL,
        subjectTemplate: 'Subject',
        bodyTemplate: 'Body',
      } as NotificationTemplate;

      const result = service.validateTemplate(template);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('ID'))).toBe(true);
    });

    it('should fail for missing body', () => {
      const template = {
        id: 'test',
        name: 'Test',
        channel: NotificationChannel.EMAIL,
        subjectTemplate: 'Subject',
        bodyTemplate: '',
      } as NotificationTemplate;

      const result = service.validateTemplate(template);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Body'))).toBe(true);
    });

    it('should require subject for email', () => {
      const template = {
        id: 'test',
        name: 'Test',
        channel: NotificationChannel.EMAIL,
        subjectTemplate: '',
        bodyTemplate: 'Body',
      } as NotificationTemplate;

      const result = service.validateTemplate(template);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Subject'))).toBe(true);
    });
  });

  describe('previewTemplate', () => {
    it('should preview template with sample data', () => {
      const template: NotificationTemplate = {
        id: 'preview-test',
        name: 'Preview Test',
        channel: NotificationChannel.EMAIL,
        subjectTemplate: '[{{severity}}] {{incident.title}}',
        bodyTemplate: 'Description: {{incident.description}}',
      };

      const result = service.previewTemplate(template);

      expect(result.subject).toContain('Sample Alert');
      expect(result.body).toContain('Temperature');
    });

    it('should preview template with custom context', () => {
      const template: NotificationTemplate = {
        id: 'preview-test',
        name: 'Preview Test',
        channel: NotificationChannel.EMAIL,
        subjectTemplate: '{{incident.title}}',
        bodyTemplate: 'Body',
      };

      const customContext: TemplateContext = {
        incident: { title: 'Custom Title' } as any,
        severity: AlertSeverity.CRITICAL,
      };

      const result = service.previewTemplate(template, customContext);

      expect(result.subject).toBe('Custom Title');
    });
  });

  describe('severity colors', () => {
    it('should include correct color for CRITICAL', () => {
      const context: TemplateContext = {
        ...baseContext,
        severity: AlertSeverity.CRITICAL,
      };

      const result = service.renderForEmail(context);

      expect(result.htmlBody).toContain('#dc2626');
    });

    it('should include correct color for HIGH', () => {
      const context: TemplateContext = {
        ...baseContext,
        severity: AlertSeverity.HIGH,
      };

      const result = service.renderForEmail(context);

      expect(result.htmlBody).toContain('#ea580c');
    });

    it('should include correct color for MEDIUM', () => {
      const context: TemplateContext = {
        ...baseContext,
        severity: AlertSeverity.MEDIUM,
      };

      const result = service.renderForEmail(context);

      expect(result.htmlBody).toContain('#ca8a04');
    });
  });

  describe('clearCustomTemplates', () => {
    it('should clear all custom templates', () => {
      service.registerTemplate({
        id: 'custom-1',
        name: 'Custom 1',
        channel: NotificationChannel.EMAIL,
        subjectTemplate: 'Subject',
        bodyTemplate: 'Body',
      });

      service.registerTemplate({
        id: 'custom-2',
        name: 'Custom 2',
        channel: NotificationChannel.SMS,
        subjectTemplate: '',
        bodyTemplate: 'Body',
      });

      service.clearCustomTemplates();

      // Should fall back to default
      const emailTemplates = service.getTemplatesForChannel(NotificationChannel.EMAIL);
      expect(emailTemplates.every(t => t.isDefault || !t.id.startsWith('custom'))).toBe(true);
    });
  });
});
