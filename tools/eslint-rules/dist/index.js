'use strict';
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
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.rules = void 0;
const no_actor_in_input_dto_1 = __importDefault(require('./rules/no-actor-in-input-dto'));
const no_bare_graphql_query_string_1 = __importDefault(
  require('./rules/no-bare-graphql-query-string'),
);
const no_bare_tenant_query_key_1 = __importDefault(require('./rules/no-bare-tenant-query-key'));
const no_claude_sdk_raw_call_1 = __importDefault(require('./rules/no-claude-sdk-raw-call'));
const no_direct_event_publish_1 = __importDefault(require('./rules/no-direct-event-publish'));
const no_high_cardinality_metric_label_1 = __importDefault(
  require('./rules/no-high-cardinality-metric-label'),
);
const no_unpinned_ssrf_fetch_1 = __importDefault(require('./rules/no-unpinned-ssrf-fetch'));
const no_unsandboxed_html_frame_1 = __importDefault(require('./rules/no-unsandboxed-html-frame'));
const no_unverified_tenant_param_1 = __importDefault(require('./rules/no-unverified-tenant-param'));
const require_entity_schema_1 = __importDefault(require('./rules/require-entity-schema'));
exports.rules = {
  'require-entity-schema': require_entity_schema_1.default,
  'no-bare-tenant-query-key': no_bare_tenant_query_key_1.default,
  'no-direct-event-publish': no_direct_event_publish_1.default,
  'no-high-cardinality-metric-label': no_high_cardinality_metric_label_1.default,
  'no-claude-sdk-raw-call': no_claude_sdk_raw_call_1.default,
  'no-bare-graphql-query-string': no_bare_graphql_query_string_1.default,
  'no-unpinned-ssrf-fetch': no_unpinned_ssrf_fetch_1.default,
  'no-unsandboxed-html-frame': no_unsandboxed_html_frame_1.default,
  'no-actor-in-input-dto': no_actor_in_input_dto_1.default,
  'no-unverified-tenant-param': no_unverified_tenant_param_1.default,
};
//# sourceMappingURL=index.js.map
