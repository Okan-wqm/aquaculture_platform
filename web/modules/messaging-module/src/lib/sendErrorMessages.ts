/**
 * Send-failure → i18n key mapping for the ChatRoom error banner.
 *
 * FAZ 0's lib/graphqlErrors.ts owns the error-CODE contract readers; this file
 * owns the (small, testable) decision of WHICH user-facing message each code
 * maps to. Keyed by code, never by message-string sniffing (locale- and
 * phrasing-fragile). Transport failures with no GraphQL code (network drop)
 * fall through to the generic send-failed banner.
 */
import type { MessageKey } from '@aquaculture/shared-ui';

import { isForbidden, isNotFound, isRateLimited, isUnauthenticated } from './graphqlErrors';

/** The banner copy for a failed sendMessage, chosen by the contractual code. */
export function sendErrorBannerKey(error: unknown): MessageKey {
  if (isRateLimited(error)) return 'messaging.error.rateLimited';
  if (isForbidden(error)) return 'messaging.error.forbidden';
  if (isNotFound(error)) return 'messaging.error.notFound';
  if (isUnauthenticated(error)) return 'messaging.error.unauthenticated';
  return 'messaging.error.sendFailed';
}
