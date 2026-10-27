/**
 * API Configuration — Sensor Module
 *
 * WHY THIS IS A THIN DELEGATE, NOT A SEPARATE CLIENT:
 * Every MFE module MUST use the shared graphqlClient from @aquaculture/shared-ui.
 * The shared client provides: token lifecycle barrier (prevents 401 race on page
 * load), automatic 401 → token refresh → retry, session clear on permanent auth
 * failure, and Module Federation cross-bundle token propagation.
 *
 * Previously, this file had its own raw `fetch()` wrapper that bypassed all of
 * these mechanisms, causing 401 Unauthorized on every page load because requests
 * fired before silentRefresh() restored the token from the httpOnly cookie.
 *
 * The import path `import { graphqlFetch } from '../config/api'` is preserved
 * so existing hooks don't need to change their imports.
 *
 * FE-MEDIUM-380: it is the module's ONLY GraphQL transport. Five hooks and the
 * SCADA batch read kept their own raw fetch copies against the endpoint; besides the
 * barrier and refresh above, those never reported a GRAPHQL_VALIDATION_FAILED
 * to the shell's build-skew check (shared-ui graphql-validation-signal.ts), so
 * a tab running a stale sensor-module build did not reload on it. The endpoint
 * constant and the header builder they used are gone with them;
 * tests/invariants/web-no-raw-graphql-rest-fetch.spec.ts catches a new copy.
 */

import { graphqlClient } from '@aquaculture/shared-ui';

/**
 * GraphQL fetch — delegates to the shared graphqlClient.
 *
 * The shared client handles: lifecycle barrier, 401 retry with token refresh,
 * session clear on permanent failure, and tenant header propagation.
 *
 * @returns The `data` field from the GraphQL response (unwrapped).
 */
export async function graphqlFetch<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  return graphqlClient.request<T>(query, variables);
}
