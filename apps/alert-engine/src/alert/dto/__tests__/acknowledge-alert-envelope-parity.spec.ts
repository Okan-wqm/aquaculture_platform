import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';

import { AcknowledgeAlertInput } from '../create-alert-rule.dto';

/**
 * Mobile-command envelope parity — AcknowledgeAlertInput (MOB-HIGH-006).
 *
 * AquaMobil queues alert acknowledgements offline ('acknowledgeAlert' in the
 * mobile operation registry) and replays them as `{ input: <payload-with-
 * envelope> }`. The gateway ValidationPipe runs `forbidNonWhitelisted: true`,
 * so if this input does not model the injected envelope fields
 * (clientCommandId, clientCreatedAt, deviceId, operationType, payloadHash,
 * schemaVersion) the replayed acknowledgement is rejected with a 400 and the
 * field worker's ack is permanently lost behind a false "Queued" badge — the
 * exact defect class MSG-CRITICAL-054 documented for messaging. Extending
 * MobileCommandEnvelopeInput is the uniform tier-1 cure; this spec is the
 * guard. (The ack itself is naturally idempotent — re-applying it converges —
 * so the envelope is acceptance-only here, no receipt ledger required.)
 */
describe('AcknowledgeAlertInput mobile-command envelope parity (MOB-HIGH-006)', () => {
  it('extends MobileCommandEnvelopeInput so the offline-injected envelope is accepted', () => {
    expect(new AcknowledgeAlertInput()).toBeInstanceOf(MobileCommandEnvelopeInput);
  });
});
