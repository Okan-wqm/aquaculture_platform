"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("@typescript-eslint/utils");
const createRule = utils_1.ESLintUtils.RuleCreator((name) => `https://github.com/Okan-wqm/aquaculture_platform/blob/main/tools/eslint-rules/rules/${name}.ts`);
/**
 * Files where an outbound HTTP target is operator/tenant-controlled and a bare
 * global fetch is therefore a rebinding hazard: protocol adapters and webhook
 * senders (incl. the notification dispatcher).
 */
const SSRF_SENSITIVE_PATH = /(\/adapters\/|notification-dispatcher\.service\.|webhook)/i;
const TEST_FILE_PATTERNS = [
    /\.spec\.ts$/,
    /\.test\.ts$/,
    /\.e2e\.ts$/,
    /\/__tests__\//,
    /\/__mocks__\//,
];
exports.default = createRule({
    name: 'no-unpinned-ssrf-fetch',
    meta: {
        type: 'problem',
        docs: {
            description: 'Operator/tenant-controlled outbound HTTP must go through SsrfValidatorService.safeFetch (IP-pinned); bare global fetch() re-opens the DNS-rebinding window (SENSOR-CRITICAL-002).',
        },
        schema: [],
        messages: {
            bareFetchInSensitiveZone: 'Bare global fetch() on a non-literal URL in an SSRF-sensitive file re-opens the DNS-rebinding window that safeFetch closes. Route operator/tenant-controlled requests through SsrfValidatorService.safeFetch — it validates the host and pins the connection to the validated IP. SENSOR-CRITICAL-002.',
            removedGetSafeFetchOptions: 'getSafeFetchOptions() was removed — it only set redirect:"error" and did NOT pin the resolved IP. Use SsrfValidatorService.safeFetch, which validates the host and pins the connection to the validated IP. SENSOR-CRITICAL-002.',
        },
    },
    defaultOptions: [],
    create(context) {
        const filename = context.getFilename();
        const isTestFile = TEST_FILE_PATTERNS.some((re) => re.test(filename));
        const inSensitiveZone = SSRF_SENSITIVE_PATH.test(filename) && !isTestFile;
        return {
            MemberExpression(node) {
                if (node.property.type === 'Identifier' && node.property.name === 'getSafeFetchOptions') {
                    context.report({ node, messageId: 'removedGetSafeFetchOptions' });
                }
            },
            CallExpression(node) {
                if (!inSensitiveZone)
                    return;
                // Only the GLOBAL fetch — `x.fetch(...)` (HTTP-pool helper etc.) is a
                // MemberExpression callee and is intentionally not matched.
                if (node.callee.type !== 'Identifier' || node.callee.name !== 'fetch')
                    return;
                const [urlArg] = node.arguments;
                // A fixed string literal is a hardcoded internal endpoint — allowed.
                if (urlArg !== undefined && urlArg.type === 'Literal' && typeof urlArg.value === 'string') {
                    return;
                }
                context.report({ node, messageId: 'bareFetchInSensitiveZone' });
            },
        };
    },
});
//# sourceMappingURL=no-unpinned-ssrf-fetch.js.map