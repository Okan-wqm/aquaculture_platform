import { resolveFeatureEvaluationKeyring } from '../feature-evaluation-keyring';

const DEVELOPMENT_SECRET = 'local-development-feature-key-material';

describe('resolveFeatureEvaluationKeyring', () => {
  it('uses the configured active keyring without rewriting key material', () => {
    const rawKeyring = JSON.stringify([
      { kid: 'active', secret: 'a'.repeat(32), status: 'active' },
    ]);

    expect(
      resolveFeatureEvaluationKeyring({
        rawKeyring,
        configuredActiveKeyId: 'active',
        developmentSecret: DEVELOPMENT_SECRET,
        isProduction: true,
      }),
    ).toEqual({
      keyring: [{ kid: 'active', secret: 'a'.repeat(32), status: 'active' }],
      activeKeyId: 'active',
    });
  });

  it('maps the established development secret to one shared synthetic key', () => {
    expect(
      resolveFeatureEvaluationKeyring({
        rawKeyring: undefined,
        configuredActiveKeyId: undefined,
        developmentSecret: DEVELOPMENT_SECRET,
        isProduction: false,
      }),
    ).toEqual({
      keyring: [{ kid: 'local-dev', secret: DEVELOPMENT_SECRET, status: 'active' }],
      activeKeyId: 'local-dev',
    });
  });

  it('never turns a development secret into production verification authority', () => {
    expect(() =>
      resolveFeatureEvaluationKeyring({
        rawKeyring: undefined,
        configuredActiveKeyId: undefined,
        developmentSecret: DEVELOPMENT_SECRET,
        isProduction: true,
      }),
    ).toThrow('Production feature evaluation keyring configuration is invalid');
  });

  it.each([
    ['empty object', '{}', 'active'],
    [
      'duplicate key ids',
      JSON.stringify([
        { kid: 'active', secret: 'a'.repeat(32), status: 'active' },
        { kid: 'active', secret: 'b'.repeat(32), status: 'previous' },
      ]),
      'active',
    ],
    [
      'missing configured key',
      JSON.stringify([{ kid: 'active', secret: 'a'.repeat(32), status: 'active' }]),
      'missing',
    ],
    [
      'configured previous key',
      JSON.stringify([{ kid: 'previous', secret: 'a'.repeat(32), status: 'previous' }]),
      'previous',
    ],
    [
      'weak key material',
      JSON.stringify([{ kid: 'active', secret: 'too-short', status: 'active' }]),
      'active',
    ],
    [
      'unknown entry fields',
      JSON.stringify([{ kid: 'active', secret: 'a'.repeat(32), status: 'active', fallback: true }]),
      'active',
    ],
  ])('rejects production %s', (_label, rawKeyring, configuredActiveKeyId) => {
    expect(() =>
      resolveFeatureEvaluationKeyring({
        rawKeyring,
        configuredActiveKeyId,
        developmentSecret: undefined,
        isProduction: true,
      }),
    ).toThrow('Production feature evaluation keyring configuration is invalid');
  });

  it('rejects a short explicit development fallback before runtime', () => {
    expect(() =>
      resolveFeatureEvaluationKeyring({
        rawKeyring: undefined,
        configuredActiveKeyId: undefined,
        developmentSecret: 'too-short',
        isProduction: false,
      }),
    ).toThrow('must contain at least 32 bytes');
  });
});
