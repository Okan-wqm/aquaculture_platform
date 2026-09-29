/**
 * EmailSenderService against the REAL nodemailer SMTP transport.
 *
 * WHY: every other EmailSenderService spec replaces nodemailer with a mock, so
 * a nodemailer major bump (9 → 10: TypeScript rewrite, new CJS entry point,
 * bundled declarations) could change what `createTransport` / `sendMail`
 * return at runtime without any test noticing. The service reads
 * `result.messageId` without narrowing because nodemailer 10 declares it a
 * string; this spec proves that declaration against the library itself. It is
 * a library contract test: it passes on nodemailer 9 as well, and guards the
 * contract, not the upgrade.
 * WHAT: the shared in-process SMTP responder (`withFakeSmtpServer`) answers
 * the real dialogue on 127.0.0.1; each test owns its responder and service and
 * tears both down in `finally`.
 */
import { withFakeSmtpServer } from '@aquaculture/testing';
import { Test } from '@nestjs/testing';

import { EmailSenderService } from '../services/email-sender.service';
import { SystemSettingService } from '../services/system-setting.service';

async function buildService(port: number): Promise<EmailSenderService> {
  const settings: Pick<SystemSettingService, 'getEmailConfigForSending'> = {
    getEmailConfigForSending: () => ({
      smtpHost: '127.0.0.1',
      smtpPort: port,
      smtpSecure: false,
      smtpUsername: '',
      smtpPassword: '',
      fromAddress: 'noreply@aquaculture.test',
      fromName: 'Aquaculture Platform',
    }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [EmailSenderService, { provide: SystemSettingService, useValue: settings }],
  }).compile();
  return moduleRef.get(EmailSenderService);
}

describe('EmailSenderService — real nodemailer SMTP transport contract', () => {
  it('returns the Message-ID nodemailer generated when the server accepts the message', async () => {
    // SCENARIO: the SMTP server accepts sender, recipient and DATA.
    // EXPECTS: success on the first attempt; messageId is the non-empty string
    // nodemailer wrote into the delivered message's Message-ID header.
    await withFakeSmtpServer({}, async (smtp) => {
      const service = await buildService(smtp.port);
      try {
        const result = await service.sendEmail(
          'ops@aquaculture.test',
          'Contract probe',
          '<p>hi</p>',
        );

        expect(result).toEqual({ success: true, messageId: expect.any(String), attempts: 1 });
        expect(result.messageId).toMatch(/^<.+@.+>$/);
        expect(smtp.messages).toEqual([
          expect.objectContaining({
            data: expect.stringContaining(`Message-ID: ${String(result.messageId)}`),
          }),
        ]);
        expect(smtp.messages).toEqual([
          expect.objectContaining({ data: expect.stringContaining('Subject: Contract probe') }),
        ]);
      } finally {
        service.onModuleDestroy();
      }
    });
  });

  it('reports the SMTP rejection when the server refuses the envelope sender', async () => {
    // SCENARIO: the server answers MAIL FROM with a permanent 550.
    // EXPECTS: no delivery, a failed result carrying the server's reply, and a
    // single attempt (default maxRetries = 1).
    await withFakeSmtpServer(
      { replies: { mailFrom: '550 5.7.1 sender rejected' } },
      async (smtp) => {
        const service = await buildService(smtp.port);
        try {
          const result = await service.sendEmail(
            'ops@aquaculture.test',
            'Contract probe',
            '<p>hi</p>',
          );

          expect(result.success).toBe(false);
          expect(result.attempts).toBe(1);
          expect(result.error).toContain('550 5.7.1 sender rejected');
          expect(smtp.messages).toEqual([]);
        } finally {
          service.onModuleDestroy();
        }
      },
    );
  });
});
