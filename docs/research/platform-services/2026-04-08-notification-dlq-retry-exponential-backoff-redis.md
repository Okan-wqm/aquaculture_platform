# Research: Notification DLQ, Retry, Exponential Backoff, Redis Rate Limiting & PII Masking

**Topic:** Multi-channel notification dispatch reliability — retry with exponential backoff, dead letter queue semantics, tenant rate limiting via Redis token bucket with in-memory fallback, deduplication, concurrency limiter, and PII masking in logs
**Date:** 2026-04-08
**Agent:** platform-services

## Sources
- [Martin Fowler / Hohpe - Enterprise Integration Patterns: Dead Letter Channel](https://www.enterpriseintegrationpatterns.com/patterns/messaging/DeadLetterChannel.html)
- [Martin Fowler / Hohpe - EIP: Invalid Message Channel](https://www.enterpriseintegrationpatterns.com/patterns/messaging/InvalidMessageChannel.html)
- [NATS Docs - JetStream Consumers (AckWait, BackOff, MaxDeliver, DLQ advisories)](https://docs.nats.io/nats-concepts/jetstream/consumers)
- [NATS Docs - Consumer Details](https://docs.nats.io/using-nats/developer/develop_jetstream/consumers)
- [AWS SQS - Using dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [AWS SNS - Dead-letter queues](https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html)
- [AWS Architecture Blog - Designing durable serverless apps with DLQs](https://aws.amazon.com/blogs/compute/designing-durable-serverless-apps-with-dlqs-for-amazon-sns-amazon-sqs-aws-lambda/)
- [Twilio - API best practices (rate limits, retries)](https://www.twilio.com/docs/usage/rest-api-best-practices)
- [Twilio - Best practices for managing retry logic with SMS 2FA](https://www.twilio.com/en-us/blog/best-practices-retry-logic-sms-2fa)
- [Twilio - Understanding Rate Limits and Message Queues](https://help.twilio.com/articles/115002943027)
- [Firebase - Best practices when sending FCM messages at scale](https://firebase.google.com/docs/cloud-messaging/scale-fcm)
- [Firebase - FCM Throttling and Quotas](https://firebase.google.com/docs/cloud-messaging/throttling-and-quotas)
- [Firebase - Your server environment and FCM](https://firebase.google.com/docs/cloud-messaging/server-environment)
- [Redis - How to Build 5 Rate Limiters](https://redis.io/tutorials/howtos/ratelimiting/)
- [OWASP - Logging Cheat Sheet (PII handling)](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

## Key Findings

1. **Dead Letter Channel vs Invalid Message Channel (Hohpe / Fowler).** Two distinct patterns often conflated:
   - **Invalid Message Channel:** the receiver received the message but cannot *interpret* it (bad schema, missing required field, unknown type). The message is routed to a review queue for developer inspection.
   - **Dead Letter Channel:** the message is well-formed but could not be *delivered* after the configured retry budget (transient failure repeatedly). The message is parked for replay after the underlying cause is fixed.
   A notification-service should have *both*: an `invalid_notification_events` table for parse/validation failures, and a `notification_dlq` table for delivery failures. Conflating them loses root-cause visibility.
2. **Retry budget: 3 attempts is the industry standard for user-facing notifications.** Twilio, Firebase, and most transactional email providers recommend 3 retries with exponential backoff. Beyond 3, the message is stale (users expect near-real-time delivery) and further retries create a tsunami of duplicates when the downstream recovers. For `aqua-saas`, a 3-retry budget with backoff `1s, 4s, 16s` (total wait ~21s) balances reliability vs staleness.
3. **Exponential backoff with jitter is mandatory.** Per Firebase scale guide and AWS docs: "implement exponential back-off with jittering for retrying requests" — without jitter, thousands of retries synchronize to the same moment and amplify the downstream outage (retry amplification / thundering herd). Full jitter: `sleep = random_between(0, base * 2^attempt)`. Decorrelated jitter: `sleep = min(cap, random_between(base, prev_sleep * 3))`.
4. **Retry-After header respect.** When a downstream returns `429 Too Many Requests` or `503 Service Unavailable` with a `Retry-After: N` header, the dispatcher MUST respect N — not blindly apply its own backoff curve. Firebase: "429 error responses with retry-after headers may be returned to indicate that you should wait a given time period before retrying the request." Twilio: same.
5. **NATS JetStream delivers at-least-once with BackOff list.** Per docs: "You can control the timing of re-deliveries using either the single AckWait duration attribute of the consumer, or as a sequence of durations in the BackOff attribute (which overrides AckWait). This BackOff attribute allows you to implement exponential backoff strategies." A consumer with `MaxDeliver: 3` and `BackOff: [1s, 4s, 16s]` implements exactly our policy. On exceeding MaxDeliver, JetStream publishes a `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.<STREAM>.<CONSUMER>` advisory — a DLQ handler subscribes to this advisory and moves the underlying message to the DLQ table.
6. **DLQ full-payload preservation.** When a notification event moves to the DLQ, the full original event payload (sanitized of PII or with PII encrypted) plus context (last error, channel, attempts, first-seen-at, last-attempt-at, tenant-id) must be preserved. Operators replay DLQ entries after fixing the root cause; a DLQ that stored only "error: timeout" is useless.
7. **Multi-channel dispatch fan-out.** A single `AlertTriggered` domain event can result in email + SMS + push + webhook + in-app for the same alert. Each channel is an independent delivery attempt with its own retry budget and rate limit bucket. Failure of one channel (SMS to Twilio) must not block the others (email to SMTP). Fan-out is implemented as N parallel Promise chains with a top-level `Promise.allSettled` — never `Promise.all` (which short-circuits).
8. **Deduplication by `{channel, recipient, alertId}`.** A user with two active subscriptions to the same alert must receive one notification per channel, not two. A Redis `SET` with TTL = 5 minutes keyed on a canonical dedupe key suppresses the duplicate. The dedupe must happen *before* the rate-limiter check (to avoid burning rate-limit capacity on duplicates).
9. **Rate limiting: token bucket per tenant.** Per Redis docs and common practice: token bucket allows controlled bursts (up to bucket size) while enforcing a steady refill rate. For aqua-saas `100 notifications/min/tenant`: bucket size 100, refill 100 per 60s (≈ 1.67/s). Implemented atomically via a Lua script to avoid race conditions:
   ```lua
   local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or ARGV[1])
   local last = tonumber(redis.call('HGET', KEYS[1], 'last') or 0)
   local now = tonumber(ARGV[3])
   local refill = (now - last) * ARGV[2]
   tokens = math.min(ARGV[1], tokens + refill)
   if tokens < 1 then return 0 end
   tokens = tokens - 1
   redis.call('HSET', KEYS[1], 'tokens', tokens, 'last', now)
   redis.call('EXPIRE', KEYS[1], 120)
   return 1
   ```
10. **Redis in-memory fallback.** When Redis is unreachable, the rate limiter must not fail-open (unlimited traffic) or fail-closed (block everything). The correct behavior is **fail to a local in-memory bucket** — each replica enforces its own local quota, at the cost of weaker global coordination. On Redis recovery, the local state is discarded and global buckets resume. This is a graceful degradation pattern; it must be explicit and logged.
11. **Concurrency limiter (MAX_CONCURRENCY=10).** Separate from rate limiting. Concurrency = simultaneous in-flight requests; rate = requests per second. A dispatcher that fires 1000 emails/sec at Twilio without bounding concurrency exhausts the Node HTTP agent's socket pool and causes head-of-line blocking on TCP connect. A semaphore of 10 limits concurrent dispatches per channel-provider. The `p-limit` library or a custom async semaphore.
12. **Per-provider quota awareness.**
    - **Firebase FCM:** 600k messages/min/project HTTP v1 quota. 429 on exceed with retry-after. Internal RPC timeout 10s — set client timeout ≥ 10s. Cap total retry age at 60 minutes ("if a request is continually retried with exponential backoff and is still failing 60 minutes later, it is either miscategorized as a retryable error, or FCM is experiencing an outage where retries may be inadvertently exacerbating the situation").
    - **Twilio SMS:** 1 message/sec/long-code by default (US/CA). Throughput scales with phone-number type (toll-free, short code). On 429: back off; on 5xx: retry with exponential backoff. Rate-limit enforcement is per-account — sharing one account across tenants means one tenant can starve another.
    - **SMTP:** varies by provider. SendGrid / Postmark / AWS SES have per-account per-hour caps and deliverability reputation damage on spike.
13. **PII masking in logs.** Per OWASP Logging Cheat Sheet: "do not log sensitive data such as session identifiers, passwords, credit card numbers, social security numbers." For notifications, masking rules:
    - Email: `j***@example.com` (first char + domain) or hash
    - Phone: `+1***5678` (country + last 4) or hash
    - Push tokens: first 8 chars of hash + `...`
    - Webhook URL: host + path-stub, query-string redacted
    - Message body: log length and hash, not contents
    - Recipient name: `First L.` or hash
    Structured JSON logging with a central redactor — not per-log-line `.replace()` — ensures consistency. Pino + `pino-redact` or custom Logger wrapper.

## Security Concerns

- **CRITICAL:** Rate limiter fail-open on Redis unreachable → a single tenant can send 100k SMS in one minute, burning the Twilio budget and triggering tenant-billing attacks.
- **CRITICAL:** No dedupe → duplicate SMS on retry, duplicate SMS billing, user complaints.
- **CRITICAL:** Full message body (containing 2FA code, password reset link, personal notification) logged at INFO level → credential theft via log exfiltration.
- **CRITICAL:** DLQ accessible via GraphQL or REST without strict RBAC → operators can read all failed notifications (with PII) across tenants.
- **HIGH:** `Promise.all` instead of `Promise.allSettled` for multi-channel fan-out → first channel failure cancels in-flight dispatches for other channels, incomplete notification delivery.
- **HIGH:** Missing `Retry-After` respect → thundering herd on provider recovery, repeated 429s, back-to-back outages.
- **HIGH:** No jitter in exponential backoff → synchronized retry tsunami amplifies downstream outage.
- **HIGH:** No max-retry-age cap → FCM request retried every 16s for 24h, generating O(5000) calls and possibly spamming the user once the account recovers.
- **HIGH:** Sharing one Twilio/Firebase account across tenants → noisy-neighbor rate limit starvation.
- **MEDIUM:** PII log masking implemented per-log-site rather than centralized → new log lines regularly leak PII.
- **MEDIUM:** DLQ entries contain plaintext payloads with PII → DLQ becomes a PII honeypot.
- **MEDIUM:** Retry budget counted per-attempt rather than per-event → a bug in the retry path can infinite-loop.

## Performance Concerns

- Redis Lua rate-limit script: ~0.5ms per call on co-located Redis. At 1000 RPS per replica, that's 0.5s/s CPU on Redis — fine. At 10k RPS, consider connection pooling and Redis cluster sharding by tenant ID.
- NATS JetStream at-least-once with MaxDeliver=3 and BackOff list adds ~21s worst-case end-to-end latency for repeatedly-failing messages. Alert on `delivered_count >= 2` for p99 visibility.
- Concurrency limiter of 10 per provider caps throughput at (10 / avg_request_time) msgs/sec per replica. For 500ms avg Twilio latency → 20 msgs/sec per replica. Scale horizontally by adding replicas (shared Redis rate limiter ensures global cap).
- PII redaction via pino-redact is ~2x faster than manual regex substitution. Use the structured logger's built-in redact path.
- DLQ table grows monotonically; partition by month and retain 30 days for non-PII metadata, longer for investigation-relevant entries.

## Architectural Implications for platform-services reviews

- `apps/notification-service/src/notification/services/` must contain:
  - `NotificationDispatcher` — top-level fan-out, `Promise.allSettled` across channels, writes outcome to `NotificationAttempt` table
  - `ChannelEmailService`, `ChannelSmsService`, `ChannelPushService`, `ChannelWebhookService`, `ChannelInAppService` — each with its own retry, rate limiter, concurrency semaphore, provider client
  - `RateLimiterService` — Redis token bucket via Lua, in-memory fallback on Redis failure
  - `DeduplicationService` — Redis `SETNX` with TTL 5min, in-memory fallback
  - `RetryScheduler` — exponential backoff with jitter, respects `Retry-After`, caps at 60min total age
  - `DeadLetterQueue` — writes failed events + full context, exposed only to admin RBAC
  - `InvalidMessageChannel` — writes parse/validation failures, separate from delivery DLQ
  - `PiiRedactorLogger` wrapper — centralized masking before emit
- NATS JetStream consumer configuration (code review point): `MaxDeliver: 3`, `BackOff: [1s, 4s, 16s]`, `AckWait: 30s`. Missing BackOff = no exponential retry = all retries happen immediately.
- A single `DispatchEnvelope` type carries the event + dedupe key + first-seen-at + attempt count + correlation ID. Each channel handler receives the same envelope; they do not mutate each other's state.
- Deduplication key format: `dedupe:{tenantId}:{channel}:{canonicalRecipient}:{eventKey}` where `eventKey = alertId` or similar domain-stable ID.
- Rate limit key format: `ratelimit:{tenantId}:notifications` (global) and `ratelimit:{tenantId}:sms` (per-channel sub-limit) — two separate buckets.
- Twilio/Firebase clients initialized with per-tenant credentials via config-service (see config-service research). A single shared account is allowed only for dev/staging.
- Integration tests: (a) 3-retry + DLQ path with deterministic backoff, (b) Redis down → in-memory fallback activates and logs WARN, (c) `Retry-After: 30` respected, (d) dedupe suppresses second identical send, (e) `Promise.allSettled` — SMS provider down doesn't block email, (f) PII redactor masks email/phone/push-token/webhook-url in logs, (g) DLQ entry carries full context for replay.

## Domain Rule Additions for platform-services (Notification Delivery subsection)

- **[CRITICAL]** Retry policy: exactly 3 retries max, exponential backoff with **jitter** (full or decorrelated). Backoff without jitter is a blocking review failure (thundering herd).
- **[CRITICAL]** Total retry age MUST be capped (e.g., 30 minutes). After cap, message moves to DLQ regardless of attempts remaining.
- **[CRITICAL]** `Retry-After` header from downstream providers MUST be respected. Blindly applying the local backoff curve on top of a provider 429 is a blocking review failure.
- **[CRITICAL]** Rate limiter MUST NOT fail-open on Redis unavailability. Fail to a local in-memory bucket with WARN log. Fail-open is a blocking review failure.
- **[CRITICAL]** Deduplication MUST run *before* rate-limit check. Dedupe key = `{tenantId}:{channel}:{recipientCanonical}:{eventKey}`. TTL 5-15 minutes.
- **[CRITICAL]** Multi-channel fan-out MUST use `Promise.allSettled` — never `Promise.all`. One channel failure cannot cancel others.
- **[CRITICAL]** PII (email, phone, push token, webhook URL, message body) in logs MUST be masked via a centralized `PiiRedactorLogger` or pino-redact. Ad-hoc `.replace()` at log sites is a blocking review failure.
- **[CRITICAL]** DLQ access MUST be gated by `NOTIFICATION_DLQ_READ` RBAC. Unrestricted DLQ query endpoints are a blocking review failure.
- **[HIGH]** NATS consumer MUST declare explicit `MaxDeliver` and `BackOff` list. Default `AckWait` behavior (immediate retries) is a HIGH finding.
- **[HIGH]** Concurrency limiter (semaphore, e.g., 10) MUST bound in-flight dispatches per channel-provider to protect the Node HTTP agent socket pool.
- **[HIGH]** DLQ entries MUST preserve the full dispatch envelope (event payload with PII encrypted or hashed, error category, attempt history, first-seen, correlation ID) for replay.
- **[HIGH]** Invalid-message channel MUST be distinct from delivery DLQ. Parse/validation failures and delivery failures have different remediation paths.
- **[MEDIUM]** Rate limit keys MUST be per-tenant AND per-channel where applicable (SMS more expensive than email). Global buckets mask noisy tenants.
- **[MEDIUM]** Provider-specific quota awareness MUST be documented per channel: FCM 600k/min, Twilio 1/sec per long-code, etc. Alerts fire at 80% of known quota.
- **[MEDIUM]** DLQ retention >= 30 days for metadata; PII-containing payloads encrypted at rest.

Research: `docs/research/platform-services/2026-04-08-notification-dlq-retry-exponential-backoff-redis.md`
