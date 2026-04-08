# Research: nginx Production Hardening — TLS, HSTS, CSP, Rate Limiting, WebSocket, CORS

**Topic:** nginx production reverse-proxy hardening — TLS 1.2/1.3 only, strong ciphers, OCSP stapling, HSTS preload (2yr), CSP without unsafe-eval, `server_tokens off`, rate limit zones, `/metrics` deny, HTTP→HTTPS redirect, WebSocket upgrade map, CORS allowlist.
**Date:** 2026-04-08
**Agent:** infra-expert

## Sources
- [nginx.org: Configuring HTTPS servers](https://nginx.org/en/docs/http/configuring_https_servers.html)
- [nginx.org: WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
- [nginx.org: ngx_http_limit_req_module](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)
- [nginx.org: ngx_http_ssl_module (OCSP stapling)](https://nginx.org/en/docs/http/ngx_http_ssl_module.html)
- [Mozilla SSL Configuration Generator](https://ssl-config.mozilla.org/)
- [Mozilla Observatory](https://observatory.mozilla.org/)
- [MDN: HTTP Strict-Transport-Security (HSTS)](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security)
- [MDN: Content Security Policy (CSP) Reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [hstspreload.org submission requirements](https://hstspreload.org/)
- [OWASP Secure Headers Project](https://owasp.org/www-project-secure-headers/)
- [Cloudflare: What is HSTS and how does it work](https://www.cloudflare.com/learning/ssl/what-is-hsts/)
- [nginx.org: Using nginx as HTTP load balancer / ngx_http_map_module](https://nginx.org/en/docs/http/ngx_http_map_module.html)

## Key Findings

1. **TLS protocols: `ssl_protocols TLSv1.2 TLSv1.3;`** TLS 1.0/1.1 are deprecated (RFC 8996) and vulnerable to BEAST/POODLE. Mozilla "intermediate" profile (2025+) recommends 1.2+1.3 for broad client compatibility; "modern" profile is 1.3-only. Including 1.0/1.1 = CRITICAL.
2. **Strong cipher suite with forward secrecy.** Only ECDHE-based AEAD ciphers: `ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305`. No RC4, 3DES, CBC-mode, RSA key exchange. `ssl_prefer_server_ciphers off;` on TLS 1.3 (client chooses). Any weak cipher enabled = CRITICAL.
3. **OCSP stapling** reduces handshake latency and eliminates client OCSP lookup (privacy). Config: `ssl_stapling on; ssl_stapling_verify on; ssl_trusted_certificate /path/to/fullchain.pem; resolver 1.1.1.1 8.8.8.8 valid=300s; resolver_timeout 5s;`. Missing = MEDIUM.
4. **HSTS with preload, 2-year max-age.** `add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;`. `max-age` < 1 year = HIGH. Missing `includeSubDomains` on root domain = HIGH. Missing `preload` or not submitted to hstspreload.org = MEDIUM. WARNING: preload is hard to undo — validate all subdomains serve HTTPS before enabling.
5. **Content Security Policy without `unsafe-eval`, minimal `unsafe-inline`.** Production CSP MUST set `default-src 'self'; script-src 'self' <trusted-cdn> 'nonce-<generated>'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' wss: https://api.example.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests;`. `unsafe-eval` in script-src = HIGH. `*` wildcard in script-src or connect-src = HIGH.
6. **`server_tokens off;` at http-level.** Hides nginx version in error pages and `Server:` header. Disclosing version helps attackers match CVEs. Missing = LOW.
7. **Rate limiting zones and per-route limit.** Define `limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;` and `limit_req_zone $binary_remote_addr zone=graphql:10m rate=10r/s;` and `limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;`. Apply with `limit_req zone=api burst=40 nodelay;`. Missing rate limits on `/graphql`, `/api/`, `/auth/login` = HIGH (brute-force exposure).
8. **`/metrics` endpoint denied from public access.** Prometheus scraping should be internal-only. `location = /metrics { allow 10.0.0.0/8; allow 172.16.0.0/12; deny all; return 403; }`. Metrics leaking publicly = HIGH (info disclosure, SSRF pivot).
9. **HTTP → HTTPS redirect on port 80.** Separate server block: `server { listen 80; listen [::]:80; server_name example.com; return 301 https://$host$request_uri; }`. Never serve content on port 80 except ACME challenge.
10. **WebSocket upgrade via `map $http_upgrade $connection_upgrade`.** Required because `Connection` is hop-by-hop and must not be passed through blindly:
    ```nginx
    map $http_upgrade $connection_upgrade {
      default upgrade;
      ''      close;
    }
    location /ws {
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Host $host;
      proxy_read_timeout 3600s;
    }
    ```
    Missing upgrade handling = WebSocket broken in production.
11. **CORS via `$cors_origin` map (allowlist, never wildcard).**
    ```nginx
    map $http_origin $cors_origin {
      default "";
      "~^https://(app|admin)\.example\.com$" $http_origin;
    }
    add_header Access-Control-Allow-Origin $cors_origin always;
    add_header Access-Control-Allow-Credentials "true" always;
    add_header Vary "Origin" always;
    ```
    `Access-Control-Allow-Origin: *` combined with `Allow-Credentials: true` = CRITICAL (CORS spec violation + credential leak).
12. **`client_max_body_size 10m;`** (or appropriate for upload endpoints). Default 1m is often too small; unlimited is DoS vector.
13. **Additional security headers:**
    - `X-Content-Type-Options nosniff`
    - `X-Frame-Options DENY` (redundant with `frame-ancestors 'none'` but good defense-in-depth)
    - `Referrer-Policy strict-origin-when-cross-origin`
    - `Permissions-Policy camera=(), microphone=(), geolocation=(), fullscreen=(self)`
    - `Cross-Origin-Opener-Policy same-origin`
    - `Cross-Origin-Embedder-Policy require-corp` (if no third-party embeds)
14. **TLS key and DH parameters.** `ssl_dhparam` with ≥ 2048-bit DH params (or use ECDHE only, which doesn't need it). Private key permissions 600 root:root.
15. **`ssl_session_cache shared:SSL:10m; ssl_session_timeout 1d;`** for session resumption performance.

## Security Concerns
- TLS 1.0/1.1 enabled = CRITICAL.
- Weak ciphers (RC4, 3DES, CBC, RSA key exchange) = CRITICAL.
- Missing HSTS or `max-age` < 31536000 = HIGH.
- CSP with `unsafe-eval` in script-src = HIGH.
- CSP `*` wildcard in script-src/connect-src = HIGH.
- `Access-Control-Allow-Origin: *` with credentials = CRITICAL.
- Missing rate limits on auth/graphql endpoints = HIGH.
- `/metrics` publicly accessible = HIGH.
- Missing HTTP→HTTPS redirect = HIGH.
- OCSP stapling disabled = MEDIUM.
- `server_tokens on` (default) = LOW.
- Missing `X-Frame-Options` / `frame-ancestors` = MEDIUM (clickjacking).
- `client_max_body_size` unlimited or 0 = HIGH (DoS).
- Using self-signed cert in production = CRITICAL.
- `proxy_pass` without preserving `$host` / `X-Forwarded-For` / `X-Real-IP` = MEDIUM (audit logging broken).

## Performance Concerns
- Missing `ssl_session_cache` = MEDIUM (handshake overhead on reconnect).
- `ssl_protocols` without 1.3 = LOW (1.3 is faster handshake).
- `sendfile on; tcp_nopush on; tcp_nodelay on;` missing = LOW.
- Missing `gzip` / `brotli` on text content = LOW.
- No `http2` (or `http3`) enabled in `listen 443 ssl http2;` = MEDIUM.
- `proxy_buffering off` when not streaming = MEDIUM.
- Missing upstream keepalive (`keepalive 32;` in upstream block) = MEDIUM (connection churn).

## Architectural Implications for infra-expert reviews
- Every HTTPS server block MUST have: TLS 1.2+1.3 only, strong ciphers, HSTS 2yr preload, CSP without unsafe-eval, all 7+ security headers, OCSP stapling, HTTP→HTTPS redirect, `server_tokens off`.
- Every API/auth endpoint MUST have a rate limit zone applied.
- `/metrics` MUST be IP-restricted.
- WebSocket endpoints MUST use the `$connection_upgrade` map pattern.
- CORS MUST use a map-based origin allowlist.
- Any wildcard `*` in CSP script-src or CORS with credentials = CRITICAL.

## Domain Rule Additions for infra-expert

Add to `## Domain Rules → nginx (Critical)`:
- TLS MUST be 1.2 and 1.3 only; including 1.0/1.1 = CRITICAL.
- Cipher suite MUST be ECDHE-based AEAD only (GCM/CHACHA20); any CBC/3DES/RC4 = CRITICAL.
- OCSP stapling MUST be enabled (`ssl_stapling on; ssl_stapling_verify on;`); missing = MEDIUM.
- HSTS MUST use `max-age=63072000; includeSubDomains; preload`; missing or weaker = HIGH.
- CSP MUST NOT include `unsafe-eval` in `script-src`; wildcard `*` in script-src/connect-src = HIGH.
- `server_tokens off;` MUST be set at http-level.
- Rate limit zones MUST exist for `/api/`, `/graphql`, and `/auth/login`; missing = HIGH.
- `/metrics` MUST be IP-restricted (`deny all;` with internal CIDR allowlist); public = HIGH.
- HTTP port 80 MUST 301-redirect to HTTPS (except `/.well-known/acme-challenge/`).
- WebSocket proxying MUST use `map $http_upgrade $connection_upgrade` and `proxy_http_version 1.1`; raw `Connection: upgrade` pass-through = HIGH.
- CORS origin MUST come from a `map $http_origin $cors_origin` allowlist; `Access-Control-Allow-Origin: *` with `Allow-Credentials: true` = CRITICAL.
- `client_max_body_size` MUST be set explicitly (not unlimited); missing = HIGH.
- All responses MUST include `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`; missing = MEDIUM each.
