/**
 * ValidatedPayload<T> — compile-time proof that a Mattilsynet payload passed
 * official-schema validation.
 *
 * The brand symbol is declared but never exported as a value, so the only way
 * to produce a ValidatedPayload is the single assertion inside
 * MattilsynetSchemaValidatorService.validate(). Every
 * MattilsynetApiService.submit*Report signature requires ValidatedPayload<T>,
 * which structurally rejects any code path that skips validation — a tier-1
 * "make it impossible" gate at the network boundary. The type-assertion
 * escape hatches that could forge the brand are banned repo-wide by the
 * banned-construct gate, so the guarantee holds in practice.
 */
import type { MattilsynetBasePayload } from '../mattilsynet-api.service';

declare const officialSchemaValidated: unique symbol;

export type ValidatedPayload<T extends MattilsynetBasePayload> = T & {
  readonly [officialSchemaValidated]: true;
};
