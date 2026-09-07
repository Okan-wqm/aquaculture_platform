import { ConfigService } from '@nestjs/config';

import { EmailDeliveryError, EmailService } from '../email.service';

/**
 * PLAT-HIGH-902 — a failed e-mail delivery is classified at the source so the
 * handler can hand the bus a retry or a terminate without guessing.
 */
describe('EmailDeliveryError (PLAT-HIGH-902)', () => {
  it('a missing transporter is permanent: redelivery cannot configure SMTP', async () => {
    const service = new EmailService(new ConfigService({}));
    await expect(service.sendEmail('a@example.test', 'subject', '<p>hi</p>')).rejects.toMatchObject(
      {
        name: 'EmailDeliveryError',
        failureClass: 'permanent',
      },
    );
  });

  it('an SMTP 5xx reply is permanent, everything else transient', () => {
    const rejected = Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 });
    expect(EmailDeliveryError.fromTransport(rejected).failureClass).toBe('permanent');
    const greylisted = Object.assign(new Error('450 try again later'), { responseCode: 450 });
    expect(EmailDeliveryError.fromTransport(greylisted).failureClass).toBe('transient');
    expect(EmailDeliveryError.fromTransport(new Error('ECONNREFUSED')).failureClass).toBe(
      'transient',
    );
  });

  it('keeps an already-classified error as is', () => {
    const original = new EmailDeliveryError('x', 'permanent');
    expect(EmailDeliveryError.fromTransport(original)).toBe(original);
  });
});
