/**
 * An in-process SMTP responder for contract tests of the REAL nodemailer
 * transports.
 *
 * WHY: a service spec that mocks nodemailer away proves nothing about what
 * nodemailer does on the wire — how a reply code reaches the error the service
 * classifies, what `sendMail` resolves to, whether a pooled STARTTLS session
 * completes. A peer that answers the SMTP dialogue lets the library run as in
 * production while nothing leaves 127.0.0.1.
 * WHAT: EHLO / MAIL / RCPT / DATA / QUIT (anything else gets 250), optional
 * STARTTLS with a throwaway loopback certificate the process trusts while the
 * server lives (without it, STARTTLS gets `454`), and per-verb reply overrides
 * to provoke rejections.
 */
import { createServer, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { createSecureContext, TLSSocket } from 'node:tls';

import { trustCertificateInDefaultCaList } from './default-ca-trust';
import { createLoopbackCertificate, type LoopbackCertificate } from './loopback-certificate';

export interface FakeSmtpReplies {
  /** Reply to MAIL FROM (default `250 2.1.0 sender ok`). */
  readonly mailFrom?: string;
  /** Reply to every RCPT TO (default `250 2.1.5 recipient ok`). */
  readonly rcptTo?: string;
}

export interface FakeSmtpServerOptions {
  readonly replies?: FakeSmtpReplies;
  /** Advertise STARTTLS with a certificate the process trusts until teardown. */
  readonly startTls?: boolean;
}

export interface FakeSmtpMessage {
  /** Envelope recipients from RCPT TO, in order. */
  readonly recipients: readonly string[];
  /** The DATA payload, lines joined with `\n`. */
  readonly data: string;
  /** Whether the session had been upgraded with STARTTLS when DATA ended. */
  readonly overTls: boolean;
}

export interface FakeSmtpServer {
  readonly host: '127.0.0.1';
  readonly port: number;
  /** Every message the server accepted, in order. */
  readonly messages: readonly FakeSmtpMessage[];
}

interface Session {
  readonly replies: Required<FakeSmtpReplies>;
  readonly identity: LoopbackCertificate | null;
  readonly accept: (message: FakeSmtpMessage) => void;
}

/** WHAT: one SMTP dialogue on `stream`; STARTTLS re-enters it on the TLS socket. */
function serve(stream: Duplex, session: Session, overTls: boolean): void {
  const reply = (line: string): void => void stream.write(`${line}\r\n`);
  const offersStartTls = session.identity !== null && !overTls;
  let pending = '';
  let recipients: string[] = [];
  let data: string[] | null = null;
  const onData = (chunk: Buffer): void => {
    pending += chunk.toString('utf8');
    for (let end = pending.indexOf('\r\n'); end >= 0; end = pending.indexOf('\r\n')) {
      const line = pending.slice(0, end);
      const command = line.toUpperCase();
      pending = pending.slice(end + 2);
      if (data !== null) {
        if (line !== '.') {
          data.push(line);
          continue;
        }
        session.accept({ recipients, data: data.join('\n'), overTls });
        data = null;
        recipients = [];
        reply('250 2.0.0 queued');
      } else if (command.startsWith('EHLO')) {
        const extensions = ['fake.smtp', ...(offersStartTls ? ['STARTTLS'] : []), '8BITMIME'];
        extensions.forEach((extension, index) =>
          reply(`250${index === extensions.length - 1 ? ' ' : '-'}${extension}`),
        );
      } else if (command === 'STARTTLS' && offersStartTls && session.identity !== null) {
        // The client sends its ClientHello only after this 220, so the TLS
        // socket is attached before a single encrypted byte arrives.
        stream.off('data', onData);
        reply('220 2.0.0 ready to start TLS');
        const secure = new TLSSocket(stream, {
          isServer: true,
          secureContext: createSecureContext({
            cert: session.identity.certPem,
            key: session.identity.keyPem,
          }),
        });
        // A client that drops mid-handshake is the client's failure to report.
        secure.on('error', () => stream.destroy());
        serve(secure, session, true);
        return;
      } else if (command === 'STARTTLS') {
        // What a real server without TLS answers. A client that requires TLS
        // must stop here instead of carrying on in plaintext.
        reply('454 4.7.0 TLS not available');
      } else if (command.startsWith('MAIL')) {
        recipients = [];
        reply(session.replies.mailFrom);
      } else if (command.startsWith('RCPT')) {
        recipients.push(line.replace(/^RCPT TO:\s*<?([^>\s]*)>?.*$/i, '$1'));
        reply(session.replies.rcptTo);
      } else if (command === 'DATA') {
        data = [];
        reply('354 end data with <CR><LF>.<CR><LF>');
      } else if (command === 'QUIT') {
        reply('221 2.0.0 bye');
        stream.end();
      } else {
        reply('250 2.0.0 ok');
      }
    }
  };
  stream.on('data', onData);
  if (!overTls) reply('220 fake.smtp ESMTP');
}

/**
 * Runs `test` against a fresh responder and always tears it down.
 *
 * WHY: a responder a failing assertion forgets to close keeps its port, its
 * sockets and — with STARTTLS — its process-wide CA trust alive into the next
 * spec. INVARIANT: teardown runs in `finally`, so no test path can skip it; if
 * it could → leaked handles and a CA list that trusts a discarded key.
 */
export async function withFakeSmtpServer<T>(
  { replies = {}, startTls = false }: FakeSmtpServerOptions,
  test: (server: FakeSmtpServer) => Promise<T>,
): Promise<T> {
  const messages: FakeSmtpMessage[] = [];
  const session: Session = {
    replies: {
      mailFrom: replies.mailFrom ?? '250 2.1.0 sender ok',
      rcptTo: replies.rcptTo ?? '250 2.1.5 recipient ok',
    },
    identity: startTls ? createLoopbackCertificate() : null,
    accept: (message) => void messages.push(message),
  };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // A pooled client torn down by teardown resets the socket (ECONNRESET);
    // without a listener that reset would crash the Jest worker.
    socket.on('error', () => socket.destroy());
    serve(socket, session, false);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let restoreCaList = (): void => undefined;
  try {
    if (session.identity !== null) {
      restoreCaList = trustCertificateInDefaultCaList(session.identity.certPem);
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fake SMTP server did not bind a TCP port');
    }
    return await test({ host: '127.0.0.1', port: address.port, messages });
  } finally {
    restoreCaList();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
