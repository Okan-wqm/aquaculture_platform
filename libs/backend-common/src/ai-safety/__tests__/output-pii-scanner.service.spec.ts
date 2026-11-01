import { OutputPiiScannerService } from '../output-pii-scanner.service';

const TENANT = '00000000-0000-4000-8000-000000000001';
// 13 digits, Luhn-valid: both the phone and the credit-card pattern match it.
const CARD_13 = '4222222222222';

/** Mulberry32: a small seeded PRNG, so a failing case is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Feed `text` to a stream in the given piece lengths; return what it emitted. */
function streamed(
  scanner: OutputPiiScannerService,
  text: string,
  pieces: number[],
): { emitted: string[]; total: string } {
  const stream = scanner.redactStream(TENANT);
  const emitted: string[] = [];
  let at = 0;
  for (const length of pieces) {
    emitted.push(stream.push(text.slice(at, at + length)));
    at += length;
  }
  emitted.push(stream.push(text.slice(at)));
  emitted.push(stream.end().text);
  return { emitted, total: emitted.join('') };
}

describe('OutputPiiScannerService', () => {
  const scanner = new OutputPiiScannerService();

  describe('redact', () => {
    it('replaces each kind of PII and keeps the text around it', () => {
      const text = `Mail ops@example.com, call +90 532 123 45 67, card ${CARD_13} or id 3f0c6a7e-1b2d-4c3e-9f80-0a1b2c3d4e5f.`;
      expect(scanner.redact(text, TENANT).redactedText).toBe(
        'Mail [REDACTED], call [REDACTED], card [REDACTED] or id [REDACTED].',
      );
    });

    it('redacts detections that overlap once, without eating the text after them', () => {
      const result = scanner.redact(`Card ${CARD_13} is on file.`, TENANT);
      expect(result.scanResult.countByType).toEqual({ phone: 1, credit_card: 1 });
      expect(result.redactedText).toBe('Card [REDACTED] is on file.');
    });

    it('reports detections at their positions in the original text', () => {
      const text = 'a ops@example.com b ops@example.org';
      expect(
        scanner
          .redact(text, TENANT)
          .scanResult.detections.map((d) => text.slice(d.startIndex, d.endIndex)),
      ).toEqual(['ops@example.com', 'ops@example.org']);
    });
  });

  describe('redactStream', () => {
    it('emits text as soon as no PII match can still change it', () => {
      const stream = scanner.redactStream(TENANT);
      expect(stream.push('The tank ')).toBe('The tank ');
      // An unfinished word is held: it may still become an address.
      expect(stream.push('is ops')).toBe('is ');
      expect(stream.push('@example.com now')).toBe('[REDACTED] ');
      expect(stream.end().text).toBe('now');
    });

    it('holds digit groups until the number is complete', () => {
      const stream = scanner.redactStream(TENANT);
      expect(stream.push('Call +90 532 ')).toBe('Call ');
      expect(stream.push('123 45 67 ')).toBe('');
      expect(stream.push('today.')).toBe('[REDACTED] ');
      expect(stream.end().text).toBe('today.');
    });

    it('reports the scan of the whole text when it ends', () => {
      const stream = scanner.redactStream(TENANT);
      stream.push('reach ops@example.com or ');
      stream.push(`pay with ${CARD_13} today`);
      expect(stream.end().scanResult.countByType).toEqual({ email: 1, phone: 1, credit_card: 1 });
    });

    it.each([
      ['an address split anywhere', 'Write to ops.team+farm@example.co.uk about tank 4.'],
      ['a phone number split anywhere', 'Phone: (0532) 123-45-67 or +1 555 123 4567, then stop.'],
      ['a spaced card number split anywhere', 'Card 4111 1111 1111 1111 expires soon.'],
      ['a dashed card number', 'Card 4111-1111-1111-1111\nnext line'],
      ['an SSN and a UUID', 'SSN 123-45-6789 id 3F0C6A7E-1B2D-4C3E-9F80-0A1B2C3D4E5F ok'],
      ['digits that are not PII', 'Tanks 1 2 3 4 hold 12 34 fish at 7.5 pH.'],
      ['overlapping matches', `Card ${CARD_13} is on file.`],
    ])('emits exactly what redact returns for %s', (_name, text) => {
      const expected = scanner.redact(text, TENANT).redactedText;
      for (let cut = 0; cut <= text.length; cut++) {
        expect(streamed(scanner, text, [cut]).total).toBe(expected);
      }
      expect(
        streamed(
          scanner,
          text,
          Array.from(text, () => 1),
        ).total,
      ).toBe(expected);
    });

    it('emits exactly what redact returns for random text in random pieces', () => {
      // Characters every pattern is built from, so matches start, cross
      // whitespace and end at arbitrary points.
      const alphabet = 'ab@.-+() 0123456789\n';
      const random = prng(2026_10_31);
      for (let run = 0; run < 3000; run++) {
        const text = Array.from(
          { length: 1 + Math.floor(random() * 60) },
          () => alphabet[Math.floor(random() * alphabet.length)],
        ).join('');
        const pieces = Array.from({ length: Math.floor(random() * 8) }, () =>
          Math.floor(random() * 10),
        );
        const expected = scanner.redact(text, TENANT).redactedText;
        const actual = streamed(scanner, text, pieces).total;
        if (actual !== expected) {
          throw new Error(
            `stream diverged from redact for ${JSON.stringify(text)} in pieces ${JSON.stringify(pieces)}: ` +
              `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
          );
        }
      }
    });
  });
});
