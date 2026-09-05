/**
 * @aquaculture/eslint-rules — custom lint rules
 *
 * Entry point exports a `rules` object consumed by ESLint when this
 * package is loaded via the `plugins: ["aquaculture"]` directive in
 * the root `.eslintrc.json`.
 *
 * Each rule encodes a specific architectural invariant from CLAUDE.md
 * or a canonical ADR. Rules start at `severity: "warn"` for 30 days
 * per the progressive-rollout protocol (plan v4 D.5) and promote to
 * `error` only after the calibration window confirms low false-positive
 * rate.
 *
 * See `/root/.claude/plans/declarative-riding-shamir.md` BLOCKER-20.
 */

import noActorInInputDto from './rules/no-actor-in-input-dto';
import noBareGraphqlQueryString from './rules/no-bare-graphql-query-string';
import noBareTenantQueryKey from './rules/no-bare-tenant-query-key';
import noClaudeSdkRawCall from './rules/no-claude-sdk-raw-call';
import noDirectEventPublish from './rules/no-direct-event-publish';
import noHighCardinalityMetricLabel from './rules/no-high-cardinality-metric-label';
import noUnpinnedSsrfFetch from './rules/no-unpinned-ssrf-fetch';
import noUnsandboxedHtmlFrame from './rules/no-unsandboxed-html-frame';
import noUnverifiedTenantParam from './rules/no-unverified-tenant-param';
import requireEntitySchema from './rules/require-entity-schema';

export const rules = {
  'require-entity-schema': requireEntitySchema,
  'no-bare-tenant-query-key': noBareTenantQueryKey,
  'no-direct-event-publish': noDirectEventPublish,
  'no-high-cardinality-metric-label': noHighCardinalityMetricLabel,
  'no-claude-sdk-raw-call': noClaudeSdkRawCall,
  'no-bare-graphql-query-string': noBareGraphqlQueryString,
  'no-unpinned-ssrf-fetch': noUnpinnedSsrfFetch,
  'no-unsandboxed-html-frame': noUnsandboxedHtmlFrame,
  'no-actor-in-input-dto': noActorInInputDto,
  'no-unverified-tenant-param': noUnverifiedTenantParam,
};
