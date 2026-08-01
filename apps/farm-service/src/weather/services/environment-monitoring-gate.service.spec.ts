import { ServiceUnavailableException } from '@nestjs/common';

import {
  ENVIRONMENT_MONITORING_ENABLED_KEY,
  type EnvironmentMonitoringConfiguration,
  EnvironmentMonitoringGate,
  parseEnvironmentMonitoringFlag,
} from './environment-monitoring-gate.service';

class StubConfigService implements EnvironmentMonitoringConfiguration {
  constructor(private readonly values: Readonly<Record<string, string>>) {}

  get(key: string): string | undefined {
    return this.values[key];
  }
}

function createGate(value?: string): EnvironmentMonitoringGate {
  const values: Readonly<Record<string, string>> =
    value === undefined ? {} : { [ENVIRONMENT_MONITORING_ENABLED_KEY]: value };
  return new EnvironmentMonitoringGate(new StubConfigService(values));
}

describe('EnvironmentMonitoringGate', () => {
  it('defaults to disabled when the rollout flag is absent', () => {
    expect(createGate().isEnabled()).toBe(false);
  });

  it.each([
    ['true', true],
    [' TRUE ', true],
    ['false', false],
    [' False ', false],
  ])('parses %p as %p', (rawValue, expected) => {
    expect(parseEnvironmentMonitoringFlag(rawValue)).toBe(expected);
  });

  it('fails fast for an ambiguous rollout value', () => {
    expect(() => createGate('yes')).toThrow(
      `${ENVIRONMENT_MONITORING_ENABLED_KEY} must be either "true" or "false"`,
    );
  });

  it('rejects an entry point with a stable unavailable response while disabled', () => {
    const gate = createGate('false');

    try {
      gate.assertEnabled();
      throw new Error('Expected the gate to reject');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      if (!(error instanceof ServiceUnavailableException)) {
        throw error;
      }
      expect(error.getResponse()).toEqual({
        statusCode: 503,
        code: 'ENVIRONMENT_MONITORING_DISABLED',
        message: 'Environmental monitoring is not enabled for this deployment',
      });
    }
  });

  it('allows an entry point only when explicitly enabled', () => {
    expect(() => createGate('true').assertEnabled()).not.toThrow();
  });
});
