/**
 * @module SsrfValidatorService
 * @description Validates URLs for MCP/tool calls to prevent Server-Side
 * Request Forgery (SSRF) attacks.
 *
 * Defense layers:
 * 1. Protocol allowlist (http, https only)
 * 2. Port allowlist (80, 443 only)
 * 3. DNS resolution BEFORE connect — resolves hostname to IP first
 * 4. IP denylist: RFC 1918, link-local, loopback, CGNAT, cloud metadata
 * 5. Redirect policy: no following redirects (redirect: 'error')
 *
 * IMPORTANT: DNS resolution happens pre-connect to prevent DNS rebinding
 * attacks where a hostname resolves to a public IP during validation but
 * resolves to a private IP during the actual connection.
 *
 * @see MSG-CRITICAL-029 (SSRF finding)
 */
import { Injectable, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';
import { isIPv4, isIPv6 } from 'net';

// ── Result Types ──

/** Result of URL validation. */
export interface SsrfValidationResult {
  /** Whether the URL is safe for server-side requests. */
  safe: boolean;
  /** Human-readable reason if not safe. */
  reason?: string;
  /** The resolved IP address (if DNS resolution was performed). */
  resolvedIp?: string;
}

// ── Constants ──

/** Allowed protocols for outbound requests. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Allowed destination ports. */
const ALLOWED_PORTS = new Set([80, 443]);

/** Default ports by protocol (when no explicit port is specified in the URL). */
const DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

/**
 * IP ranges that MUST be blocked to prevent SSRF.
 * Each entry is a [network, prefixLength] tuple for CIDR matching.
 *
 * SECURITY: This list covers:
 * - RFC 1918 private ranges (10/8, 172.16/12, 192.168/16)
 * - Loopback (127/8)
 * - Link-local (169.254/16) — includes AWS/GCP metadata endpoints
 * - CGNAT (100.64/10)
 * - Cloud metadata IPs (explicitly listed as defense-in-depth)
 */
const IPV4_DENY_CIDRS: Array<{ network: number; mask: number }> = [
  // 10.0.0.0/8 — RFC 1918
  { network: ipToNumber('10.0.0.0'), mask: cidrMask(8) },
  // 172.16.0.0/12 — RFC 1918
  { network: ipToNumber('172.16.0.0'), mask: cidrMask(12) },
  // 192.168.0.0/16 — RFC 1918
  { network: ipToNumber('192.168.0.0'), mask: cidrMask(16) },
  // 127.0.0.0/8 — Loopback
  { network: ipToNumber('127.0.0.0'), mask: cidrMask(8) },
  // 169.254.0.0/16 — Link-local (AWS metadata: 169.254.169.254)
  { network: ipToNumber('169.254.0.0'), mask: cidrMask(16) },
  // 100.64.0.0/10 — CGNAT (Carrier-grade NAT)
  { network: ipToNumber('100.64.0.0'), mask: cidrMask(10) },
  // 0.0.0.0/8 — "This network"
  { network: ipToNumber('0.0.0.0'), mask: cidrMask(8) },
  // 192.0.0.0/24 — IETF Protocol Assignments
  { network: ipToNumber('192.0.0.0'), mask: cidrMask(24) },
  // 192.0.2.0/24 — Documentation (TEST-NET-1)
  { network: ipToNumber('192.0.2.0'), mask: cidrMask(24) },
  // 198.51.100.0/24 — Documentation (TEST-NET-2)
  { network: ipToNumber('198.51.100.0'), mask: cidrMask(24) },
  // 203.0.113.0/24 — Documentation (TEST-NET-3)
  { network: ipToNumber('203.0.113.0'), mask: cidrMask(24) },
  // 224.0.0.0/4 — Multicast
  { network: ipToNumber('224.0.0.0'), mask: cidrMask(4) },
  // 240.0.0.0/4 — Reserved
  { network: ipToNumber('240.0.0.0'), mask: cidrMask(4) },
];

/**
 * IPv6 prefixes that MUST be blocked.
 */
const IPV6_DENY_PREFIXES: string[] = [
  '::1',       // Loopback
  'fe80:',     // Link-local
  'fc',        // Unique local (fc00::/7)
  'fd',        // Unique local (fc00::/7)
  '::ffff:',   // IPv4-mapped IPv6 (handled via IPv4 checks after extraction)
];

/**
 * Cloud provider metadata endpoint hostnames and IPs.
 * These are blocked as defense-in-depth (in addition to IP range blocks).
 */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'kubernetes.default.svc',
]);

// ── Helper Functions ──

/** Convert dotted IPv4 string to 32-bit number. */
function ipToNumber(ip: string): number {
  const parts = ip.split('.');
  return (
    ((parseInt(parts[0]!, 10) << 24) |
      (parseInt(parts[1]!, 10) << 16) |
      (parseInt(parts[2]!, 10) << 8) |
      parseInt(parts[3]!, 10)) >>>
    0
  );
}

/** Generate a CIDR bitmask from prefix length. */
function cidrMask(prefix: number): number {
  return prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
}

@Injectable()
export class SsrfValidatorService {
  private readonly logger = new Logger(SsrfValidatorService.name);

  /**
   * Validate a URL for safe server-side requests.
   * Performs DNS resolution and IP validation BEFORE any connection.
   *
   * @param url - The URL to validate
   * @returns SsrfValidationResult with safety verdict
   */
  async validateUrl(url: string): Promise<SsrfValidationResult> {
    // ── Step 1: Parse URL ──
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { safe: false, reason: 'Invalid URL format' };
    }

    // ── Step 2: Protocol allowlist ──
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return {
        safe: false,
        reason: `Protocol "${parsed.protocol}" not allowed. Only http: and https: are permitted.`,
      };
    }

    // ── Step 3: Port allowlist ──
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : DEFAULT_PORTS[parsed.protocol] ?? 0;

    if (!ALLOWED_PORTS.has(port)) {
      return {
        safe: false,
        reason: `Port ${port} not allowed. Only ports 80 and 443 are permitted.`,
      };
    }

    // ── Step 4: Hostname checks ──
    const hostname = parsed.hostname.toLowerCase();

    // Block known metadata hostnames
    if (METADATA_HOSTNAMES.has(hostname)) {
      return {
        safe: false,
        reason: `Hostname "${hostname}" is a cloud metadata endpoint.`,
      };
    }

    // Block localhost variants
    if (
      hostname === 'localhost' ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]' ||
      hostname === '::1'
    ) {
      return { safe: false, reason: 'Localhost addresses are not allowed.' };
    }

    // ── Step 5: DNS resolution (pre-connect) ──
    // SECURITY: Resolve BEFORE connecting to prevent DNS rebinding attacks.
    // The resolved IP is what we validate, not the hostname.
    let resolvedIp: string;

    if (isIPv4(hostname) || isIPv6(hostname)) {
      // Already an IP literal — use directly
      resolvedIp = hostname;
    } else {
      try {
        const addresses = await dns.resolve4(hostname);
        if (addresses.length === 0) {
          return { safe: false, reason: `DNS resolution failed: no A records for "${hostname}".` };
        }
        // SECURITY: Validate ALL resolved IPs, not just the first one.
        // An attacker could add a public IP alongside a private IP in DNS.
        for (const ip of addresses) {
          const ipCheck = this.isPrivateIp(ip);
          if (ipCheck) {
            return {
              safe: false,
              reason: `DNS resolved to private IP: ${ipCheck}`,
              resolvedIp: ip,
            };
          }
        }
        resolvedIp = addresses[0]!;
      } catch {
        return {
          safe: false,
          reason: `DNS resolution failed for hostname "${hostname}".`,
        };
      }
    }

    // ── Step 6: IP validation ──
    const ipCheck = this.isPrivateIp(resolvedIp);
    if (ipCheck) {
      return {
        safe: false,
        reason: `IP address ${resolvedIp} is in a restricted range: ${ipCheck}`,
        resolvedIp,
      };
    }

    return { safe: true, resolvedIp };
  }

  /**
   * Validate a raw network target (host + port) for safe server-side
   * socket connections to non-HTTP endpoints — industrial protocol links
   * such as Modbus-TCP, raw TCP/UDP sockets, and WebSocket device streams.
   *
   * Unlike {@link validateUrl}, this deliberately does NOT enforce the
   * HTTP protocol/port allowlist: industrial devices legitimately listen
   * on arbitrary ports (Modbus 502, vendor-specific ranges). The SSRF
   * defense that DOES apply is identical — the destination must not resolve
   * to a private/loopback/link-local/CGNAT/metadata address, and DNS is
   * resolved BEFORE the caller connects so the resolved IP (not the
   * hostname) is what gets pinned, closing the DNS-rebinding window.
   *
   * SECURITY: the caller MUST connect to `result.resolvedIp` (not the
   * original hostname) to make the pre-resolution guarantee real.
   *
   * @param host - Hostname or IP literal of the target device
   * @param port - Destination TCP/UDP port (validated as a positive integer)
   * @returns SsrfValidationResult with safety verdict + resolved IP to pin
   */
  async validateHost(host: string, port: number): Promise<SsrfValidationResult> {
    if (!host || typeof host !== 'string') {
      return { safe: false, reason: 'Host is required.' };
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { safe: false, reason: `Port ${port} is out of range (1-65535).` };
    }

    const hostname = host.trim().toLowerCase().replace(/^\[|\]$/g, '');

    // Block known metadata hostnames + localhost variants (defense-in-depth
    // before DNS, mirroring validateUrl steps 4).
    if (METADATA_HOSTNAMES.has(hostname)) {
      return { safe: false, reason: `Host "${hostname}" is a cloud metadata endpoint.` };
    }
    if (
      hostname === 'localhost' ||
      hostname === '0.0.0.0' ||
      hostname === '::1'
    ) {
      return { safe: false, reason: 'Localhost addresses are not allowed.' };
    }

    // DNS resolution (pre-connect) — validate ALL resolved IPs.
    let resolvedIp: string;
    if (isIPv4(hostname) || isIPv6(hostname)) {
      resolvedIp = hostname;
    } else {
      try {
        const addresses = await dns.resolve4(hostname);
        const [firstAddress] = addresses;
        if (firstAddress === undefined) {
          return { safe: false, reason: `DNS resolution failed: no A records for "${hostname}".` };
        }
        for (const ip of addresses) {
          const denied = this.isPrivateIp(ip);
          if (denied) {
            return { safe: false, reason: `DNS resolved to private IP: ${denied}`, resolvedIp: ip };
          }
        }
        resolvedIp = firstAddress;
      } catch {
        return { safe: false, reason: `DNS resolution failed for hostname "${hostname}".` };
      }
    }

    const ipCheck = this.isPrivateIp(resolvedIp);
    if (ipCheck) {
      return {
        safe: false,
        reason: `IP address ${resolvedIp} is in a restricted range: ${ipCheck}`,
        resolvedIp,
      };
    }

    return { safe: true, resolvedIp };
  }

  /**
   * Get fetch options with SSRF-safe defaults.
   * Use these options when making HTTP requests to validated URLs.
   *
   * @returns Partial RequestInit with safe defaults
   */
  getSafeFetchOptions(): RequestInit {
    return {
      // SECURITY: Never follow redirects — a safe URL could redirect to an internal one.
      redirect: 'error',
    };
  }

  /**
   * Check if an IP address falls within any denied range.
   *
   * @param ip - IP address string
   * @returns Reason string if the IP is private/restricted, null if safe
   */
  private isPrivateIp(ip: string): string | null {
    // ── IPv4 check ──
    if (isIPv4(ip)) {
      const ipNum = ipToNumber(ip);
      for (const cidr of IPV4_DENY_CIDRS) {
        if ((ipNum & cidr.mask) === (cidr.network & cidr.mask)) {
          return `IPv4 address in denied CIDR range`;
        }
      }
      return null;
    }

    // ── IPv6 check ──
    if (isIPv6(ip)) {
      const lower = ip.toLowerCase();

      // Check for IPv4-mapped IPv6 (::ffff:x.x.x.x)
      const v4MappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
      if (v4MappedMatch) {
        // Recursively check the embedded IPv4 address
        return this.isPrivateIp(v4MappedMatch[1]!);
      }

      for (const prefix of IPV6_DENY_PREFIXES) {
        if (lower.startsWith(prefix)) {
          return `IPv6 address in denied prefix range (${prefix})`;
        }
      }
      return null;
    }

    // Unknown format — deny by default
    return 'Unrecognized IP format';
  }
}
