# Package 06: pii-log-masking-central

## Metadata
Status: DONE (commit TBD)
Estimated Tokens: 6K
Priority: HIGH (upgraded from MEDIUM in merged plan)
Security-Sensitive: yes
Parallelizable: yes (tier 0)
Prerequisites: none
Closing-Findings: [HIGH-005]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md (2026-04-14 gap scan #9)

## Context
`StructuredLoggerService.maskSensitive()` redacts values whose KEY name matches a sensitive pattern (password, token, secret, etc.). It does not redact PII embedded in free-form strings — e.g. `logger.log({ details: "login failed for alice@example.com from 10.1.2.3" })` leaked the email and IP. `pii-mask.util.ts` had `maskEmail` and `logSafeUserId` but no value-pattern masker.

Architectural fix: add `maskPii()` that recognises email / phone / credit-card / SSN / IPv4 patterns in any string value, and wire it into the logger's deep-masking walk so every log line is value-scanned.

## Findings
**HIGH-005** (2026-04-14 gap scan #9): No central PII masker; audit logs capture emails/IDs verbatim.

## Affected Files
- /var/aqua-saas/libs/backend-common/src/utils/pii-mask.util.ts (add maskPhone, maskPii, maskPiiDeep + value patterns)
- /var/aqua-saas/libs/backend-common/src/logging/structured-logger.service.ts (wire maskPii into maskSensitive walk)
- /var/aqua-saas/libs/backend-common/src/index.ts (export new helpers)

## Atomic Commit Plan

```
security(logging): add value-pattern PII masker, wire into structured logger

Two-layer redaction is now the default for every service that uses
StructuredLoggerService (the platform default via createServiceApp):

  1. KEY-based (unchanged): values whose key matches SENSITIVE_KEYS
     are fully replaced with [REDACTED].
  2. VALUE-based (new): every surviving string leaf passes through
     maskPii() which replaces email / phone / credit-card / SSN /
     IPv4 patterns regardless of the key name.

Closes the gap where PII was embedded in free-form message strings
("login failed for alice@example.com from 10.1.2.3") and bypassed the
key-based masker.

New helpers in pii-mask.util.ts:
- maskPhone(phone): preserves country code + last two digits.
- maskPii(str): applies all value patterns (CC, SSN, email, phone, IP).
- maskPiiDeep(obj): recursive walk applying maskPii to every string leaf.

Regexes are calibrated to err on the side of over-redaction — for a log
scrubber, a false positive (masking a non-PII string) is harmless; a
false negative (leaking PII) is a GDPR breach. Credit-card match is not
Luhn-validated for the same reason.

Closes: docs/security/2026-04-12-hardening-gap-report.md#HIGH-005
```

## Test Plan
- Scoped tsc clean on the two files
- Unit test harness would assert: `maskPii("login from alice@ex.com")` returns "login from [EMAIL-REDACTED]"

## Verification Command
scoped tsc

## Rollback Plan
`git revert {commit_hash} --no-edit`

## Failure Notes
_(empty)_
