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
// CI/CD pipeline should generate this map after each build:
//   1. Build all microfrontend modules
//   2. Compute SHA-256 hash: sha256sum dist/assets/remoteEntry.js
//   3. Inject hashes into this map (or import from a generated hashes.json)
//
// Format: { '<path-to-remoteEntry.js>': 'sha256-<base64-hash>' }
//
// When populated, the createElement patch in installRemoteIntegrityGuard()
// will set the `integrity` attribute on injected <script> elements, enabling
// browser-native SRI verification before execution.
//
// TODO(CI/CD): Add a post-build step that:
//   - Runs: for module in dashboard farm-module hr-module sensor-module hydroponics-module admin-panel tenant-admin; do
//       HASH=$(cat web/modules/$module/dist/assets/remoteEntry.js | openssl dgst -sha256 -binary | openssl base64 -A)
//       echo "  '/remotes/$module/assets/remoteEntry.js': 'sha256-$HASH',"
//     done
//   - Writes the output to web/shell/src/generated/remoteHashes.json
//   - This file imports and re-exports the generated map
// ---------------------------------------------------------------------------
const REMOTE_HASH_PINS: Record<string, string> = {
  // Populated by CI/CD pipeline — do not edit manually
  // '/remotes/dashboard/assets/remoteEntry.js': 'sha256-...',
  // '/remotes/farm-module/assets/remoteEntry.js': 'sha256-...',
  // '/remotes/hr-module/assets/remoteEntry.js': 'sha256-...',
  // '/remotes/sensor-module/assets/remoteEntry.js': 'sha256-...',
  // '/remotes/hydroponics-module/assets/remoteEntry.js': 'sha256-...',
  // '/remotes/admin-panel/assets/remoteEntry.js': 'sha256-...',
  // '/remotes/tenant-admin/assets/remoteEntry.js': 'sha256-...',
};

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
// createElement patch
// ---------------------------------------------------------------------------

let patchApplied = false;

/**
 * Installs a `document.createElement` patch that intercepts dynamically
 * injected <script> elements whose `src` matches a remoteEntry pattern.
 *
 * For each intercepted script:
 *  - If the `src` is NOT in the allowlist, the element's `src` is cleared and
 *    a security violation is reported.
 *  - If a hash pin is registered for the `src`, the `integrity` attribute is
 *    set so the browser enforces SRI natively.
 *
 * Must be called once, as early as possible in application bootstrap (before
 * any import() of remote modules).
 */
export function installRemoteIntegrityGuard(): void {
  if (patchApplied || typeof document === 'undefined') return;
  patchApplied = true;

  const originalCreateElement = document.createElement.bind(document);

  // Use a type assertion so we can replace the overloaded DOM method while
  // keeping the return type compatible.
  (document as Document & { createElement: typeof document.createElement }).createElement =
    function patchedCreateElement<K extends keyof HTMLElementTagNameMap>(
      tagName: K,
      options?: ElementCreationOptions
    ): HTMLElementTagNameMap[K] {
      const element = originalCreateElement(tagName, options);

      if (tagName.toLowerCase() !== 'script') {
        return element;
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
          _src = value;

          if (isRemoteEntryScript(value)) {
            if (!isAllowedRemoteUrl(value)) {
              reportViolation(value);
              // Block by leaving src empty — script won't load
              _src = '';
              if (descriptor?.set) {
                descriptor.set.call(this, '');
              }
              return;
            }

            // Apply hash pin if registered
            const pin = REMOTE_HASH_PINS[value];
            if (pin) {
              script.integrity = pin;
              script.crossOrigin = 'anonymous';
            } else if (import.meta.env.DEV) {
              // Warn in development when no hash pin is registered.
              // In production this is expected until CI populates REMOTE_HASH_PINS.
              // eslint-disable-next-line no-console
              console.warn(
                `[SH-SEC-04] No integrity hash pinned for remote entry: ${value}. ` +
                  'Populate REMOTE_HASH_PINS at build time for full SRI enforcement.'
              );
            }
          }

          if (descriptor?.set) {
            descriptor.set.call(this, _src);
          }
        },
        configurable: true,
        enumerable: true,
      });

      return element as HTMLElementTagNameMap[K];
    };
}
