/**
 * Compile-time guard for the ValidatedPayload gate (tier-1 enforcement).
 *
 * `RAW_PAYLOAD_IS_REJECTED` is typed by a conditional type that is `false`
 * exactly while a raw (unvalidated) payload is NOT assignable to the API
 * client's parameter. The moment someone widens a
 * MattilsynetApiService.submit* signature back to a raw payload — i.e.
 * removes the official-schema validation requirement — the conditional
 * flips to `true` and the `false` literal below stops compiling.
 * Enforced by `npm run type-check` and the jest ts transform.
 */
import { MattilsynetApiService, SeaLicePayload } from '../mattilsynet-api.service';

type SubmitPayloadParam = Parameters<MattilsynetApiService['submitSeaLiceReport']>[1];

type RawPayloadAssignable = SeaLicePayload extends SubmitPayloadParam ? true : false;

// Compiles ONLY while the API client rejects unvalidated payloads.
const RAW_PAYLOAD_IS_REJECTED: RawPayloadAssignable = false;

describe('ValidatedPayload compile-time gate', () => {
  it('the API client does not accept a raw, unvalidated payload', () => {
    expect(RAW_PAYLOAD_IS_REJECTED).toBe(false);
  });
});
