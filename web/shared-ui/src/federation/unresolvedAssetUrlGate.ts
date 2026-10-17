/**
 * A build that would ship a stylesheet pointing at a file it did not emit
 * fails instead (FE-MEDIUM-348).
 *
 * WHY: Vite rewrites every `url()` in a stylesheet to the asset it emits for
 * it. One it cannot resolve it leaves as written, with a warning — "… didn't
 * resolve at build time, it will remain unchanged to be resolved at runtime" —
 * and the build passes. The shell's stylesheet is emitted under `/assets/`, so
 * the browser resolves that reference against `/assets/`, where nginx serves
 * only what the build emitted (`try_files $uri =404`): the request 404s and the
 * rule paints nothing. The workspace motifs shipped exactly so — their CSS was
 * `@import`ed from shared-ui into the shell's entry, the `url()` came to be
 * resolved against the shell's styles directory, and the warning scrolled past
 * in every build while the mask stayed transparent in production.
 *
 * WHAT: a plugin every federation config (the shell and each remote) mounts.
 * Its `config` hook wraps the logger Vite would have used — the same level,
 * the same clear-screen choice and any custom logger already configured — so
 * every other message prints as before, and that one warning throws instead.
 * Vite raises it while transforming the stylesheet, so the build stops with
 * the URL and the file that named it.
 * `tests/invariants/web-vite-unresolved-asset-gate.spec.ts` proves every
 * federation config's resolved build pipeline carries the plugin;
 * `__tests__/unresolvedAssetUrlGate.spec.ts` builds a stylesheet with Vite and
 * proves the warning arrives here and stops the build.
 */
import type { Logger, Plugin } from 'vite';

/** The plugin's name, which the invariant looks for in each resolved pipeline. */
export const UNRESOLVED_ASSET_URL_GATE = 'aquaculture:unresolved-asset-url-gate';

/** The words of Vite's warning for a `url()` it left unresolved (vite:css, Vite 7). */
export const UNRESOLVED_ASSET_URL_WARNING = "didn't resolve at build time";

function refuse(message: string): void {
  if (!message.includes(UNRESOLVED_ASSET_URL_WARNING)) return;
  throw new Error(
    `[${UNRESOLVED_ASSET_URL_GATE}] ${message.trim()}\n` +
      'The emitted stylesheet would keep this reference as written, and the browser would ' +
      'request it next to the stylesheet, where the build emitted nothing. Make the file resolvable from the CSS that names it, or inline it as a data URI.',
  );
}

/**
 * `logger`, except that Vite's unresolved-`url()` warning throws.
 *
 * @param logger the logger Vite would otherwise use
 * @returns a logger delegating every call to `logger`
 */
export function failOnUnresolvedAssetUrls(logger: Logger): Logger {
  return {
    get hasWarned(): boolean {
      return logger.hasWarned;
    },
    set hasWarned(value: boolean) {
      logger.hasWarned = value;
    },
    info: (message, options) => logger.info(message, options),
    warn: (message, options) => {
      refuse(message);
      logger.warn(message, options);
    },
    warnOnce: (message, options) => {
      refuse(message);
      logger.warnOnce(message, options);
    },
    error: (message, options) => logger.error(message, options),
    clearScreen: (type) => logger.clearScreen(type),
    hasErrorLogged: (error) => logger.hasErrorLogged(error),
  };
}

/**
 * The gate as a plugin. A build-only `config` hook may set the logger: Vite
 * creates it from the config after every plugin's `config` hook has run.
 * Vite is loaded inside the hook, where a build is already running it: Vite 7
 * is ESM-only, and the invariant suite (CommonJS) imports this module for the
 * plugin's name.
 *
 * @returns the plugin to list in a config's `plugins`
 */
export function unresolvedAssetUrlGate(): Plugin {
  return {
    name: UNRESOLVED_ASSET_URL_GATE,
    apply: 'build',
    async config(config): Promise<void> {
      const { createLogger } = await import('vite');
      config.customLogger = failOnUnresolvedAssetUrls(
        createLogger(config.logLevel, {
          allowClearScreen: config.clearScreen,
          customLogger: config.customLogger,
        }),
      );
    },
  };
}
