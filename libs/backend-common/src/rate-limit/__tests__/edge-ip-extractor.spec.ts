import { extractClientIp, isValidIp } from '../edge/ip-extractor';
import { EdgeRequestFacts, INVALID_IP_BUCKET } from '../rate-limit.types';

function facts(partial: Partial<EdgeRequestFacts>): EdgeRequestFacts {
  return { headers: {}, ...partial };
}

describe('isValidIp', () => {
  it.each([
    ['1.2.3.4', true],
    ['255.255.255.255', true],
    ['256.1.1.1', false],
    ['::1', true],
    ['2001:db8::1', true],
    ['::ffff:1.2.3.4', true], // IPv4-mapped IPv6 — stripped then validated as IPv4
    ['not-an-ip', false],
    ['unknown', false],
    ['', false],
    [undefined, false],
  ])('isValidIp(%s) === %s', (ip, expected) => {
    expect(isValidIp(ip)).toBe(expected);
  });
});

describe('extractClientIp — precedence (gateway parity)', () => {
  it('prefers request.ip when valid and non-loopback', () => {
    const r = extractClientIp(facts({ ip: '9.9.9.9', headers: { 'x-forwarded-for': '1.1.1.1' } }));
    expect(r).toEqual({ ip: '9.9.9.9', unverifiedForwardedFor: false });
  });

  it.each(['::1', '127.0.0.1'])('falls through loopback request.ip %s', (loopback) => {
    const r = extractClientIp(facts({ ip: loopback, headers: { 'x-forwarded-for': '1.1.1.1' } }));
    expect(r.ip).toBe('1.1.1.1');
    expect(r.unverifiedForwardedFor).toBe(true);
  });

  it('falls through invalid request.ip to X-Forwarded-For', () => {
    const r = extractClientIp(facts({ ip: 'garbage', headers: { 'x-forwarded-for': '8.8.8.8, 1.1.1.1' } }));
    expect(r).toEqual({ ip: '8.8.8.8', unverifiedForwardedFor: true });
  });

  it('ignores an array X-Forwarded-For (duplicate header) and uses X-Real-IP', () => {
    const r = extractClientIp(
      facts({ headers: { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'], 'x-real-ip': '3.3.3.3' } }),
    );
    expect(r).toEqual({ ip: '3.3.3.3', unverifiedForwardedFor: false });
  });

  it('uses connection/socket remoteAddress as the last resort', () => {
    const r = extractClientIp(facts({ remoteAddress: '4.4.4.4' }));
    expect(r).toEqual({ ip: '4.4.4.4', unverifiedForwardedFor: false });
  });

  it('groups all unresolvable IPs into one INVALID_IP_BUCKET (no bypass)', () => {
    const r = extractClientIp(facts({ ip: 'bad', headers: { 'x-forwarded-for': 'also-bad' } }));
    expect(r).toEqual({ ip: INVALID_IP_BUCKET, unverifiedForwardedFor: false });
  });

  it('rejects a non-IP first X-Forwarded-For entry', () => {
    const r = extractClientIp(facts({ headers: { 'x-forwarded-for': 'evil, 8.8.8.8' } }));
    expect(r.ip).toBe(INVALID_IP_BUCKET);
  });
});
