import { SetMetadata } from '@nestjs/common';

export const SKIP_RESPONSE_ENVELOPE_KEY = 'admin:skip-response-envelope';

/** Preserve a cryptographically signed response byte shape without wrapping it. */
export const SkipResponseEnvelope = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_RESPONSE_ENVELOPE_KEY, true);
