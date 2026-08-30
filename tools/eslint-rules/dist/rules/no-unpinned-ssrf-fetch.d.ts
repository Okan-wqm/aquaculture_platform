/**
 * no-unpinned-ssrf-fetch — enforces the IP-pinned outbound-HTTP contract for
 * operator/tenant-controlled URLs (SENSOR-CRITICAL-002 residual).
 *
 * `SsrfValidatorService.validateHost/validateUrl` resolves + validates a host,
 * but a plain `fetch(hostname)` afterwards lets Node RE-resolve DNS at connect
 * time, so the validated IP and the connected IP can diverge (DNS-rebinding
 * TOCTOU). The single correct path is `SsrfValidatorService.safeFetch`, which
 * validates the host AND pins the socket to the validated IP.
 *
 * Rule mechanics:
 *   (a) ANY use of the removed `getSafeFetchOptions()` member — it only set
 *       `redirect:'error'` and never pinned the IP; its presence means an
 *       unpinned fetch is being assembled. Flagged everywhere.
 *   (b) A bare global `fetch(<non-literal-URL>)` CallExpression inside an
 *       SSRF-sensitive file (protocol adapters, the notification webhook
 *       dispatcher, webhook senders). A fixed string-literal URL is a
 *       hardcoded internal endpoint and is allowed; a dynamic URL
 *       (identifier / member / template / concat) is operator-controlled and
 *       must be pinned. `x.fetch(...)` (a method call such as an HTTP-pool
 *       helper) is NOT matched — only the global `fetch`.
 *
 * Exemptions: test files (mocks stub fetch to assert call shape).
 *
 * Refs:
 *  - libs/backend-common/src/ai-safety/ssrf-validator.service.ts (safeFetch)
 *  - docs/reviews/2026-07-05-sensor-vfd-device-audit.md (SENSOR-CRITICAL-002)
 */
import { ESLintUtils } from '@typescript-eslint/utils';
type MessageIds = 'bareFetchInSensitiveZone' | 'removedGetSafeFetchOptions';
declare const _default: ESLintUtils.RuleModule<MessageIds, [], unknown, ESLintUtils.RuleListener> & {
    name: string;
};
export default _default;
//# sourceMappingURL=no-unpinned-ssrf-fetch.d.ts.map