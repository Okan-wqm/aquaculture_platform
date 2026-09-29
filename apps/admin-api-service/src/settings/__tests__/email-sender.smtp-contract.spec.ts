/**
 * EmailSenderService against the REAL nodemailer SMTP transport.
 *
 * WHY: every other EmailSenderService spec replaces nodemailer with a mock, so
 * a nodemailer major bump (9 → 10: TypeScript rewrite, new CJS entry point,
 * bundled declarations) could change what `createTransport` / `sendMail`
 * return at runtime without any test noticing. The service reads
 * `result.messageId` without narrowing because nodemailer 10 declares it a
 * string; this spec proves that declaration against the library itself.
 * WHAT: an in-process SMTP responder on 127.0.0.1 speaks just enough of
 * RFC 5321 (EHLO, MAIL, RCPT, DATA, QUIT) for nodemailer to complete, or be
 * refused, a real delivery. No network leaves the host.
 */
import { createServer, type Server, type Socket } from 'node:net';

import { Test } from '@nestjs/testing';

import { EmailSenderService } from '../services/email-sender.service';
import { SystemSettingService } from '../services/system-setting.service';

interface FakeSmtpServer {
  readonly port: number;
  /** Raw DATA payloads the server accepted, one per delivered message. */
  readonly messages: string[];
  close(): Promise<void>;
}

/**
 * WHY: nodemailer only resolves `sendMail` after a full SMTP exchange, so the
 * contract needs a peer that answers it. WHAT: replies to each command line;
 * `mailFromReply` decides whether the envelope sender is accepted.
 */
async function startFakeSmtpServer(mailFromReply: string): Promise<FakeSmtpServer> {
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reply = (line: string): void => {
      socket.write(`${line}\r\n`);
    };
    let pending = '';
    let data: string[] | null = null;
    reply('220 fake.smtp ESMTP');
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      let end = pending.indexOf('\r\n');
      while (end >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        end = pending.indexOf('\r\n');
        if (data !== null) {
          if (line === '.') {
            messages.push(data.join('\n'));
            data = null;
            reply('250 2.0.0 queued');
          } else {
            data.push(line);
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          reply('250-fake.smtp');
          reply('250 8BITMIME');
        } else if (verb === 'MAIL') {
          reply(mailFromReply);
        } else if (verb === 'RCPT') {
          reply('250 2.1.5 recipient ok');
        } else if (verb === 'DATA') {
          data = [];
          reply('354 end data with <CR><LF>.<CR><LF>');
        } else if (verb === 'QUIT') {
          reply('221 2.0.0 bye');
          socket.end();
        } else {
          reply('250 ok');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake SMTP server did not bind a TCP port');
  }
  return {
    port: address.port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

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
  let smtp: FakeSmtpServer | null = null;
  let service: EmailSenderService | null = null;

  afterEach(async () => {
    service?.onModuleDestroy();
    await smtp?.close();
    service = null;
    smtp = null;
  });

  it('returns the Message-ID nodemailer generated when the server accepts the message', async () => {
    // SCENARIO: the SMTP server accepts sender, recipient and DATA.
    // EXPECTS: success on the first attempt; messageId is the non-empty string
    // nodemailer wrote into the delivered message's Message-ID header.
    smtp = await startFakeSmtpServer('250 2.1.0 sender ok');
    service = await buildService(smtp.port);

    const result = await service.sendEmail('ops@aquaculture.test', 'Contract probe', '<p>hi</p>');

    expect(result).toEqual({ success: true, messageId: expect.any(String), attempts: 1 });
    expect(result.messageId).toMatch(/^<.+@.+>$/);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toContain(`Message-ID: ${result.messageId}`);
    expect(smtp.messages[0]).toContain('Subject: Contract probe');
  });

  it('reports the SMTP rejection when the server refuses the envelope sender', async () => {
    // SCENARIO: the server answers MAIL FROM with a permanent 550.
    // EXPECTS: no delivery, a failed result carrying the server's reply, and a
    // single attempt (default maxRetries = 1).
    smtp = await startFakeSmtpServer('550 5.7.1 sender rejected');
    service = await buildService(smtp.port);

    const result = await service.sendEmail('ops@aquaculture.test', 'Contract probe', '<p>hi</p>');

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error).toContain('550 5.7.1 sender rejected');
    expect(smtp.messages).toHaveLength(0);
  });
});
