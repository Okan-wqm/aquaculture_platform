/**
 * MSGFIX-FAZ0 — AI kill-switch config tests.
 *
 * The flag must fail CLOSED: unset, empty, or any non-'true' value disables
 * the AI trigger; only the exact string 'true' (trim + case-insensitive)
 * enables it. Also pins the single startup log line emitted when disabled.
 */
import {
  AiTriggerConfig,
  MESSAGING_AI_TRIGGER_ENABLED_ENV,
  messagingAiFlagEnabled,
  parseMessagingAiEnabledFlag,
} from '../ai-trigger.config';

const savedEnv = process.env[MESSAGING_AI_TRIGGER_ENABLED_ENV];

describe('AiTriggerConfig — MESSAGING_AI_TRIGGER_ENABLED kill-switch (MSGFIX-FAZ0)', () => {
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[MESSAGING_AI_TRIGGER_ENABLED_ENV];
    else process.env[MESSAGING_AI_TRIGGER_ENABLED_ENV] = savedEnv;
  });

  it('is DISABLED when the env var is unset (default false)', () => {
    delete process.env[MESSAGING_AI_TRIGGER_ENABLED_ENV];
    expect(new AiTriggerConfig().triggerEnabled).toBe(false);
  });

  it("is ENABLED only for the exact string 'true'", () => {
    process.env[MESSAGING_AI_TRIGGER_ENABLED_ENV] = 'true';
    expect(new AiTriggerConfig().triggerEnabled).toBe(true);
  });

  it("trim + case-insensitive 'true' variants still ENABLE (strictness targets typos, not casing)", () => {
    // Failing CLOSED on typos is the goal; innocent casing/whitespace must
    // not silently disable a deliberately enabled flag.
    process.env[MESSAGING_AI_TRIGGER_ENABLED_ENV] = ' TRUE ';
    expect(new AiTriggerConfig().triggerEnabled).toBe(true);
  });

  it('fails CLOSED on every non-true value (typos, 1, yes, false)', () => {
    for (const value of ['', '1', 'yes', 'false', 'ture', 'enabled', '0']) {
      process.env[MESSAGING_AI_TRIGGER_ENABLED_ENV] = value;
      expect(new AiTriggerConfig().triggerEnabled).toBe(false);
    }
  });

  it('logs exactly one line at startup when disabled, and is silent when enabled', () => {
    delete process.env[MESSAGING_AI_TRIGGER_ENABLED_ENV];
    const disabledConfig = new AiTriggerConfig();
    const disabledLog = jest
      .spyOn(disabledConfig['logger'], 'log')
      .mockImplementation(() => undefined);
    disabledConfig.onModuleInit();
    expect(disabledLog).toHaveBeenCalledTimes(1);
    expect(String(disabledLog.mock.calls[0]?.[0])).toContain('DISABLED');
    expect(String(disabledLog.mock.calls[0]?.[0])).toContain(MESSAGING_AI_TRIGGER_ENABLED_ENV);
    disabledLog.mockRestore();

    process.env[MESSAGING_AI_TRIGGER_ENABLED_ENV] = 'true';
    const enabledConfig = new AiTriggerConfig();
    const enabledLog = jest
      .spyOn(enabledConfig['logger'], 'log')
      .mockImplementation(() => undefined);
    enabledConfig.onModuleInit();
    expect(enabledLog).not.toHaveBeenCalled();
    enabledLog.mockRestore();
  });
});

describe('parseMessagingAiEnabledFlag — shared strict parser (cron gates reuse this)', () => {
  it('returns the default for undefined and empty', () => {
    expect(parseMessagingAiEnabledFlag(undefined, false)).toBe(false);
    expect(parseMessagingAiEnabledFlag(undefined, true)).toBe(true);
    expect(parseMessagingAiEnabledFlag('', false)).toBe(false);
    expect(parseMessagingAiEnabledFlag('   ', false)).toBe(false);
  });

  it('enables only on trim+lowercased true', () => {
    expect(parseMessagingAiEnabledFlag('true')).toBe(true);
    expect(parseMessagingAiEnabledFlag(' True\t')).toBe(true);
    expect(parseMessagingAiEnabledFlag('tru')).toBe(false);
    expect(parseMessagingAiEnabledFlag('true1')).toBe(false);
  });

  it('messagingAiFlagEnabled reads the live process env', () => {
    const name = 'MESSAGING_TEST_FLAG_X';
    delete process.env[name];
    expect(messagingAiFlagEnabled(name)).toBe(false);
    process.env[name] = 'true';
    expect(messagingAiFlagEnabled(name)).toBe(true);
    delete process.env[name];
  });
});
