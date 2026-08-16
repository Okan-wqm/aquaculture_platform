import {
  canonicalConfigurationInput,
  canonicalConfigurationJson,
  ConfigurationValueError,
  parseCanonicalConfigurationValue,
} from './configuration-values';
import {
  CONFIGURATION_DEFINITION_BY_ID,
  ConfigurationKeyId,
} from './generated/configuration-catalog.generated';

describe('configuration value contract', () => {
  it('canonicalizes JSON object keys and numeric spellings', () => {
    expect(canonicalConfigurationJson({ z: 1, a: [true, -0] })).toBe('{"a":[true,0],"z":1}');
    expect(
      canonicalConfigurationInput(
        CONFIGURATION_DEFINITION_BY_ID[ConfigurationKeyId.EMAIL_SMTP_PORT],
        '0587.0',
      ),
    ).toBe('587');
  });

  it('rejects invalid values from generated semantic rules', () => {
    expect(() =>
      canonicalConfigurationInput(
        CONFIGURATION_DEFINITION_BY_ID[ConfigurationKeyId.EMAIL_SMTP_PORT],
        '70000',
      ),
    ).toThrow(ConfigurationValueError);
    expect(() =>
      canonicalConfigurationInput(
        CONFIGURATION_DEFINITION_BY_ID[ConfigurationKeyId.PLATFORM_LOCALE],
        'not a locale',
      ),
    ).toThrow(ConfigurationValueError);
  });

  it('does not expose secret rows through the typed value parser', () => {
    expect(() =>
      parseCanonicalConfigurationValue(
        CONFIGURATION_DEFINITION_BY_ID[ConfigurationKeyId.EMAIL_SMTP_PASSWORD],
        'secret',
      ),
    ).toThrow('secret values cannot be projected');
  });
});
