# Research: SSRF Taxonomy, DNS Rebinding, Cloud Metadata, Webhook Hardening

**Topic:** SSRF classes (basic, blind, DNS rebinding, metadata-service exploit), CIDR blocks for cloud provider metadata, URL validation patterns, webhook URL hardening
**Date:** 2026-04-08
**Agent:** security-reviewer

## Sources

- [OWASP Top 10 — A10:2021 Server-Side Request Forgery](https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/)
- [OWASP Cheat Sheet — Server-Side Request Forgery Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [PortSwigger Web Security — SSRF](https://portswigger.net/web-security/ssrf)
- [PortSwigger Research — Cracking the Lens: Targeting HTTP's Hidden Attack Surface](https://portswigger.net/research/cracking-the-lens-targeting-https-hidden-attack-surface)
- [Capital One Breach (2019) — SSRF + Metadata Service Post-Mortem](https://www.capitalone.com/about/newsroom/capital-one-announces-data-security-incident/)
- [AWS — Use IMDSv2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-use.html)
- [GCP — Securing Metadata Server](https://cloud.google.com/compute/docs/metadata/overview)
- [Azure — Instance Metadata Service Security](https://learn.microsoft.com/en-us/azure/virtual-machines/instance-metadata-service)
- [DigitalOcean — Metadata Service](https://docs.digitalocean.com/products/droplets/how-to/retrieve-droplet-metadata/)
- [Hetzner Cloud — Metadata API](https://docs.hetzner.cloud/#server-metadata)
- [IETF RFC 6890 — Special-Purpose IP Address Registries](https://datatracker.ietf.org/doc/html/rfc6890)
- [IETF RFC 1918 — Private Address Allocation](https://datatracker.ietf.org/doc/html/rfc1918)
- [Cloudflare Blog — DNS Rebinding Attacks](https://blog.cloudflare.com/dns-rebinding-attacks/)
- [NCC Group Research — SSRF Bypass Techniques](https://research.nccgroup.com/category/security/)
- [Google Project Zero — DNS Rebinding writeup](https://googleprojectzero.blogspot.com/)

## Key Findings

### 1. SSRF taxonomy — four distinct classes, four distinct mitigations
1. **Basic SSRF (in-band)** — attacker controls a URL, server fetches it, response is reflected back. Mitigation: allowlist of permitted destinations OR strict URL validation.
2. **Blind SSRF (out-of-band)** — server fetches the URL but doesn't return the body to the attacker. Detection requires DNS/HTTP callback infrastructure (Burp Collaborator, similar). Mitigation: same as basic — allowlist.
3. **DNS rebinding SSRF** — attacker registers a domain that resolves first to an allowed IP (passes validation), then to an internal IP (used for the actual fetch). Mitigation: resolve hostname ONCE, validate the resolved IP, then connect to that IP directly (not the hostname).
4. **Cloud metadata SSRF** — attacker targets the cloud provider's metadata service (`169.254.169.254`) to steal IAM credentials or instance metadata. Mitigation: block the metadata CIDR explicitly, AND use IMDSv2 (token-based).

### 2. The cloud metadata IP space is not "just 169.254.169.254"
Comprehensive blocklist:
- **AWS / GCP / Azure / DigitalOcean / Oracle / IBM:** `169.254.169.254` (IPv4 link-local, RFC 3927)
- **Azure additional:** `168.63.129.16` (Wireserver)
- **Alibaba Cloud:** `100.100.100.200`
- **Hetzner:** `169.254.169.254`
- **GCP also exposes:** `metadata.google.internal` (DNS resolves to 169.254.169.254)
- **AWS IMDS v6:** `fd00:ec2::254` (IPv6 link-local equivalent)

A complete blocklist must reject:
- The entire `169.254.0.0/16` link-local range (RFC 3927)
- The entire `127.0.0.0/8` loopback range
- The entire `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` private ranges (RFC 1918)
- IPv6: `::1/128`, `fc00::/7` (unique local), `fe80::/10` (link-local)
- `0.0.0.0/8` (unspecified) and `0.0.0.0` resolves locally on Linux
- Multicast: `224.0.0.0/4`
- Broadcast: `255.255.255.255`

### 3. URL validation — substring matching is broken; use parsed URL components
Anti-patterns:
- `if (!url.includes("169.254.169.254")) ...` — bypassed by `0x0a000001`, `0177.0.0.1`, `[::1]`, `[::ffff:7f00:1]`, decimal `2130706433`.
- `if (!url.startsWith("https://")) ...` — bypassed by `https://attacker.com@169.254.169.254/`.
- `if (host == "metadata.example.com") ...` — bypassed by DNS rebinding.

Correct pattern (per OWASP SSRF Cheat Sheet):
```typescript
const parsed = new URL(input);
// 1. Protocol allowlist
if (!['http:', 'https:'].includes(parsed.protocol)) reject();
// 2. Resolve hostname EXACTLY ONCE
const ips = await dns.lookup(parsed.hostname, { all: true });
// 3. Validate every resolved IP against the blocklist
for (const ip of ips) if (isPrivate(ip) || isLinkLocal(ip) || isLoopback(ip)) reject();
// 4. Connect to the validated IP, not the hostname (bypass DNS rebinding)
const agent = new http.Agent({ lookup: () => ips[0] });
const response = await fetch(parsed.toString(), { agent });
```
A complete reference: `ssrf-req-filter` for Node, `safe-curl` for PHP, `gopkg.in/yaml.v3` does NOT validate URLs (the fetch layer must).

### 4. DNS rebinding is non-trivial — the attacker can win the race
Cloudflare's DNS rebinding writeup and Project Zero's research both stress: even if you resolve once and connect to the resolved IP, an HTTP redirect to a hostname triggers a NEW resolution by the HTTP client. Mitigations:
- Disable HTTP redirects in the fetcher (`maxRedirects: 0`) OR re-validate the redirect URL.
- Pin the resolved IP for the entire connection (not just first lookup).
- Run the fetcher in a network namespace that blocks RFC 1918 / link-local / loopback at the kernel level (defense in depth).

### 5. Webhook URL hardening is the highest-value SSRF mitigation in SaaS
Webhooks are user-controlled URLs by design (the customer specifies where to deliver events). Mitigations:
- **Allowlist mode (preferred):** customer pre-registers domains; only allowlisted hosts accepted.
- **Blocklist mode (minimum):** reject all RFC 1918 / link-local / loopback / metadata IPs at validation AND at fetch time (DNS rebinding defense).
- **Egress proxy:** all webhook deliveries route through a dedicated proxy that lives in a network namespace with no internal network routes. The proxy enforces the IP filter; the application code calls the proxy.
- **Signed webhooks:** sign every delivery with HMAC; customer verifies signature. Prevents the webhook receiver from being spoofed.
- **Dead-letter and rate cap:** failing webhook URLs MUST be rate-limited (no infinite retry storm), MUST timeout aggressively (5s connect, 30s total), MUST not exhaust the worker pool.
- **No internal hostnames in error messages:** if delivery fails, the error returned to the customer must not echo internal hostnames or IPs.

### 6. Capital One taught the industry that IMDS v1 is a death sentence
The 2019 Capital One breach was an SSRF -> IMDS v1 -> stolen IAM credentials -> S3 dump. Post-mortem lessons:
- **Use IMDSv2** (token-based, requires PUT request, blocks GET-only SSRF).
- **Configure metadata hop limit to 1** (prevents the metadata response from leaking through reverse proxies).
- **IAM role principle of least privilege** — even if metadata is stolen, the role's permissions are minimal.
- **Network policy** — block egress to 169.254.169.254 from app pods that don't need IMDS.

For aqua-saas: every container that reaches outbound HTTP MUST run with IMDSv2 enforced AND a network policy that blocks 169.254.169.254 at the pod level.

### 7. Open redirects are SSRF-adjacent and equally weaponizable
An open redirect (`/redirect?url=...`) becomes an SSRF amplifier when chained with a vulnerable fetcher. Mitigations:
- Allowlist redirect destinations.
- Use signed redirect tokens.
- Never echo unvalidated user input as the `Location` header.

## Security Concerns

- **Webhook URL accepts arbitrary destination = HIGH** (CRITICAL if running in a cloud with metadata service).
- **URL validation via substring match instead of parsed URL components = CRITICAL** (trivially bypassed).
- **DNS resolved per connection (not pinned) = HIGH** (DNS rebinding window).
- **HTTP redirects followed without re-validation = HIGH** (DNS rebinding via redirect).
- **IMDSv1 enabled (or IMDSv2 not enforced) on EC2 instances = HIGH** (Capital One class breach).
- **Image proxy / favicon fetcher / SSRF-in-SVG / OG-card preview without filter = HIGH**.
- **PDF generators / headless Chrome / wkhtmltopdf accepting user-controlled URLs = HIGH**.
- **GraphQL `@http` directive or REST data source pointing at user-controlled URL = CRITICAL**.
- **Fetcher running in same network namespace as internal services = HIGH** (lateral SSRF).
- **Error response includes internal hostname / IP / port = MEDIUM** (info disclosure feeding next attack).

## Performance Concerns

- DNS lookups in the fetch hot path can become a DoS vector if the resolver is overloaded; cache validation results per (hostname, ttl).
- Synchronous webhook delivery on the request thread blocks the worker pool; deliveries MUST be queued.
- Slow webhook destinations exhausting connection pool — circuit breakers per destination, per-destination concurrency limits.

## Architectural Implications for security-reviewer

When reviewing any code that fetches a URL (fetch, axios, http.get, undici, image proxy, webhook delivery, OG-card preview, PDF generator, GraphQL HTTP datasource), the agent MUST verify:
1. Protocol is allowlisted (http/https only — no `file://`, `gopher://`, `ftp://`, `dict://`).
2. Hostname is resolved exactly once and the resolved IP is validated against the full blocklist (RFC 1918 + link-local + loopback + metadata + IPv6 equivalents).
3. The fetch connects to the validated IP, not the hostname (DNS rebinding defense).
4. HTTP redirects are disabled OR re-validated.
5. Connect timeout ≤ 5s, total timeout ≤ 30s.
6. Error messages do not echo resolved IPs or internal hostnames.
7. The runtime container has IMDSv2 enforced AND a network policy blocking metadata CIDR.
8. Webhook deliveries run through an egress proxy in an isolated network namespace.
9. Open redirects are allowlisted or signed.

## Domain Rule Additions for security-reviewer

- ANY user-controlled URL fetch without ALL FOUR of (protocol allowlist, IP blocklist, DNS-pinning, redirect handling) = CRITICAL.
- URL validation via string matching instead of parsed URL + DNS resolution = CRITICAL.
- Webhook delivery from the same network namespace as internal services = HIGH.
- IMDSv1 enabled OR IMDSv2 not enforced on any container that issues outbound HTTP = HIGH.
- Missing network policy blocking 169.254.169.254 + 168.63.129.16 + 100.100.100.200 + IPv6 link-local from app pods = HIGH.
- HTTP redirect followed without re-validation in a fetcher = HIGH (DNS rebinding via redirect).
- Connect timeout > 5s OR total timeout > 30s on a webhook fetcher = MEDIUM (DoS amplifier).
- Webhook delivery error messages echoing internal hostnames or IPs = MEDIUM.
- Open redirect endpoint without allowlist or signed token = HIGH.
- Image proxy / favicon / OG-card / PDF generator accepting arbitrary URLs without the full filter pipeline = CRITICAL.
