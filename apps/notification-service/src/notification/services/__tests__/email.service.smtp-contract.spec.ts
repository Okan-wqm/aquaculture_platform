import { withFakeSmtpServer } from '@aquaculture/testing';
import { ConfigService } from '@nestjs/config';

import { EmailDeliveryError, EmailService } from '../email.service';

/**
 * EmailService against the REAL nodemailer pool transport.
 *
 * WHY: the other EmailService specs replace nodemailer with a mock, so the
 * transport this service actually builds — `pool: true`, `requireTLS`,
 * `rejectUnauthorized: true`, the path nodemailer 10.0.12 changed — and the
 * PLAT-HIGH-902 split (`EmailDeliveryError.fromTransport`: an SMTP 5xx is
 * permanent, anything else transient) had only ever been checked against
 * hand-built error objects. The split keys on nodemailer's `responseCode`; if
 * a nodemailer release stops setting it, every hard bounce is silently
 * retried as transient.
 * WHAT: the service's own constructor path (a real ConfigService pointing at
 * the in-process responder) over verified STARTTLS; the responder's MAIL FROM
 * reply decides the outcome, and a responder without TLS proves the transport
 * never falls back to plaintext.
 */

function buildService(port: number): EmailService {
  return new EmailService(
    new ConfigService({
      SMTP_ENABLED: 'true',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: port,
      SMTP_FROM: 'noreply@aquaculture.test',
    }),
  );
}

/** WHAT: the value a promise rejected with, or a failure if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`expected a rejection, resolved with ${String(value)}`);
    },
    (error: unknown) => error,
  );
}

describe('EmailService — real nodemailer pool transport contract', () => {
  it('returns the Message-ID of a message delivered over verified STARTTLS', async () => {
    // SCENARIO: the server accepts sender, recipient and DATA.
    // EXPECTS: sendEmail resolves to the Message-ID nodemailer generated and
    // wrote into the delivered message, and the session was TLS-upgraded
    // (requireTLS with certificate verification, as production builds it).
    await withFakeSmtpServer({ startTls: true }, async (smtp) => {
      const messageId = await buildService(smtp.port).sendEmail(
        'ops@aquaculture.test',
        'Pool contract',
        '<p>hi</p>',
      );

      expect(messageId).toMatch(/^<.+@.+>$/);
      expect(smtp.messages).toEqual([
        {
          recipients: ['ops@aquaculture.test'],
          data: expect.stringContaining(`Message-ID: ${messageId}`),
          overTls: true,
        },
      ]);
    });
  });

  it('refuses to fall back to plaintext when the server cannot start TLS', async () => {
    // SCENARIO: the server neither advertises nor supports STARTTLS (it answers
    // 454). A client without requireTLS would deliver in plaintext here.
    // EXPECTS: nothing is delivered; sendEmail rejects with a transient
    // EmailDeliveryError whose cause is nodemailer's ETLS error. That is the
    // service's `requireTLS` at work (10.0.12 also lets it override
    // ignoreTLS / opportunisticTLS, which the service does not set).
    await withFakeSmtpServer({}, async (smtp) => {
      const error = await rejectionOf(
        buildService(smtp.port).sendEmail('ops@aquaculture.test', 'Plaintext', '<p>hi</p>'),
      );

      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect(error).toMatchObject({
        failureClass: 'transient',
        cause: expect.objectContaining({ code: 'ETLS', responseCode: 454 }),
      });
      expect(smtp.messages).toEqual([]);
    });
  });

  it('classifies a 550 reply as a permanent delivery failure', async () => {
    // SCENARIO: the server refuses the envelope sender with 550.
    // EXPECTS: an EmailDeliveryError whose failureClass is 'permanent' (the
    // bus must not redeliver), carrying nodemailer's responseCode 550, and no
    // message delivered.
    await withFakeSmtpServer(
      { startTls: true, replies: { mailFrom: '550 5.7.1 sender rejected' } },
      async (smtp) => {
        const error = await rejectionOf(
          buildService(smtp.port).sendEmail('ops@aquaculture.test', 'Bounce', '<p>hi</p>'),
        );

        expect(error).toBeInstanceOf(EmailDeliveryError);
        expect(error).toMatchObject({
          failureClass: 'permanent',
          cause: expect.objectContaining({ responseCode: 550 }),
        });
        expect(smtp.messages).toEqual([]);
      },
    );
  });

  it('classifies a 451 reply as a transient delivery failure', async () => {
    // SCENARIO: the server defers the envelope sender with 451 (greylisting).
    // EXPECTS: an EmailDeliveryError whose failureClass is 'transient' (worth
    // the bus's retry budget), carrying responseCode 451, nothing delivered.
    await withFakeSmtpServer(
      { startTls: true, replies: { mailFrom: '451 4.7.1 greylisted, try again later' } },
      async (smtp) => {
        const error = await rejectionOf(
          buildService(smtp.port).sendEmail('ops@aquaculture.test', 'Deferral', '<p>hi</p>'),
        );

        expect(error).toBeInstanceOf(EmailDeliveryError);
        expect(error).toMatchObject({
          failureClass: 'transient',
          cause: expect.objectContaining({ responseCode: 451 }),
        });
        expect(smtp.messages).toEqual([]);
      },
    );
  });
});
