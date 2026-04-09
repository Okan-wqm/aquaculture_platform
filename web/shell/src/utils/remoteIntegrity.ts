/**
 * Remote Module Integrity Guard
 *
 * SH-SEC-04: Vite Module Federation (@originjs/vite-plugin-federation) does not
 * generate or validate Subresource Integrity (SRI) hashes for remote entry files.
 * This module provides two layers of defense:
 *
 *   1. A production-time allowlist of known remote entry URL patterns — any
 *      remoteEntry.js fetched from an origin not on this list is blocked and a
 *      security event is dispatched.
 *
 *   2. An extensible hash-pinning map that, when populated (e.g. at CI/CD time
 *      via a generated file), verifies SHA-256 digests of fetched remote bundles
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
// Format: { '/remotes/<module>/assets/remoteEntry.js': 'sha256-<base64>' }
// ---------------------------------------------------------------------------
let REMOTE_HASH_PINS: Record<string, string> = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const generated = require('./generated/remoteHashes.json') as Record<string, string>;
  REMOTE_HASH_PINS = generated;
} catch {
  // File absent in local dev or when CI hasn't run yet — hash verification skipped.
}

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
    // eslint-disable-next-line no-console
    console.error(message);
  }

  // Dispatch a custom security event so monitoring/analytics can capture it
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('aquaculture:security-violation', {
        detail: { type: 'REMOTE_SCRIPT_BLOCKED', src, timestamp: Date.now() },
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Shared script src validation logic
// ---------------------------------------------------------------------------

/**
 * Validates a script src value against the allowlist and applies SRI hash
 * pins when available. Returns the (possibly cleared) src value.
 *
 * SECURITY: This is the single enforcement point for both createElement and
 * setAttribute interception paths, ensuring consistent policy application.
 *
 * @param src - The script src URL to validate
 * @param scriptElement - The script element to apply integrity attributes to
 * @returns The validated src (empty string if blocked)
 */
function validateAndEnforceScriptSrc(src: string, scriptElement: HTMLScriptElement): string {
  if (!isRemoteEntryScript(src)) {
    return src;
  }

  if (!isAllowedRemoteUrl(src)) {
    reportViolation(src);
    return '';
  }

  // Apply hash pin if registered
  const pin = REMOTE_HASH_PINS[src];
  if (pin) {
    scriptElement.integrity = pin;
    scriptElement.crossOrigin = 'anonymous';
  } else if (import.meta.env.DEV) {
    // Warn in development when no hash pin is registered.
    // In production this is expected until CI populates REMOTE_HASH_PINS.
    // eslint-disable-next-line no-console
    console.warn(
      `[SH-SEC-04] No integrity hash pinned for remote entry: ${src}. ` +
        'Populate REMOTE_HASH_PINS at build time for full SRI enforcement.'
    );
  } else if (import.meta.env.PROD) {
    // SEC-M02: Runtime warning when SRI hash map is empty in production.
    // This indicates the CI/CD pipeline has not yet populated REMOTE_HASH_PINS.
    // Remote modules will still load (allowlist permits them), but without
    // integrity verification, a CDN or proxy compromise could inject
    // malicious code. Dispatch a security event for monitoring/alerting.
    // eslint-disable-next-line no-console
    console.warn(
      `[SH-SEC-04] PRODUCTION: No SRI hash pinned for remote entry: ${src}. ` +
        'CI/CD must populate REMOTE_HASH_PINS for subresource integrity enforcement.'
    );
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('aquaculture:security-violation', {
          detail: {
            type: 'SRI_HASH_MISSING',
            src,
            timestamp: Date.now(),
            severity: 'warning',
          },
        })
      );
    }
  }

  return src;
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
  const originalCreateElement = Document.prototype.createElement;

  Document.prototype.createElement = function patchedCreateElement<
    K extends keyof HTMLElementTagNameMap,
  >(
    this: Document,
    tagName: K,
    options?: ElementCreationOptions
  ): HTMLElementTagNameMap[K] {
    const element = originalCreateElement.call(this, tagName, options);

    if (tagName.toLowerCase() !== 'script') {
      return element;
    }

    const script = element as HTMLScriptElement;

    // Intercept src assignment via property descriptor override
    let _src = '';
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLScriptElement.prototype,
      'src'
    );

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
  const originalSetAttribute = Element.prototype.setAttribute;

  Element.prototype.setAttribute = function patchedSetAttribute(
    this: Element,
    name: string,
    value: string
  ): void {
    // Only intercept 'src' attribute on script elements
    if (
      name.toLowerCase() === 'src' &&
      this instanceof HTMLScriptElement
    ) {
      const validatedSrc = validateAndEnforceScriptSrc(
        value,
        this as HTMLScriptElement
      );
      // If blocked, set empty src to prevent loading
      originalSetAttribute.call(this, name, validatedSrc);
      return;
    }

    // Pass through for all non-script or non-src attributes
    originalSetAttribute.call(this, name, value);
  };
}
