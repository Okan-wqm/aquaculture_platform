import { withFakeSmtpServer } from '@aquaculture/testing';
import { ConfigService } from '@nestjs/config';

import { NotificationService } from '../notification.service';

/**
 * SCADA NotificationService.sendDirectEmail against the REAL nodemailer SMTP
 * transport.
 *
 * WHY: this is the transport server-side SCADA scripts reach through
 * `$sendMessage()`, and until now no spec exercised it at all. The nodemailer
 * 10 upgrade changed the transporter's declared type here (the plain
 * `Transporter` replaced `ReturnType<typeof createTransport>`); this spec
 * proves the library still delivers what the service hands it and still
 * rejects the way the caller's error handling expects.
 * WHAT: the service's lazy transporter, built from a real ConfigService that
 * points at the in-process responder.
 */

function buildService(port: number): NotificationService {
  return new NotificationService(
    new ConfigService({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_FROM: 'SCADA Alarms <scada@aquaculture.test>',
    }),
  );
}

describe('NotificationService.sendDirectEmail — real nodemailer SMTP transport', () => {
  it('delivers the script message to the requested recipient', async () => {
    // SCENARIO: a SCADA script sends a free-form message; the server accepts it.
    // EXPECTS: one delivered message addressed (envelope and header) to the
    // requested recipient, with the script's subject and HTML body.
    await withFakeSmtpServer({}, async (smtp) => {
      await buildService(smtp.port).sendDirectEmail(
        'operator@aquaculture.test',
        'Pump 3 tripped',
        '<p>Pump 3 overcurrent</p>',
      );

      expect(smtp.messages).toEqual([
        {
          recipients: ['operator@aquaculture.test'],
          data: expect.stringMatching(/^To: operator@aquaculture\.test$/m),
          overTls: false,
        },
      ]);
      expect(smtp.messages).toEqual([
        expect.objectContaining({
          data: expect.stringMatching(/^Subject: Pump 3 tripped$[\s\S]*Pump 3 overcurrent/m),
        }),
      ]);
    });
  });

  it('rejects with the SMTP reply when the server refuses the recipient', async () => {
    // SCENARIO: the server answers RCPT TO with a permanent 550.
    // EXPECTS: sendDirectEmail rejects with nodemailer's error (responseCode
    // 550) instead of resolving, so the script caller sees the failure; no
    // message is delivered.
    await withFakeSmtpServer({ replies: { rcptTo: '550 5.1.1 no such user' } }, async (smtp) => {
      await expect(
        buildService(smtp.port).sendDirectEmail('ghost@aquaculture.test', 'Probe', '<p>x</p>'),
      ).rejects.toMatchObject({ responseCode: 550 });
      expect(smtp.messages).toEqual([]);
    });
  });
});
