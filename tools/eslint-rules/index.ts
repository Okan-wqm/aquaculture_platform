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

import noBareTenantQueryKey from './rules/no-bare-tenant-query-key';
import noDirectEventPublish from './rules/no-direct-event-publish';
import noHighCardinalityMetricLabel from './rules/no-high-cardinality-metric-label';
import requireEntitySchema from './rules/require-entity-schema';

export const rules = {
  'require-entity-schema': requireEntitySchema,
  'no-bare-tenant-query-key': noBareTenantQueryKey,
  'no-direct-event-publish': noDirectEventPublish,
  'no-high-cardinality-metric-label': noHighCardinalityMetricLabel,
};
