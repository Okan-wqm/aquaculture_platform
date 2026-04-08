# Research: Webhook SSRF Prevention — Blocked Hosts, CIDR Taxonomy, DNS Rebinding, URL Encryption

**Topic:** Building a defense-in-depth SSRF allowlist/denylist for outbound webhook dispatch, handling IPv4/IPv6 edge cases, DNS rebinding (TOCTOU) mitigation, and AES-GCM encryption of stored webhook URLs
**Date:** 2026-04-08
**Agent:** platform-services

## Sources
- [OWASP - Server Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP Top 10 2021 - A10 Server-Side Request Forgery](https://owasp.org/Top10/2021/A10_2021-Server-Side_Request_Forgery_(SSRF)/)
- [RFC 1918 - Address Allocation for Private Internets](https://datatracker.ietf.org/doc/html/rfc1918)
- [RFC 6598 - IANA-Reserved IPv4 Prefix for Shared Address Space (CGNAT 100.64.0.0/10)](https://datatracker.ietf.org/doc/html/rfc6598)
- [RFC 4193 - Unique Local IPv6 Unicast Addresses (fc00::/7)](https://datatracker.ietf.org/doc/html/rfc4193)
- [RFC 4291 - IP Version 6 Addressing Architecture (link-local fe80::/10)](https://datatracker.ietf.org/doc/html/rfc4291)
- [RFC 3927 - Dynamic Configuration of IPv4 Link-Local Addresses (169.254.0.0/16)](https://datatracker.ietf.org/doc/html/rfc3927)
- [RFC 5737 - IPv4 Address Blocks Reserved for Documentation (TEST-NET-1/2/3)](https://datatracker.ietf.org/doc/html/rfc5737)
- [AWS - Instance Metadata Service v2 (IMDSv2)](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html)
- [Google Cloud - VM metadata server](https://cloud.google.com/compute/docs/metadata/overview)
- [Azure - Instance Metadata Service](https://learn.microsoft.com/en-us/azure/virtual-machines/instance-metadata-service)
- [NIST SP 800-38D - Galois/Counter Mode (GCM) and GMAC](https://csrc.nist.gov/pubs/sp/800/38/d/final)

## Key Findings

1. **Allowlist > denylist** per OWASP SSRF Cheat Sheet. If the webhook destinations are under the tenant's control (marketing automation, Slack, Zapier), a *domain* allowlist is preferable. For aqua-saas where tenants legitimately configure arbitrary customer endpoints, a strict denylist is the only option — but it must be exhaustive, defense-in-depth, and enforced at both URL parse time *and* TCP dial time.
2. **The minimum IPv4 denylist** for a production webhook dispatcher:
   - `0.0.0.0/8` — "this network" (RFC 1122)
   - `10.0.0.0/8` — private (RFC 1918)
   - `100.64.0.0/10` — CGNAT shared address space (RFC 6598)
   - `127.0.0.0/8` — loopback (RFC 1122)
   - `169.254.0.0/16` — link-local and cloud metadata (`169.254.169.254` is AWS/Azure IMDS, GCP metadata)
   - `172.16.0.0/12` — private (RFC 1918)
   - `192.0.0.0/24` — IETF protocol assignments
   - `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` — TEST-NET documentation (RFC 5737)
   - `192.168.0.0/16` — private (RFC 1918)
   - `198.18.0.0/15` — benchmark testing (RFC 2544)
   - `224.0.0.0/4` — multicast (RFC 5771)
   - `240.0.0.0/4` — future use / reserved
   - `255.255.255.255/32` — limited broadcast
3. **The minimum IPv6 denylist**:
   - `::/128` — unspecified
   - `::1/128` — loopback
   - `::ffff:0:0/96` — IPv4-mapped (attackers wrap an IPv4 internal address as `::ffff:10.0.0.1` to bypass IPv4-only filters)
   - `100::/64` — discard-only address block (RFC 6666)
   - `2001:db8::/32` — documentation (RFC 3849)
   - `fc00::/7` — Unique Local Addresses (RFC 4193)
   - `fe80::/10` — link-local (RFC 4291)
   - `fec0::/10` — deprecated site-local
   - `ff00::/8` — multicast
4. **Cloud metadata endpoints** — high-priority blocks because they yield IAM credentials:
   - `169.254.169.254` — AWS EC2 / Azure / OpenStack / DigitalOcean / Alibaba / Oracle Cloud
   - `metadata.google.internal` (resolves to `169.254.169.254`)
   - `metadata` (unqualified hostname that some DNS configs resolve to metadata)
   - `metadata.azure.com`, `169.254.169.254` for Azure IMDS
   - Per OWASP: migrating to **IMDSv2** is defense-in-depth — it requires a `PUT` with a session token header, so a simple SSRF via `GET` is blocked.
5. **Hostname denylist** (distinct from IP denylist, applied before DNS resolution):
   - `localhost`, `localhost.localdomain`, `ip6-localhost`, `ip6-loopback`
   - `metadata`, `metadata.google.internal`, `metadata.azure.com`
   - Any hostname ending in `.internal`, `.local`, `.lan`, `.intranet`, `.corp`, `.home` (common internal suffixes)
   - Kubernetes service discovery: `*.cluster.local`, `*.svc`, `*.svc.cluster.local`, `kubernetes.default`, `kubernetes.default.svc`
   - Tenant-owned internal hosts of aqua-saas itself: `*.aqua-saas.internal`, any service name registered with NATS / Consul
6. **IP literal encoding bypass techniques to normalize before filtering** — these are the most common bypass vectors seen in HackerOne SSRF reports:
   - **Decimal:** `http://2130706433/` (decimal representation of `127.0.0.1`)
   - **Octal:** `http://0177.0.0.1/` (leading `0` octets parsed as octal by `inet_aton`)
   - **Hex:** `http://0x7f.0.0.1/` or `http://0x7f000001/`
   - **Mixed:** `http://127.1/` (short-form: missing zero octets)
   - **IPv6 brackets:** `http://[::1]/`
   - **IPv6 compressed:** `http://[::ffff:7f00:1]/`
   - **Userinfo trick:** `http://evil.com@127.0.0.1/` (URL parser sees `evil.com` as userinfo, host is `127.0.0.1`)
   - **Fragment trick:** `http://127.0.0.1#@evil.com/`
   - **Unicode normalization:** Cyrillic homograph hostnames
   - **URL decoding twice:** `http://127.0.0.%31/` → `http://127.0.0.1/`
7. **Normalize before filter.** The rule is: parse the URL with a spec-compliant parser (Node's `new URL(input)`, not regex), extract the hostname, Punycode-decode IDN, resolve all numeric IPv4/IPv6 literal forms to their canonical form via `net.isIP` and `ipaddr.js`, then check against the denylist. *Then* resolve DNS, check the resolved IP against the denylist again, and *only then* proceed.
8. **DNS rebinding (TOCTOU) defense.** The canonical SSRF bypass is: (a) attacker controls `rebind.attacker.com`, (b) DNS server returns `203.0.113.50` (public) on first query, (c) validator resolves, checks allowlist/denylist, approves, (d) HTTP client re-resolves at connect time, gets `127.0.0.1` (attacker's second answer with TTL=0), (e) client connects to localhost. **The fix is to pin the IP at validate time and dial the pinned IP** — not the hostname. This means using a custom HTTP agent that overrides `lookup()` to return the pre-validated IP, passing the original hostname only as the `Host:` header for TLS SNI and virtual-host routing. The libraries `ssrf-req-filter` (Node) and `safe-curl` implement this pattern.
9. **Redirect handling is mandatory.** If the webhook target responds `302 Location: http://169.254.169.254/`, a naive HTTP client follows it and bypasses all filters. The client must either (a) disable redirect following entirely (`maxRedirects: 0`), or (b) re-run the full URL validation on every redirect target. Option (a) is simpler and more secure.
10. **TLS requirement.** Webhook URLs must be HTTPS-only in production. Plaintext HTTP webhooks leak the HMAC signature header, the payload body (PII), and are trivially MITM-able. Self-signed certs must be rejected in production (reject `NODE_TLS_REJECT_UNAUTHORIZED=0`).
11. **Port denylist.** Even on a "public" IP, some ports are dangerous: `22` (SSH), `23` (telnet), `25` (SMTP), `110` (POP3), `111` (RPC), `135/139/445` (SMB), `3306` (MySQL), `5432` (Postgres), `6379` (Redis), `9200` (Elasticsearch), `11211` (Memcached), `27017` (MongoDB). Restrict outbound webhook dispatch to `{80, 443, 8080, 8443}` and reject everything else. The attacker-picked `http://internal-db.attacker-controlled.cloud:5432/` is a real attack.
12. **Webhook URL at rest encryption — AES-256-GCM.** Tenant-configured webhook URLs are bearer credentials (the URL path often embeds a tenant-specific secret: `https://hooks.slack.com/services/T0/B0/XXXXXXXXX`). They must be encrypted at rest with AES-256-GCM. Per NIST SP 800-38D:
    - **Key:** 256-bit random key, held in `WEBHOOK_ENCRYPTION_KEY` env var (or secrets manager), REQUIRED in production.
    - **IV:** 96-bit random per encryption. Never reuse an IV with the same key — catastrophic confidentiality loss.
    - **AAD:** the tenant ID, bound into the ciphertext. Prevents an attacker who swaps ciphertexts between tenants.
    - **Auth tag:** 128-bit, verified on decrypt via `decipher.setAuthTag()`. A failed tag = tampering, throw and alert.
    - **Serialization:** `ENC_V1:{base64(iv)}:{base64(tag)}:{base64(ciphertext)}` or single base64 of `iv || tag || ciphertext`. Version prefix enables future algorithm migration.
13. **Rate limiting per destination.** Even a valid webhook can be abused to DoS a third party from the aqua-saas IP range. Per-destination-host rate limit (e.g., 100 RPS per external host) protects tenant reputation and avoids being blocklisted as a botnet source.

## Security Concerns

- **CRITICAL:** Any webhook dispatcher that validates the URL string but dials the hostname is vulnerable to DNS rebinding. The dispatcher must pin the validated IP and dial by IP.
- **CRITICAL:** IPv4-mapped IPv6 (`::ffff:10.0.0.1`) and decimal/octal IPv4 literals must be normalized before filtering. A denylist that matches only dotted-quad IPv4 misses 80% of real SSRF exploits.
- **CRITICAL:** The cloud metadata endpoint `169.254.169.254` yields IAM credentials. A webhook dispatcher that can reach this from an EC2/GKE/AKS pod is full cloud account takeover.
- **CRITICAL:** `WEBHOOK_ENCRYPTION_KEY` stored in plaintext env or committed to Git. Use a secrets manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault) or encrypted config-service value.
- **CRITICAL:** Following HTTP redirects without re-validating the target URL is an instant SSRF bypass. `maxRedirects: 0` is the safe default.
- **HIGH:** Accepting `http://` webhooks in production leaks signature, payload, and is MITM-able. HTTPS-only.
- **HIGH:** Reusing an AES-GCM IV with the same key destroys confidentiality. IV must be per-encryption random 96-bit.
- **HIGH:** Not binding tenant ID as AAD in the AES-GCM envelope means an attacker with DB write access can swap ciphertexts between tenants and exfiltrate to their own webhook.
- **HIGH:** Outbound webhook ports not restricted to 80/443/8080/8443 — attacker targets internal Postgres/Redis ports.
- **MEDIUM:** No per-destination rate limit — tenant reputation risk, DoS amplification.
- **MEDIUM:** No global timeout on webhook dispatch (default Node http timeout is infinity) — slowloris attacks exhaust worker pool.

## Performance Concerns

- DNS resolution on every dispatch adds 20-100ms latency. Cache resolution results for 30-60s, but *revalidate the cached IP against the denylist on every use* (the blocked CIDR set may have changed between resolves).
- Normalizing URL literals (`ipaddr.js`, `URL`, Punycode) is cheap (<1ms). Do it unconditionally.
- A single global HTTP agent with a connection pool bounded by `maxSockets: 50` per host prevents a single tenant from saturating the outbound worker pool.
- Per-destination rate limiting via Redis token bucket adds one Redis GET/INCR round-trip per dispatch (~1ms on same-VPC Redis).

## Architectural Implications for platform-services reviews

- A single `WebhookDispatcher` service in `apps/notification-service/src/notification/services/` owns:
  1. URL parsing via `new URL()` (reject on parse error)
  2. Scheme check (HTTPS-only in prod)
  3. Hostname normalization (IDN/Punycode/case-fold)
  4. Hostname denylist check (`localhost`, `*.internal`, metadata hosts, etc.)
  5. IP literal normalization via `ipaddr.js` (decimal/octal/hex/compressed IPv6)
  6. IP denylist check against full CIDR set (IPv4 + IPv6 + IPv4-mapped IPv6)
  7. Port denylist check (only `80, 443, 8080, 8443`)
  8. DNS resolution via `dns.promises.lookup(host, { all: true, family: 0 })` to get ALL addresses
  9. Each resolved address re-checked against the CIDR denylist (one bad IP = reject)
  10. HTTP dial via custom agent that pins the validated IP, passes `Host:` header and SNI as original hostname
  11. `maxRedirects: 0`, explicit `timeout: 10000`, `maxContentLength: 1_000_000`
  12. Per-destination Redis rate limit (token bucket, e.g., 100/min per host)
  13. Outcome logged to `WebhookDispatchAttempt` with tenant ID, destination host, status, duration, error category
- A `BlockedHostRegistry` constant lives in a single file (`apps/notification-service/src/notification/security/blocked-hosts.ts`) with the full CIDR lists above, exported as `ipaddr.Prefix` arrays. Tests load this and assert each RFC reference range is present.
- Webhook URL columns (`NotificationChannel.webhookUrl`, `WebhookSubscription.url`) are `@Column({ type: 'text' })` storing `ENC_V1:...` ciphertext. A `@AfterLoad` / `@BeforeInsert` transformer handles decrypt/encrypt. The plaintext URL exists only in memory during dispatch and is never logged.
- `WEBHOOK_ENCRYPTION_KEY` is loaded at bootstrap via `ConfigService` from a secrets manager, never from `.env`. Missing key in production fails startup with a clear error.
- Every HTTP redirect attempt is treated as a new SSRF input — the dispatcher re-runs all 12 validation steps on the `Location:` header before following. (Or simpler: don't follow.)
- Integration tests must cover: (a) decimal IP literal `2130706433` → rejected, (b) octal `0177.0.0.1` → rejected, (c) IPv6 `[::1]` → rejected, (d) IPv4-mapped `[::ffff:127.0.0.1]` → rejected, (e) DNS rebinding simulation (validator sees `8.8.8.8`, dial sees `127.0.0.1`) → connection refused because dial pins the validated IP, (f) redirect to `169.254.169.254` → not followed, (g) AES-GCM tag mismatch on decrypt → throws, no fallback to plaintext, (h) tenant ID AAD mismatch on decrypt → throws.

## Domain Rule Additions for platform-services (Notification Delivery subsection)

- **[CRITICAL]** The `WebhookDispatcher` MUST execute all 12 validation steps listed above, in order, on every dispatch (and on every redirect target). Skipping any step is a blocking review failure.
- **[CRITICAL]** IP denylist MUST cover the full RFC set: IPv4 (0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4), IPv6 (::/128, ::1/128, ::ffff:0:0/96, 100::/64, 2001:db8::/32, fc00::/7, fe80::/10, fec0::/10, ff00::/8).
- **[CRITICAL]** Hostname denylist MUST cover `localhost`, `metadata`, `metadata.google.internal`, `metadata.azure.com`, `*.internal`, `*.local`, `*.cluster.local`, `*.svc`, `kubernetes.default*`, and aqua-saas internal service names.
- **[CRITICAL]** IP literal normalization (decimal, octal, hex, IPv4-mapped IPv6, compressed IPv6) via `ipaddr.js` MUST run before any denylist check. Raw string matching on dotted-quad only is a blocking review failure.
- **[CRITICAL]** DNS rebinding (TOCTOU) MUST be mitigated by pinning the validated IP at dial time via a custom HTTP agent. Dialing by hostname after validating by hostname is a blocking review failure.
- **[CRITICAL]** HTTP redirects MUST be disabled (`maxRedirects: 0`) or re-validated on every `Location:` hop.
- **[CRITICAL]** Webhook URL columns MUST be encrypted at rest with AES-256-GCM, 96-bit random IV per encryption, 128-bit auth tag, tenant ID as AAD, `ENC_V1:` prefix. `WEBHOOK_ENCRYPTION_KEY` MUST come from a secrets manager in production.
- **[HIGH]** Webhook URLs MUST be HTTPS-only in production. Plaintext `http://` webhook URLs rejected on save.
- **[HIGH]** Outbound webhook ports MUST be restricted to `{80, 443, 8080, 8443}`. Any other port rejected.
- **[HIGH]** AES-GCM IV MUST be 96-bit random per encryption and MUST NOT be reused with the same key. AAD MUST bind the tenant ID.
- **[MEDIUM]** Per-destination-host rate limit (e.g., 100 requests/min per external host) via Redis token bucket.
- **[MEDIUM]** Global webhook dispatch timeout 10s, `maxContentLength` 1MB, per-tenant concurrent-dispatch cap.

Research: `docs/research/platform-services/2026-04-08-webhook-ssrf-prevention-blocked-hosts-cidr.md`
