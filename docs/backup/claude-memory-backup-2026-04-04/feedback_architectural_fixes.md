---
name: Architectural fixes only — no patches
description: All bug fixes and review findings must be solved with proper architectural solutions, never quick patches or workarounds
type: feedback
---

When fixing review findings or bugs, ALWAYS implement proper architectural solutions — NEVER apply patches, workarounds, or quick hacks.

**Why:** User explicitly stated "mimari çözüm, yama istemiyoruz" (architectural solution, we don't want patches). The codebase must remain enterprise production-grade with clean, sustainable fixes that address root causes.

**How to apply:**
- If a review finds duplicate Redis clients → create a SharedRedisModule with proper DI, don't just change constructor params
- If WebSocket lacks membership check → design a proper NATS request-reply verification flow, don't add inline DB queries
- If CQRS is bypassed → create proper Command/Handler pairs, don't add inline logic
- If sanitization is inconsistent → extract a shared sanitization utility module, don't copy-paste fixes
- Every fix should make the architecture BETTER, not just silence the finding
- Root cause analysis before every fix — ask "why did this happen?" and fix the systemic issue
