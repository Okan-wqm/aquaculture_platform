import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';

import { SendMessageInput } from '../send-message.input';
import { EditMessageInput } from '../edit-message.input';
import { MarkReadInput } from '../mark-read.input';

/**
 * Mobile-command envelope parity invariant (MSG-CRITICAL-054 / MSG-HIGH-058 / MSG-HIGH-059).
 *
 * The AquaMobil offline queue injects the command envelope (clientCommandId,
 * clientCreatedAt, deviceId, operationType, payloadHash, schemaVersion) into the
 * payload of EVERY queued operation, then replays messaging mutations as
 * `{ input: <payload-with-envelope> }`. The gateway ValidationPipe runs
 * `forbidNonWhitelisted: true`, so any messaging mutation whose GraphQL `input`
 * type does NOT model the envelope rejects the replayed command with a 400 and
 * the offline write is permanently lost behind a false "Queued" badge.
 *
 * This is the exact defect class that lost offline sends (MSG-CRITICAL-054),
 * offline mark-reads (MSG-HIGH-058) and offline edits (MSG-HIGH-059). The
 * architectural cure is uniform: every messaging mutation whose input the offline
 * queue wraps as `{ input }` MUST extend MobileCommandEnvelopeInput. This test is
 * the tier-1 guard — a new enveloped-input messaging mutation that forgets to
 * extend the envelope fails here before it can silently eat offline writes.
 *
 * deleteMessage is intentionally NOT in this list: it takes a top-level `id: ID!`
 * argument (no `input` object), so the injected envelope rides as ignored
 * top-level variables and never reaches a typed input — it does not need the
 * envelope and must not be forced to model it.
 */
describe('mobile-command envelope parity — enveloped messaging inputs', () => {
  const ENVELOPED_INPUTS: ReadonlyArray<{ name: string; ctor: new () => object }> = [
    { name: 'SendMessageInput', ctor: SendMessageInput },
    { name: 'EditMessageInput', ctor: EditMessageInput },
    { name: 'MarkReadInput', ctor: MarkReadInput },
  ];

  it.each(ENVELOPED_INPUTS)(
    '$name extends MobileCommandEnvelopeInput so the offline-injected envelope is accepted',
    ({ ctor }) => {
      expect(new ctor()).toBeInstanceOf(MobileCommandEnvelopeInput);
    },
  );

  it.each(ENVELOPED_INPUTS)(
    '$name inherits every envelope field name (schema whitelists the injected payload)',
    ({ ctor }) => {
      // A fresh MobileCommandEnvelopeInput enumerates no own keys (all optional),
      // so we assert the prototype chain instead: the input's chain must include
      // MobileCommandEnvelopeInput.prototype. This catches a subclass that
      // re-declares the fields locally without actually extending the base.
      let proto: unknown = Object.getPrototypeOf(ctor.prototype);
      let found = false;
      while (proto) {
        if (proto === MobileCommandEnvelopeInput.prototype) {
          found = true;
          break;
        }
        proto = Object.getPrototypeOf(proto);
      }
      expect(found).toBe(true);
    },
  );
});
