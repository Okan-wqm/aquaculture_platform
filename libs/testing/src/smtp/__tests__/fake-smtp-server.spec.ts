import { X509Certificate, createPrivateKey } from 'node:crypto';
import { getCACertificates } from 'node:tls';

import * as nodemailer from 'nodemailer';

import { withFakeSmtpServer } from '../fake-smtp-server';
import { createLoopbackCertificate } from '../loopback-certificate';

/**
 * The SMTP responder is the peer every real-transport contract spec trusts, so
 * a defect here would turn those specs green for the wrong reason. Pinned:
 * the hand-encoded certificate is a valid X.509 identity for 127.0.0.1, a
 * verifying STARTTLS client reaches DATA through it, and teardown gives the
 * process its CA list back.
 */
describe('createLoopbackCertificate', () => {
  it('mints a self-signed certificate for 127.0.0.1 that matches its key', () => {
    // SCENARIO: the DER encoder builds a certificate from scratch.
    // EXPECTS: OpenSSL parses it, its signature verifies against its own
    // public key, its SAN matches the loopback IP, it is valid now, and the
    // private key belongs to it.
    const { certPem, keyPem } = createLoopbackCertificate();
    const certificate = new X509Certificate(certPem);

    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(certificate.subjectAltName).toBe('IP Address:127.0.0.1');
    expect(Date.parse(certificate.validFrom)).toBeLessThan(Date.now());
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now());
    expect(certificate.checkPrivateKey(createPrivateKey(keyPem))).toBe(true);
  });
});

describe('withFakeSmtpServer', () => {
  it('completes a verified STARTTLS delivery and records the message', async () => {
    // SCENARIO: a nodemailer client that requires TLS and rejects unknown
    // certificates, given no CA of its own, sends one message.
    // EXPECTS: the handshake verifies against the process-trusted loopback
    // certificate, and the server records the envelope, the payload and that
    // it arrived over TLS.
    await withFakeSmtpServer({ startTls: true }, async (smtp) => {
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        requireTLS: true,
        tls: { rejectUnauthorized: true },
      });
      try {
        await transport.sendMail({
          from: 'probe@aquaculture.test',
          to: 'ops@aquaculture.test',
          subject: 'Responder probe',
          text: 'hi',
        });
      } finally {
        transport.close();
      }

      expect(smtp.messages.map(({ recipients, overTls }) => ({ recipients, overTls }))).toEqual([
        { recipients: ['ops@aquaculture.test'], overTls: true },
      ]);
      expect(smtp.messages.map(({ data }) => data.includes('Subject: Responder probe'))).toEqual([
        true,
      ]);
    });
  });

  it('returns the process CA list to its previous state after teardown', async () => {
    // SCENARIO: a STARTTLS responder lives for one callback.
    // EXPECTS: exactly one extra CA while it lives, none after it closes —
    // even when the callback throws.
    const before = getCACertificates('default').length;

    await expect(
      withFakeSmtpServer({ startTls: true }, () => {
        expect(getCACertificates('default')).toHaveLength(before + 1);
        return Promise.reject(new Error('assertion failed inside the callback'));
      }),
    ).rejects.toThrow('assertion failed inside the callback');

    expect(getCACertificates('default')).toHaveLength(before);
  });
});
