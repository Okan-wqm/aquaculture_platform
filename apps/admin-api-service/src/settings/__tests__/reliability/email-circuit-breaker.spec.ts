import { Test, TestingModule } from '@nestjs/testing';

import { EmailSenderService, EmailResult } from '../../services/email-sender.service';
import { SystemSettingService } from '../../services/system-setting.service';

// Mock nodemailer — must be at top level
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn(),
    verify: jest.fn(),
    close: jest.fn(),
  }),
}));

import * as nodemailer from 'nodemailer';

const mockEmailConfig = {
  smtpHost: 'smtp.test.com',
  smtpPort: 587,
  smtpSecure: false,
  smtpUsername: 'user',
  smtpPassword: 'pass',
  fromAddress: 'test@test.com',
  fromName: 'Test Platform',
};

describe('EmailSenderService — Circuit Breaker', () => {
  let service: EmailSenderService;
  let mockTransporter: any;

  const mockSettingsService = {
    getEmailConfigForSending: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockTransporter = {
      sendMail: jest.fn(),
      verify: jest.fn(),
      close: jest.fn(),
    };
    (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);
    mockSettingsService.getEmailConfigForSending.mockReturnValue(mockEmailConfig);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailSenderService,
        { provide: SystemSettingService, useValue: mockSettingsService },
      ],
    }).compile();

    service = module.get<EmailSenderService>(EmailSenderService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('normal operation (circuit CLOSED)', () => {
    it('should pass requests through when circuit is closed', async () => {
      mockTransporter.sendMail.mockResolvedValue({ messageId: 'msg-1' });

      const result = await service.sendEmail(
        'user@test.com',
        'Test Subject',
        '<p>Hello</p>',
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-1');
      expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
    });

    it('should report circuit status as closed initially', () => {
      const status = service.getCircuitStatus();

      expect(status.state).toBe('closed');
      expect(status.consecutiveFailures).toBe(0);
    });
  });

  describe('circuit opening after N failures', () => {
    it('should open circuit after 5 consecutive failures', async () => {
      const error = new Error('SMTP connection refused');
      mockTransporter.sendMail.mockRejectedValue(error);

      // Send 5 failing emails (1 retry each = threshold reached)
      for (let i = 0; i < 5; i++) {
        await service.sendEmail(
          'user@test.com',
          `Test ${i}`,
          '<p>Hello</p>',
          undefined,
          { maxRetries: 1, retryDelayMs: 0 },
        );
      }

      const status = service.getCircuitStatus();
      expect(status.state).toBe('open');
      expect(status.consecutiveFailures).toBeGreaterThanOrEqual(5);
    });

    it('should reject fast (without calling SMTP) when circuit is open', async () => {
      const error = new Error('SMTP connection refused');
      mockTransporter.sendMail.mockRejectedValue(error);

      // Force circuit open
      for (let i = 0; i < 5; i++) {
        await service.sendEmail('user@test.com', `Fail ${i}`, '<p>F</p>', undefined, {
          maxRetries: 1,
          retryDelayMs: 0,
        });
      }

      const callsBefore = mockTransporter.sendMail.mock.calls.length;

      // This should be rejected immediately (circuit open)
      const result = await service.sendEmail(
        'user@test.com',
        'Rejected',
        '<p>Should fail fast</p>',
      );

      expect(result.success).toBe(false);
      expect(result.circuitBreakerOpen).toBe(true);
      expect(result.attempts).toBe(0);
      // No new SMTP calls should have been made
      expect(mockTransporter.sendMail.mock.calls.length).toBe(callsBefore);
    });

    it('should throw when circuit is open and email is required', async () => {
      const error = new Error('SMTP connection refused');
      mockTransporter.sendMail.mockRejectedValue(error);

      for (let i = 0; i < 5; i++) {
        await service.sendEmail('user@test.com', `Fail ${i}`, '<p>F</p>', undefined, {
          maxRetries: 1,
          retryDelayMs: 0,
        });
      }

      await expect(
        service.sendEmail('user@test.com', 'Required', '<p>Must send</p>', undefined, {
          required: true,
        }),
      ).rejects.toThrow('circuit breaker is open');
    });
  });

  describe('circuit recovery (HALF_OPEN → CLOSED)', () => {
    it('should transition to half-open after recovery timeout', async () => {
      const error = new Error('SMTP down');
      mockTransporter.sendMail.mockRejectedValue(error);

      // Open the circuit
      for (let i = 0; i < 5; i++) {
        await service.sendEmail('user@test.com', `Fail ${i}`, '<p>F</p>', undefined, {
          maxRetries: 1,
          retryDelayMs: 0,
        });
      }
      expect(service.getCircuitStatus().state).toBe('open');

      // Advance past recovery timeout (60s)
      jest.advanceTimersByTime(61_000);

      // Now allow the test request to succeed
      mockTransporter.sendMail.mockResolvedValue({ messageId: 'recovery-1' });

      const result = await service.sendEmail(
        'user@test.com',
        'Recovery Test',
        '<p>Back online</p>',
      );

      expect(result.success).toBe(true);
      expect(service.getCircuitStatus().state).toBe('closed');
      expect(service.getCircuitStatus().consecutiveFailures).toBe(0);
    });

    it('should re-open circuit if half-open test request fails', async () => {
      const error = new Error('SMTP down');
      mockTransporter.sendMail.mockRejectedValue(error);

      // Open the circuit
      for (let i = 0; i < 5; i++) {
        await service.sendEmail('user@test.com', `Fail ${i}`, '<p>F</p>', undefined, {
          maxRetries: 1,
          retryDelayMs: 0,
        });
      }

      // Advance past recovery timeout
      jest.advanceTimersByTime(61_000);

      // Half-open test request also fails
      const result = await service.sendEmail(
        'user@test.com',
        'Still broken',
        '<p>Nope</p>',
        undefined,
        { maxRetries: 1, retryDelayMs: 0 },
      );

      expect(result.success).toBe(false);
      expect(service.getCircuitStatus().state).toBe('open');
    });
  });

  describe('retry with exponential backoff', () => {
    it('should retry up to maxRetries times', async () => {
      // Use real timers for this test — retryDelayMs: 0 keeps it fast
      jest.useRealTimers();

      mockTransporter.sendMail
        .mockRejectedValueOnce(new Error('Transient error 1'))
        .mockRejectedValueOnce(new Error('Transient error 2'))
        .mockResolvedValueOnce({ messageId: 'retry-success' });

      const result = await service.sendEmail(
        'user@test.com',
        'Retry Test',
        '<p>Hello</p>',
        undefined,
        { maxRetries: 3, retryDelayMs: 0 },
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);

      jest.useFakeTimers();
    });

    it('should cap maxRetries at 5', async () => {
      jest.useRealTimers();

      mockTransporter.sendMail.mockRejectedValue(new Error('Always fails'));

      const result = await service.sendEmail(
        'user@test.com',
        'Max Retry',
        '<p>Hello</p>',
        undefined,
        { maxRetries: 100, retryDelayMs: 0 },
      );

      expect(result.success).toBe(false);
      expect(result.attempts).toBeLessThanOrEqual(5);

      jest.useFakeTimers();
    });
  });

  describe('SMTP not configured', () => {
    it('should return graceful failure when SMTP host is empty', async () => {
      mockSettingsService.getEmailConfigForSending.mockReturnValue({
        ...mockEmailConfig,
        smtpHost: '',
      });
      // Force re-initialization by creating new instance
      const module = await Test.createTestingModule({
        providers: [
          EmailSenderService,
          { provide: SystemSettingService, useValue: mockSettingsService },
        ],
      }).compile();
      const freshService = module.get<EmailSenderService>(EmailSenderService);

      const result = await freshService.sendEmail(
        'user@test.com',
        'No SMTP',
        '<p>Hello</p>',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('SMTP not configured');
    });

    it('should throw when SMTP not configured and email is required', async () => {
      mockSettingsService.getEmailConfigForSending.mockReturnValue({
        ...mockEmailConfig,
        smtpHost: '',
      });
      const module = await Test.createTestingModule({
        providers: [
          EmailSenderService,
          { provide: SystemSettingService, useValue: mockSettingsService },
        ],
      }).compile();
      const freshService = module.get<EmailSenderService>(EmailSenderService);

      await expect(
        freshService.sendEmail('user@test.com', 'Required', '<p>Hello</p>', undefined, {
          required: true,
        }),
      ).rejects.toThrow('SMTP not configured');
    });
  });

  describe('testConnection', () => {
    it('should reset circuit breaker on successful test', async () => {
      const error = new Error('SMTP down');
      mockTransporter.sendMail.mockRejectedValue(error);

      // Open the circuit
      for (let i = 0; i < 5; i++) {
        await service.sendEmail('user@test.com', `Fail ${i}`, '<p>F</p>', undefined, {
          maxRetries: 1,
          retryDelayMs: 0,
        });
      }
      expect(service.getCircuitStatus().state).toBe('open');

      // Advance past recovery timeout so testConnection doesn't get blocked
      jest.advanceTimersByTime(61_000);

      // Successful connection test should close the circuit
      mockTransporter.verify.mockResolvedValue(true);
      const result = await service.testConnection();

      expect(result.success).toBe(true);
      expect(service.getCircuitStatus().state).toBe('closed');
    });

    it('should record failure on failed connection test', async () => {
      mockTransporter.verify.mockRejectedValue(new Error('Connection refused'));

      const result = await service.testConnection();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });
  });

  describe('onModuleDestroy', () => {
    it('should close transporter on module destroy', async () => {
      // Trigger transporter creation
      mockTransporter.sendMail.mockResolvedValue({ messageId: 'msg-1' });
      await service.sendEmail('user@test.com', 'Test', '<p>Hello</p>');

      service.onModuleDestroy();

      expect(mockTransporter.close).toHaveBeenCalled();
    });
  });
});
