import { of, throwError } from 'rxjs';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AlertRule } from '../../../database/entities/alert-rule.entity';
import { NotificationChannel } from '../../../database/entities/escalation-policy.entity';
import {
  ALERT_AUTH_NATS_CLIENT,
  RuleRecipientNormalizer,
} from '../rule-recipient-normalizer.service';
import { directPersonTargetsOf } from '../rule-targets';

/**
 * Decision 7 — a sensor rule's people and its external targets.
 */
const TENANT = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';
const PERSON = '44444444-4444-4444-8444-444444444444';
const COLLEAGUE = '55555555-5555-4555-8555-555555555555';

function rule(recipients: string[], channels: string[]): AlertRule {
  return Object.assign(new AlertRule(), { recipients, notificationChannels: channels });
}

describe('directPersonTargetsOf', () => {
  it('takes only user ids, over the push/e-mail channels the rule lists', () => {
    expect(
      directPersonTargetsOf(rule([PERSON, 'ops@example.com', PERSON], ['EMAIL', 'sms'])),
    ).toEqual({ userIds: [PERSON], channels: [NotificationChannel.EMAIL] });
  });

  it('names nobody when the rule lists no user id', () => {
    expect(directPersonTargetsOf(rule(['ops@example.com'], ['email']))).toBeUndefined();
  });
});

describe('RuleRecipientNormalizer', () => {
  async function build(
    send: jest.Mock,
  ): Promise<{ normalizer: RuleRecipientNormalizer; send: jest.Mock }> {
    const moduleRef = await Test.createTestingModule({
      providers: [RuleRecipientNormalizer, { provide: ALERT_AUTH_NATS_CLIENT, useValue: { send } }],
    }).compile();
    return { normalizer: moduleRef.get(RuleRecipientNormalizer), send };
  }

  const replying = (reply: unknown): jest.Mock => jest.fn(() => of(reply));

  it("stores a colleague's e-mail as the colleague's user id; keeps outside addresses", async () => {
    // SCENARIO: the rule names a colleague by e-mail, an outside address and a webhook.
    // EXPECTS: the colleague becomes a user id (paged once, by escalation); the rest stay.
    const { normalizer, send } = await build(
      replying({ success: true, matches: [{ email: 'ayse@farm.test', userId: COLLEAGUE }] }),
    );

    await expect(
      normalizer.normalize(TENANT, [
        'Ayse@Farm.test',
        'ops@partner.test',
        'https://hooks.example.com/x',
        PERSON,
      ]),
    ).resolves.toEqual({
      recipients: [COLLEAGUE, 'ops@partner.test', 'https://hooks.example.com/x', PERSON],
      replaced: 1,
    });
    expect(send).toHaveBeenCalledWith('request.auth.user.resolveTenantUserIdsByEmail', {
      tenantId: TENANT,
      emails: ['ayse@farm.test', 'ops@partner.test'],
    });
  });

  it('asks nobody when there is no e-mail to resolve', async () => {
    const { normalizer, send } = await build(replying({ success: true, matches: [] }));

    await expect(normalizer.normalize(TENANT, [PERSON])).resolves.toEqual({
      recipients: [PERSON],
      replaced: 0,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed when the directory is unreachable or answers outside the contract', async () => {
    const down = await build(jest.fn(() => throwError(() => new Error('no responders'))));
    await expect(down.normalizer.normalize(TENANT, ['a@b.test'])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const { normalizer } = await build(
      replying({ success: true, matches: [{ email: 'a@b.test', userId: 'x' }] }),
    );
    await expect(normalizer.normalize(TENANT, ['a@b.test'])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
