/**
 * Remote Module Integrity Guard
 *
 * SH-SEC-04: Vite Module Federation (@module-federation/vite) does not
 * generate or validate Subresource Integrity (SRI) hashes for remote entry files.
 * This module provides two layers of defense:
 *
 *   1. A production-time allowlist of known remote entry URL patterns — any
 *      remoteEntry.js fetched from an origin not on this list is blocked and a
 *      security event is dispatched.
 *
 *   2. An extensible hash-pinning map that, when populated (e.g. at CI/CD time
 *      via a generated file), applies SHA-384 SRI pins to remote bundles
 *      before they execute.
 *
 * Current limitation: Vite MF loads remotes via <script> injection, not fetch(),
 * so a fetch interceptor cannot intercept the actual module eval. The allowlist
 * guard therefore works by patching `document.createElement` to intercept
 * dynamically injected <script> elements before they are appended to the DOM,
 * validating their `src` attribute against the allowlist.
 *
 * Full SRI enforcement requires either:
 *   - A service worker that intercepts all fetch requests and validates hashes, or
 *   - A CSP `script-src` policy with explicit hash values (requires build-time hash generation).
 *
 * This file wires up the `createElement` guard, which is callable in bootstrap
 * before any remote modules load.
 */

// ---------------------------------------------------------------------------
// Allowlist of permitted remote script URL patterns (regex)
// ---------------------------------------------------------------------------

const REMOTE_SCRIPT_ALLOWLIST: RegExp[] = [
  // Same-origin relative paths (production nginx proxy via /remotes/)
  /^\/remotes\//,
  // Local development proxy via docker nginx at port 8080
  /^http:\/\/localhost:8080\/mf\//,
  // Production origin — update this when the production domain is finalised
  /^https:\/\/app\.suderra\.com\//,
];

// ---------------------------------------------------------------------------
// Optional hash-pinning map: { urlPattern -> expected SHA-256 hex digest }
// Populate this at build time (e.g. from a generated hashes.json) to enable
// integrity verification. When empty, hash verification is skipped.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D14-SC-01: SRI hash-pinning map for remote entry files
//
// Populated at build time by the generate-sri-hashes CI job, which writes
// web/shell/src/generated/remoteHashes.json after each frontend build.
// That file is gitignored; on local dev the catch below returns an empty map
// and hash verification is skipped (allowlist guard still applies).
//
// Format: { '/remotes/<module>/remoteEntry.js': 'sha384-<base64>' }
// ---------------------------------------------------------------------------
let REMOTE_HASH_PINS: Record<string, string> = {};
const generatedHashPins = import.meta.glob<Record<string, string>>(
  '../generated/remoteHashes.json',
  { eager: true, import: 'default' },
);
REMOTE_HASH_PINS = Object.values(generatedHashPins)[0] ?? {};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isAllowedRemoteUrl(src: string): boolean {
  return REMOTE_SCRIPT_ALLOWLIST.some((pattern) => pattern.test(src));
}

function isRemoteEntryScript(src: string): boolean {
  return src.includes('remoteEntry');
}

function reportViolation(src: string): void {
  const message = `[SH-SEC-04] Remote script blocked: origin not in allowlist — ${src}`;

  if (import.meta.env.DEV) {
    console.error(message);
  }

  // Dispatch a custom security event so monitoring/analytics can capture it
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('aquaculture:security-violation', {
        detail: { type: 'REMOTE_SCRIPT_BLOCKED', src, timestamp: Date.now() },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Shared script src validation logic
// ---------------------------------------------------------------------------

/**
 * Determines whether a dynamically injected script is a federation-runtime
 * script that must pass through the integrity guard.
 *
 * SECURITY (FE-CRITICAL-001): The previous implementation only checked
 * `src.includes('remoteEntry')`, allowing any other injected script path
 * (e.g., `shared.js`, `vendor.js`, arbitrary extension scripts) to bypass
 * the allowlist and SRI enforcement entirely.
 *
 * A federation-managed script is any script whose src:
 *   1. Matches one of the allowlisted origins (same-origin /remotes/, localhost:8080, production), OR
 *   2. Contains 'remoteEntry' in the path (legacy pattern), OR
 *   3. Is loaded from a path containing '/mf/' or '/remotes/' (federation namespace)
 *
 * For scripts that match NONE of the above, they are treated as non-federation
 * (e.g., analytics, browser extensions) and passed through. This avoids
 * breaking third-party scripts while still enforcing the guard on ALL
 * federation-injected scripts, not just remoteEntry.
 */
function isFederationScript(src: string): boolean {
  // Explicit remoteEntry match (original pattern)
  if (isRemoteEntryScript(src)) return true;
  // Any script under the federation namespace paths
  if (src.includes('/remotes/') || src.includes('/mf/')) return true;
  // Any script matching a known remote origin pattern
  if (isAllowedRemoteUrl(src)) return true;
  return false;
}

/**
 * Validates a script src value against the allowlist and applies SRI hash
 * pins when available. Returns the (possibly cleared) src value.
 *
 * SECURITY: This is the single enforcement point for both createElement and
 * setAttribute interception paths, ensuring consistent policy application.
 * In production, scripts without a manifest pin are blocked (fail-closed).
 * In development, unverified scripts are allowed with a warning.
 *
 * @param src - The script src URL to validate
 * @param scriptElement - The script element to apply integrity attributes to
 * @returns The validated src (empty string if blocked)
 */
function validateAndEnforceScriptSrc(src: string, scriptElement: HTMLScriptElement): string {
  // SECURITY (FE-CRITICAL-001 fix): Previously this returned early for ANY
  // script not containing 'remoteEntry', allowing arbitrary injected scripts
  // to bypass the allowlist entirely. Now we check all federation scripts.
  if (!isFederationScript(src)) {
    return src;
  }

  if (!isAllowedRemoteUrl(src)) {
    reportViolation(src);
    return '';
  }

  // ── SRI hash-pin enforcement ──
  const pin = REMOTE_HASH_PINS[src];
  if (pin) {
    scriptElement.integrity = pin;
    scriptElement.crossOrigin = 'anonymous';
    return src;
  }

  // No hash pin registered for this script URL
  if (import.meta.env.DEV) {
    // SECURITY: development mode — warn only, allow script to load
    console.warn(
      `[SH-SEC-04] No integrity hash pinned for federation script: ${src}. ` +
        'Populate REMOTE_HASH_PINS at build time for full SRI enforcement.',
    );
    return src;
  }

  // SECURITY: fail-closed — block unverified scripts in production
  // Any federation script without a manifest pin is blocked. This ensures
  // that a compromised CDN/proxy cannot inject scripts that bypass SRI.
  // CI/CD must populate REMOTE_HASH_PINS for all federation bundles.
  const blockMessage =
    `[SH-SEC-04] PRODUCTION: Blocked federation script without SRI hash pin: ${src}. ` +
    'CI/CD must populate REMOTE_HASH_PINS for subresource integrity enforcement.';

  console.error(blockMessage);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('aquaculture:security-violation', {
        detail: {
          type: 'SRI_HASH_MISSING_BLOCKED',
          src,
          timestamp: Date.now(),
          severity: 'critical',
        },
      }),
    );
  }

  return '';
}

// ---------------------------------------------------------------------------
// createElement patch (on Document.prototype)
// ---------------------------------------------------------------------------

let patchApplied = false;

/**
 * Installs prototype-level patches that intercept dynamically injected
 * <script> elements whose `src` matches a remoteEntry pattern.
 *
 * Two interception layers are installed:
 *
 *   1. `Document.prototype.createElement` — intercepts script element
 *      creation and overrides the `src` property descriptor on each
 *      new script element to validate against the allowlist.
 *
 *   2. `Element.prototype.setAttribute` — intercepts `setAttribute('src', ...)`
 *      calls on script elements, preventing bypass via attribute manipulation
 *      instead of property assignment.
 *
 * SECURITY: Patches are applied to prototypes (not instances) so they
 * cover all document contexts including iframes and sandboxed contexts.
 *
 * For each intercepted script:
 *  - If the `src` is NOT in the allowlist, the element's `src` is cleared and
 *    a security violation is reported.
 *  - If a hash pin is registered for the `src`, the `integrity` attribute is
 *    set so the browser enforces SRI natively.
 *
 * Must be called once, as early as possible — BEFORE any library imports
 * (React, ReactDOM, etc.) to ensure the guard is active when those
 * libraries execute.
 */
export function installRemoteIntegrityGuard(): void {
  if (patchApplied || typeof document === 'undefined') return;
  patchApplied = true;

  // ── Layer 1: Document.prototype.createElement patch ──
  // SECURITY: Patching the prototype (not the instance) ensures coverage
  // across all document contexts — iframes, sandboxed contexts, or any
  // code that obtains a fresh document reference will still be intercepted.
  // WHY Reflect.get (not a bare `Document.prototype.createElement` extraction):
  // we must snapshot the UNPATCHED implementation eagerly here, before the
  // reassignment below replaces it. A bare member-access extraction yields an
  // unbound method (unbound-method) because the host method needs the call-time
  // document as `this` (binding it statically throws "Illegal invocation").
  // Reflect.get captures the same function value through a call expression, and
  // Reflect.apply forwards the real instance as `this` at invocation time, so
  // behaviour is byte-for-byte identical while no method is left unbound.
  const originalCreateElement: typeof Document.prototype.createElement = Reflect.get(
    Document.prototype,
    'createElement',
  );

  Document.prototype.createElement = function patchedCreateElement<
    K extends keyof HTMLElementTagNameMap,
  >(this: Document, tagName: K, options?: ElementCreationOptions): HTMLElementTagNameMap[K] {
    const element = Reflect.apply(originalCreateElement, this, [
      tagName,
      options,
    ]) as HTMLElementTagNameMap[K];

    if (tagName.toLowerCase() !== 'script') {
      return element as HTMLElementTagNameMap[K];
    }

    const script = element as HTMLScriptElement;

    // Intercept src assignment via property descriptor override
    let _src = '';
    const descriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');

    Object.defineProperty(script, 'src', {
      get() {
        return _src;
      },
      set(value: string) {
        const validatedSrc = validateAndEnforceScriptSrc(value, script);
        _src = validatedSrc;
        if (descriptor?.set) {
          descriptor.set.call(this, validatedSrc);
        }
      },
      configurable: true,
      enumerable: true,
    });

    return element as HTMLElementTagNameMap[K];
  } as typeof Document.prototype.createElement;

  // ── Layer 2: Element.prototype.setAttribute patch ──
  // SECURITY: Intercepts `el.setAttribute('src', url)` on script elements.
  // Without this, an attacker can bypass the createElement src property
  // descriptor by using setAttribute directly.
  // WHY Reflect.get + Reflect.apply: same reasoning as Layer 1 — snapshot the
  // unpatched implementation eagerly via a call expression (so the method is
  // never extracted unbound) and forward the call-time element as `this`
  // explicitly, keeping behaviour byte-for-byte identical.
  const originalSetAttribute: typeof Element.prototype.setAttribute = Reflect.get(
    Element.prototype,
    'setAttribute',
  );

  Element.prototype.setAttribute = function patchedSetAttribute(
    this: Element,
    name: string,
    value: string,
  ): void {
    // Only intercept 'src' attribute on script elements
    if (name.toLowerCase() === 'src' && this instanceof HTMLScriptElement) {
      const validatedSrc = validateAndEnforceScriptSrc(value, this);
      // If blocked, set empty src to prevent loading
      Reflect.apply(originalSetAttribute, this, [name, validatedSrc]);
      return;
    }

    // Pass through for all non-script or non-src attributes
    Reflect.apply(originalSetAttribute, this, [name, value]);
  };
}
